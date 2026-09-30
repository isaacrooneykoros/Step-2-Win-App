package com.step2win.app;

import android.app.AlarmManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import androidx.activity.result.ActivityResult;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import org.json.JSONArray;
import org.json.JSONObject;

import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.Iterator;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Android side of the 'DeviceStepCounter' Capacitor plugin (contract:
 * src/plugins/deviceStepCounter.ts; iOS: DeviceStepCounterPlugin.swift).
 *
 * Live sensors come from {@link MotionHub} (client "app" while the app is in front). Location
 * is foreground-only: it is asked at the first "Start a walk" and used only during walks
 * ({@link WalkSessionService}). Background location is never requested.
 */
@CapacitorPlugin(
    name = "DeviceStepCounter",
    permissions = {
        @Permission(alias = "activityRecognition", strings = {"android.permission.ACTIVITY_RECOGNITION"}),
        @Permission(alias = "location", strings = {
            "android.permission.ACCESS_COARSE_LOCATION",
            "android.permission.ACCESS_FINE_LOCATION"
        })
    }
)
public class DeviceStepCounterPlugin extends Plugin {
    private static final String PREFS = StepCaptureForegroundService.PREFS;
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

    private static final long LEDGER_WRITE_EVERY_MS = 15_000L;
    private static final long STEPS_EVENT_EVERY_MS = 3_000L;
    private static final int MAX_POINTS_PER_TAKE = 5000;

    private MotionHub hub;
    private final GaitAnalyzer gaitAnalyzer = GaitAnalyzer.SHARED;
    private final ExecutorService syncExecutor = Executors.newSingleThreadExecutor();
    private volatile long lastLedgerWriteAtMs = 0L;
    private long lastStepsEventAtMs = 0L;
    private int lastEmittedSteps = -1;
    private volatile long lastMovementAtMs = 0L;
    private boolean hubHeld = false;

    private final MotionHub.Listener hubListener = new MotionHub.Listener() {
        @Override
        public void onCounter(float raw, int delta, long wallMs) {
            if (delta > 0) lastMovementAtMs = wallMs;
            if (wallMs - lastLedgerWriteAtMs >= LEDGER_WRITE_EVERY_MS) {
                lastLedgerWriteAtMs = wallMs;
                StepLedger.record(getContext(), raw);
                getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                    .putFloat(KEY_LATEST_RAW, raw).apply();
            }
            maybeEmitSteps(wallMs, raw);
        }
    };

    private final WalkSessionService.UpdateListener walkListener = state -> {
        try {
            notifyListeners("walkUpdate", JSObject.fromJSONObject(state));
        } catch (Exception ignored) {
            // bridge gone
        }
    };

    @Override
    public void load() {
        hub = MotionHub.get(getContext());
        WalkSessionService.updateListener = walkListener;
        StepCaptureForegroundService.clearLegacyWaypoints(getContext());
    }

    // ── permissions ──────────────────────────────────────────────────────────

    @PluginMethod
    public void checkPermissions(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("activityRecognition", permissionStateToString(activityRecognitionState()));
        call.resolve(ret);
    }

    @PluginMethod
    public void checkAdvancedPermissions(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("activityRecognition", permissionStateToString(activityRecognitionState()));
        ret.put("location", permissionStateToString(getPermissionState("location")));
        boolean exactAlarmAllowed = true;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            AlarmManager alarmManager = (AlarmManager) getContext().getSystemService(Context.ALARM_SERVICE);
            exactAlarmAllowed = alarmManager != null && alarmManager.canScheduleExactAlarms();
        }
        ret.put("exactAlarm", exactAlarmAllowed ? "granted" : "denied");
        ret.put("exactAlarmApplicable", true);
        ret.put("platform", "android");
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

    /** Foreground location (asked at the first "Start a walk"). */
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

    @SuppressWarnings("unused")
    @PermissionCallback
    public void permissionCallback(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("activityRecognition", permissionStateToString(activityRecognitionState()));
        if (activityRecognitionState() == PermissionState.GRANTED && SyncPolicy.appInForeground) {
            ensureHub();
        }
        call.resolve(ret);
    }

    @SuppressWarnings("unused")
    @PermissionCallback
    public void locationPermissionCallback(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("location", permissionStateToString(getPermissionState("location")));
        call.resolve(ret);
    }

    // ── step session (replay protection) ─────────────────────────────────────

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

    /** Next sequence number of the active step session (strictly increasing). */
    @PluginMethod
    public void claimSequence(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("sequence_number", StepSyncEngine.claimSequence(getContext()));
        call.resolve(ret);
    }

    // ── steps ────────────────────────────────────────────────────────────────

    /** Phase 1b fields shared by every reading. */
    private void putEvidenceFields(JSObject ret, StepLedger.Day day) {
        ret.put("evidence_source", StepSyncEngine.EVIDENCE_SOURCE);
        ret.put("evidence_hours", StepSyncEngine.evidenceHoursJson(day));
        ret.put("install_id", InstallInfo.installId(getContext()));
        ret.put("tz_offset_minutes", InstallInfo.tzOffsetMinutes());
        ret.put("tz_name", InstallInfo.tzName());
    }

    @PluginMethod
    public void getTodaySteps(PluginCall call) {
        if (activityRecognitionState() != PermissionState.GRANTED) {
            call.reject("Activity recognition permission not granted.");
            return;
        }
        Context context = getContext();
        if (!hub.hasStepCounter()) {
            // No hardware counter: only walk steps (accelerometer) can be in the ledger.
            StepLedger.Day day = StepLedger.getDay(context, today());
            long nowMs = System.currentTimeMillis();
            JSObject ret = new JSObject();
            ret.put("steps", day.total);
            ret.put("date", day.date);
            ret.put("timestamp", nowMs);
            ret.put("timestamp_client", Instant.ofEpochMilli(nowMs).toString());
            ret.put("available", false);
            ret.put("cadence_spm", 0);
            ret.put("burst_steps_5s", 0);
            ret.put("burst_source", "arrival_batched");
            ret.put("device_id", getOrCreateDeviceId());
            ret.put("platform", "android");
            ret.put("app_version", getAppVersion());
            ret.put("ml_model_version", getCurrentMlModelVersion());
            ret.put("background_running", false);
            putEvidenceFields(ret, day);
            call.resolve(ret);
            return;
        }

        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        if (SyncPolicy.appInForeground) ensureHub();

        float raw = hub.latestRaw();
        if (raw < 0f) {
            // Listener just registered (or the app isn't in front): read the counter directly.
            raw = StepCounterReader.readOnce(context, 2_500L);
        }
        if (raw >= 0f) {
            StepLedger.record(context, raw);
            lastLedgerWriteAtMs = System.currentTimeMillis();
        } else if (StepLedger.lastReadingAt(context) == 0L) {
            call.reject("Step sensor is warming up. Try again in a moment.");
            return;
        }

        // Today's steps from the durable ledger: survives reboots and app kills, and includes
        // the steps taken while the app was closed (and a reinstall resume, if any).
        StepLedger.Day day = StepLedger.getDay(context, today());
        int stepsToday = day.total;
        long nowMs = System.currentTimeMillis();
        boolean liveFresh = nowMs - StepSyncEngine.liveUpdatedAt < 2 * 60_000L;
        int cadenceSpm = liveFresh ? StepSyncEngine.liveCadenceSpm : 0;
        int burst5s = liveFresh ? StepSyncEngine.liveBurst5s : 0;
        GaitAnalyzer.Snapshot gait = gaitAnalyzer.getSnapshot();

        String sessionId = prefs.getString(KEY_SESSION_ID, null);
        String sessionToken = prefs.getString(KEY_SESSION_TOKEN, null);
        String expiresAt = prefs.getString(KEY_SESSION_EXPIRES_AT, null);
        int nextSequence = prefs.getInt(KEY_SESSION_NEXT_SEQUENCE, 1);
        int lastReportedTotal = prefs.getInt(KEY_SESSION_LAST_TOTAL, -1);
        if (expiresAt != null && isExpiredIso(expiresAt)) {
            clearActiveStepSessionPrefs(prefs);
            sessionId = null;
            sessionToken = null;
            nextSequence = 1;
            lastReportedTotal = -1;
        }
        // Reading steps doesn't consume a sequence number: numbers are claimed only when an
        // upload is actually sent (StepSyncEngine / claimSequence()).
        int stepsDelta = lastReportedTotal >= 0 ? Math.max(0, stepsToday - lastReportedTotal) : stepsToday;

        int cadenceOut = cadenceSpm;
        if (gait.validatedCadenceSpm > 0) cadenceOut = Math.max(cadenceOut, gait.validatedCadenceSpm);
        // The burst is reported as measured: mixing in the analyzer's estimate would make a
        // "live_timed" value partly untimed.
        int burstOut = burst5s;

        JSObject ret = new JSObject();
        ret.put("steps", stepsToday);
        ret.put("steps_total", stepsToday);
        ret.put("steps_delta", stepsDelta);
        ret.put("date", day.date);
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
        ret.put("burst_source", liveFresh ? StepSyncEngine.burstSource() : "arrival_batched");
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
        ret.put("gait_available", true);
        ret.put("background_running", prefs.getBoolean(KEY_BACKGROUND_RUNNING, false));
        putEvidenceFields(ret, day);
        call.resolve(ret);
    }

    /**
     * Enables smart background capture. It does NOT start a foreground service: the
     * hardware counter counts by itself, WorkManager uploads, and the walking service only
     * starts when the user actually walks during a challenge day.
     */
    @PluginMethod
    public void startBackgroundCapture(PluginCall call) {
        if (activityRecognitionState() != PermissionState.GRANTED) {
            call.reject("Activity recognition permission not granted.");
            return;
        }
        Context context = getContext();
        SyncPolicy.prefs(context).edit().putBoolean(SyncPolicy.KEY_CAPTURE_ENABLED, true).apply();
        if (!SyncPolicy.apiBase(context).isEmpty()) {
            StepSyncScheduler.ensurePeriodic(context);
        }
        MotionTriggers.refresh(context);
        JSObject ret = new JSObject();
        ret.put("running", StepCaptureForegroundService.isRunning());
        ret.put("smart", true);
        call.resolve(ret);
    }

    @PluginMethod
    public void stopBackgroundCapture(PluginCall call) {
        Context context = getContext();
        SyncPolicy.prefs(context).edit().putBoolean(SyncPolicy.KEY_CAPTURE_ENABLED, false).apply();
        StepCaptureForegroundService.stop(context);
        MotionTriggers.refresh(context);
        JSObject ret = new JSObject();
        ret.put("running", false);
        call.resolve(ret);
    }

    @PluginMethod
    public void getBackgroundStatus(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("running", StepCaptureForegroundService.isRunning());
        ret.put("motionTriggers", MotionTriggers.isRegistered(getContext()));
        ret.put("backgroundIntervalMinutes", StepSyncScheduler.currentIntervalMinutes(getContext()));
        call.resolve(ret);
    }

    /**
     * Web layer -> native sync settings: API URL, stride/weight (distance and calories),
     * Data Saver, and the user's active challenge date ranges (15-min cadence on challenge
     * days, the walking service, and the deadline boost).
     */
    @PluginMethod
    public void configureSync(PluginCall call) {
        Context context = getContext();
        SharedPreferences.Editor editor = SyncPolicy.prefs(context).edit();
        String apiBase = call.getString("apiBaseUrl", null);
        if (apiBase != null && !apiBase.trim().isEmpty()) editor.putString(SyncPolicy.KEY_API_BASE, apiBase.trim());
        Double stride = call.getDouble("strideCm");
        if (stride != null && stride > 0) editor.putFloat(SyncPolicy.KEY_STRIDE_CM, stride.floatValue());
        Double weight = call.getDouble("weightKg");
        if (weight != null && weight > 0) editor.putFloat(SyncPolicy.KEY_WEIGHT_KG, weight.floatValue());
        Boolean dataSaver = call.getBoolean("dataSaver");
        if (dataSaver != null) editor.putBoolean(SyncPolicy.KEY_DATA_SAVER, dataSaver);
        JSArray windows = call.getArray("challengeWindows");
        if (windows != null) editor.putString(SyncPolicy.KEY_CHALLENGES, windows.toString());
        editor.commit();
        StepSyncScheduler.ensurePeriodic(context);
        MotionTriggers.refresh(context);
        JSObject ret = new JSObject();
        ret.put("backgroundIntervalMinutes", StepSyncScheduler.currentIntervalMinutes(context));
        ret.put("challengeActiveToday", SyncPolicy.challengeActiveToday(context));
        ret.put("nearDeadline", SyncPolicy.nearDeadline(context));
        ret.put("motionTriggers", MotionTriggers.isRegistered(context));
        call.resolve(ret);
    }

    /** Runs the native uploader now (off the UI thread). Honours Retry-After / backoff. */
    @PluginMethod
    public void syncNow(PluginCall call) {
        final boolean force = Boolean.TRUE.equals(call.getBoolean("force", false));
        final String reason = call.getString("reason", "app");
        final Context context = getContext();
        final float raw = hub.latestRaw();
        syncExecutor.execute(() -> {
            if (raw >= 0f) {
                StepLedger.record(context, raw);
            } else {
                StepCounterReader.readAndRecord(context, 2_500L);
            }
            StepSyncEngine.Options options = new StepSyncEngine.Options();
            options.force = force;
            options.foreground = SyncPolicy.appInForeground;
            options.reason = reason;
            StepSyncEngine.Result result = StepSyncEngine.run(context, options);
            // Phase 1c: Health Connect (opt-in) on app open / resume, rate-limited, AFTER our
            // own steps went up (a slow provider never delays them); new summaries upload
            // in a second, health-only pass. Never fails the step sync.
            try {
                String health = HealthSources.refresh(context, !SyncPolicy.appInForeground, false);
                String userKey = StepSyncEngine.currentUserKey(context);
                if (("ok".equals(health) || "partial".equals(health))
                    && HealthSources.pendingUploads(context, userKey).length() > 0
                    && !"backoff".equals(result.status) && !"throttled".equals(result.status)
                    && !"offline".equals(result.status)) {
                    StepSyncEngine.Result second = StepSyncEngine.run(context, options);
                    if ("ok".equals(second.status) && !"ok".equals(result.status)) result = second;
                }
            } catch (Throwable ignored) {
                // Health Connect missing / crashed: our own counting carries on
            }
            try {
                call.resolve(JSObject.fromJSONObject(result.toJson()));
            } catch (Exception error) {
                call.reject("Sync result unavailable");
            }
        });
    }

    // ── Phase 1c: Health Connect (opt-in, read-only) ─────────────────────────

    @PluginMethod
    public void healthSourcesStatus(PluginCall call) {
        final Context context = getContext();
        syncExecutor.execute(() -> resolveHealthStatus(call, context, null));
    }

    /**
     * Opt in and show Health Connect's own permission screen (read steps, exercise,
     * routes, background). When Health Connect is missing or too old, resolves with that
     * state instead (the app offers the Play Store install and carries on without it).
     */
    @PluginMethod
    public void healthSourcesConnect(PluginCall call) {
        Context context = getContext();
        HealthSources.setOptedIn(context, true);
        String availability = HealthSources.availability(context);
        if (!"available".equals(availability)) {
            resolveHealthStatus(call, context, null);
            return;
        }
        try {
            startActivityForResult(call, HealthConnectPermissions.requestIntent(context, HealthSources.requestedPermissions()), "healthPermissionResult");
        } catch (Throwable t) {
            resolveHealthStatus(call, context, "permission_screen_unavailable");
        }
    }

    @ActivityCallback
    private void healthPermissionResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        final Context context = getContext();
        syncExecutor.execute(() -> {
            try {
                HealthSources.refresh(context, false, true);
            } catch (Throwable ignored) {
                // status below says what happened
            }
            resolveHealthStatus(call, context, null);
        });
    }

    @PluginMethod
    public void healthSourcesRead(PluginCall call) {
        final Context context = getContext();
        syncExecutor.execute(() -> {
            try {
                HealthSources.refresh(context, !SyncPolicy.appInForeground, true);
            } catch (Throwable ignored) {
                // status below
            }
            resolveHealthStatus(call, context, null);
        });
    }

    /** Stop reading, forget what was read and hand the permissions back to Health Connect. */
    @PluginMethod
    public void healthSourcesDisconnect(PluginCall call) {
        final Context context = getContext();
        HealthSources.setOptedIn(context, false);
        syncExecutor.execute(() -> {
            try {
                if ("available".equals(HealthSources.availability(context))) HealthConnectPermissions.revokeAll(context);
            } catch (Throwable ignored) {
                // already gone / Health Connect missing
            }
            resolveHealthStatus(call, context, null);
        });
    }

    /** Android 9-13: Play Store page of the Health Connect app. */
    @PluginMethod
    public void healthSourcesInstall(PluginCall call) {
        Context context = getContext();
        JSObject ret = new JSObject();
        try {
            context.startActivity(HealthConnectPermissions.installIntent());
            ret.put("opened", true);
        } catch (Throwable t) {
            try {
                context.startActivity(HealthConnectPermissions.installWebIntent());
                ret.put("opened", true);
            } catch (Throwable t2) {
                ret.put("opened", false);
            }
        }
        call.resolve(ret);
    }

    @PluginMethod
    public void healthSourcesOpenSettings(PluginCall call) {
        JSObject ret = new JSObject();
        try {
            android.content.Intent intent = HealthConnectPermissions.settingsIntent(getContext());
            intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            ret.put("opened", true);
        } catch (Throwable t) {
            ret.put("opened", false);
        }
        call.resolve(ret);
    }

    private void resolveHealthStatus(PluginCall call, Context context, String note) {
        try {
            JSObject ret = JSObject.fromJSONObject(HealthSources.status(context));
            if (note != null) ret.put("note", note);
            call.resolve(ret);
        } catch (Throwable t) {
            call.reject("Health Connect status unavailable");
        }
    }

    @PluginMethod
    public void getSyncStatus(PluginCall call) {
        try {
            call.resolve(JSObject.fromJSONObject(StepSyncEngine.status(getContext())));
        } catch (Exception error) {
            call.reject("Sync status unavailable");
        }
    }

    /** Background route points no longer exist (no background location): always empty. */
    @PluginMethod
    public void getPendingWaypoints(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("date", today());
        ret.put("waypoints", new JSArray());
        call.resolve(ret);
    }

    @PluginMethod
    public void clearPendingWaypoints(PluginCall call) {
        StepCaptureForegroundService.clearLegacyWaypoints(getContext());
        JSObject ret = new JSObject();
        ret.put("cleared", true);
        ret.put("remaining", 0);
        call.resolve(ret);
    }

    // ── walks ────────────────────────────────────────────────────────────────

    @PluginMethod
    public void startWalk(PluginCall call) {
        String walkId = call.getString("walkId", null);
        if (walkId == null || walkId.trim().isEmpty()) {
            call.reject("walkId is required.");
            return;
        }
        Context context = getContext();
        JSObject ret = new JSObject();
        String active = WalkSessionService.activeWalkId(context);
        String source = hub.hasStepCounter() ? "step_counter" : "accelerometer";
        if (active != null) {
            ret.put("started", active.equals(walkId));
            if (!active.equals(walkId)) ret.put("reason", "already_active");
            ret.put("stepSource", source);
            call.resolve(ret);
            return;
        }
        String reason = null;
        if (!hub.hasStepCounter() && !hub.hasAccelerometer()) {
            reason = "unsupported";
        } else if (activityRecognitionState() != PermissionState.GRANTED) {
            reason = "activity_permission";
        } else if (!WalkSessionService.hasFineLocation(context)) {
            reason = "location_permission";
        } else if (!WalkSessionService.locationEnabled(context)) {
            reason = "gps_off";
        }
        if (reason != null) {
            ret.put("started", false);
            ret.put("reason", reason);
            ret.put("stepSource", source);
            call.resolve(ret);
            return;
        }
        Double autoEndMinutes = call.getDouble("autoEndMinutes");
        long autoEndMs = autoEndMinutes != null && autoEndMinutes > 0
            ? (long) (Math.max(3.0, Math.min(60.0, autoEndMinutes)) * 60_000L)
            : WalkTracker.DEFAULT_AUTO_END_MS;
        try {
            WalkSessionService.start(context, walkId.trim(), autoEndMs);
        } catch (RuntimeException notAllowed) {
            ret.put("started", false);
            ret.put("reason", "unsupported");
            ret.put("stepSource", source);
            call.resolve(ret);
            return;
        }
        ret.put("started", true);
        ret.put("stepSource", source);
        call.resolve(ret);
    }

    @PluginMethod
    public void getWalkState(PluginCall call) {
        try {
            call.resolve(JSObject.fromJSONObject(WalkSessionService.state(getContext())));
        } catch (Exception error) {
            call.reject("Walk state unavailable");
        }
    }

    @PluginMethod
    public void takeWalkPoints(PluginCall call) {
        Integer max = call.getInt("max");
        int n = max != null && max > 0 ? Math.min(max, MAX_POINTS_PER_TAKE) : 500;
        JSObject ret = new JSObject();
        ret.put("points", WalkSessionService.takePoints(getContext(), n));
        call.resolve(ret);
    }

    @PluginMethod
    public void stopWalk(PluginCall call) {
        try {
            JSONObject state = WalkSessionService.stop(getContext());
            JSObject ret = JSObject.fromJSONObject(state);
            ret.put("points", WalkSessionService.takePoints(getContext(), MAX_POINTS_PER_TAKE));
            ret.put("pointsPending", WalkSessionService.pendingPoints(getContext()));
            call.resolve(ret);
        } catch (Exception error) {
            call.reject("Walk could not be stopped");
        }
    }

    // ── device integrity / capabilities ──────────────────────────────────────

    @PluginMethod
    public void requestIntegrityToken(PluginCall call) {
        String nonce = call.getString("nonce", null);
        JSObject ret = new JSObject();
        if (nonce == null || nonce.length() < 16) {
            ret.put("token", JSObject.NULL);
            ret.put("error", "bad_nonce");
            call.resolve(ret);
            return;
        }
        if (DeviceIntegrity.cloudProjectNumber() <= 0) {
            ret.put("token", JSObject.NULL);
            ret.put("error", "not_configured");
            call.resolve(ret);
            return;
        }
        try {
            DeviceIntegrity.startTokenRequest(getContext(), nonce)
                .addOnSuccessListener(response -> {
                    JSObject ok = new JSObject();
                    String token = response != null ? response.token() : null;
                    ok.put("token", token != null ? token : JSObject.NULL);
                    if (token == null) ok.put("error", "empty_token");
                    call.resolve(ok);
                })
                .addOnFailureListener(error -> {
                    JSObject failed = new JSObject();
                    failed.put("token", JSObject.NULL);
                    failed.put("error", DeviceIntegrity.errorCode(error));
                    call.resolve(failed);
                });
        } catch (Throwable error) {
            ret.put("token", JSObject.NULL);
            ret.put("error", DeviceIntegrity.errorCode(error));
            call.resolve(ret);
        }
    }

    @PluginMethod
    public void getDeviceSignals(PluginCall call) {
        try {
            call.resolve(JSObject.fromJSONObject(DeviceIntegrity.signals(getContext())));
        } catch (Exception error) {
            call.reject("Device signals unavailable");
        }
    }

    @PluginMethod
    public void getSensorCapabilities(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("hasStepCounter", hub.hasStepCounter());
        ret.put("hasStepDetector", hub.hasStepDetector());
        ret.put("hasAccelerometer", hub.hasAccelerometer());
        ret.put("hasGyroscope", hub.hasGyroscope());
        ret.put("hasGravity", hub.hasGravity());
        ret.put("walkSupported", hub.hasStepCounter() || hub.hasAccelerometer());
        call.resolve(ret);
    }

    // ── lifecycle ────────────────────────────────────────────────────────────

    private PermissionState activityRecognitionState() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            return PermissionState.GRANTED; // No runtime permission for the step counter before Android 10.
        }
        return getPermissionState("activityRecognition");
    }

    private synchronized void ensureHub() {
        if (hubHeld || hub == null) return;
        hub.addListener(hubListener);
        hub.acquire(MotionHub.CLIENT_APP);
        hubHeld = true;
    }

    private synchronized void releaseHub() {
        if (!hubHeld || hub == null) return;
        hub.removeListener(hubListener);
        hub.release(MotionHub.CLIENT_APP);
        hubHeld = false;
    }

    @Override
    protected void handleOnPause() {
        super.handleOnPause();
        SyncPolicy.appInForeground = false;
        float raw = hub.latestRaw();
        if (raw >= 0f) {
            StepLedger.record(getContext(), raw);
        }
        releaseHub();
        // Leaving the app mid-walk on a challenge day: hand gait analysis to the walking
        // service (starting it now, while the activity is still visible, is allowed).
        boolean walkingNow = System.currentTimeMillis() - lastMovementAtMs < 90_000L;
        if (walkingNow && SyncPolicy.captureEnabled(getContext())) {
            StepCaptureForegroundService.start(getContext(), "app_left_while_walking");
        }
    }

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        SyncPolicy.appInForeground = true;
        // The open app analyses motion itself; the walking service isn't needed now.
        StepCaptureForegroundService.stop(getContext());
        if (activityRecognitionState() == PermissionState.GRANTED) {
            ensureHub();
        }
    }

    @Override
    protected void handleOnDestroy() {
        SyncPolicy.appInForeground = false;
        if (WalkSessionService.updateListener == walkListener) {
            WalkSessionService.updateListener = null;
        }
        syncExecutor.shutdown();
        releaseHub();
        super.handleOnDestroy();
    }

    /** "stepsChanged" events so the web layer syncs on meaningful change instead of polling. */
    private void maybeEmitSteps(long nowMs, float raw) {
        if (nowMs - lastStepsEventAtMs < STEPS_EVENT_EVERY_MS) {
            return;
        }
        lastStepsEventAtMs = nowMs;
        if (nowMs - lastLedgerWriteAtMs > 1_000L) {
            lastLedgerWriteAtMs = nowMs;
            StepLedger.record(getContext(), raw);
        }
        int steps = StepLedger.todayTotal(getContext());
        if (steps == lastEmittedSteps) {
            return;
        }
        lastEmittedSteps = steps;
        JSObject data = new JSObject();
        data.put("steps", steps);
        data.put("date", today());
        data.put("cadence_spm", StepSyncEngine.liveCadenceSpm);
        notifyListeners("stepsChanged", data);
    }

    // ── helpers ──────────────────────────────────────────────────────────────

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
        String version = "unknown";
        try {
            PackageInfo packageInfo = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
            if (packageInfo.versionName != null && !packageInfo.versionName.trim().isEmpty()) {
                version = packageInfo.versionName;
            }
        } catch (PackageManager.NameNotFoundException ignored) {
            // Fall back to the stored / unknown value.
        }
        if ("unknown".equals(version) && stored != null && !stored.isEmpty()) return stored;
        if (!version.equals(stored)) prefs.edit().putString(KEY_APP_VERSION, version).apply();
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
