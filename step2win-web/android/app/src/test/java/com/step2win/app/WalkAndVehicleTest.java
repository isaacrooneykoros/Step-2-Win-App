package com.step2win.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Test;

/** User walk state (GPS, steps, gait buckets, auto-end) and the vehicle timeline. */
public class WalkAndVehicleTest {
    private static final long T0 = 1_790_000_000_000L;
    private static final double LAT = -1.2921, LNG = 36.8219; // Nairobi
    private static final double M_PER_DEG = 111_195.0;

    private static GaitClassifier.Result window(GaitClassifier.Verdict v, double freq) {
        GaitClassifier.Result r = new GaitClassifier.Result();
        r.verdict = v;
        r.reason = v == GaitClassifier.Verdict.SHAKE ? "erratic" : "gait";
        r.stepFreqHz = freq;
        r.rms = 2.0;
        return r;
    }

    private static WalkTracker started(String source) {
        WalkTracker w = new WalkTracker();
        w.start("walk-1", T0, source, WalkTracker.DEFAULT_AUTO_END_MS);
        return w;
    }

    @Test
    public void gpsFixesKeepFastPointsDropOnlyBadAccuracyAndFlagMock() {
        WalkTracker w = started("step_counter");
        assertNull(w.onLocation(T0, LAT, LNG, 120, 1.2, false, T0));      // accuracy > 75 m: dropped
        assertEquals(1, w.badFixes);
        assertEquals("searching", w.gpsStatus);
        WalkTracker.Point p = w.onLocation(T0 + 3_000, LAT, LNG, 8, 1.3, false, T0 + 3_000);
        assertNotNull(p);
        assertEquals("ok", w.gpsStatus);
        // a 12 m/s fix is KEPT (flagged by its speed), not dropped
        WalkTracker.Point fast = w.onLocation(T0 + 6_000, LAT + 36 / M_PER_DEG, LNG, 8, 12.0, false, T0 + 6_000);
        assertNotNull(fast);
        assertEquals(12.0, fast.spd, 1e-9);
        // speed missing: derived from the previous fix
        WalkTracker.Point derived = w.onLocation(T0 + 9_000, LAT + 42 / M_PER_DEG, LNG, 8, Double.NaN, false, T0 + 9_000);
        assertEquals(2.0, derived.spd, 0.1);
        WalkTracker.Point mock = w.onLocation(T0 + 12_000, LAT + 45 / M_PER_DEG, LNG, 5, 1.0, true, T0 + 12_000);
        assertTrue(mock.mock);
        assertTrue(w.mockLocation);
        JSONObject json = mock.toJson();
        assertTrue(json.optBoolean("mock"));
        assertTrue(json.optString("t").endsWith("Z"));
        assertEquals(4, w.pointsRecorded);
    }

    @Test
    public void sustainedVehicleSpeedCountsVehicleSeconds() {
        WalkTracker w = started("step_counter");
        long t = T0;
        double lat = LAT;
        w.tick(t, false);
        // one fast fix alone is not "sustained"
        w.onLocation(t, lat, LNG, 6, 1.4, false, t);
        t += 2_000; lat += 30 / M_PER_DEG;
        w.onLocation(t, lat, LNG, 6, 15.0, false, t);
        assertFalse(w.gpsVehicleNow());
        w.tick(t, false);
        assertEquals(0, w.vehicleSeconds, 1e-9);
        for (int i = 0; i < 10; i++) {
            t += 2_000; lat += 30 / M_PER_DEG;
            w.onLocation(t, lat, LNG, 6, 15.0, false, t);
            w.tick(t, false);
        }
        assertTrue(w.gpsVehicleNow());
        assertEquals(20, w.vehicleSeconds, 0.01);
        // Activity Recognition in a vehicle also counts
        WalkTracker ar = started("step_counter");
        ar.tick(T0, false);
        ar.tick(T0 + 2_000, true);
        ar.tick(T0 + 4_000, true);
        assertEquals(4, ar.vehicleSeconds, 0.01);
    }

    @Test
    public void distanceIgnoresGpsJitterWhileStanding() {
        WalkTracker w = started("step_counter");
        java.util.Random rnd = new java.util.Random(1);
        for (int i = 0; i < 30; i++) {
            double jitter = (rnd.nextDouble() - 0.5) * 6 / M_PER_DEG; // +-3 m
            w.onLocation(T0 + i * 3_000L, LAT + jitter, LNG + jitter, 10, 0.3, false, T0 + i * 3_000L);
        }
        assertTrue("jitter distance " + w.distanceM, w.distanceM < 10);
        // then a straight 300 m walk
        for (int i = 1; i <= 60; i++) {
            long t = T0 + 90_000L + i * 3_000L;
            w.onLocation(t, LAT + i * 5.0 / M_PER_DEG, LNG, 6, 1.6, false, t);
        }
        assertEquals(300, w.distanceM, 20);
    }

    @Test
    public void walkStepsAreSplitByGaitVerdict() {
        WalkTracker w = started("step_counter");
        for (int i = 0; i < 12; i++) w.onWindow(window(GaitClassifier.Verdict.WALKING, 1.8), T0 + i * 2_500L);
        w.onCounterSteps(50, T0 + 30_000);
        for (int i = 0; i < 12; i++) w.onWindow(window(GaitClassifier.Verdict.SHAKE, 0), T0 + 30_000 + i * 2_500L);
        w.onCounterSteps(30, T0 + 60_000);
        for (int i = 0; i < 12; i++) w.onWindow(window(GaitClassifier.Verdict.UNKNOWN, 0), T0 + 60_000 + i * 2_500L);
        w.onCounterSteps(20, T0 + 90_000);
        assertEquals(100, w.steps);
        assertEquals(50, w.gaitVerified);
        assertEquals(30, w.gaitShake);
        assertEquals(20, w.gaitUnknown);
        assertEquals(w.steps, w.gaitVerified + w.gaitShake + w.gaitUnknown);
    }

    @Test
    public void phonesWithoutStepCounterCountWalkStepsFromTheAccelerometer() {
        WalkTracker w = started("accelerometer");
        int added = 0;
        for (int i = 0; i < 24; i++) added += w.onWindow(window(GaitClassifier.Verdict.WALKING, 1.8), T0 + i * 2_500L);
        assertEquals(108, added); // 1.8 steps/s for 60 s
        assertEquals(108, w.steps);
        assertEquals(w.steps, w.gaitVerified + w.gaitShake + w.gaitUnknown);
        // idle windows add nothing; with a hardware counter windows never add steps
        assertEquals(0, w.onWindow(window(GaitClassifier.Verdict.IDLE, 0), T0 + 61_000));
        WalkTracker counter = started("step_counter");
        assertEquals(0, counter.onWindow(window(GaitClassifier.Verdict.WALKING, 1.8), T0));
    }

    @Test
    public void walkAutoEndsAfterInactivityAndAtTheHardCap() {
        WalkTracker w = started("step_counter");
        w.onCounterSteps(10, T0 + 60_000);
        assertNull(w.tick(T0 + 5 * 60_000L, false));
        assertEquals("inactive", w.tick(T0 + 60_000 + WalkTracker.DEFAULT_AUTO_END_MS, false));
        w.finish(T0 + 60_000 + WalkTracker.DEFAULT_AUTO_END_MS, true);
        assertFalse(w.active);
        assertTrue(w.autoEnded);
        assertEquals(0, w.onWindow(window(GaitClassifier.Verdict.WALKING, 1.8), T0 + 700_000)); // ignored after end

        WalkTracker capped = started("step_counter");
        long t = T0;
        String end = null;
        while (end == null && t < T0 + 5 * 3_600_000L) {
            t += 60_000;
            capped.onCounterSteps(100, t);
            end = capped.tick(t, false);
        }
        assertEquals("max_duration", end);
        assertEquals(WalkTracker.MAX_DURATION_MS, t - T0);
    }

    @Test
    public void walkStateSurvivesProcessDeath() throws Exception {
        WalkTracker w = started("step_counter");
        for (int i = 0; i < 12; i++) w.onWindow(window(GaitClassifier.Verdict.WALKING, 1.8), T0 + i * 2_500L);
        w.onCounterSteps(40, T0 + 30_000);
        w.onLocation(T0 + 30_000, LAT, LNG, 5, 1.0, true, T0 + 30_000);
        w.tick(T0 + 30_000, false);
        WalkTracker r = WalkTracker.parse(w.serialize());
        assertEquals("walk-1", r.walkId);
        assertTrue(r.active);
        assertEquals(40, r.steps);
        assertEquals(40, r.gaitVerified);
        assertTrue(r.mockLocation);
        JSONObject state = r.toJson(T0 + 40_000, 3);
        assertEquals("walk-1", state.getString("walkId"));
        assertEquals(40, state.getLong("elapsedS"));
        assertEquals(3, state.getInt("pointsPending"));
        assertEquals("step_counter", state.getString("stepSource"));
        assertTrue(state.getString("startedAt").endsWith("Z"));
        assertEquals(JSONObject.NULL, state.get("endedAt"));
    }

    // ── vehicle timeline ─────────────────────────────────────────────────────

    @Test
    public void vehicleTimelineIntervalsAndStaleEnter() {
        VehicleTimeline v = new VehicleTimeline();
        v.enter(T0);
        v.exit(T0 + 600_000);
        assertTrue(v.activeAt(T0 + 1));
        assertFalse(v.activeAt(T0 + 600_001));
        assertEquals(0.5, v.overlapFraction(T0 - 600_000, T0 + 600_000), 1e-9);
        // an ENTER without EXIT ends after 3 h
        v.enter(T0 + 3_600_000);
        assertTrue(v.activeAt(T0 + 3_600_000 + 2 * 3_600_000L));
        assertFalse(v.activeAt(T0 + 3_600_000 + VehicleTimeline.STALE_MS + 1));
        // a repeated ENTER while inside is ignored; EXIT closes
        v.enter(T0 + 4_000_000);
        v.exit(T0 + 5_000_000);
        assertEquals(2, v.size());
        VehicleTimeline restored = VehicleTimeline.parse(v.serialize());
        assertEquals(v.serialize(), restored.serialize());
        assertTrue(restored.activeAt(T0 + 4_500_000));
        assertFalse(restored.activeAt(T0 + 5_000_001));
        assertEquals(0, VehicleTimeline.parse("garbage;1,x").size());
    }
}
