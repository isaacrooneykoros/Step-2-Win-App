package com.step2win.app;

import android.content.Context;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

/**
 * Background step capture + upload (app in the background, or killed). Reads the
 * hardware counter into the ledger, then uploads only if the adaptive policy says the
 * data is worth a network round-trip. Always returns success: retries and backoff are
 * handled by the engine (Retry-After / exponential), so WorkManager keeps its calm cadence.
 */
public class StepSyncWorker extends Worker {
    private static final String TAG = "Step2WinSync";

    public StepSyncWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        Context context = getApplicationContext();
        String reason = getInputData().getString("reason");
        if (reason == null) reason = "periodic";
        float raw = StepCounterReader.readAndRecord(context, 4_000L);

        String status = "skipped";
        if (SyncPolicy.appInForeground) {
            status = "app_in_foreground"; // the open app drives syncs itself
        } else if (SyncPolicy.shouldUploadInBackground(context) || "deadline".equals(reason) || "walk_ended".equals(reason) || "debug".equals(reason)) {
            StepSyncEngine.Options options = new StepSyncEngine.Options();
            options.foreground = false;
            options.reason = "worker:" + reason;
            status = StepSyncEngine.run(context, options).status;
        }

        // Phase 1c: Health Connect (opt-in) in the background only where Health Connect
        // allows background reads (else the app reads it on open / resume), after our own
        // steps went up; what it reads uploads with the next sync. Never affects capture.
        if (!SyncPolicy.appInForeground) {
            try {
                HealthSources.refresh(context, true, false);
            } catch (Throwable t) {
                Log.w(TAG, "health connect background read skipped", t);
            }
        }
        Log.i(TAG, "worker " + reason + " raw=" + raw + " today=" + StepLedger.todayTotal(context) + " -> " + status);
        StepSyncScheduler.afterRun(context, reason);
        return Result.success();
    }
}
