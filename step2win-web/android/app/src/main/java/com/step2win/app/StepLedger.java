package com.step2win.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.SystemClock;
import android.provider.Settings;

import org.json.JSONArray;
import org.json.JSONObject;

import java.time.LocalDate;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Iterator;
import java.util.List;

/**
 * Durable per-day / per-hour step ledger built from the hardware step counter.
 *
 * TYPE_STEP_COUNTER is a low-power, hardware-batched counter of steps since boot. It keeps
 * counting while the app is closed, so the app only needs to *read* it now and then (app
 * open, WorkManager every 15-60 min, walking service). Each reading adds the steps since
 * the previous reading to the local-time hours that interval covered.
 *
 * The logic lives in {@link LedgerCore} (pure, unit-tested): reboots (BOOT_COUNT, raw value or
 * elapsedRealtime going backwards), local-day boundaries, wall-clock / time-zone changes, the
 * 4 steps/s sanity clamp, per-hour walking evidence buckets ({@link EvidenceTracker}) and the
 * reinstall resume. This class only loads / stores the state in SharedPreferences (one commit
 * per reading, so totals and evidence always change together).
 *
 * Keeps the last {@link #KEEP_DAYS} days (the offline catch-up window).
 */
public final class StepLedger {
    static final String PREFS = "step2win_step_ledger";
    private static final String KEY_LAST_RAW = "last_raw";
    private static final String KEY_LAST_ELAPSED = "last_elapsed";
    private static final String KEY_LAST_WALL = "last_wall";
    private static final String KEY_BOOT_COUNT = "boot_count";
    private static final String KEY_DAYS = "days";
    private static final String KEY_LAST_STEP_WALL = "last_step_wall";
    private static final String KEY_RESUME_CHECKED = "resume_checked_date";
    static final int KEEP_DAYS = LedgerCore.KEEP_DAYS;
    private static final int MAX_DELTA_PER_READING = LedgerCore.MAX_DELTA_PER_READING;

    private StepLedger() {}

    public static final class Day {
        public final String date;
        /** What the phone reports for the day (ledger total, or the resumed total after a reinstall). */
        public final int total;
        /** Steps this install's ledger counted (the sum of the hours). */
        public final int ledgerTotal;
        public final int[] hours;
        public final long updatedAt;
        final JSONObject raw;

        Day(String date, int total, int ledgerTotal, int[] hours, long updatedAt, JSONObject raw) {
            this.date = date;
            this.total = total;
            this.ledgerTotal = ledgerTotal;
            this.hours = hours;
            this.updatedAt = updatedAt;
            this.raw = raw;
        }

        public List<LedgerCore.EvidenceHour> evidenceHours() {
            return LedgerCore.evidenceHours(raw);
        }
    }

    static String today() {
        return LocalDate.now(ZoneId.systemDefault()).format(DateTimeFormatter.ISO_LOCAL_DATE);
    }

    private static SharedPreferences prefs(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static int bootCount(Context context) {
        try {
            return Settings.Global.getInt(context.getContentResolver(), Settings.Global.BOOT_COUNT, -1);
        } catch (Exception ignored) {
            return -1;
        }
    }

    private static LedgerCore.State load(SharedPreferences prefs) {
        LedgerCore.State st = new LedgerCore.State();
        st.lastRaw = prefs.contains(KEY_LAST_RAW) ? prefs.getLong(KEY_LAST_RAW, -1L) : -1L;
        st.lastElapsed = prefs.getLong(KEY_LAST_ELAPSED, 0L);
        st.lastWall = prefs.getLong(KEY_LAST_WALL, 0L);
        st.bootCount = prefs.getInt(KEY_BOOT_COUNT, -1);
        st.lastStepWall = prefs.getLong(KEY_LAST_STEP_WALL, 0L);
        st.days = readDays(prefs);
        return st;
    }

    private static void save(SharedPreferences prefs, LedgerCore.State st) {
        SharedPreferences.Editor editor = prefs.edit()
            .putString(KEY_DAYS, st.days.toString())
            .putLong(KEY_LAST_STEP_WALL, st.lastStepWall);
        if (st.lastRaw >= 0) {
            editor.putLong(KEY_LAST_RAW, st.lastRaw)
                .putLong(KEY_LAST_ELAPSED, st.lastElapsed)
                .putLong(KEY_LAST_WALL, st.lastWall)
                .putInt(KEY_BOOT_COUNT, st.bootCount);
        }
        editor.commit();
    }

    /** Attribution of new steps to evidence buckets (live observations + vehicle timeline). */
    private static LedgerCore.Attributor attributor(Context context) {
        final EvidenceTracker.VehicleCheck vehicle = EvidenceTracker.of(VehicleState.timeline(context));
        return (steps, start, end) -> EvidenceTracker.SHARED.attribute(steps, start, end, vehicle);
    }

    /** Closed minutes -> observed active / analysed minutes of their hour. */
    private static void applyClosedMinutes(LedgerCore.State st, long nowWall) {
        ZoneId zone = ZoneId.systemDefault();
        for (EvidenceTracker.MinuteFacts f : EvidenceTracker.SHARED.drainClosed(nowWall)) {
            LedgerCore.applyMinute(st.days, f.startMs, f.active, f.analysed, zone);
        }
    }

    /**
     * Records a raw counter value. Returns the number of new steps added (0 for the first
     * reading ever, which only sets the baseline).
     */
    public static synchronized int record(Context context, float rawValue) {
        if (rawValue < 0f || Float.isNaN(rawValue)) {
            return 0;
        }
        SharedPreferences prefs = prefs(context);
        long nowElapsed = SystemClock.elapsedRealtime();
        long nowWall = System.currentTimeMillis();
        LedgerCore.State st = load(prefs);
        if (st.lastRaw < 0) {
            seedFromLegacyBaseline(context, st, (long) Math.floor(rawValue), nowWall);
        }
        int accepted = LedgerCore.record(st, rawValue, nowElapsed, nowWall, bootCount(context), ZoneId.systemDefault(), attributor(context));
        applyClosedMinutes(st, nowWall);
        save(prefs, st);
        return accepted;
    }

    /**
     * Steps counted without the hardware counter: accelerometer step detection during a user
     * walk on phones that have no TYPE_STEP_COUNTER. They go to the "walk" bucket.
     */
    public static synchronized void addWalkSteps(Context context, int steps, long startWall, long endWall) {
        if (steps <= 0) return;
        SharedPreferences prefs = prefs(context);
        LedgerCore.State st = load(prefs);
        LedgerCore.addSteps(st, steps, startWall, endWall, ZoneId.systemDefault(), LedgerCore.walkBucket());
        save(prefs, st);
    }

    /**
     * First run after upgrading from the old baseline-per-day plugin: carry today's steps
     * over (raw minus this morning's baseline) so today's total doesn't restart at zero
     * (which the server would reject as a decreasing total). Unobserved: "unknown".
     */
    private static void seedFromLegacyBaseline(Context context, LedgerCore.State st, long raw, long nowWall) {
        try {
            SharedPreferences legacy = context.getApplicationContext()
                .getSharedPreferences(StepCaptureForegroundService.PREFS, Context.MODE_PRIVATE);
            String baselineDate = legacy.getString("baseline_date", "");
            float baseline = legacy.getFloat("baseline_value", -1f);
            if (!today().equals(baselineDate) || baseline < 0f || raw < baseline) {
                return;
            }
            int steps = (int) Math.min(MAX_DELTA_PER_READING, raw - (long) baseline);
            if (steps <= 0) {
                return;
            }
            LedgerCore.addSteps(st, steps, nowWall, nowWall, ZoneId.systemDefault(), LedgerCore.ALL_UNKNOWN);
        } catch (Exception ignored) {
            // Best effort only.
        }
    }

    private static JSONObject readDays(SharedPreferences prefs) {
        try {
            return new JSONObject(prefs.getString(KEY_DAYS, "{}"));
        } catch (Exception ignored) {
            return new JSONObject();
        }
    }

    public static synchronized Day getDay(Context context, String date) {
        JSONObject day = readDays(prefs(context)).optJSONObject(date);
        return toDay(date, day);
    }

    private static Day toDay(String date, JSONObject day) {
        int[] hours = new int[24];
        if (day == null) {
            return new Day(date, 0, 0, hours, 0L, null);
        }
        JSONArray h = day.optJSONArray("h");
        if (h != null) {
            for (int i = 0; i < 24 && i < h.length(); i++) {
                hours[i] = h.optInt(i, 0);
            }
        }
        return new Day(date, LedgerCore.reportedTotal(day), day.optInt("t", 0), hours, day.optLong("u", 0L), day);
    }

    /** Days in the ledger, oldest first. */
    public static synchronized List<Day> getDays(Context context) {
        JSONObject days = readDays(prefs(context));
        List<String> keys = new ArrayList<>();
        Iterator<String> it = days.keys();
        while (it.hasNext()) {
            keys.add(it.next());
        }
        Collections.sort(keys);
        List<Day> out = new ArrayList<>();
        for (String key : keys) {
            out.add(toDay(key, days.optJSONObject(key)));
        }
        return out;
    }

    public static int todayTotal(Context context) {
        return getDay(context, today()).total;
    }

    /** Wall time of the last reading that added steps (0 if none). */
    public static long lastStepAt(Context context) {
        return prefs(context).getLong(KEY_LAST_STEP_WALL, 0L);
    }

    /** Wall time of the last counter reading of any kind (0 if none). */
    public static long lastReadingAt(Context context) {
        return prefs(context).getLong(KEY_LAST_WALL, 0L);
    }

    // ── reinstall resume ─────────────────────────────────────────────────────

    /** True when a resume should be fetched for `date`: no ledger data that day, not checked yet. */
    static synchronized boolean needsResumeCheck(Context context, String date) {
        SharedPreferences prefs = prefs(context);
        if (date.equals(prefs.getString(KEY_RESUME_CHECKED, ""))) return false;
        JSONObject day = readDays(prefs).optJSONObject(date);
        return day == null || (day.optInt("t", 0) <= 0 && day.optInt("rb", 0) <= 0);
    }

    /** Stores the server's last raw total for `date` (once) and marks the date as checked. */
    static synchronized void applyResume(Context context, String date, int lastRawSteps) {
        SharedPreferences prefs = prefs(context);
        LedgerCore.State st = load(prefs);
        LedgerCore.applyResume(st.days, date, lastRawSteps, System.currentTimeMillis());
        save(prefs, st);
        prefs.edit().putString(KEY_RESUME_CHECKED, date).commit();
    }

    /** Debug builds only: add synthetic steps (emulators have no step counter). */
    static synchronized void addDebugSteps(Context context, int steps) {
        SharedPreferences prefs = prefs(context);
        LedgerCore.State st = load(prefs);
        long now = System.currentTimeMillis();
        LedgerCore.addSteps(st, Math.max(0, steps), now, now, ZoneId.systemDefault(), LedgerCore.ALL_UNKNOWN);
        save(prefs, st);
    }
}
