package com.step2win.app;

import android.content.Context;
import android.content.SharedPreferences;

/**
 * Persisted {@link VehicleTimeline} (Activity Recognition IN_VEHICLE / ON_BICYCLE transitions),
 * so a reading taken hours later (WorkManager) still knows which of its steps were in a vehicle.
 */
public final class VehicleState {
    private static final String PREFS = "step2win_motion_state";
    private static final String KEY_TIMELINE = "vehicle_timeline";
    private static VehicleTimeline cached;

    private VehicleState() {}

    static synchronized VehicleTimeline timeline(Context context) {
        if (cached == null) {
            cached = VehicleTimeline.parse(prefs(context).getString(KEY_TIMELINE, ""));
        }
        return cached;
    }

    static synchronized void onEnter(Context context, long wallMs) {
        VehicleTimeline t = timeline(context);
        t.enter(wallMs);
        t.prune(System.currentTimeMillis());
        save(context, t);
    }

    static synchronized void onExit(Context context, long wallMs) {
        VehicleTimeline t = timeline(context);
        t.exit(wallMs);
        save(context, t);
    }

    static boolean activeNow(Context context) {
        return timeline(context).activeAt(System.currentTimeMillis());
    }

    private static void save(Context context, VehicleTimeline t) {
        prefs(context).edit().putString(KEY_TIMELINE, t.serialize()).apply();
    }

    private static SharedPreferences prefs(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
