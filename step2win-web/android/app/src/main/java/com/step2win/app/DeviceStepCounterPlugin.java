package com.step2win.app;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.app.AlarmManager;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.os.Build;
import android.provider.Settings;
import android.net.Uri;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.time.LocalDate;
import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayDeque;
import java.util.UUID;

import org.json.JSONArray;
import org.json.JSONObject;

@CapacitorPlugin(
    name = "DeviceStepCounter",
    permissions = {
        @Permission(alias = "activityRecognition", strings = {"android.permission.ACTIVITY_RECOGNITION"}),
        @Permission(alias = "location", strings = {
            "android.permission.ACCESS_COARSE_LOCATION",
            "android.permission.ACCESS_FINE_LOCATION"
        }),
        @Permission(alias = "backgroundLocation", strings = {"android.permission.ACCESS_BACKGROUND_LOCATION"})
    }
)
public class DeviceStepCounterPlugin extends Plugin {
    private static final String PREFS = StepCaptureForegroundService.PREFS;
    private static final String KEY_DATE = "baseline_date";
    private static final String KEY_BASELINE = "baseline_value";
    private static final String KEY_LATEST_RAW = StepCaptureForegroundService.KEY_LATEST_RAW;
    private static final String KEY_BACKGROUND_RUNNING = StepCaptureForegroundService.KEY_BACKGROUND_RUNNING;
    private static final String KEY_DEVICE_ID = "device_id";
    private static final String KEY_APP_VERSION = "app_version";
    private static final String KEY_ML_MODEL_VERSION = "ml_model_version";
    private static final String KEY_SESSION_ID = "step_session_id";
    private static final String KEY_SESSION_TOKEN = "step_session_token";
    private static final String KEY_SESSION_EXPIRES_AT = "step_session_expires_at";
    private static final String KEY_SESSION_NEXT_SEQUENCE = "step_session_next_sequence";
    private static final String KEY_SESSION_LAST_TOTAL = "step_session_last_total";

    private SensorManager sensorManager;
    private Sensor stepCounterSensor;
    private Sensor linearAccelerationSensor;
    private Sensor gravitySensor;
    private Sensor accelerometerSensor;
    private Sensor gyroscopeSensor;

    private final float[] latestLinear = new float[] {0f, 0f, 0f};
    private final float[] latestGravity = new float[] {0f, 0f, 0f};
    private final float[] latestAccelerometer = new float[] {0f, 0f, 0f};
    private boolean hasLinear = false;
    private boolean hasGravity = false;
    private boolean hasAccelerometer = false;
    private float latestGyroMagnitude = 0f;

    private final GaitAnalyzer gaitAnalyzer = new GaitAnalyzer();

    private float latestSensorSteps = -1f;
    private float lastSensorValue = -1f;
    private long lastSensorEventAtMs = 0L;
    private boolean listenerRegistered = false;
    private final ArrayDeque<Long> stepTimesMillis = new ArrayDeque<>();

    private final SensorEventListener sensorListener = new SensorEventListener() {
        @Override
        public void onSensorChanged(SensorEvent event) {
            if (event == null || event.values == null || event.values.length == 0 || event.sensor == null) {
                return;
            }

            int sensorType = event.sensor.getType();
            if (sensorType == Sensor.TYPE_STEP_COUNTER) {
                float raw = event.values[0];

                long nowMs = System.currentTimeMillis();
                if (latestSensorSteps < 0f || lastSensorValue < 0f || raw < lastSensorValue) {
                    latestSensorSteps = raw;
                    stepTimesMillis.clear();
                } else if (raw >= lastSensorValue) {
                    int delta = Math.round(raw - lastSensorValue);
                    if (delta > 0) {
                        long elapsedMs = Math.max(1L, nowMs - lastSensorEventAtMs);
                        int maxDelta = Math.max(1, (int) Math.ceil(elapsedMs / 250.0));
                        int acceptedDelta = Math.min(delta, maxDelta);
                        latestSensorSteps = Math.max(0f, latestSensorSteps) + acceptedDelta;
                        for (int i = 0; i < acceptedDelta; i++) {
                            stepTimesMillis.addLast(nowMs);
                        }
                    }
                }

                lastSensorValue = raw;
                lastSensorEventAtMs = nowMs;
                trimOldStepTimes(nowMs);

                SharedPreferences prefs = getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
                prefs.edit().putFloat(KEY_LATEST_RAW, latestSensorSteps).apply();
                return;
            }

            if (sensorType == Sensor.TYPE_LINEAR_ACCELERATION && event.values.length >= 3) {
                latestLinear[0] = event.values[0];
                latestLinear[1] = event.values[1];
                latestLinear[2] = event.values[2];
                hasLinear = true;
            } else if (sensorType == Sensor.TYPE_GRAVITY && event.values.length >= 3) {
                latestGravity[0] = event.values[0];
                latestGravity[1] = event.values[1];
                latestGravity[2] = event.values[2];
                hasGravity = true;
            } else if (sensorType == Sensor.TYPE_ACCELEROMETER && event.values.length >= 3) {
                latestAccelerometer[0] = event.values[0];
                latestAccelerometer[1] = event.values[1];
                latestAccelerometer[2] = event.values[2];
                hasAccelerometer = true;
                if (!hasGravity) {
                    // Low-pass estimate of gravity when TYPE_GRAVITY is unavailable.
                    final float alpha = 0.92f;
                    latestGravity[0] = alpha * latestGravity[0] + (1f - alpha) * latestAccelerometer[0];
                    latestGravity[1] = alpha * latestGravity[1] + (1f - alpha) * latestAccelerometer[1];
                    latestGravity[2] = alpha * latestGravity[2] + (1f - alpha) * latestAccelerometer[2];
                    hasGravity = true;
                }
            } else if (sensorType == Sensor.TYPE_GYROSCOPE && event.values.length >= 3) {
                float gx = event.values[0];
                float gy = event.values[1];
                float gz = event.values[2];
                latestGyroMagnitude = (float) Math.sqrt(gx * gx + gy * gy + gz * gz);
            }

            feedGaitAnalyzer();
        }

        private void feedGaitAnalyzer() {
            if (!hasGravity) {
                return;
            }

            float lx;
            float ly;
            float lz;
            if (hasLinear) {
                lx = latestLinear[0];
                ly = latestLinear[1];
                lz = latestLinear[2];
            } else if (hasAccelerometer) {
                lx = latestAccelerometer[0] - latestGravity[0];
                ly = latestAccelerometer[1] - latestGravity[1];
                lz = latestAccelerometer[2] - latestGravity[2];
            } else {
                return;
            }

            gaitAnalyzer.addSample(
                System.currentTimeMillis(),
                lx,
                ly,
                lz,
                latestGravity[0],
                latestGravity[1],
                latestGravity[2],
                latestGyroMagnitude
            );
        }

        @Override
        public void onAccuracyChanged(Sensor sensor, int accuracy) {
            // no-op
        }
    };

    @Override
    public void load() {
        sensorManager = (SensorManager) getContext().getSystemService(Context.SENSOR_SERVICE);
        if (sensorManager != null) {
            stepCounterSensor = sensorManager.getDefaultSensor(Sensor.TYPE_STEP_COUNTER);
            linearAccelerationSensor = sensorManager.getDefaultSensor(Sensor.TYPE_LINEAR_ACCELERATION);
            gravitySensor = sensorManager.getDefaultSensor(Sensor.TYPE_GRAVITY);
            accelerometerSensor = sensorManager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER);
            gyroscopeSensor = sensorManager.getDefaultSensor(Sensor.TYPE_GYROSCOPE);
        }
    }

    @PluginMethod
    public void checkPermissions(PluginCall call) {
        JSObject ret = new JSObject();
        PermissionState state = activityRecognitionState();
        ret.put("activityRecognition", permissionStateToString(state));
        call.resolve(ret);
    }

    @PluginMethod
    public void checkAdvancedPermissions(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("activityRecognition", permissionStateToString(activityRecognitionState()));
        ret.put("location", permissionStateToString(getPermissionState("location")));
        ret.put("backgroundLocation", permissionStateToString(getPermissionState("backgroundLocation")));

        boolean exactAlarmAllowed = true;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            AlarmManager alarmManager = (AlarmManager) getContext().getSystemService(Context.ALARM_SERVICE);
            exactAlarmAllowed = alarmManager != null && alarmManager.canScheduleExactAlarms();
        }
        ret.put("exactAlarm", exactAlarmAllowed ? "granted" : "denied");
        call.resolve(ret);
    }

    @PluginMethod
    public void requestPermissions(PluginCall call) {
        if (activityRecognitionState() == PermissionState.GRANTED) {
            JSObject ret = new JSObject();
            ret.put("activityRecognition", "granted");
            call.resolve(ret);
            return;
        }

        requestPermissionForAlias("activityRecognition", call, "permissionCallback");
    }

    @PluginMethod
    public void requestLocationPermissions(PluginCall call) {
        if (getPermissionState("location") == PermissionState.GRANTED) {
            JSObject ret = new JSObject();
            ret.put("location", "granted");
            call.resolve(ret);
            return;
        }
        requestPermissionForAlias("location", call, "locationPermissionCallback");
    }

    @PluginMethod
    public void requestBackgroundLocationPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            JSObject ret = new JSObject();
            ret.put("backgroundLocation", "granted");
            call.resolve(ret);
            return;
        }

        if (getPermissionState("backgroundLocation") == PermissionState.GRANTED) {
            JSObject ret = new JSObject();
            ret.put("backgroundLocation", "granted");
            call.resolve(ret);
            return;
        }
        requestPermissionForAlias("backgroundLocation", call, "backgroundLocationPermissionCallback");
    }

    @PluginMethod
    public void openExactAlarmSettings(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            JSObject ret = new JSObject();
            ret.put("opened", false);
            ret.put("supported", false);
            call.resolve(ret);
            return;
        }

        Intent intent = new Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM);
        intent.setData(Uri.parse("package:" + getContext().getPackageName()));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);

        JSObject ret = new JSObject();
        ret.put("opened", true);
        ret.put("supported", true);
        call.resolve(ret);
    }

    @PluginMethod
    public void startStepSession(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("device_id", getOrCreateDeviceId());
        ret.put("platform", "android");
        ret.put("app_version", getAppVersion());
        ret.put("ml_model_version", getCurrentMlModelVersion());

        SharedPreferences prefs = getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String sessionId = prefs.getString(KEY_SESSION_ID, null);
        String sessionToken = prefs.getString(KEY_SESSION_TOKEN, null);
        String expiresAt = prefs.getString(KEY_SESSION_EXPIRES_AT, null);
        int nextSequence = prefs.getInt(KEY_SESSION_NEXT_SEQUENCE, 1);

        if (sessionId != null && sessionToken != null && expiresAt != null) {
            if (!isExpiredIso(expiresAt)) {
                ret.put("session_id", sessionId);
                ret.put("session_token", sessionToken);
                ret.put("expires_at", expiresAt);
                ret.put("next_sequence_number", nextSequence);
            } else {
                clearActiveStepSessionPrefs(prefs);
            }
        }

        call.resolve(ret);
    }

    @PluginMethod
    public void setActiveStepSession(PluginCall call) {
        String sessionId = call.getString("session_id", null);
        String sessionToken = call.getString("session_token", null);
        String expiresAt = call.getString("expires_at", null);
        Integer nextSequenceValue = call.getInt("next_sequence_number");
        int nextSequence = nextSequenceValue != null ? nextSequenceValue : 1;

        if (sessionId == null || sessionToken == null || expiresAt == null) {
            call.reject("Missing session fields.");
            return;
        }

        SharedPreferences prefs = getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        prefs.edit()
            .putString(KEY_SESSION_ID, sessionId)
            .putString(KEY_SESSION_TOKEN, sessionToken)
            .putString(KEY_SESSION_EXPIRES_AT, expiresAt)
            .putInt(KEY_SESSION_NEXT_SEQUENCE, Math.max(1, nextSequence))
            .putInt(KEY_SESSION_LAST_TOTAL, 0)
            .apply();

        JSObject ret = new JSObject();
        ret.put("saved", true);
        call.resolve(ret);
    }

    @PluginMethod
    public void clearActiveStepSession(PluginCall call) {
        SharedPreferences prefs = getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        clearActiveStepSessionPrefs(prefs);
        JSObject ret = new JSObject();
        ret.put("cleared", true);
        call.resolve(ret);
    }

    @PluginMethod
    public void getTodaySteps(PluginCall call) {
        if (activityRecognitionState() != PermissionState.GRANTED) {
            call.reject("Activity recognition permission not granted.");
            return;
        }

        if (stepCounterSensor == null || sensorManager == null) {
            JSObject ret = new JSObject();
            ret.put("steps", 0);
            ret.put("date", today());
            long nowMs = System.currentTimeMillis();
            ret.put("timestamp", nowMs);
            ret.put("timestamp_client", Instant.ofEpochMilli(nowMs).toString());
            ret.put("available", false);
            ret.put("device_id", getOrCreateDeviceId());
            ret.put("platform", "android");
            ret.put("app_version", getAppVersion());
            ret.put("ml_model_version", getCurrentMlModelVersion());
            call.resolve(ret);
            return;
        }

        final String today = today();
        SharedPreferences prefs = getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);

        ensureListenerRegistered();

        float raw = latestSensorSteps;
        if (raw < 0f) {
            raw = prefs.getFloat(KEY_LATEST_RAW, -1f);
            latestSensorSteps = raw;
        }

        if (raw < 0f) {
            call.reject("Step sensor is warming up. Try again in a moment.");
            return;
        }

        String baselineDate = prefs.getString(KEY_DATE, "");
        float baselineValue = prefs.getFloat(KEY_BASELINE, -1f);

        if (!today.equals(baselineDate) || baselineValue < 0f) {
            baselineValue = raw;
            prefs.edit()
                .putString(KEY_DATE, today)
                .putFloat(KEY_BASELINE, baselineValue)
                .apply();
        }

        int stepsToday = Math.max(0, Math.round(raw - baselineValue));
        long nowMs = System.currentTimeMillis();
        trimOldStepTimes(nowMs);
        int cadenceSpm = stepTimesMillis.size();
        int burst5s = countStepsInWindow(nowMs, 5_000L);
        GaitAnalyzer.Snapshot gait = gaitAnalyzer.getSnapshot();

        SharedPreferences prefsForSession = getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String sessionId = prefsForSession.getString(KEY_SESSION_ID, null);
        String sessionToken = prefsForSession.getString(KEY_SESSION_TOKEN, null);
        String expiresAt = prefsForSession.getString(KEY_SESSION_EXPIRES_AT, null);
        int nextSequence = prefsForSession.getInt(KEY_SESSION_NEXT_SEQUENCE, 1);
        int lastReportedTotal = prefsForSession.getInt(KEY_SESSION_LAST_TOTAL, -1);

        if (expiresAt != null && isExpiredIso(expiresAt)) {
            clearActiveStepSessionPrefs(prefsForSession);
            sessionId = null;
            sessionToken = null;
            expiresAt = null;
            nextSequence = 1;
            lastReportedTotal = -1;
        }

        int stepsDelta = lastReportedTotal >= 0 ? Math.max(0, stepsToday - lastReportedTotal) : stepsToday;
        prefsForSession.edit().putInt(KEY_SESSION_LAST_TOTAL, stepsToday).putInt(KEY_SESSION_NEXT_SEQUENCE, Math.max(1, nextSequence + 1)).apply();

        int cadenceOut = cadenceSpm;
        if (gait.validatedCadenceSpm > 0) {
            cadenceOut = Math.max(cadenceOut, gait.validatedCadenceSpm);
        }
        int burstOut = burst5s;
        if (gait.validatedBurst5s > 0) {
            burstOut = Math.max(burstOut, gait.validatedBurst5s);
        }

        JSObject ret = new JSObject();
        ret.put("steps", stepsToday);
        ret.put("steps_total", stepsToday);
        ret.put("steps_delta", stepsDelta);
        ret.put("date", today);
        ret.put("timestamp", nowMs);
        ret.put("timestamp_client", Instant.ofEpochMilli(nowMs).toString());
        ret.put("available", true);
        ret.put("device_id", getOrCreateDeviceId());
        ret.put("platform", "android");
        ret.put("app_version", getAppVersion());
        ret.put("session_id", sessionId);
        ret.put("session_token", sessionToken);
        ret.put("sequence_number", nextSequence);
        ret.put("ml_model_version", gait.mlModelVersion);
        ret.put("cadence_spm", cadenceOut);
        ret.put("burst_steps_5s", burstOut);
        ret.put("gait_state", gait.gaitState);
        ret.put("gait_confidence", gait.confidence);
        ret.put("gait_dominant_freq_hz", gait.dominantFreqHz);
        ret.put("gait_autocorr", gait.autocorr);
        ret.put("gait_interval_std_ms", gait.intervalStdMs);
        ret.put("gait_valid_peaks_2s", gait.validPeaks2s);
        ret.put("gait_gyro_variance", gait.gyroVariance);
        ret.put("gait_jerk_rms", gait.jerkRms);
        ret.put("carry_mode", gait.carryMode);
        ret.put("ml_motion_label", gait.mlMotionLabel);
        ret.put("ml_walk_probability", gait.mlWalkProbability);
        ret.put("ml_shake_probability", gait.mlShakeProbability);
        ret.put("smoothed_walk_probability", gait.smoothedWalkProbability);
        ret.put("smoothed_shake_probability", gait.smoothedShakeProbability);
        ret.put("ml_window_count", gait.mlWindowCount);
        ret.put("ml_confidence_stability", gait.mlConfidenceStability);
        ret.put("motion_entropy", gait.motionEntropy);
        ret.put("background_running", prefs.getBoolean(KEY_BACKGROUND_RUNNING, false));
        call.resolve(ret);
    }

    @PluginMethod
    public void startBackgroundCapture(PluginCall call) {
        if (activityRecognitionState() != PermissionState.GRANTED) {
            call.reject("Activity recognition permission not granted.");
            return;
        }

        Context context = getContext();
        Intent intent = new Intent(context, StepCaptureForegroundService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            ContextCompat.startForegroundService(context, intent);
        } else {
            context.startService(intent);
        }

        JSObject ret = new JSObject();
        ret.put("running", true);
        call.resolve(ret);
    }

    @PluginMethod
    public void stopBackgroundCapture(PluginCall call) {
        Context context = getContext();
        Intent intent = new Intent(context, StepCaptureForegroundService.class);
        context.stopService(intent);

        JSObject ret = new JSObject();
        ret.put("running", false);
        call.resolve(ret);
    }

    @PluginMethod
    public void getBackgroundStatus(PluginCall call) {
        SharedPreferences prefs = getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        JSObject ret = new JSObject();
        ret.put("running", prefs.getBoolean(KEY_BACKGROUND_RUNNING, false));
        call.resolve(ret);
    }

    @PluginMethod
    public void getPendingWaypoints(PluginCall call) {
        SharedPreferences prefs = getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String raw = prefs.getString(StepCaptureForegroundService.KEY_WAYPOINTS_JSON, "[]");
        String date = prefs.getString(StepCaptureForegroundService.KEY_WAYPOINTS_DATE, today());

        JSObject ret = new JSObject();
        ret.put("date", date);

        JSONArray source;
        try {
            source = new JSONArray(raw);
        } catch (Exception ignored) {
            source = new JSONArray();
        }

        com.getcapacitor.JSArray items = new com.getcapacitor.JSArray();
        for (int i = 0; i < source.length(); i++) {
            JSONObject src = source.optJSONObject(i);
            if (src == null) {
                continue;
            }

            JSObject item = new JSObject();
            item.put("hour", src.optInt("hour", 0));
            item.put("recorded_at", src.optString("recorded_at", ""));
            item.put("latitude", src.optDouble("latitude", 0));
            item.put("longitude", src.optDouble("longitude", 0));
            item.put("accuracy_m", src.optDouble("accuracy_m", 0));
            items.put(item);
        }
        ret.put("waypoints", items);
        call.resolve(ret);
    }

    @PluginMethod
    public void clearPendingWaypoints(PluginCall call) {
        SharedPreferences prefs = getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        // Optional `date` + `upTo` (recorded_at of the last uploaded point): only drop points that
        // were uploaded, so a point captured between read and clear is never lost.
        String date = call.getString("date", null);
        String upTo = call.getString("upTo", null);
        int remaining = 0;
        synchronized (StepCaptureForegroundService.class) {
            String storedDate = prefs.getString(StepCaptureForegroundService.KEY_WAYPOINTS_DATE, today());
            if (upTo != null && date != null && date.equals(storedDate)) {
                JSONArray kept = new JSONArray();
                try {
                    Instant cutoff = Instant.parse(upTo);
                    JSONArray source = new JSONArray(prefs.getString(StepCaptureForegroundService.KEY_WAYPOINTS_JSON, "[]"));
                    for (int i = 0; i < source.length(); i++) {
                        JSONObject item = source.optJSONObject(i);
                        if (item == null) continue;
                        try {
                            if (Instant.parse(item.optString("recorded_at", "")).isAfter(cutoff)) {
                                kept.put(item);
                            }
                        } catch (Exception ignoredItem) {
                            // Unparseable timestamp: drop it.
                        }
                    }
                } catch (Exception ignored) {
                    // Corrupt buffer: fall through and clear it.
                }
                remaining = kept.length();
                prefs.edit().putString(StepCaptureForegroundService.KEY_WAYPOINTS_JSON, kept.toString()).commit();
            } else if (upTo == null) {
                prefs.edit()
                    .putString(StepCaptureForegroundService.KEY_WAYPOINTS_JSON, "[]")
                    .putString(StepCaptureForegroundService.KEY_WAYPOINTS_DATE, today())
                    .commit();
            }
        }

        JSObject ret = new JSObject();
        ret.put("cleared", true);
        ret.put("remaining", remaining);
        call.resolve(ret);
    }

    private PermissionState activityRecognitionState() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            return PermissionState.GRANTED; // No runtime permission for the step counter before Android 10.
        }
        return getPermissionState("activityRecognition");
    }

    @Override
    protected void handleOnPause() {
        super.handleOnPause();
        unregisterListener();
    }

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        if (activityRecognitionState() == PermissionState.GRANTED) {
            ensureListenerRegistered();
        }
    }

    @Override
    protected void handleOnDestroy() {
        unregisterListener();
        synchronized (this) {
            if (sensorThread != null) {
                sensorThread.quitSafely();
                sensorThread = null;
                sensorHandlerInstance = null;
            }
        }
        super.handleOnDestroy();
    }

    @SuppressWarnings("unused")
    @PermissionCallback
    public void permissionCallback(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("activityRecognition", permissionStateToString(activityRecognitionState()));
        call.resolve(ret);
    }

    @SuppressWarnings("unused")
    @PermissionCallback
    public void locationPermissionCallback(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("location", permissionStateToString(getPermissionState("location")));
        call.resolve(ret);
    }

    @SuppressWarnings("unused")
    @PermissionCallback
    public void backgroundLocationPermissionCallback(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("backgroundLocation", permissionStateToString(getPermissionState("backgroundLocation")));
        call.resolve(ret);
    }

    private void ensureListenerRegistered() {
        if (listenerRegistered || sensorManager == null || stepCounterSensor == null) {
            return;
        }
        // ~200 motion events/s run through GaitAnalyzer: deliver them on a background thread,
        // never the UI thread (UI-thread delivery caused ANRs on slower devices).

        boolean stepRegistered = sensorManager.registerListener(
            sensorListener,
            stepCounterSensor,
            SensorManager.SENSOR_DELAY_NORMAL,
            sensorHandler()
        );

        boolean motionRegistered = false;
        if (linearAccelerationSensor != null) {
            motionRegistered = sensorManager.registerListener(
                sensorListener,
                linearAccelerationSensor,
                SensorManager.SENSOR_DELAY_GAME,
            sensorHandler()
            ) || motionRegistered;
        }

        if (gravitySensor != null) {
            motionRegistered = sensorManager.registerListener(
                sensorListener,
                gravitySensor,
                SensorManager.SENSOR_DELAY_GAME,
            sensorHandler()
            ) || motionRegistered;
        }

        if (accelerometerSensor != null && gravitySensor == null) {
            motionRegistered = sensorManager.registerListener(
                sensorListener,
                accelerometerSensor,
                SensorManager.SENSOR_DELAY_GAME,
            sensorHandler()
            ) || motionRegistered;
        }

        if (gyroscopeSensor != null) {
            motionRegistered = sensorManager.registerListener(
                sensorListener,
                gyroscopeSensor,
                SensorManager.SENSOR_DELAY_GAME,
            sensorHandler()
            ) || motionRegistered;
        }

        listenerRegistered = stepRegistered || motionRegistered;
    }

    private android.os.HandlerThread sensorThread;
    private android.os.Handler sensorHandlerInstance;

    private synchronized android.os.Handler sensorHandler() {
        if (sensorHandlerInstance == null) {
            sensorThread = new android.os.HandlerThread("Step2WinSensors");
            sensorThread.start();
            sensorHandlerInstance = new android.os.Handler(sensorThread.getLooper());
        }
        return sensorHandlerInstance;
    }

    private void unregisterListener() {
        if (!listenerRegistered || sensorManager == null) {
            return;
        }
        sensorManager.unregisterListener(sensorListener);
        listenerRegistered = false;
    }

    private void trimOldStepTimes(long nowMs) {
        long cutoff = nowMs - 60_000L;
        while (!stepTimesMillis.isEmpty() && stepTimesMillis.peekFirst() < cutoff) {
            stepTimesMillis.pollFirst();
        }
    }

    private int countStepsInWindow(long nowMs, long windowMs) {
        long cutoff = nowMs - windowMs;
        int count = 0;
        for (Long ts : stepTimesMillis) {
            if (ts >= cutoff) {
                count++;
            }
        }
        return count;
    }

    private static String permissionStateToString(PermissionState state) {
        if (state == PermissionState.GRANTED) {
            return "granted";
        }
        if (state == PermissionState.PROMPT || state == PermissionState.PROMPT_WITH_RATIONALE) {
            return "prompt";
        }
        return "denied";
    }

    private static String today() {
        return LocalDate.now(ZoneId.systemDefault()).format(DateTimeFormatter.ISO_LOCAL_DATE);
    }

    private String getOrCreateDeviceId() {
        SharedPreferences prefs = getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String stored = prefs.getString(KEY_DEVICE_ID, null);
        if (stored != null && !stored.isEmpty()) {
            return stored;
        }

        String androidId = Settings.Secure.getString(getContext().getContentResolver(), Settings.Secure.ANDROID_ID);
        String deviceId = (androidId != null && !androidId.trim().isEmpty()) ? androidId : UUID.randomUUID().toString();
        prefs.edit().putString(KEY_DEVICE_ID, deviceId).apply();
        return deviceId;
    }

    private String getAppVersion() {
        SharedPreferences prefs = getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String stored = prefs.getString(KEY_APP_VERSION, null);
        if (stored != null && !stored.isEmpty()) {
            return stored;
        }

        String version = "unknown";
        try {
            PackageInfo packageInfo = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
            if (packageInfo.versionName != null && !packageInfo.versionName.trim().isEmpty()) {
                version = packageInfo.versionName;
            }
        } catch (PackageManager.NameNotFoundException ignored) {
            // Fall back to unknown.
        }
        prefs.edit().putString(KEY_APP_VERSION, version).apply();
        return version;
    }

    private String getCurrentMlModelVersion() {
        SharedPreferences prefs = getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String stored = prefs.getString(KEY_ML_MODEL_VERSION, null);
        if (stored != null && !stored.isEmpty()) {
            return stored;
        }
        String modelVersion = gaitAnalyzer.getSnapshot().mlModelVersion;
        if (modelVersion == null || modelVersion.trim().isEmpty()) {
            modelVersion = "shakewalk-logreg-v1";
        }
        prefs.edit().putString(KEY_ML_MODEL_VERSION, modelVersion).apply();
        return modelVersion;
    }

    private boolean isExpiredIso(String isoValue) {
        try {
            return Instant.parse(isoValue).isBefore(Instant.now());
        } catch (Exception ignored) {
            return true;
        }
    }

    private void clearActiveStepSessionPrefs(SharedPreferences prefs) {
        prefs.edit()
            .remove(KEY_SESSION_ID)
            .remove(KEY_SESSION_TOKEN)
            .remove(KEY_SESSION_EXPIRES_AT)
            .remove(KEY_SESSION_NEXT_SEQUENCE)
            .remove(KEY_SESSION_LAST_TOTAL)
            .apply();
    }
}
