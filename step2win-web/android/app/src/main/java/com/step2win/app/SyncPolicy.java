package com.step2win.app;

import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.BatteryManager;
import android.os.PowerManager;

import org.json.JSONArray;
import org.json.JSONObject;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.temporal.ChronoUnit;

/**
 * Sync configuration pushed from the web layer (API URL, stride/weight, data saver, the
 * user's active challenge dates) plus the adaptive-cadence rules shared by every trigger.
 *
 * Cadence tiers (why these numbers: see the report / StepSyncScheduler):
 * - near a challenge deadline (last 2 h of an active challenge's end date): any new step
 * - the previous day still has unsent steps (day rollover): upload
 * - normal: >= 50 unsent steps, or anything unsent for >= 45 min
 * - saver (Data Saver, Android Battery Saver, or battery <= 15% and not charging):
 *   >= 500 unsent steps, or anything unsent for >= 2 h; optional route points are skipped
 */
public final class SyncPolicy {
    static final String PREFS = "step2win_sync";
    static final String KEY_API_BASE = "api_base";
    static final String KEY_STRIDE_CM = "stride_cm";
    static final String KEY_WEIGHT_KG = "weight_kg";
    static final String KEY_DATA_SAVER = "data_saver";
    static final String KEY_CHALLENGES = "challenge_windows";
    static final String KEY_CAPTURE_ENABLED = "capture_enabled";

    static final long DEADLINE_WINDOW_MS = 2 * 60 * 60 * 1000L;
    static final int NORMAL_MIN_STEPS = 50;
    static final long NORMAL_MAX_AGE_MS = 45 * 60 * 1000L;
    static final int SAVER_MIN_STEPS = 500;
    static final long SAVER_MAX_AGE_MS = 2 * 60 * 60 * 1000L;

    /** True while the app's UI is in the foreground (the web layer drives syncs then). */
    static volatile boolean appInForeground = false;

    private SyncPolicy() {}

    static SharedPreferences prefs(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static String apiBase(Context context) {
        String base = prefs(context).getString(KEY_API_BASE, "");
        return base == null ? "" : base.replaceAll("/+$", "");
    }

    static boolean dataSaver(Context context) {
        return prefs(context).getBoolean(KEY_DATA_SAVER, false);
    }

    static boolean captureEnabled(Context context) {
        return prefs(context).getBoolean(KEY_CAPTURE_ENABLED, true);
    }

    /** Data Saver, system Battery Saver, or a low battery that isn't charging. */
    static boolean saverMode(Context context) {
        if (dataSaver(context)) {
            return true;
        }
        PowerManager pm = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
        if (pm != null && pm.isPowerSaveMode()) {
            return true;
        }
        return batteryLow(context);
    }

    static boolean batteryLow(Context context) {
        try {
            Intent battery = context.registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
            if (battery == null) {
                return false;
            }
            int level = battery.getIntExtra(BatteryManager.EXTRA_LEVEL, -1);
            int scale = battery.getIntExtra(BatteryManager.EXTRA_SCALE, -1);
            int status = battery.getIntExtra(BatteryManager.EXTRA_STATUS, -1);
            boolean charging = status == BatteryManager.BATTERY_STATUS_CHARGING || status == BatteryManager.BATTERY_STATUS_FULL;
            if (level < 0 || scale <= 0) {
                return false;
            }
            return !charging && (level * 100 / scale) <= 15;
        } catch (Exception ignored) {
            return false;
        }
    }

    static boolean online(Context context) {
        ConnectivityManager cm = (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm == null) {
            return false;
        }
        Network network = cm.getActiveNetwork();
        if (network == null) {
            return false;
        }
        NetworkCapabilities caps = cm.getNetworkCapabilities(network);
        return caps != null && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
    }

    private static JSONArray challengeWindows(Context context) {
        try {
            return new JSONArray(prefs(context).getString(KEY_CHALLENGES, "[]"));
        } catch (Exception ignored) {
            return new JSONArray();
        }
    }

    /** The user is in an active challenge that includes today (phone's local date). */
    static boolean challengeActiveToday(Context context) {
        LocalDate today = LocalDate.now(ZoneId.systemDefault());
        JSONArray windows = challengeWindows(context);
        for (int i = 0; i < windows.length(); i++) {
            JSONObject w = windows.optJSONObject(i);
            if (w == null) continue;
            try {
                LocalDate start = LocalDate.parse(w.optString("start"));
                LocalDate end = LocalDate.parse(w.optString("end"));
                if (!today.isBefore(start) && !today.isAfter(end)) {
                    return true;
                }
            } catch (Exception ignored) {
                // malformed window
            }
        }
        return false;
    }

    /**
     * Milliseconds until the nearest active challenge ends (end of its end date, local
     * time), or -1 if none ends within the deadline window.
     */
    static long msUntilDeadline(Context context) {
        LocalDateTime now = LocalDateTime.now(ZoneId.systemDefault());
        LocalDate today = now.toLocalDate();
        long best = -1;
        JSONArray windows = challengeWindows(context);
        for (int i = 0; i < windows.length(); i++) {
            JSONObject w = windows.optJSONObject(i);
            if (w == null) continue;
            try {
                LocalDate end = LocalDate.parse(w.optString("end"));
                if (!end.equals(today)) continue;
                long ms = ChronoUnit.MILLIS.between(now, end.plusDays(1).atStartOfDay());
                if (ms >= 0 && ms <= DEADLINE_WINDOW_MS && (best < 0 || ms < best)) {
                    best = ms;
                }
            } catch (Exception ignored) {
                // malformed window
            }
        }
        return best;
    }

    static boolean nearDeadline(Context context) {
        return msUntilDeadline(context) >= 0;
    }

    /**
     * Background upload decision (WorkManager / walking service). Cheap: local state only.
     */
    static boolean shouldUploadInBackground(Context context) {
        String today = StepLedger.today();
        String userKey = StepSyncEngine.currentUserKey(context);
        if (userKey == null) {
            return false;
        }
        long now = System.currentTimeMillis();
        boolean saver = saverMode(context);
        int unsentToday = 0;
        for (StepLedger.Day day : StepLedger.getDays(context)) {
            int unsent = day.total - StepSyncEngine.ackedSteps(context, userKey, day.date);
            if (unsent <= 0) continue;
            if (day.date.compareTo(today) < 0) {
                return true; // yesterday (or older) still has unsent steps: final counts first
            }
            if (day.date.equals(today)) {
                unsentToday = unsent;
            }
        }
        if (unsentToday <= 0) {
            return false;
        }
        if (nearDeadline(context)) {
            return true;
        }
        long since = now - StepSyncEngine.lastSuccessAt(context);
        if (saver) {
            return unsentToday >= SAVER_MIN_STEPS || since >= SAVER_MAX_AGE_MS;
        }
        return unsentToday >= NORMAL_MIN_STEPS || since >= NORMAL_MAX_AGE_MS;
    }
}
