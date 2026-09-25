package com.step2win.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

import com.google.android.gms.location.ActivityTransition;
import com.google.android.gms.location.ActivityTransitionEvent;
import com.google.android.gms.location.ActivityTransitionResult;

/**
 * Walking started -> start the walking service (only with an active challenge today).
 * Walking stopped -> the service winds down by itself after a few idle minutes; queue an
 * upload of the finished walk.
 *
 * (Emulators produce neither transitions nor step-counter events: debug builds add
 * DebugSyncReceiver from src/debug to simulate them over adb.)
 */
public class MotionTransitionReceiver extends BroadcastReceiver {
    private static final String TAG = "Step2WinMotion";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null) return;
        if (!ActivityTransitionResult.hasResult(intent)) return;
        ActivityTransitionResult result = ActivityTransitionResult.extractResult(intent);
        if (result == null) return;
        boolean started = false;
        boolean stopped = false;
        for (ActivityTransitionEvent event : result.getTransitionEvents()) {
            if (event.getTransitionType() == ActivityTransition.ACTIVITY_TRANSITION_ENTER) started = true;
            else stopped = true;
        }
        if (started) onMovementStarted(context);
        else if (stopped) onMovementStopped(context);
    }

    static void onMovementStarted(Context context) {
        Log.i(TAG, "movement started; challengeToday=" + SyncPolicy.challengeActiveToday(context));
        if (!SyncPolicy.captureEnabled(context) || !SyncPolicy.challengeActiveToday(context)) return;
        StepCaptureForegroundService.start(context, "motion");
    }

    static void onMovementStopped(Context context) {
        Log.i(TAG, "movement stopped");
        StepCaptureForegroundService.noteMovementStopped(context);
        StepSyncScheduler.scheduleSoon(context, 60_000L, "walk_ended");
    }
}
