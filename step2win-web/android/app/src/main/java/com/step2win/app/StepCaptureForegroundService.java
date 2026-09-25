package com.step2win.app;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.location.Location;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.PowerManager;
import android.util.Log;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

import com.google.android.gms.location.FusedLocationProviderClient;
import com.google.android.gms.location.LocationCallback;
import com.google.android.gms.location.LocationRequest;
import com.google.android.gms.location.LocationResult;
import com.google.android.gms.location.LocationServices;
import com.google.android.gms.location.Priority;

import org.json.JSONArray;
import org.json.JSONObject;

import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayDeque;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * The walking service: a foreground service (type "health") that exists ONLY while the user
 * is walking during a challenge day with the app in the background. It adds what the
 * hardware step counter alone can't: continuous accelerometer/gyroscope gait analysis
 * (anti-cheat evidence for background walks) and the route map.
 *
 * Started by a walking transition (MotionTransitionReceiver) or when the app is left while
 * walking; stops itself after {@link #IDLE_STOP_MS} without steps, after
 * {@link #MAX_RUN_MS}, when the challenge day ends, or when the app comes back to the
 * foreground (the app does the same analysis itself then). Never sticky, never all day.
 *
 * Counting never depends on this service: the hardware counter counts regardless and the
 * WorkManager job uploads. While walking it uploads about every 10 minutes (sooner near a
 * deadline), and once more when the walk ends.
 */
public class StepCaptureForegroundService extends Service implements SensorEventListener {
    private static final String TAG = "Step2WinWalk";
    public static final String PREFS = "device_step_counter_prefs";
    public static final String KEY_LATEST_RAW = "latest_raw_steps";
    public static final String KEY_LAST_TS = "latest_raw_timestamp";
    public static final String KEY_BACKGROUND_RUNNING = "background_running";
    public static final String KEY_WAYPOINTS_DATE = "pending_waypoints_date";
    public static final String KEY_WAYPOINTS_JSON = "pending_waypoints_json";
    public static final int MAX_WAYPOINTS_PER_DAY = 500;
    static final String ACTION_STOP = "com.step2win.app.STOP_WALK_CAPTURE";

    private static final String CHANNEL_ID = "step_capture_channel";
    private static final int NOTIFICATION_ID = 4021;

    static final long IDLE_STOP_MS = 5 * 60_000L;
    static final long MAX_RUN_MS = 3 * 60 * 60_000L;
    private static final long TICK_MS = 60_000L;
    private static final long WAKELOCK_MS = TICK_MS + 30_000L;
    private static final long UPLOAD_EVERY_MS = 10 * 60_000L;
    private static final int UPLOAD_MIN_STEPS = 250;

    private static final long LOCATION_INTERVAL_MS = 10_000L;
    private static final float LOCATION_MIN_DISPLACEMENT_METERS = 8f;
    private static final float WAYPOINT_MAX_ACCURACY_METERS = 65f;
    private static final float WAYPOINT_MIN_DISTANCE_METERS = 2.5f;
    private static final float WAYPOINT_MAX_SPEED_MPS = 8.0f;

    private static volatile boolean running = false;
    private static volatile long lastStepEventAtMs = 0L;
    private static volatile boolean movementStopped = false;

    private SensorManager sensorManager;
    private Sensor stepCounterSensor;
    private Sensor linearSensor;
    private Sensor gravitySensor;
    private Sensor accelerometerSensor;
    private Sensor gyroscopeSensor;
    private HandlerThread sensorThread;
    private Handler sensorHandler;
    private final Handler mainHandler = new Handler(android.os.Looper.getMainLooper());
    private final ExecutorService uploader = Executors.newSingleThreadExecutor();

    private final float[] linear = new float[3];
    private final float[] gravity = new float[3];
    private final float[] accel = new float[3];
    private boolean hasLinear;
    private boolean hasGravity;
    private boolean hasAccel;
    private float gyroMagnitude;
    private float lastRaw = -1f;
    private long lastRawAtMs = 0L;
    private final ArrayDeque<Long> stepTimes = new ArrayDeque<>();

    private FusedLocationProviderClient fusedLocationClient;
    private LocationCallback fusedLocationCallback;
    private boolean locationRegistered = false;
    private long lastWaypointTimeMs = 0L;
    private double lastWaypointLat = Double.NaN;
    private double lastWaypointLng = Double.NaN;
    private float lastWaypointAccuracy = 0f;

    private PowerManager.WakeLock wakeLock;
    private long startedAtMs;
    private boolean uploadInFlight = false;

    // ── start / stop helpers ─────────────────────────────────────────────────

    /** Starts the walking service if it can add value. Safe to call from anywhere. */
    static void start(Context context, String reason) {
        Context app = context.getApplicationContext();
        if (running || !hasActivityRecognitionPermission(app) || !SyncPolicy.challengeActiveToday(app)) {
            return;
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

    // ── lifecycle ────────────────────────────────────────────────────────────

    @Override
    public void onCreate() {
        super.onCreate();
        sensorManager = (SensorManager) getSystemService(Context.SENSOR_SERVICE);
        if (sensorManager != null) {
            stepCounterSensor = sensorManager.getDefaultSensor(Sensor.TYPE_STEP_COUNTER);
            linearSensor = sensorManager.getDefaultSensor(Sensor.TYPE_LINEAR_ACCELERATION);
            gravitySensor = sensorManager.getDefaultSensor(Sensor.TYPE_GRAVITY);
            accelerometerSensor = sensorManager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER);
            gyroscopeSensor = sensorManager.getDefaultSensor(Sensor.TYPE_GYROSCOPE);
        }
        fusedLocationClient = LocationServices.getFusedLocationProviderClient(this);
        fusedLocationCallback = new LocationCallback() {
            @Override
            public void onLocationResult(LocationResult result) {
                if (result == null) return;
                for (Location location : result.getLocations()) {
                    enqueueWaypoint(location);
                }
            }
        };
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
            registerSensors();
            if (!SyncPolicy.saverMode(this)) {
                registerLocation(); // route points are optional: skipped on Data/Battery Saver
            }
            renewWakeLock();
            mainHandler.postDelayed(tick, TICK_MS);
            Log.i(TAG, "walking service started (" + (intent != null ? intent.getStringExtra("reason") : "restart") + ")");
        }
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        mainHandler.removeCallbacks(tick);
        unregisterSensors();
        unregisterLocation();
        if (lastRaw >= 0f) {
            StepLedger.record(this, lastRaw);
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

    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            long now = System.currentTimeMillis();
            if (lastRaw >= 0f) {
                StepLedger.record(StepCaptureForegroundService.this, lastRaw);
            }
            String stopReason = null;
            if (SyncPolicy.appInForeground) stopReason = "app_in_foreground";
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

    // ── sensors ──────────────────────────────────────────────────────────────

    private void registerSensors() {
        if (sensorManager == null) return;
        sensorThread = new HandlerThread("Step2WinWalkSensors");
        sensorThread.start();
        sensorHandler = new Handler(sensorThread.getLooper());
        if (stepCounterSensor != null) {
            sensorManager.registerListener(this, stepCounterSensor, SensorManager.SENSOR_DELAY_NORMAL, sensorHandler);
        }
        // Gait analysis needs ~50 Hz motion data; this is the battery cost that the
        // "only while walking, only on challenge days, stop when idle" rules bound.
        if (linearSensor != null) sensorManager.registerListener(this, linearSensor, SensorManager.SENSOR_DELAY_GAME, sensorHandler);
        if (gravitySensor != null) sensorManager.registerListener(this, gravitySensor, SensorManager.SENSOR_DELAY_GAME, sensorHandler);
        if (accelerometerSensor != null && gravitySensor == null) sensorManager.registerListener(this, accelerometerSensor, SensorManager.SENSOR_DELAY_GAME, sensorHandler);
        if (gyroscopeSensor != null) sensorManager.registerListener(this, gyroscopeSensor, SensorManager.SENSOR_DELAY_GAME, sensorHandler);
    }

    private void unregisterSensors() {
        if (sensorManager != null) {
            try {
                sensorManager.unregisterListener(this);
            } catch (Exception ignored) {
                // already unregistered
            }
        }
        if (sensorThread != null) {
            sensorThread.quitSafely();
            sensorThread = null;
            sensorHandler = null;
        }
    }

    @Override
    public void onSensorChanged(SensorEvent event) {
        if (event == null || event.values == null || event.values.length == 0 || event.sensor == null) return;
        int type = event.sensor.getType();
        long now = System.currentTimeMillis();
        if (type == Sensor.TYPE_STEP_COUNTER) {
            float raw = event.values[0];
            if (lastRaw >= 0f && raw > lastRaw) {
                int delta = Math.round(raw - lastRaw);
                long elapsed = Math.max(1L, now - lastRawAtMs);
                int accepted = Math.min(delta, Math.max(1, (int) Math.ceil(elapsed / 250.0)));
                for (int i = 0; i < accepted; i++) stepTimes.addLast(now);
                lastStepEventAtMs = now;
                movementStopped = false;
            }
            lastRaw = raw;
            lastRawAtMs = now;
            while (!stepTimes.isEmpty() && stepTimes.peekFirst() < now - 60_000L) stepTimes.pollFirst();
            int burst = 0;
            for (Long t : stepTimes) if (t >= now - 5_000L) burst++;
            StepSyncEngine.liveCadenceSpm = stepTimes.size();
            StepSyncEngine.liveBurst5s = burst;
            StepSyncEngine.liveUpdatedAt = now;
            getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putFloat(KEY_LATEST_RAW, raw).putLong(KEY_LAST_TS, now).apply();
            return;
        }
        if (SyncPolicy.appInForeground) return; // the plugin feeds the analyzer while the app is open
        if (type == Sensor.TYPE_LINEAR_ACCELERATION && event.values.length >= 3) {
            System.arraycopy(event.values, 0, linear, 0, 3);
            hasLinear = true;
        } else if (type == Sensor.TYPE_GRAVITY && event.values.length >= 3) {
            System.arraycopy(event.values, 0, gravity, 0, 3);
            hasGravity = true;
        } else if (type == Sensor.TYPE_ACCELEROMETER && event.values.length >= 3) {
            System.arraycopy(event.values, 0, accel, 0, 3);
            hasAccel = true;
            final float alpha = 0.92f;
            for (int i = 0; i < 3; i++) gravity[i] = alpha * gravity[i] + (1f - alpha) * accel[i];
            hasGravity = true;
        } else if (type == Sensor.TYPE_GYROSCOPE && event.values.length >= 3) {
            float gx = event.values[0], gy = event.values[1], gz = event.values[2];
            gyroMagnitude = (float) Math.sqrt(gx * gx + gy * gy + gz * gz);
        }
        if (!hasGravity) return;
        float lx, ly, lz;
        if (hasLinear) {
            lx = linear[0]; ly = linear[1]; lz = linear[2];
        } else if (hasAccel) {
            lx = accel[0] - gravity[0]; ly = accel[1] - gravity[1]; lz = accel[2] - gravity[2];
        } else {
            return;
        }
        GaitAnalyzer.SHARED.addSample(now, lx, ly, lz, gravity[0], gravity[1], gravity[2], gyroMagnitude);
    }

    @Override
    public void onAccuracyChanged(Sensor sensor, int accuracy) {
        // no-op
    }

    private void setRunningPref(boolean value) {
        getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(KEY_BACKGROUND_RUNNING, value).apply();
    }

    // ── location (route map) ─────────────────────────────────────────────────

    private void registerLocation() {
        if (locationRegistered || fusedLocationClient == null) return;
        boolean hasFine = ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
        boolean hasCoarse = ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
        if (!hasFine && !hasCoarse) return;
        try {
            LocationRequest request = new LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, LOCATION_INTERVAL_MS)
                .setMinUpdateDistanceMeters(LOCATION_MIN_DISPLACEMENT_METERS)
                .setMinUpdateIntervalMillis(5_000L)
                .build();
            fusedLocationClient.requestLocationUpdates(request, fusedLocationCallback, getMainLooper());
            locationRegistered = true;
        } catch (SecurityException ignored) {
            locationRegistered = false;
        }
    }

    private void unregisterLocation() {
        if (!locationRegistered || fusedLocationClient == null) return;
        fusedLocationClient.removeLocationUpdates(fusedLocationCallback);
        locationRegistered = false;
    }

    private void enqueueWaypoint(Location location) {
        if (location == null) return;
        if (location.hasAccuracy() && location.getAccuracy() > WAYPOINT_MAX_ACCURACY_METERS) return;
        long now = System.currentTimeMillis();
        if (lastWaypointTimeMs > 0L) {
            double jumpMeters = haversineMeters(lastWaypointLat, lastWaypointLng, location.getLatitude(), location.getLongitude());
            if (jumpMeters < WAYPOINT_MIN_DISTANCE_METERS) return;
            double dtSeconds = Math.max(1.0, (now - lastWaypointTimeMs) / 1000.0);
            if (jumpMeters / dtSeconds > WAYPOINT_MAX_SPEED_MPS) return;
        }
        double smoothLat = location.getLatitude();
        double smoothLng = location.getLongitude();
        if (!Double.isNaN(lastWaypointLat) && !Double.isNaN(lastWaypointLng)) {
            float currentAccuracy = location.hasAccuracy() ? Math.max(1f, location.getAccuracy()) : WAYPOINT_MAX_ACCURACY_METERS;
            float baselineAccuracy = Math.max(1f, lastWaypointAccuracy);
            double alpha = Math.max(0.2, Math.min(0.75, baselineAccuracy / (baselineAccuracy + currentAccuracy)));
            smoothLat = (alpha * smoothLat) + ((1 - alpha) * lastWaypointLat);
            smoothLng = (alpha * smoothLng) + ((1 - alpha) * lastWaypointLng);
        }
        appendWaypoint(this, now, smoothLat, smoothLng, Math.max(0f, location.getAccuracy()));
        lastWaypointLat = smoothLat;
        lastWaypointLng = smoothLng;
        lastWaypointTimeMs = now;
        lastWaypointAccuracy = Math.max(0f, location.getAccuracy());
    }

    static void appendWaypoint(Context context, long now, double lat, double lng, float accuracy) {
        synchronized (StepCaptureForegroundService.class) {
            SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            String today = LocalDate.now(ZoneId.systemDefault()).format(DateTimeFormatter.ISO_LOCAL_DATE);
            String storedDate = prefs.getString(KEY_WAYPOINTS_DATE, "");
            JSONArray array;
            try {
                array = today.equals(storedDate) ? new JSONArray(prefs.getString(KEY_WAYPOINTS_JSON, "[]")) : new JSONArray();
            } catch (Exception ignored) {
                array = new JSONArray();
            }
            try {
                JSONObject waypoint = new JSONObject();
                waypoint.put("hour", java.time.LocalTime.now().getHour());
                waypoint.put("recorded_at", Instant.ofEpochMilli(now).toString());
                waypoint.put("latitude", lat);
                waypoint.put("longitude", lng);
                waypoint.put("accuracy_m", accuracy);
                array.put(waypoint);
            } catch (Exception ignored) {
                return;
            }
            if (array.length() > MAX_WAYPOINTS_PER_DAY) {
                JSONArray trimmed = new JSONArray();
                for (int i = array.length() - MAX_WAYPOINTS_PER_DAY; i < array.length(); i++) {
                    JSONObject item = array.optJSONObject(i);
                    if (item != null) trimmed.put(item);
                }
                array = trimmed;
            }
            prefs.edit().putString(KEY_WAYPOINTS_DATE, today).putString(KEY_WAYPOINTS_JSON, array.toString()).apply();
        }
    }

    /** {date, waypoints[]} currently buffered on the phone. */
    static JSONObject readPendingWaypoints(Context context) {
        JSONObject out = new JSONObject();
        synchronized (StepCaptureForegroundService.class) {
            SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            try {
                out.put("date", prefs.getString(KEY_WAYPOINTS_DATE, StepLedger.today()));
                out.put("waypoints", new JSONArray(prefs.getString(KEY_WAYPOINTS_JSON, "[]")));
            } catch (Exception ignored) {
                try {
                    out.put("waypoints", new JSONArray());
                } catch (Exception ignoredToo) {
                    // no-op
                }
            }
        }
        return out;
    }

    /**
     * Drops only the points up to `upTo` (recorded_at of the last uploaded point) so a point
     * captured between read and clear is never lost. Returns how many remain.
     */
    static int clearWaypointsUpTo(Context context, String date, String upTo) {
        synchronized (StepCaptureForegroundService.class) {
            SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            String storedDate = prefs.getString(KEY_WAYPOINTS_DATE, StepLedger.today());
            if (date == null || !date.equals(storedDate)) {
                try {
                    return new JSONArray(prefs.getString(KEY_WAYPOINTS_JSON, "[]")).length();
                } catch (Exception ignored) {
                    return 0;
                }
            }
            JSONArray kept = new JSONArray();
            try {
                Instant cutoff = Instant.parse(upTo);
                JSONArray source = new JSONArray(prefs.getString(KEY_WAYPOINTS_JSON, "[]"));
                for (int i = 0; i < source.length(); i++) {
                    JSONObject item = source.optJSONObject(i);
                    if (item == null) continue;
                    try {
                        if (Instant.parse(item.optString("recorded_at", "")).isAfter(cutoff)) kept.put(item);
                    } catch (Exception ignoredItem) {
                        // Unparseable timestamp: drop it.
                    }
                }
            } catch (Exception ignored) {
                // Corrupt buffer: clear it.
            }
            prefs.edit().putString(KEY_WAYPOINTS_JSON, kept.toString()).commit();
            return kept.length();
        }
    }

    private static double haversineMeters(double lat1, double lon1, double lat2, double lon2) {
        double r = 6371000.0;
        double dLat = Math.toRadians(lat2 - lat1);
        double dLon = Math.toRadians(lon2 - lon1);
        double a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
            + Math.cos(Math.toRadians(lat1)) * Math.cos(Math.toRadians(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
        return r * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
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
