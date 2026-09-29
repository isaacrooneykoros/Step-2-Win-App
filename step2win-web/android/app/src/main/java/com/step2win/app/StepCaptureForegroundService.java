package com.step2win.app;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.PowerManager;
import android.util.Log;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * The automatic walking service: a foreground service (type "health") that exists ONLY while
 * the user is walking during a challenge day with the app in the background. It adds what the
 * hardware step counter alone can't: continuous accelerometer (+ gyroscope) gait analysis, the
 * per-minute walking evidence for background walks ({@link EvidenceTracker}). No GPS: location
 * is only ever used in a walk the user starts himself ({@link WalkSessionService}).
 *
 * Started by a walking transition (MotionTransitionReceiver) or when the app is left while
 * walking; stops itself after {@link #IDLE_STOP_MS} without steps, after
 * {@link #MAX_RUN_MS}, when the challenge day ends, when the app comes back to the foreground
 * (the app does the same analysis itself then) or when the user starts a walk. Never sticky,
 * never all day.
 *
 * Counting never depends on this service: the hardware counter counts regardless and the
 * WorkManager job uploads. While walking it uploads about every 10 minutes (sooner near a
 * deadline), and once more when the walk ends.
 */
public class StepCaptureForegroundService extends Service {
    private static final String TAG = "Step2WinWalk";
    public static final String PREFS = "device_step_counter_prefs";
    public static final String KEY_LATEST_RAW = "latest_raw_steps";
    public static final String KEY_LAST_TS = "latest_raw_timestamp";
    public static final String KEY_BACKGROUND_RUNNING = "background_running";
    /** Legacy route buffer keys (background GPS was removed; cleared on start). */
    static final String KEY_WAYPOINTS_DATE = "pending_waypoints_date";
    static final String KEY_WAYPOINTS_JSON = "pending_waypoints_json";
    static final String ACTION_STOP = "com.step2win.app.STOP_WALK_CAPTURE";

    private static final String CHANNEL_ID = "step_capture_channel";
    private static final int NOTIFICATION_ID = 4021;

    static final long IDLE_STOP_MS = 5 * 60_000L;
    static final long MAX_RUN_MS = 3 * 60 * 60_000L;
    private static final long TICK_MS = 60_000L;
    private static final long LEDGER_EVERY_MS = 15_000L;
    private static final long WAKELOCK_MS = TICK_MS + 30_000L;
    private static final long UPLOAD_EVERY_MS = 10 * 60_000L;
    private static final int UPLOAD_MIN_STEPS = 250;

    private static volatile boolean running = false;
    private static volatile long lastStepEventAtMs = 0L;
    private static volatile boolean movementStopped = false;

    private final Handler mainHandler = new Handler(android.os.Looper.getMainLooper());
    private final ExecutorService uploader = Executors.newSingleThreadExecutor();
    private PowerManager.WakeLock wakeLock;
    private long startedAtMs;
    private volatile boolean uploadInFlight = false;
    private volatile long lastLedgerAtMs = 0L;

    // ── start / stop helpers ─────────────────────────────────────────────────

    /** Starts the walking service if it can add value. Safe to call from anywhere. */
    static void start(Context context, String reason) {
        Context app = context.getApplicationContext();
        if (running || !hasActivityRecognitionPermission(app) || !SyncPolicy.challengeActiveToday(app)) {
            return;
        }
        if (WalkSessionService.isRunning()) {
            return; // a user walk is recording: it does the same analysis
        }
        try {
            ContextCompat.startForegroundService(app, new Intent(app, StepCaptureForegroundService.class).putExtra("reason", reason));
        } catch (RuntimeException notAllowed) {
            // Android 12+ background-start restriction: counting continues via the hardware
            // counter + WorkManager; only background gait analysis is skipped this time.
            Log.i(TAG, "walking service not started (" + reason + "): " + notAllowed.getClass().getSimpleName());
        }
    }

    static void stop(Context context) {
        Context app = context.getApplicationContext();
        if (!running) return;
        try {
            app.startService(new Intent(app, StepCaptureForegroundService.class).setAction(ACTION_STOP));
        } catch (RuntimeException ignored) {
            app.stopService(new Intent(app, StepCaptureForegroundService.class));
        }
    }

    static boolean isRunning() {
        return running;
    }

    static void noteMovementStopped(Context context) {
        movementStopped = true;
    }

    static void noteDebugSteps(int steps) {
        lastStepEventAtMs = System.currentTimeMillis();
        movementStopped = false;
    }

    /** Removes the legacy background-route buffer (background location is no longer used). */
    static void clearLegacyWaypoints(Context context) {
        context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .remove(KEY_WAYPOINTS_JSON)
            .remove(KEY_WAYPOINTS_DATE)
            .apply();
    }

    // ── lifecycle ────────────────────────────────────────────────────────────

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopSelf();
            return START_NOT_STICKY;
        }
        // Android 14+ only lets a "health" foreground service start while a health-related
        // runtime permission (ACTIVITY_RECOGNITION) is granted. Re-check on every start.
        if (!hasActivityRecognitionPermission(this)) {
            stopSelf();
            return START_NOT_STICKY;
        }
        try {
            if (Build.VERSION.SDK_INT >= 34) {
                startForeground(NOTIFICATION_ID, buildNotification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_HEALTH);
            } else {
                startForeground(NOTIFICATION_ID, buildNotification());
            }
        } catch (RuntimeException startError) {
            // SecurityException / ForegroundServiceStartNotAllowedException: stop quietly.
            stopSelf();
            return START_NOT_STICKY;
        }
        if (!running) {
            running = true;
            startedAtMs = System.currentTimeMillis();
            lastStepEventAtMs = Math.max(lastStepEventAtMs, startedAtMs); // grace period after start
            movementStopped = false;
            setRunningPref(true);
            clearLegacyWaypoints(this);
            MotionHub hub = MotionHub.get(this);
            hub.addListener(hubListener);
            hub.acquire(MotionHub.CLIENT_CAPTURE);
            renewWakeLock();
            mainHandler.postDelayed(tick, TICK_MS);
            Log.i(TAG, "walking service started (" + (intent != null ? intent.getStringExtra("reason") : "restart") + ")");
        }
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        mainHandler.removeCallbacks(tick);
        MotionHub hub = MotionHub.get(this);
        hub.removeListener(hubListener);
        hub.release(MotionHub.CLIENT_CAPTURE);
        float raw = hub.latestRaw();
        if (raw >= 0f) {
            StepLedger.record(this, raw);
        }
        releaseWakeLock();
        running = false;
        setRunningPref(false);
        uploader.shutdown();
        // Upload the finished walk soon (WorkManager: survives the process going away).
        StepSyncScheduler.scheduleSoon(this, 30_000L, "walk_ended");
        Log.i(TAG, "walking service stopped after " + ((System.currentTimeMillis() - startedAtMs) / 1000) + " s");
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private final MotionHub.Listener hubListener = new MotionHub.Listener() {
        @Override
        public void onCounter(float raw, int delta, long wallMs) {
            if (delta > 0) {
                lastStepEventAtMs = wallMs;
                movementStopped = false;
            }
            getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putFloat(KEY_LATEST_RAW, raw).putLong(KEY_LAST_TS, wallMs).apply();
            if (wallMs - lastLedgerAtMs >= LEDGER_EVERY_MS) {
                lastLedgerAtMs = wallMs;
                StepLedger.record(getApplicationContext(), raw);
            }
        }
    };

    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            long now = System.currentTimeMillis();
            float raw = MotionHub.get(StepCaptureForegroundService.this).latestRaw();
            if (raw >= 0f) {
                StepLedger.record(StepCaptureForegroundService.this, raw);
                lastLedgerAtMs = now;
            }
            String stopReason = null;
            if (SyncPolicy.appInForeground) stopReason = "app_in_foreground";
            else if (WalkSessionService.isRunning()) stopReason = "user_walk";
            else if (now - lastStepEventAtMs >= IDLE_STOP_MS) stopReason = "idle";
            else if (movementStopped && now - lastStepEventAtMs >= 2 * 60_000L) stopReason = "walk_ended";
            else if (now - startedAtMs >= MAX_RUN_MS) stopReason = "max_duration";
            else if (!SyncPolicy.challengeActiveToday(StepCaptureForegroundService.this)) stopReason = "no_challenge_today";
            if (stopReason != null) {
                Log.i(TAG, "stopping: " + stopReason);
                stopSelf();
                return;
            }
            renewWakeLock();
            maybeUpload(now);
            mainHandler.postDelayed(this, TICK_MS);
        }
    };

    private void maybeUpload(long now) {
        if (uploadInFlight || SyncPolicy.appInForeground || !SyncPolicy.online(this)) return;
        String userKey = StepSyncEngine.currentUserKey(this);
        if (userKey == null) return;
        String today = StepLedger.today();
        int unsent = StepLedger.todayTotal(this) - StepSyncEngine.ackedSteps(this, userKey, today);
        long since = now - StepSyncEngine.lastSuccessAt(this);
        boolean due = unsent > 0 && (unsent >= UPLOAD_MIN_STEPS || since >= UPLOAD_EVERY_MS || SyncPolicy.nearDeadline(this));
        if (!due) return;
        uploadInFlight = true;
        uploader.execute(() -> {
            try {
                StepSyncEngine.Options options = new StepSyncEngine.Options();
                options.foreground = false;
                options.reason = "walking";
                StepSyncEngine.run(getApplicationContext(), options);
            } finally {
                uploadInFlight = false;
            }
        });
    }

    private void setRunningPref(boolean value) {
        getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(KEY_BACKGROUND_RUNNING, value).apply();
    }

    static boolean hasActivityRecognitionPermission(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            return true; // The step counter needs no runtime permission before Android 10.
        }
        return ContextCompat.checkSelfPermission(context, Manifest.permission.ACTIVITY_RECOGNITION) == PackageManager.PERMISSION_GRANTED;
    }

    // ── notification + wake lock ─────────────────────────────────────────────

    private Notification buildNotification() {
        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_step2win)
            .setColor(0xFF14855D)
            .setContentTitle("Recording your challenge walk")
            .setContentText("Stops by itself a few minutes after you stop walking.")
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setSilent(true)
            .setShowWhen(false)
            .setOnlyAlertOnce(true)
            .setOngoing(true);
        if (Build.VERSION.SDK_INT >= 31) {
            builder.setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_DEFERRED);
        }
        Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
        if (launch != null) {
            launch.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            builder.setContentIntent(PendingIntent.getActivity(this, 0, launch, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
        }
        return builder.build();
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "Challenge walks", NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("Shown only while Step2Win records a walk during a challenge.");
        channel.setShowBadge(false);
        channel.setSound(null, null);
        channel.enableVibration(false);
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) manager.createNotificationChannel(channel);
    }

    /** Short, renewed wake lock: never outlives the service by more than ~90 s. */
    private void renewWakeLock() {
        PowerManager powerManager = (PowerManager) getSystemService(Context.POWER_SERVICE);
        if (powerManager == null) return;
        if (wakeLock == null) {
            wakeLock = powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "step2win:WalkCapture");
            wakeLock.setReferenceCounted(false);
        }
        wakeLock.acquire(WAKELOCK_MS);
    }

    private void releaseWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        wakeLock = null;
    }
}
