package com.step2win.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

import androidx.work.Data;
import androidx.work.OneTimeWorkRequest;
import androidx.work.WorkManager;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * DEBUG BUILDS ONLY (src/debug): emulator test hooks for the smart step sync, because an
 * emulator has no step counter and never reports walking transitions.
 *
 *   adb shell am broadcast -n com.step2win.app/.DebugSyncReceiver -a com.step2win.app.DEBUG_STEPS --ei steps 120
 *   adb shell am broadcast -n com.step2win.app/.DebugSyncReceiver -a com.step2win.app.DEBUG_MOTION --es state walking|still
 *   adb shell am broadcast -n com.step2win.app/.DebugSyncReceiver -a com.step2win.app.DEBUG_SYNC
 *   adb shell am broadcast -n com.step2win.app/.DebugSyncReceiver -a com.step2win.app.DEBUG_CHALLENGE --es start 2026-09-20 --es end 2026-09-30
 *   adb shell am broadcast -n com.step2win.app/.DebugSyncReceiver -a com.step2win.app.DEBUG_STATUS
 */
public class DebugSyncReceiver extends BroadcastReceiver {
    private static final String TAG = "Step2WinDebug";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || intent.getAction() == null) return;
        String action = intent.getAction();
        switch (action) {
            case "com.step2win.app.DEBUG_STEPS": {
                int steps = intent.getIntExtra("steps", 0);
                StepLedger.addDebugSteps(context, steps);
                StepCaptureForegroundService.noteDebugSteps(steps);
                Log.i(TAG, "added " + steps + " steps; today=" + StepLedger.todayTotal(context));
                break;
            }
            case "com.step2win.app.DEBUG_MOTION": {
                String state = intent.getStringExtra("state");
                if ("walking".equals(state)) MotionTransitionReceiver.onMovementStarted(context);
                else MotionTransitionReceiver.onMovementStopped(context);
                break;
            }
            case "com.step2win.app.DEBUG_SYNC": {
                OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(StepSyncWorker.class)
                    .setInputData(new Data.Builder().putString("reason", "debug").build())
                    .build();
                WorkManager.getInstance(context).enqueue(request);
                Log.i(TAG, "debug sync enqueued");
                break;
            }
            case "com.step2win.app.DEBUG_CHALLENGE": {
                try {
                    JSONArray windows = new JSONArray();
                    String start = intent.getStringExtra("start");
                    String end = intent.getStringExtra("end");
                    if (start != null && end != null) {
                        JSONObject w = new JSONObject();
                        w.put("start", start);
                        w.put("end", end);
                        windows.put(w);
                    }
                    SyncPolicy.prefs(context).edit().putString(SyncPolicy.KEY_CHALLENGES, windows.toString()).commit();
                    StepSyncScheduler.ensurePeriodic(context);
                    MotionTriggers.refresh(context);
                    Log.i(TAG, "challenge windows=" + windows + " activeToday=" + SyncPolicy.challengeActiveToday(context)
                        + " nearDeadline=" + SyncPolicy.nearDeadline(context)
                        + " interval=" + StepSyncScheduler.currentIntervalMinutes(context));
                } catch (Exception error) {
                    Log.w(TAG, "bad challenge extras", error);
                }
                break;
            }
            case "com.step2win.app.DEBUG_STATUS":
                Log.i(TAG, "status " + StepSyncEngine.status(context));
                break;
            default:
                break;
        }
    }
}
