package com.step2win.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.SystemClock;
import android.provider.Settings;

import org.json.JSONArray;
import org.json.JSONObject;

import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
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
 * Handles:
 * - reboots: counter restarts at 0 (detected via Settings.Global.BOOT_COUNT, a smaller raw
 *   value, or elapsedRealtime going backwards); steps since boot are then counted from 0.
 * - day boundaries in the phone's time zone: an interval spanning midnight is split by time.
 * - wall-clock changes: interval lengths use the monotonic elapsedRealtime clock; the wall
 *   clock is only used to label the local hour/day of "now".
 * - time-zone changes: buckets use the zone in effect when the reading is recorded.
 * - sanity: a reading can add at most 4 steps per elapsed second (same client-side clamp the
 *   plugin always applied), so a sensor glitch can't inject a huge jump.
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
    static final int KEEP_DAYS = 8;
    private static final long MIN_STEP_INTERVAL_MS = 250L; // at most 4 steps per second
    private static final int MAX_DELTA_PER_READING = 100_000;

    private StepLedger() {}

    public static final class Day {
        public final String date;
        public final int total;
        public final int[] hours;
        public final long updatedAt;

        Day(String date, int total, int[] hours, long updatedAt) {
            this.date = date;
            this.total = total;
            this.hours = hours;
            this.updatedAt = updatedAt;
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
        int boots = bootCount(context);
        long raw = (long) Math.floor(rawValue);

        if (!prefs.contains(KEY_LAST_RAW)) {
            seedFromLegacyBaseline(context, prefs, raw, nowWall);
            prefs.edit()
                .putLong(KEY_LAST_RAW, raw)
                .putLong(KEY_LAST_ELAPSED, nowElapsed)
                .putLong(KEY_LAST_WALL, nowWall)
                .putInt(KEY_BOOT_COUNT, boots)
                .commit();
            return 0;
        }

        long lastRaw = prefs.getLong(KEY_LAST_RAW, raw);
        long lastElapsed = prefs.getLong(KEY_LAST_ELAPSED, nowElapsed);
        int lastBoots = prefs.getInt(KEY_BOOT_COUNT, boots);

        boolean rebooted = (boots >= 0 && lastBoots >= 0 && boots != lastBoots)
            || nowElapsed < lastElapsed
            || raw < lastRaw;

        long delta;
        long intervalMs;
        if (rebooted) {
            // The counter restarted at boot: everything on it now happened since boot.
            delta = raw;
            intervalMs = nowElapsed;
        } else {
            delta = raw - lastRaw;
            intervalMs = nowElapsed - lastElapsed;
        }
        intervalMs = Math.max(1L, intervalMs);

        int accepted = (int) Math.max(0L, Math.min(Math.min(delta, MAX_DELTA_PER_READING),
            (long) Math.ceil(intervalMs / (double) MIN_STEP_INTERVAL_MS)));

        SharedPreferences.Editor editor = prefs.edit()
            .putLong(KEY_LAST_RAW, raw)
            .putLong(KEY_LAST_ELAPSED, nowElapsed)
            .putLong(KEY_LAST_WALL, nowWall)
            .putInt(KEY_BOOT_COUNT, boots);

        if (accepted > 0) {
            JSONObject days = readDays(prefs);
            distribute(days, accepted, nowWall - intervalMs, nowWall);
            pruneDays(days);
            editor.putString(KEY_DAYS, days.toString()).putLong(KEY_LAST_STEP_WALL, nowWall);
        }
        editor.commit();
        return accepted;
    }

    /**
     * First run after upgrading from the old baseline-per-day plugin: carry today's steps
     * over (raw minus this morning's baseline) so today's total doesn't restart at zero
     * (which the server would reject as a decreasing total).
     */
    private static void seedFromLegacyBaseline(Context context, SharedPreferences prefs, long raw, long nowWall) {
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
            JSONObject days = readDays(prefs);
            // When they were taken is unknown: attribute them to the current hour.
            distribute(days, steps, nowWall, nowWall);
            prefs.edit().putString(KEY_DAYS, days.toString()).commit();
        } catch (Exception ignored) {
            // Best effort only.
        }
    }

    /** Spreads `steps` over [startWall, endWall] into local (day, hour) buckets by time. */
    private static void distribute(JSONObject days, int steps, long startWall, long endWall) {
        ZoneId zone = ZoneId.systemDefault();
        if (endWall <= startWall) {
            ZonedDateTime at = Instant.ofEpochMilli(endWall).atZone(zone);
            addSteps(days, at.toLocalDate().toString(), at.getHour(), steps);
            return;
        }
        long total = endWall - startWall;
        List<long[]> segments = new ArrayList<>(); // [segmentStartMs, segmentEndMs]
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
        if (cursorMs < endWall) {
            // Absurdly long gap (>40 days): put the remainder on the last segment.
            segments.add(new long[] {cursorMs, endWall});
        }
        int assigned = 0;
        for (int i = 0; i < segments.size(); i++) {
            long[] seg = segments.get(i);
            int share = (i == segments.size() - 1)
                ? steps - assigned
                : (int) Math.floor(steps * ((seg[1] - seg[0]) / (double) total));
            if (share <= 0) {
                continue;
            }
            assigned += share;
            ZonedDateTime at = Instant.ofEpochMilli(seg[0]).atZone(zone);
            addSteps(days, at.toLocalDate().toString(), at.getHour(), share);
        }
    }

    private static void addSteps(JSONObject days, String date, int hour, int steps) {
        try {
            JSONObject day = days.optJSONObject(date);
            if (day == null) {
                day = new JSONObject();
                day.put("t", 0);
                day.put("h", new JSONArray(new int[24]));
            }
            JSONArray hours = day.optJSONArray("h");
            if (hours == null || hours.length() != 24) {
                hours = new JSONArray(new int[24]);
            }
            hours.put(hour, hours.optInt(hour, 0) + steps);
            day.put("h", hours);
            day.put("t", day.optInt("t", 0) + steps);
            day.put("u", System.currentTimeMillis());
            days.put(date, day);
        } catch (Exception ignored) {
            // Malformed entry: skip.
        }
    }

    private static void pruneDays(JSONObject days) {
        LocalDate oldest = LocalDate.now(ZoneId.systemDefault()).minusDays(KEEP_DAYS);
        List<String> drop = new ArrayList<>();
        Iterator<String> keys = days.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            try {
                if (LocalDate.parse(key).isBefore(oldest)) {
                    drop.add(key);
                }
            } catch (Exception ignored) {
                drop.add(key);
            }
        }
        for (String key : drop) {
            days.remove(key);
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
            return new Day(date, 0, hours, 0L);
        }
        JSONArray h = day.optJSONArray("h");
        if (h != null) {
            for (int i = 0; i < 24 && i < h.length(); i++) {
                hours[i] = h.optInt(i, 0);
            }
        }
        return new Day(date, day.optInt("t", 0), hours, day.optLong("u", 0L));
    }

    /** Days in the ledger, oldest first. */
    public static synchronized List<Day> getDays(Context context) {
        JSONObject days = readDays(prefs(context));
        List<String> keys = new ArrayList<>();
        Iterator<String> it = days.keys();
        while (it.hasNext()) {
            keys.add(it.next());
        }
        java.util.Collections.sort(keys);
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

    /** Debug builds only: add synthetic steps (emulators have no step counter). */
    static synchronized void addDebugSteps(Context context, int steps) {
        SharedPreferences prefs = prefs(context);
        JSONObject days = readDays(prefs);
        long now = System.currentTimeMillis();
        distribute(days, Math.max(0, steps), now, now);
        prefs.edit().putString(KEY_DAYS, days.toString()).putLong(KEY_LAST_STEP_WALL, now).commit();
    }
}
