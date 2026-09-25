package com.step2win.app;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.util.Log;

import com.google.android.gms.location.ActivityRecognition;
import com.google.android.gms.location.ActivityTransition;
import com.google.android.gms.location.ActivityTransitionRequest;
import com.google.android.gms.location.DetectedActivity;

import java.util.ArrayList;
import java.util.List;

/**
 * Walking start/stop events from Google Play services' Activity Recognition *transition*
 * API. It runs on the phone's low-power sensor hub (the same kind of always-on, batched
 * detection as the step counter) and wakes the app only when the user starts or stops
 * walking. A transition broadcast is also one of the few moments Android 12+ lets an app
 * start a foreground service from the background, which is exactly when the walking
 * service is useful.
 *
 * Registered only while the user has an active challenge today; unregistered otherwise.
 */
public final class MotionTriggers {
    private static final String TAG = "Step2WinMotion";
    static final String ACTION_TRANSITION = "com.step2win.app.ACTIVITY_TRANSITION";
    private static final String KEY_REGISTERED = "motion_triggers_registered";

    private MotionTriggers() {}

    static PendingIntent pendingIntent(Context context) {
        Intent intent = new Intent(context, MotionTransitionReceiver.class).setAction(ACTION_TRANSITION);
        // FLAG_MUTABLE: Play services fills in the transition result.
        return PendingIntent.getBroadcast(context, 7021, intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_MUTABLE);
    }

    /** Registers or unregisters according to the current challenge state and permission. */
    public static void refresh(Context context) {
        Context app = context.getApplicationContext();
        boolean wanted = SyncPolicy.captureEnabled(app)
            && SyncPolicy.challengeActiveToday(app)
            && StepCaptureForegroundService.hasActivityRecognitionPermission(app);
        SharedPreferences prefs = SyncPolicy.prefs(app);
        boolean registered = prefs.getBoolean(KEY_REGISTERED, false);
        if (wanted) {
            register(app); // cheap and idempotent; also re-arms after reboot / app update
        } else if (registered) {
            unregister(app);
        }
    }

    static boolean isRegistered(Context context) {
        return SyncPolicy.prefs(context).getBoolean(KEY_REGISTERED, false);
    }

    private static void register(Context context) {
        List<ActivityTransition> transitions = new ArrayList<>();
        int[] types = {DetectedActivity.WALKING, DetectedActivity.RUNNING, DetectedActivity.ON_FOOT};
        for (int type : types) {
            transitions.add(new ActivityTransition.Builder()
                .setActivityType(type)
                .setActivityTransition(ActivityTransition.ACTIVITY_TRANSITION_ENTER)
                .build());
            transitions.add(new ActivityTransition.Builder()
                .setActivityType(type)
                .setActivityTransition(ActivityTransition.ACTIVITY_TRANSITION_EXIT)
                .build());
        }
        try {
            ActivityRecognition.getClient(context)
                .requestActivityTransitionUpdates(new ActivityTransitionRequest(transitions), pendingIntent(context))
                .addOnSuccessListener(unused -> SyncPolicy.prefs(context).edit().putBoolean(KEY_REGISTERED, true).apply())
                .addOnFailureListener(error -> {
                    Log.i(TAG, "transition updates unavailable: " + error.getMessage());
                    SyncPolicy.prefs(context).edit().putBoolean(KEY_REGISTERED, false).apply();
                });
        } catch (SecurityException | IllegalStateException error) {
            // No permission / no Play services (e.g. some Huawei phones): WorkManager still
            // syncs; only the background gait service is unavailable.
            Log.i(TAG, "transition updates not registered: " + error.getMessage());
        }
    }

    private static void unregister(Context context) {
        try {
            ActivityRecognition.getClient(context).removeActivityTransitionUpdates(pendingIntent(context));
        } catch (SecurityException | IllegalStateException ignored) {
            // nothing registered
        }
        SyncPolicy.prefs(context).edit().putBoolean(KEY_REGISTERED, false).apply();
    }
}
