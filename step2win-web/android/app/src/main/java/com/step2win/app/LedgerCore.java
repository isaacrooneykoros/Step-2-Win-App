package com.step2win.app;

import org.json.JSONArray;
import org.json.JSONObject;

import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;

/**
 * Pure step-ledger logic (no Android APIs; org.json only) behind {@link StepLedger}, so reboots,
 * local-day boundaries, per-hour evidence buckets and reinstall resume are JVM-testable.
 *
 * Day JSON (inside the "days" object, keyed by local date):
 *   t  = ledger steps of the day, h = 24 hourly buckets, u = last update (wall ms),
 *   e  = 24 x [verified, shake, unknown, vehicle, walk, activeMinutesObserved, gaitMinutes,
 *        notAnalysedSteps]  (walking evidence; missing on days recorded by older versions:
 *        then every step of the hour is "unknown"),
 *   rb / r0 = reinstall resume: server's last raw total for the day and the ledger total at the
 *        moment of the resume. Reported total = max(t, rb + (t - r0)); see {@link #reportedTotal}.
 */
public final class LedgerCore {
    static final int KEEP_DAYS = 8;
    static final long MIN_STEP_INTERVAL_MS = 250L; // at most 4 steps per second
    static final int MAX_DELTA_PER_READING = 100_000;
    static final int E_FIELDS = 8;
    static final int E_ACTIVE = 5;
    static final int E_GAIT = 6;
    static final int E_NOT_ANALYSED = 7;
    /** Steps per minute assumed when estimating active minutes of steps nobody observed. */
    static final double UNOBSERVED_STEPS_PER_MINUTE = 110.0;

    private LedgerCore() {}

    /** Splits steps of a span into evidence buckets (see EvidenceTracker#attribute). */
    public interface Attributor {
        int[] attribute(int steps, long startMs, long endMs);
    }

    /** Everything unknown (nothing observed): used for legacy seeds and debug steps. */
    public static final Attributor ALL_UNKNOWN = (steps, s, e) -> new int[] {0, 0, steps, 0, 0, steps};

    public static Attributor walkBucket() {
        return (steps, s, e) -> new int[] {0, 0, 0, 0, steps, 0};
    }

    /** Mutable counter state (persisted by the Android wrapper). lastRaw < 0 = no baseline yet. */
    public static final class State {
        public long lastRaw = -1L;
        public long lastElapsed = 0L;
        public long lastWall = 0L;
        public int bootCount = -1;
        public long lastStepWall = 0L;
        public JSONObject days = new JSONObject();
    }

    /**
     * Records a raw counter value. Returns the number of new steps added (0 for the very first
     * reading, which only sets the baseline).
     *
     * Reboot: detected by a different BOOT_COUNT, elapsedRealtime going backwards or a smaller
     * raw value; the counter restarted at 0, so everything on it happened since boot.
     * Day boundaries: the span is split per local hour (and so per local day) by time.
     */
    public static int record(State st, float rawValue, long nowElapsed, long nowWall, int boots, ZoneId zone, Attributor attributor) {
        if (rawValue < 0f || Float.isNaN(rawValue)) return 0;
        long raw = (long) Math.floor(rawValue);
        if (st.lastRaw < 0) {
            st.lastRaw = raw;
            st.lastElapsed = nowElapsed;
            st.lastWall = nowWall;
            st.bootCount = boots;
            return 0;
        }
        boolean rebooted = (boots >= 0 && st.bootCount >= 0 && boots != st.bootCount)
            || nowElapsed < st.lastElapsed
            || raw < st.lastRaw;
        long delta;
        long intervalMs;
        if (rebooted) {
            delta = raw;
            intervalMs = nowElapsed;
        } else {
            delta = raw - st.lastRaw;
            intervalMs = nowElapsed - st.lastElapsed;
        }
        intervalMs = Math.max(1L, intervalMs);
        int accepted = (int) Math.max(0L, Math.min(Math.min(delta, MAX_DELTA_PER_READING),
            (long) Math.ceil(intervalMs / (double) MIN_STEP_INTERVAL_MS)));
        st.lastRaw = raw;
        st.lastElapsed = nowElapsed;
        st.lastWall = nowWall;
        st.bootCount = boots;
        if (accepted > 0) {
            distribute(st.days, accepted, nowWall - intervalMs, nowWall, zone, attributor, nowWall);
            prune(st.days, nowWall, zone);
            st.lastStepWall = nowWall;
        }
        return accepted;
    }

    /** Adds steps that don't come from the counter (accelerometer walk steps, debug). */
    public static void addSteps(State st, int steps, long startWall, long endWall, ZoneId zone, Attributor attributor) {
        if (steps <= 0) return;
        distribute(st.days, steps, startWall, endWall, zone, attributor, endWall);
        prune(st.days, endWall, zone);
        st.lastStepWall = Math.max(st.lastStepWall, endWall);
    }

    /** Spreads `steps` over [startWall, endWall] into local (day, hour) buckets by time. */
    static void distribute(JSONObject days, int steps, long startWall, long endWall, ZoneId zone, Attributor attributor, long nowWall) {
        if (attributor == null) attributor = ALL_UNKNOWN;
        if (endWall <= startWall) {
            ZonedDateTime at = Instant.ofEpochMilli(endWall).atZone(zone);
            add(days, at.toLocalDate().toString(), at.getHour(), attributor.attribute(steps, endWall, endWall + 1), nowWall);
            return;
        }
        long total = endWall - startWall;
        List<long[]> segments = new ArrayList<>();
        ZonedDateTime cursor = Instant.ofEpochMilli(startWall).atZone(zone);
        long cursorMs = startWall;
        int guard = 0;
        while (cursorMs < endWall && guard++ < 24 * 40) {
            ZonedDateTime nextHour = cursor.truncatedTo(ChronoUnit.HOURS).plusHours(1);
            long segEnd = Math.min(endWall, nextHour.toInstant().toEpochMilli());
            segments.add(new long[] {cursorMs, segEnd});
            cursorMs = segEnd;
            cursor = Instant.ofEpochMilli(cursorMs).atZone(zone);
        }
        if (cursorMs < endWall) segments.add(new long[] {cursorMs, endWall});
        int assigned = 0;
        for (int i = 0; i < segments.size(); i++) {
            long[] seg = segments.get(i);
            int share = (i == segments.size() - 1)
                ? steps - assigned
                : (int) Math.floor(steps * ((seg[1] - seg[0]) / (double) total));
            if (share <= 0) continue;
            assigned += share;
            ZonedDateTime at = Instant.ofEpochMilli(seg[0]).atZone(zone);
            add(days, at.toLocalDate().toString(), at.getHour(), attributor.attribute(share, seg[0], seg[1]), nowWall);
        }
    }

    private static JSONObject day(JSONObject days, String date) throws Exception {
        JSONObject day = days.optJSONObject(date);
        if (day == null) {
            day = new JSONObject();
            day.put("t", 0);
            day.put("h", zeros(24));
            days.put(date, day);
        }
        JSONArray hours = day.optJSONArray("h");
        if (hours == null || hours.length() != 24) day.put("h", zeros(24));
        return day;
    }

    /** Evidence array of a day, created (every existing step "unknown") when missing. */
    private static JSONArray evidence(JSONObject day) throws Exception {
        JSONArray e = day.optJSONArray("e");
        JSONArray hours = day.getJSONArray("h");
        if (e == null || e.length() != 24) {
            e = new JSONArray();
            for (int h = 0; h < 24; h++) {
                JSONArray row = zeros(E_FIELDS);
                int steps = hours.optInt(h, 0);
                row.put(EvidenceTracker.UNKNOWN, steps);
                row.put(E_NOT_ANALYSED, steps);
                e.put(row);
            }
            day.put("e", e);
        }
        return e;
    }

    private static void add(JSONObject days, String date, int hour, int[] buckets, long nowWall) {
        try {
            int steps = 0;
            for (int i = 0; i < 5; i++) steps += Math.max(0, buckets[i]);
            if (steps <= 0) return;
            JSONObject day = day(days, date);
            JSONArray e = evidence(day); // before the hour total changes (migration uses old totals)
            JSONArray hours = day.getJSONArray("h");
            hours.put(hour, hours.optInt(hour, 0) + steps);
            day.put("t", day.optInt("t", 0) + steps);
            day.put("u", nowWall);
            JSONArray row = e.optJSONArray(hour);
            if (row == null || row.length() != E_FIELDS) {
                row = zeros(E_FIELDS);
                e.put(hour, row);
            }
            for (int i = 0; i < 5; i++) row.put(i, row.optInt(i, 0) + Math.max(0, buckets[i]));
            int notAnalysed = buckets.length > EvidenceTracker.NOT_ANALYSED ? Math.max(0, buckets[EvidenceTracker.NOT_ANALYSED]) : 0;
            row.put(E_NOT_ANALYSED, row.optInt(E_NOT_ANALYSED, 0) + notAnalysed);
        } catch (Exception ignored) {
            // malformed entry: skip
        }
    }

    /** Adds closed-minute facts (observed active minute, analysed minute) to the day's hour. */
    public static void applyMinute(JSONObject days, long minuteStartMs, boolean active, boolean analysed, ZoneId zone) {
        if (!active && !analysed) return;
        try {
            ZonedDateTime at = Instant.ofEpochMilli(minuteStartMs).atZone(zone);
            String date = at.toLocalDate().toString();
            if (!days.has(date)) return; // no steps that day: nothing to describe
            JSONObject day = day(days, date);
            JSONArray row = evidence(day).getJSONArray(at.getHour());
            if (active) row.put(E_ACTIVE, Math.min(60, row.optInt(E_ACTIVE, 0) + 1));
            if (analysed) row.put(E_GAIT, Math.min(60, row.optInt(E_GAIT, 0) + 1));
        } catch (Exception ignored) {
            // best effort
        }
    }

    /** One WalkingEvidenceHour. */
    public static final class EvidenceHour {
        public int hour, verified, shake, unknown, vehicle, walk, activeMinutes, gaitMinutes;

        public int total() {
            return verified + shake + unknown + vehicle + walk;
        }
    }

    /**
     * Evidence per hour with steps (<= 24 entries). Buckets always sum to the hour's steps: an
     * inconsistency (should never happen) is repaired toward "unknown", never "verified".
     */
    public static List<EvidenceHour> evidenceHours(JSONObject day) {
        List<EvidenceHour> out = new ArrayList<>();
        if (day == null) return out;
        JSONArray hours = day.optJSONArray("h");
        if (hours == null) return out;
        JSONArray e = day.optJSONArray("e");
        for (int h = 0; h < 24 && h < hours.length(); h++) {
            int steps = hours.optInt(h, 0);
            if (steps <= 0) continue;
            EvidenceHour eh = new EvidenceHour();
            eh.hour = h;
            JSONArray row = e != null ? e.optJSONArray(h) : null;
            int notAnalysed;
            if (row == null) {
                eh.unknown = steps;
                notAnalysed = steps;
            } else {
                eh.verified = Math.max(0, row.optInt(0, 0));
                eh.shake = Math.max(0, row.optInt(1, 0));
                eh.unknown = Math.max(0, row.optInt(2, 0));
                eh.vehicle = Math.max(0, row.optInt(3, 0));
                eh.walk = Math.max(0, row.optInt(4, 0));
                eh.activeMinutes = Math.max(0, row.optInt(E_ACTIVE, 0));
                eh.gaitMinutes = Math.max(0, row.optInt(E_GAIT, 0));
                notAnalysed = Math.max(0, row.optInt(E_NOT_ANALYSED, 0));
            }
            int diff = steps - eh.total();
            if (diff > 0) {
                eh.unknown += diff;
            } else if (diff < 0) {
                int excess = -diff;
                int[] order = {EvidenceTracker.VERIFIED, EvidenceTracker.WALK, EvidenceTracker.VEHICLE, EvidenceTracker.UNKNOWN, EvidenceTracker.SHAKE};
                for (int b : order) {
                    int take = Math.min(excess, get(eh, b));
                    set(eh, b, get(eh, b) - take);
                    excess -= take;
                }
            }
            int estimated = (int) Math.ceil(Math.min(notAnalysed, steps) / UNOBSERVED_STEPS_PER_MINUTE);
            eh.activeMinutes = Math.max(1, Math.min(60, eh.activeMinutes + estimated));
            eh.gaitMinutes = Math.min(60, eh.gaitMinutes);
            out.add(eh);
        }
        return out;
    }

    private static int get(EvidenceHour e, int b) {
        switch (b) {
            case 0: return e.verified;
            case 1: return e.shake;
            case 2: return e.unknown;
            case 3: return e.vehicle;
            default: return e.walk;
        }
    }

    private static void set(EvidenceHour e, int b, int v) {
        switch (b) {
            case 0: e.verified = v; break;
            case 1: e.shake = v; break;
            case 2: e.unknown = v; break;
            case 3: e.vehicle = v; break;
            default: e.walk = v; break;
        }
    }

    // ── reinstall resume ─────────────────────────────────────────────────────

    /**
     * What the phone reports for a day: the ledger total, or after a reinstall resume the
     * server's last raw total plus the steps counted since the resume, whichever is larger.
     */
    public static int reportedTotal(int ledgerTotal, int resumeBase, int ledgerAtResume) {
        if (resumeBase <= 0) return Math.max(0, ledgerTotal);
        long sinceResume = Math.max(0, ledgerTotal - ledgerAtResume);
        long resumed = (long) resumeBase + sinceResume;
        return (int) Math.min(Integer.MAX_VALUE, Math.max(ledgerTotal, resumed));
    }

    public static int reportedTotal(JSONObject day) {
        if (day == null) return 0;
        return reportedTotal(day.optInt("t", 0), day.optInt("rb", 0), day.optInt("r0", 0));
    }

    /** Applies a resume once per day (idempotent; later calls never lower the base). */
    public static boolean applyResume(JSONObject days, String date, int lastRawSteps, long nowWall) {
        if (lastRawSteps <= 0) return false;
        try {
            JSONObject day = day(days, date);
            if (day.optInt("rb", 0) > 0) return false;
            day.put("rb", lastRawSteps);
            day.put("r0", day.optInt("t", 0));
            day.put("u", nowWall);
            return true;
        } catch (Exception ignored) {
            return false;
        }
    }

    // ── retention ────────────────────────────────────────────────────────────

    static void prune(JSONObject days, long nowWall, ZoneId zone) {
        LocalDate oldest = Instant.ofEpochMilli(nowWall).atZone(zone).toLocalDate().minusDays(KEEP_DAYS);
        List<String> drop = new ArrayList<>();
        Iterator<String> keys = days.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            try {
                if (LocalDate.parse(key).isBefore(oldest)) drop.add(key);
            } catch (Exception ignored) {
                drop.add(key);
            }
        }
        for (String key : drop) days.remove(key);
    }

    static JSONArray zeros(int n) {
        JSONArray a = new JSONArray();
        for (int i = 0; i < n; i++) a.put(0);
        return a;
    }
}
