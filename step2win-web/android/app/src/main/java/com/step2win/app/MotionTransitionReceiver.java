package com.step2win.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.SystemClock;
import android.util.Log;

import com.google.android.gms.location.ActivityTransition;
import com.google.android.gms.location.ActivityTransitionEvent;
import com.google.android.gms.location.ActivityTransitionResult;

/**
 * Activity Recognition transitions.
 *
 * Walking / running / on foot:
 * - started -> start the walking service (only with an active challenge today);
 * - stopped -> the service winds down by itself after a few idle minutes; queue an upload.
 * In a vehicle / on a bicycle (ENTER / EXIT): recorded in {@link VehicleState} with the event's
 * own time, so steps counted meanwhile go to the "vehicle" evidence bucket. A vehicle ENTER is
 * not "movement started" (no walking service for a car ride).
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
        long nowWall = System.currentTimeMillis();
        long nowElapsedNs = SystemClock.elapsedRealtimeNanos();
        for (ActivityTransitionEvent event : result.getTransitionEvents()) {
            boolean enter = event.getTransitionType() == ActivityTransition.ACTIVITY_TRANSITION_ENTER;
            if (MotionTriggers.isVehicleType(event.getActivityType())) {
                long ageMs = Math.max(0L, (nowElapsedNs - event.getElapsedRealTimeNanos()) / 1_000_000L);
                long at = nowWall - Math.min(ageMs, 6 * 60 * 60_000L);
                if (enter) VehicleState.onEnter(context, at);
                else VehicleState.onExit(context, at);
                Log.i(TAG, "vehicle " + (enter ? "enter" : "exit") + " type=" + event.getActivityType());
                continue;
            }
            if (enter) started = true;
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
