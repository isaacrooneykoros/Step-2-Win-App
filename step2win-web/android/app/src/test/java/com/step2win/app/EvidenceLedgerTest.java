package com.step2win.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Test;

import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.util.List;

/**
 * Per-minute evidence attribution + the ledger: buckets always sum to the ledger's hour steps,
 * reboots, local-day boundaries, persistence (process death), vehicle intervals, walks, and
 * the reinstall resume arithmetic.
 */
public class EvidenceLedgerTest {
    private static final ZoneId ZONE = ZoneId.of("Africa/Nairobi");
    /** 2026-09-29 10:00 local. */
    private static final long T0 = ZonedDateTime.of(2026, 9, 29, 10, 0, 0, 0, ZONE).toInstant().toEpochMilli();

    private static GaitClassifier.Result window(GaitClassifier.Verdict v, double freq) {
        GaitClassifier.Result r = new GaitClassifier.Result();
        r.verdict = v;
        r.reason = v == GaitClassifier.Verdict.SHAKE ? "erratic" : "gait";
        r.stepFreqHz = freq;
        return r;
    }

    /** Simulates one minute of live observation: 24 windows + counter steps spread over it. */
    private static void observeMinute(EvidenceTracker t, long minuteStart, GaitClassifier.Verdict v, double freq, int steps) {
        for (int i = 0; i < 24; i++) t.onWindow(minuteStart + i * 2_500L, window(v, freq));
        for (int i = 0; i < 6; i++) t.onCounterSteps(minuteStart + i * 10_000L + 5_000L, steps / 6 + (i < steps % 6 ? 1 : 0));
    }

    private static LedgerCore.Attributor attributor(EvidenceTracker t, VehicleTimeline v) {
        EvidenceTracker.VehicleCheck check = EvidenceTracker.of(v);
        return (steps, s, e) -> t.attribute(steps, s, e, check);
    }

    private static void assertBucketsSumToHours(JSONObject day) throws Exception {
        List<LedgerCore.EvidenceHour> hours = LedgerCore.evidenceHours(day);
        int total = 0;
        for (LedgerCore.EvidenceHour h : hours) {
            assertEquals("hour " + h.hour, day.getJSONArray("h").getInt(h.hour), h.total());
            assertTrue(h.activeMinutes >= 1 && h.activeMinutes <= 60);
            assertTrue(h.gaitMinutes >= 0 && h.gaitMinutes <= 60);
            total += h.total();
        }
        assertEquals(day.getInt("t"), total);
    }

    private static LedgerCore.EvidenceHour hour(JSONObject day, int h) {
        for (LedgerCore.EvidenceHour e : LedgerCore.evidenceHours(day)) if (e.hour == h) return e;
        return null;
    }

    // ── attribution ──────────────────────────────────────────────────────────

    @Test
    public void observedWalkingMinutesAreVerifiedAndTheRestUnknown() {
        EvidenceTracker t = new EvidenceTracker();
        observeMinute(t, T0, GaitClassifier.Verdict.WALKING, 1.8, 108);
        observeMinute(t, T0 + 60_000L, GaitClassifier.Verdict.WALKING, 1.8, 108);
        // the ledger adds 300 steps over those two minutes (the counter counted 84 more before
        // the listener started): 216 seen live and verified, 84 unknown / not analysed
        int[] b = t.attribute(300, T0, T0 + 120_000L, EvidenceTracker.NO_VEHICLE);
        assertEquals(216, b[EvidenceTracker.VERIFIED]);
        assertEquals(84, b[EvidenceTracker.UNKNOWN]);
        assertEquals(84, b[EvidenceTracker.NOT_ANALYSED]);
        assertEquals(0, b[EvidenceTracker.SHAKE] + b[EvidenceTracker.VEHICLE] + b[EvidenceTracker.WALK]);
        // observed steps are used only once
        int[] again = t.attribute(50, T0 + 120_000L, T0 + 150_000L, EvidenceTracker.NO_VEHICLE);
        assertEquals(50, again[EvidenceTracker.UNKNOWN]);
    }

    @Test
    public void shakeMinutesGoToShake() {
        EvidenceTracker t = new EvidenceTracker();
        observeMinute(t, T0, GaitClassifier.Verdict.SHAKE, 0, 150);
        int[] b = t.attribute(150, T0, T0 + 60_000L, EvidenceTracker.NO_VEHICLE);
        assertEquals(150, b[EvidenceTracker.SHAKE]);
    }

    @Test
    public void counterStepsWithoutAnyAnalysisAreUnknown() {
        EvidenceTracker t = new EvidenceTracker();
        for (int i = 0; i < 6; i++) t.onCounterSteps(T0 + i * 10_000L, 20);
        int[] b = t.attribute(120, T0, T0 + 60_000L, EvidenceTracker.NO_VEHICLE);
        assertEquals(120, b[EvidenceTracker.UNKNOWN]);
        assertEquals(0, b[EvidenceTracker.NOT_ANALYSED]); // seen live, just not analysed
    }

    @Test
    public void vehicleAndWalkBuckets() {
        EvidenceTracker t = new EvidenceTracker();
        VehicleTimeline v = new VehicleTimeline();
        v.enter(T0);
        v.exit(T0 + 60_000L);
        observeMinute(t, T0, GaitClassifier.Verdict.WALKING, 1.8, 60);           // in a car (AR)
        t.setWalkActive(true);
        observeMinute(t, T0 + 60_000L, GaitClassifier.Verdict.WALKING, 1.8, 100); // user walk
        observeMinute(t, T0 + 120_000L, GaitClassifier.Verdict.WALKING, 1.8, 40); // walk at GPS vehicle speed
        t.markWalkVehicle(T0 + 150_000L);
        t.setWalkActive(false);
        int[] b = t.attribute(200, T0, T0 + 180_000L, EvidenceTracker.of(v));
        assertEquals(100, b[EvidenceTracker.VEHICLE]);
        assertEquals(100, b[EvidenceTracker.WALK]);
        // unobserved steps inside a vehicle interval: by time share
        EvidenceTracker empty = new EvidenceTracker();
        int[] c = empty.attribute(100, T0 - 60_000L, T0 + 60_000L, EvidenceTracker.of(v));
        assertEquals(50, c[EvidenceTracker.VEHICLE]);
        assertEquals(50, c[EvidenceTracker.UNKNOWN]);
    }

    @Test
    public void youngMinuteIsJudgedWithThePreviousOne() {
        EvidenceTracker t = new EvidenceTracker();
        observeMinute(t, T0, GaitClassifier.Verdict.WALKING, 1.8, 108);
        // 5 s into the next minute: 2 windows only, 9 counter steps
        t.onWindow(T0 + 60_000L, window(GaitClassifier.Verdict.WALKING, 1.8));
        t.onWindow(T0 + 62_500L, window(GaitClassifier.Verdict.UNKNOWN, 0));
        t.onCounterSteps(T0 + 64_000L, 9);
        t.attribute(108, T0, T0 + 60_000L, EvidenceTracker.NO_VEHICLE);
        int[] b = t.attribute(9, T0 + 60_000L, T0 + 65_000L, EvidenceTracker.NO_VEHICLE);
        assertEquals(9, b[EvidenceTracker.VERIFIED]);
    }

    @Test
    public void machineCannotHideInTheFirstSecondsOfAMinute() {
        EvidenceTracker t = new EvidenceTracker();
        // a motor: every window looks like gait, but the cadence never changes
        for (int m = 0; m < 2; m++) {
            int windows = m == 0 ? 24 : 5;
            for (int i = 0; i < windows; i++) {
                GaitClassifier.Result r = window(GaitClassifier.Verdict.WALKING, 1.8);
                r.peakFreqHz = 1.8;
                t.onWindow(T0 + m * 60_000L + i * 2_500L, r);
            }
        }
        t.onCounterSteps(T0 + 30_000L, 108);
        t.onCounterSteps(T0 + 72_000L, 22);
        int[] b = t.attribute(130, T0, T0 + 75_000L, EvidenceTracker.NO_VEHICLE);
        assertEquals(130, b[EvidenceTracker.SHAKE]);
    }

    @Test
    public void closedMinutesAreReportedOnce() {
        EvidenceTracker t = new EvidenceTracker();
        observeMinute(t, T0, GaitClassifier.Verdict.WALKING, 1.8, 100);
        t.onWindow(T0 + 60_000L, window(GaitClassifier.Verdict.IDLE, 0)); // analysed, no steps
        assertEquals(0, t.drainClosed(T0 + 59_000L).size());
        List<EvidenceTracker.MinuteFacts> first = t.drainClosed(T0 + 125_000L);
        assertEquals(2, first.size());
        assertTrue(first.get(0).active && first.get(0).analysed);
        assertTrue(!first.get(1).active && first.get(1).analysed);
        assertEquals(0, t.drainClosed(T0 + 125_000L).size());
    }

    // ── ledger ───────────────────────────────────────────────────────────────

    @Test
    public void ledgerHourBucketsAlwaysSumToHourSteps() throws Exception {
        EvidenceTracker t = new EvidenceTracker();
        LedgerCore.State st = new LedgerCore.State();
        long elapsed = 5_000_000L;
        assertEquals(0, LedgerCore.record(st, 1000f, elapsed, T0, 7, ZONE, attributor(t, null))); // baseline
        // app open, walking 10:00-10:05, the ledger records every 15 s
        long raw = 1000;
        for (int m = 0; m < 5; m++) {
            long ms = T0 + m * 60_000L;
            for (int q = 1; q <= 4; q++) {
                long now = ms + q * 15_000L;
                for (int i = 0; i < 6; i++) t.onWindow(now - 15_000L + i * 2_500L, window(GaitClassifier.Verdict.WALKING, 1.8));
                t.onCounterSteps(now - 1_000L, 27);
                raw += 27;
                LedgerCore.record(st, raw, elapsed + (now - T0), now, 7, ZONE, attributor(t, null));
            }
            for (EvidenceTracker.MinuteFacts f : t.drainClosed(ms + 60_000L)) {
                LedgerCore.applyMinute(st.days, f.startMs, f.active, f.analysed, ZONE);
            }
        }
        // app closed; WorkManager reads 2000 more steps at 11:30 (nothing observed)
        long later = T0 + 90 * 60_000L;
        raw += 2000;
        LedgerCore.record(st, raw, elapsed + (later - T0), later, 7, ZONE, attributor(t, null));

        JSONObject day = st.days.getJSONObject("2026-09-29");
        assertEquals(540 + 2000, day.getInt("t"));
        assertBucketsSumToHours(day);
        LedgerCore.EvidenceHour h10 = hour(day, 10);
        // the first 15 s of analysis (27 steps) had too little context to verify: unknown
        assertEquals(540 - 27, h10.verified);
        assertTrue(h10.unknown > 0);
        assertEquals(5, h10.gaitMinutes);
        assertTrue(h10.activeMinutes >= 5);
        LedgerCore.EvidenceHour h11 = hour(day, 11);
        assertEquals(0, h11.verified);
        assertEquals(h11.total(), h11.unknown);
        // 11:00-11:30 carried ~700 unobserved steps: active minutes estimated at 110 steps/min
        assertEquals((int) Math.ceil(h11.total() / 110.0), h11.activeMinutes);
    }

    @Test
    public void rebootCountsStepsSinceBootWithoutDoubleCounting() throws Exception {
        LedgerCore.State st = new LedgerCore.State();
        LedgerCore.record(st, 5000f, 10_000_000L, T0, 3, ZONE, LedgerCore.ALL_UNKNOWN);
        assertEquals(200, LedgerCore.record(st, 5200f, 10_600_000L, T0 + 600_000L, 3, ZONE, LedgerCore.ALL_UNKNOWN));
        // reboot (BOOT_COUNT 3 -> 4): the counter restarted at 0 and now reads 150
        long afterBoot = T0 + 3_600_000L;
        assertEquals(150, LedgerCore.record(st, 150f, 900_000L, afterBoot, 4, ZONE, LedgerCore.ALL_UNKNOWN));
        // reboot detected without BOOT_COUNT (-1): raw went down
        assertEquals(40, LedgerCore.record(st, 40f, 1_000_000L, afterBoot + 100_000L, -1, ZONE, LedgerCore.ALL_UNKNOWN));
        JSONObject day = st.days.getJSONObject("2026-09-29");
        assertEquals(390, day.getInt("t"));
        assertBucketsSumToHours(day);
    }

    @Test
    public void stepsAfterMidnightGoToTheNewDay() throws Exception {
        long before = ZonedDateTime.of(2026, 9, 29, 23, 50, 0, 0, ZONE).toInstant().toEpochMilli();
        LedgerCore.State st = new LedgerCore.State();
        LedgerCore.record(st, 100f, 1_000_000L, before, 1, ZONE, LedgerCore.ALL_UNKNOWN);
        // 20 minutes later (00:10): 400 steps spread evenly -> 200 before midnight, 200 after
        long after = before + 20 * 60_000L;
        assertEquals(400, LedgerCore.record(st, 500f, 1_000_000L + 1_200_000L, after, 1, ZONE, LedgerCore.ALL_UNKNOWN));
        JSONObject d1 = st.days.getJSONObject("2026-09-29");
        JSONObject d2 = st.days.getJSONObject("2026-09-30");
        assertEquals(200, d1.getInt("t"));
        assertEquals(200, d2.getInt("t"));
        assertEquals(200, d1.getJSONArray("h").getInt(23));
        assertEquals(200, d2.getJSONArray("h").getInt(0));
        assertBucketsSumToHours(d1);
        assertBucketsSumToHours(d2);
        // live-observed steps after midnight are attributed on the new day
        EvidenceTracker t = new EvidenceTracker();
        long m = after + 60_000L;
        observeMinute(t, m, GaitClassifier.Verdict.WALKING, 1.8, 90);
        LedgerCore.record(st, 590f, 1_000_000L + 1_200_000L + 120_000L, m + 60_000L, 1, ZONE, attributor(t, null));
        assertEquals(90, hour(st.days.getJSONObject("2026-09-30"), 0).verified);
        assertEquals(200, st.days.getJSONObject("2026-09-29").getInt("t"));
    }

    @Test
    public void sanityClampLimitsImpossibleJumps() {
        LedgerCore.State st = new LedgerCore.State();
        LedgerCore.record(st, 0f, 1_000_000L, T0, 1, ZONE, LedgerCore.ALL_UNKNOWN);
        // 10 s later the counter claims 5000 steps: at most 4 per second are accepted
        assertEquals(40, LedgerCore.record(st, 5000f, 1_010_000L, T0 + 10_000L, 1, ZONE, LedgerCore.ALL_UNKNOWN));
    }

    @Test
    public void daysFromOlderVersionsWithoutEvidenceAreUnknown() throws Exception {
        JSONObject days = new JSONObject("{\"2026-09-29\":{\"t\":300,\"h\":[0,0,0,0,0,0,0,0,0,0,300,0,0,0,0,0,0,0,0,0,0,0,0,0],\"u\":1}}");
        LedgerCore.EvidenceHour h = hour(days.getJSONObject("2026-09-29"), 10);
        assertEquals(300, h.unknown);
        // new steps on such a day keep the invariant (old steps migrate to unknown)
        LedgerCore.State st = new LedgerCore.State();
        st.days = days;
        LedgerCore.addSteps(st, 50, T0 + 1_000L, T0 + 2_000L, ZONE, LedgerCore.walkBucket());
        JSONObject day = st.days.getJSONObject("2026-09-29");
        assertBucketsSumToHours(day);
        assertEquals(300, hour(day, 10).unknown);
        assertEquals(50, hour(day, 10).walk);
    }

    @Test
    public void evidenceSurvivesProcessDeath() throws Exception {
        EvidenceTracker t = new EvidenceTracker();
        LedgerCore.State st = new LedgerCore.State();
        LedgerCore.record(st, 0f, 1_000_000L, T0, 1, ZONE, attributor(t, null));
        observeMinute(t, T0, GaitClassifier.Verdict.WALKING, 1.8, 100);
        LedgerCore.record(st, 100f, 1_060_000L, T0 + 60_000L, 1, ZONE, attributor(t, null));
        // persisted as JSON text (SharedPreferences), reloaded in a new process
        JSONObject reloaded = new JSONObject(st.days.toString());
        assertEquals(100, hour(reloaded.getJSONObject("2026-09-29"), 10).verified);
        LedgerCore.State st2 = new LedgerCore.State();
        st2.days = reloaded;
        st2.lastRaw = st.lastRaw;
        st2.lastElapsed = st.lastElapsed;
        st2.bootCount = st.bootCount;
        // the new process has an empty tracker: its next unobserved steps are unknown
        LedgerCore.record(st2, 160f, 1_120_000L, T0 + 120_000L, 1, ZONE, attributor(new EvidenceTracker(), null));
        JSONObject day = st2.days.getJSONObject("2026-09-29");
        assertEquals(100, hour(day, 10).verified);
        assertEquals(60, hour(day, 10).unknown);
        assertBucketsSumToHours(day);
    }

    @Test
    public void oldDaysArePrunedAfterEightDays() throws Exception {
        LedgerCore.State st = new LedgerCore.State();
        long old = T0 - 10L * 24 * 3_600_000L;
        LedgerCore.addSteps(st, 10, old, old, ZONE, LedgerCore.ALL_UNKNOWN);
        assertTrue(st.days.has("2026-09-19"));
        LedgerCore.addSteps(st, 10, T0, T0, ZONE, LedgerCore.ALL_UNKNOWN);
        assertFalse(st.days.has("2026-09-19"));
        assertTrue(st.days.has("2026-09-29"));
    }

    // ── reinstall resume ─────────────────────────────────────────────────────

    @Test
    public void resumeArithmetic() {
        assertEquals(0, LedgerCore.reportedTotal(0, 0, 0));
        assertEquals(300, LedgerCore.reportedTotal(300, 0, 0));
        assertEquals(5000, LedgerCore.reportedTotal(0, 5000, 0));
        assertEquals(5300, LedgerCore.reportedTotal(300, 5000, 0));
        // resumed while the fresh ledger already had 40 steps: only steps since the resume add
        assertEquals(5260, LedgerCore.reportedTotal(300, 5000, 40));
        // never less than the ledger itself, never less than the server's last total
        assertEquals(9000, LedgerCore.reportedTotal(9000, 5000, 8000));
        assertEquals(5000, LedgerCore.reportedTotal(10, 5000, 40));
    }

    @Test
    public void reinstallResumeKeepsTheDayAndEvidenceOnlyCoversNewSteps() throws Exception {
        LedgerCore.State st = new LedgerCore.State(); // fresh install: empty ledger
        assertEquals(0, LedgerCore.record(st, 12_345f, 1_000_000L, T0, 2, ZONE, LedgerCore.ALL_UNKNOWN));
        assertTrue(LedgerCore.applyResume(st.days, "2026-09-29", 5000, T0));
        assertFalse(LedgerCore.applyResume(st.days, "2026-09-29", 7000, T0)); // once per day
        JSONObject day = st.days.getJSONObject("2026-09-29");
        assertEquals(5000, LedgerCore.reportedTotal(day));
        assertEquals(0, LedgerCore.evidenceHours(day).size());
        LedgerCore.record(st, 12_645f, 1_600_000L, T0 + 600_000L, 2, ZONE, LedgerCore.ALL_UNKNOWN);
        day = st.days.getJSONObject("2026-09-29");
        assertEquals(300, day.getInt("t"));
        assertEquals(5300, LedgerCore.reportedTotal(day));
        assertBucketsSumToHours(day); // evidence = the 300 new steps only
        assertFalse(LedgerCore.applyResume(st.days, "2026-09-29", 0, T0));
    }
}
