package com.step2win.app;

import android.content.Context;
import android.content.SharedPreferences;

import androidx.work.BackoffPolicy;
import androidx.work.Constraints;
import androidx.work.Data;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;

import java.util.Random;
import java.util.concurrent.TimeUnit;

/**
 * Background cadence (app in the background or killed), via WorkManager so it survives
 * process death and reboots and respects Doze / App Standby:
 *
 * - periodic: every 15 min while the user is in a challenge that includes today, 30 min
 *   otherwise, 60 min with Data Saver. Each run reads the hardware counter (~1 s) and only
 *   uploads when {@link SyncPolicy#shouldUploadInBackground} says so.
 * - requires a network connection; also "battery not low" when no challenge is at stake.
 * - a random initial delay spreads each phone's schedule over the whole interval, so a
 *   fleet of phones never lines up on the clock (top of the hour, midnight).
 * - near a challenge deadline (last 2 h of its end date) an extra one-off run is chained
 *   every ~5-7 min (randomised) so the final counts land in time.
 */
public final class StepSyncScheduler {
    static final String PERIODIC_WORK = "step2win-step-sync";
    static final String SOON_WORK = "step2win-step-sync-soon";
    static final String DEADLINE_WORK = "step2win-step-sync-deadline";
    private static final String KEY_INTERVAL = "periodic_interval_min";
    private static final String KEY_BATTERY_GATE = "periodic_battery_gate";
    private static final Random RANDOM = new Random();

    private StepSyncScheduler() {}

    static long desiredIntervalMinutes(Context context) {
        if (SyncPolicy.challengeActiveToday(context)) return 15;
        return SyncPolicy.dataSaver(context) ? 60 : 30;
    }

    static long currentIntervalMinutes(Context context) {
        return SyncPolicy.prefs(context).getLong(KEY_INTERVAL, 0L);
    }

    /** Idempotent: only (re)enqueues when the wanted interval/constraints changed. */
    public static void ensurePeriodic(Context context) {
        Context app = context.getApplicationContext();
        SharedPreferences prefs = SyncPolicy.prefs(app);
        long interval = desiredIntervalMinutes(app);
        boolean batteryGate = !SyncPolicy.challengeActiveToday(app);
        long current = prefs.getLong(KEY_INTERVAL, 0L);
        boolean currentGate = prefs.getBoolean(KEY_BATTERY_GATE, true);
        boolean firstTime = current == 0L;
        if (!firstTime && current == interval && currentGate == batteryGate) {
            return;
        }
        Constraints constraints = new Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .setRequiresBatteryNotLow(batteryGate)
            .build();
        PeriodicWorkRequest.Builder builder = new PeriodicWorkRequest.Builder(
            StepSyncWorker.class, interval, TimeUnit.MINUTES, Math.min(10, interval / 3), TimeUnit.MINUTES)
            .setConstraints(constraints)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 60, TimeUnit.SECONDS)
            .addTag("step2win-sync");
        if (firstTime) {
            // Spread phones across the interval instead of all starting "now".
            builder.setInitialDelay(RANDOM.nextInt((int) Math.max(1, interval * 60)), TimeUnit.SECONDS);
        }
        WorkManager.getInstance(app).enqueueUniquePeriodicWork(
            PERIODIC_WORK,
            firstTime ? ExistingPeriodicWorkPolicy.KEEP : ExistingPeriodicWorkPolicy.UPDATE,
            builder.build());
        prefs.edit().putLong(KEY_INTERVAL, interval).putBoolean(KEY_BATTERY_GATE, batteryGate).apply();
    }

    /**
     * One-off sync soon (walk ended, deadline window). KEEP: an already-scheduled one is not
     * pushed back. Random extra delay spreads phones that ended walks at the same moment.
     */
    public static void scheduleSoon(Context context, long delayMs, String reason) {
        enqueueOneOff(context, delayMs, reason, SOON_WORK, ExistingWorkPolicy.KEEP);
    }

    private static void enqueueOneOff(Context context, long delayMs, String reason, String name, ExistingWorkPolicy policy) {
        long jitter = RANDOM.nextInt(60_000);
        OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(StepSyncWorker.class)
            .setInitialDelay(Math.max(0L, delayMs) + jitter, TimeUnit.MILLISECONDS)
            .setConstraints(new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .setInputData(new Data.Builder().putString("reason", reason).putBoolean("oneOff", true).build())
            .addTag("step2win-sync")
            .build();
        WorkManager.getInstance(context.getApplicationContext())
            .enqueueUniqueWork(name, policy, request);
    }

    /** After every background run: keep the deadline chain going while it matters. */
    static void afterRun(Context context, String reason) {
        ensurePeriodic(context);
        long untilDeadline = SyncPolicy.msUntilDeadline(context);
        if (untilDeadline > 0) {
            long next = 5 * 60_000L + RANDOM.nextInt(90_000);
            if (untilDeadline < next + 60_000L) {
                // Last chance before the deadline: aim a few minutes before it.
                next = Math.max(30_000L, untilDeadline - 3 * 60_000L);
            }
            // The deadline run appends its own successor (a chain: one link at a time);
            // other runs only start the chain if none is pending.
            enqueueOneOff(context, next, "deadline", DEADLINE_WORK,
                "deadline".equals(reason) ? ExistingWorkPolicy.APPEND_OR_REPLACE : ExistingWorkPolicy.KEEP);
        }
    }
}
