package com.step2win.app;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.pm.ServiceInfo;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.location.Location;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

import androidx.annotation.Nullable;
import androidx.core.content.ContextCompat;
import androidx.core.app.NotificationCompat;

import com.google.android.gms.location.FusedLocationProviderClient;
import com.google.android.gms.location.LocationCallback;
import com.google.android.gms.location.LocationRequest;
import com.google.android.gms.location.LocationResult;
import com.google.android.gms.location.LocationServices;
import com.google.android.gms.location.Priority;

import org.json.JSONArray;
import org.json.JSONObject;

import java.time.LocalDate;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;

public class StepCaptureForegroundService extends Service implements SensorEventListener {
    public static final String PREFS = "device_step_counter_prefs";
    public static final String KEY_LATEST_RAW = "latest_raw_steps";
    public static final String KEY_LAST_TS = "latest_raw_timestamp";
    public static final String KEY_BACKGROUND_RUNNING = "background_running";
    public static final String KEY_WAYPOINTS_DATE = "pending_waypoints_date";
    public static final String KEY_WAYPOINTS_JSON = "pending_waypoints_json";
    public static final int MAX_WAYPOINTS_PER_DAY = 500;

    private static final String CHANNEL_ID = "step_capture_channel";
    private static final int NOTIFICATION_ID = 4021;

    private static final long LOCATION_INTERVAL_MOVING_MS = 8_000L;
    private static final long LOCATION_INTERVAL_IDLE_MS = 30_000L;
    private static final float LOCATION_MIN_DISPLACEMENT_METERS = 6f;
    private static final float WAYPOINT_MAX_ACCURACY_METERS = 65f;
    private static final float WAYPOINT_MIN_DISTANCE_METERS = 2.5f;
    private static final float WAYPOINT_MAX_SPEED_MPS = 8.0f;

    private SensorManager sensorManager;
    private Sensor stepCounterSensor;
    private FusedLocationProviderClient fusedLocationClient;
    private LocationCallback fusedLocationCallback;
    private LocationRequest locationRequest;
    private boolean registered = false;
    private boolean locationRegistered = false;
    private long lastMotionAtMs = 0L;
    private long lastWaypointTimeMs = 0L;
    private double lastWaypointLat = Double.NaN;
    private double lastWaypointLng = Double.NaN;
    private float lastWaypointAccuracy = 0f;
    private PowerManager.WakeLock wakeLock;

    @Override
    public void onCreate() {
        super.onCreate();
        sensorManager = (SensorManager) getSystemService(Context.SENSOR_SERVICE);
        if (sensorManager != null) {
            stepCounterSensor = sensorManager.getDefaultSensor(Sensor.TYPE_STEP_COUNTER);
        }
        fusedLocationClient = LocationServices.getFusedLocationProviderClient(this);
        fusedLocationCallback = new LocationCallback() {
            @Override
            public void onLocationResult(LocationResult result) {
                if (result == null) {
                    return;
                }
                for (Location location : result.getLocations()) {
                    enqueueWaypoint(location);
                }
            }
        };
        createNotificationChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // Android 14+ only lets a "health" foreground service start while a health-related
        // runtime permission (ACTIVITY_RECOGNITION) is granted. It can be revoked while the
        // service is sticky, so re-check on every (re)start instead of crashing.
        if (!hasActivityRecognitionPermission(this)) {
            setRunning(false);
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
            setRunning(false);
            stopSelf();
            return START_NOT_STICKY;
        }
        acquireWakeLock();
        registerSensor();
        registerLocation();
        setRunning(true);
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        unregisterSensor();
        unregisterLocation();
        releaseWakeLock();
        setRunning(false);
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onSensorChanged(SensorEvent event) {
        if (event == null || event.values == null || event.values.length == 0) {
            return;
        }

        float raw = event.values[0];
        lastMotionAtMs = System.currentTimeMillis();
        SharedPreferences prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        prefs.edit()
            .putFloat(KEY_LATEST_RAW, raw)
            .putLong(KEY_LAST_TS, System.currentTimeMillis())
            .apply();

        maybeRefreshLocationRequest();
    }

    @Override
    public void onAccuracyChanged(Sensor sensor, int accuracy) {
        // no-op
    }

    private void registerSensor() {
        if (registered || sensorManager == null || stepCounterSensor == null) {
            return;
        }
        registered = sensorManager.registerListener(this, stepCounterSensor, SensorManager.SENSOR_DELAY_NORMAL);
    }

    private void unregisterSensor() {
        if (!registered || sensorManager == null) {
            return;
        }
        sensorManager.unregisterListener(this);
        registered = false;
    }

    private void setRunning(boolean running) {
        getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putBoolean(KEY_BACKGROUND_RUNNING, running)
            .apply();
    }

    private void registerLocation() {
        if (locationRegistered || fusedLocationClient == null) {
            return;
        }

        boolean hasFine = ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
        boolean hasCoarse = ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
        if (!hasFine && !hasCoarse) {
            return;
        }

        try {
            locationRequest = buildAdaptiveLocationRequest();
            fusedLocationClient.requestLocationUpdates(locationRequest, fusedLocationCallback, getMainLooper());
            locationRegistered = true;
        } catch (SecurityException ignored) {
            locationRegistered = false;
        }
    }

    private void unregisterLocation() {
        if (!locationRegistered || fusedLocationClient == null) {
            return;
        }
        fusedLocationClient.removeLocationUpdates(fusedLocationCallback);
        locationRegistered = false;
    }

    private void maybeRefreshLocationRequest() {
        if (!locationRegistered || fusedLocationClient == null || locationRequest == null) {
            return;
        }

        LocationRequest next = buildAdaptiveLocationRequest();
        if (next.getIntervalMillis() == locationRequest.getIntervalMillis()) {
            return;
        }

        try {
            fusedLocationClient.removeLocationUpdates(fusedLocationCallback);
            fusedLocationClient.requestLocationUpdates(next, fusedLocationCallback, getMainLooper());
            locationRequest = next;
        } catch (SecurityException ignored) {
            // Keep existing request if refresh fails.
        }
    }

    private LocationRequest buildAdaptiveLocationRequest() {
        boolean recentlyMoving = (System.currentTimeMillis() - lastMotionAtMs) < 120_000L;
        long intervalMs = recentlyMoving ? LOCATION_INTERVAL_MOVING_MS : LOCATION_INTERVAL_IDLE_MS;

        return new LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, intervalMs)
            .setMinUpdateDistanceMeters(LOCATION_MIN_DISPLACEMENT_METERS)
            .setMinUpdateIntervalMillis(Math.max(2_500L, intervalMs / 2L))
            .setWaitForAccurateLocation(recentlyMoving)
            .build();
    }

    private void enqueueWaypoint(Location location) {
        if (location == null) {
            return;
        }

        if (location.hasAccuracy() && location.getAccuracy() > WAYPOINT_MAX_ACCURACY_METERS) {
            return;
        }

        long now = System.currentTimeMillis();
        if (lastWaypointTimeMs > 0L) {
            double jumpMeters = haversineMeters(lastWaypointLat, lastWaypointLng, location.getLatitude(), location.getLongitude());
            if (jumpMeters < WAYPOINT_MIN_DISTANCE_METERS) {
                return;
            }

            double dtSeconds = Math.max(1.0, (now - lastWaypointTimeMs) / 1000.0);
            double impliedSpeed = jumpMeters / dtSeconds;
            if (impliedSpeed > WAYPOINT_MAX_SPEED_MPS) {
                return;
            }
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

        synchronized (StepCaptureForegroundService.class) {
        SharedPreferences prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String today = LocalDate.now(ZoneId.systemDefault()).format(DateTimeFormatter.ISO_LOCAL_DATE);
        String storedDate = prefs.getString(KEY_WAYPOINTS_DATE, "");

        String rawJson = prefs.getString(KEY_WAYPOINTS_JSON, "[]");
        JSONArray array;
        try {
            array = (today.equals(storedDate)) ? new JSONArray(rawJson) : new JSONArray();
        } catch (Exception ignored) {
            array = new JSONArray();
        }

        try {
            JSONObject waypoint = new JSONObject();
            waypoint.put("hour", java.time.LocalTime.now().getHour());
            waypoint.put("recorded_at", java.time.Instant.ofEpochMilli(now).toString());
            waypoint.put("latitude", smoothLat);
            waypoint.put("longitude", smoothLng);
            waypoint.put("accuracy_m", Math.max(0f, location.getAccuracy()));
            array.put(waypoint);
        } catch (Exception ignored) {
            return;
        }

        if (array.length() > MAX_WAYPOINTS_PER_DAY) {
            JSONArray trimmed = new JSONArray();
            int start = array.length() - MAX_WAYPOINTS_PER_DAY;
            for (int i = start; i < array.length(); i++) {
                try {
                    trimmed.put(array.getJSONObject(i));
                } catch (Exception ignored) {
                    // Skip malformed entries.
                }
            }
            array = trimmed;
        }

        prefs.edit()
            .putString(KEY_WAYPOINTS_DATE, today)
            .putString(KEY_WAYPOINTS_JSON, array.toString())
            .apply();
        }

        lastWaypointLat = smoothLat;
        lastWaypointLng = smoothLng;
        lastWaypointTimeMs = now;
        lastWaypointAccuracy = Math.max(0f, location.getAccuracy());
    }

    private static double haversineMeters(double lat1, double lon1, double lat2, double lon2) {
        double R = 6371000.0;
        double dLat = Math.toRadians(lat2 - lat1);
        double dLon = Math.toRadians(lon2 - lon1);
        double a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
            + Math.cos(Math.toRadians(lat1)) * Math.cos(Math.toRadians(lat2))
            * Math.sin(dLon / 2) * Math.sin(dLon / 2);
        double c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c;
    }

    static boolean hasActivityRecognitionPermission(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            return true; // The step counter needs no runtime permission before Android 10.
        }
        return ContextCompat.checkSelfPermission(context, Manifest.permission.ACTIVITY_RECOGNITION) == PackageManager.PERMISSION_GRANTED;
    }

    private Notification buildNotification() {
        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_step2win)
            .setColor(0xFF14855D)
            .setContentTitle("Counting your steps")
            .setContentText("Step2Win keeps counting while the app is closed.")
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setShowWhen(false)
            .setOnlyAlertOnce(true)
            .setOngoing(true);
        Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
        if (launch != null) {
            launch.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            builder.setContentIntent(PendingIntent.getActivity(this, 0, launch, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
        }
        return builder.build();
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }

        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID,
            "Step counting",
            NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription("Shown while Step2Win counts steps in the background.");
        channel.setShowBadge(false);
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) {
            manager.createNotificationChannel(channel);
        }
    }

    private void acquireWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) {
            return;
        }

        PowerManager powerManager = (PowerManager) getSystemService(Context.POWER_SERVICE);
        if (powerManager == null) {
            return;
        }

        wakeLock = powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "step2win:StepCaptureWakeLock");
        wakeLock.setReferenceCounted(false);
        wakeLock.acquire();
    }

    private void releaseWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) {
            wakeLock.release();
        }
        wakeLock = null;
    }
}
