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
import android.location.Location;
import android.location.LocationManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.util.Log;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

import com.google.android.gms.common.ConnectionResult;
import com.google.android.gms.common.GoogleApiAvailability;
import com.google.android.gms.location.FusedLocationProviderClient;
import com.google.android.gms.location.LocationAvailability;
import com.google.android.gms.location.LocationCallback;
import com.google.android.gms.location.LocationRequest;
import com.google.android.gms.location.LocationResult;
import com.google.android.gms.location.LocationServices;
import com.google.android.gms.location.Priority;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * "Start a walk": a user-started foreground service (type location|health) that records one
 * walk with high-accuracy GPS (every ~3 s), the step counter (or accelerometer step detection
 * on phones without one) and gait analysis. Started ONLY by the user (plugin startWalk) while
 * the app is in front; never restarted by the system (START_NOT_STICKY), never started in the
 * background. GPS runs only during the session.
 *
 * Ends when the user stops it, after {@link WalkTracker#DEFAULT_AUTO_END_MS} (configurable) with
 * no steps / movement, or after 4 h. State and points survive process death (SharedPreferences
 * + an append-only points file); getWalkState works after the WebView reloads.
 */
public class WalkSessionService extends Service {
    private static final String TAG = "Step2WinWalkSession";
    static final String ACTION_START = "com.step2win.app.WALK_START";
    static final String ACTION_STOP = "com.step2win.app.WALK_STOP";
    static final String EXTRA_WALK_ID = "walkId";
    static final String EXTRA_AUTO_END_MS = "autoEndMs";
    private static final String PREFS = "step2win_walk";
    private static final String KEY_STATE = "state";
    private static final String POINTS_FILE = "walk_points.jsonl";
    private static final String CHANNEL_ID = "walk_session_channel";
    private static final int NOTIFICATION_ID = 4031;
    private static final long TICK_MS = 2_000L;
    private static final long LEDGER_EVERY_MS = 15_000L;
    private static final long LOCATION_INTERVAL_MS = 3_000L;

    /** Receives walk updates about every 2 s (main thread). */
    interface UpdateListener {
        void onWalkUpdate(JSONObject state);
    }

    static volatile UpdateListener updateListener;
    private static volatile WalkSessionService running;
    private static final Object FILE_LOCK = new Object();

    private final Handler main = new Handler(Looper.getMainLooper());
    private WalkTracker tracker;
    private FusedLocationProviderClient fused;
    private boolean locationRequested;
    private long lastLedgerAt = 0L;
    private long lastNotificationAt = 0L;
    private boolean stopping = false;
    private PowerManager.WakeLock wakeLock;

    // ── static API (plugin) ──────────────────────────────────────────────────

    static boolean isRunning() {
        return running != null;
    }

    static void start(Context context, String walkId, long autoEndMs) {
        Context app = context.getApplicationContext();
        Intent intent = new Intent(app, WalkSessionService.class)
            .setAction(ACTION_START)
            .putExtra(EXTRA_WALK_ID, walkId)
            .putExtra(EXTRA_AUTO_END_MS, autoEndMs);
        ContextCompat.startForegroundService(app, intent);
    }

    /**
     * Ends the walk now (user stop). Finalises synchronously when the service is alive so the
     * caller gets the final state immediately.
     */
    static JSONObject stop(Context context) {
        WalkSessionService s = running;
        if (s != null) {
            s.finishWalk(false, "user");
        } else {
            WalkTracker t = loadTracker(context);
            if (t.active) {
                t.finish(System.currentTimeMillis(), false);
                saveTracker(context, t);
            }
        }
        return state(context);
    }

    /** Current state (live when running; persisted otherwise, closing an orphaned walk). */
    static JSONObject state(Context context) {
        WalkSessionService s = running;
        long now = System.currentTimeMillis();
        if (s != null && s.tracker != null) {
            return s.tracker.toJson(now, pendingPoints(context));
        }
        WalkTracker t = loadTracker(context);
        if (t.active) {
            // The process died mid-walk (system kill / crash): the walk ended at its last update.
            t.finish(t.lastTickAt > 0 ? t.lastTickAt : now, true);
            saveTracker(context, t);
            EvidenceTracker.SHARED.setWalkActive(false);
        }
        return t.toJson(now, pendingPoints(context));
    }

    static String activeWalkId(Context context) {
        WalkSessionService s = running;
        if (s != null && s.tracker != null && s.tracker.active) return s.tracker.walkId;
        return null;
    }

    // ── points store (append-only file, drained by the plugin) ────────────────

    static void appendPoint(Context context, WalkTracker.Point p) {
        synchronized (FILE_LOCK) {
            File f = new File(context.getFilesDir(), POINTS_FILE);
            try (Writer w = new OutputStreamWriter(new FileOutputStream(f, true), StandardCharsets.UTF_8)) {
                w.write(p.toJson().toString());
                w.write('\n');
            } catch (Exception error) {
                Log.w(TAG, "point not stored", error);
            }
        }
    }

    private static List<String> readLines(File f) {
        List<String> lines = new ArrayList<>();
        if (!f.exists()) return lines;
        try (BufferedReader r = new BufferedReader(new InputStreamReader(new FileInputStream(f), StandardCharsets.UTF_8))) {
            String line;
            while ((line = r.readLine()) != null) {
                if (!line.trim().isEmpty()) lines.add(line);
            }
        } catch (Exception ignored) {
            // unreadable: treat as empty
        }
        return lines;
    }

    static int pendingPoints(Context context) {
        synchronized (FILE_LOCK) {
            return readLines(new File(context.getFilesDir(), POINTS_FILE)).size();
        }
    }

    /** Removes and returns up to `max` points, oldest first. */
    static JSONArray takePoints(Context context, int max) {
        JSONArray out = new JSONArray();
        synchronized (FILE_LOCK) {
            File f = new File(context.getFilesDir(), POINTS_FILE);
            List<String> lines = readLines(f);
            int n = Math.min(Math.max(0, max), lines.size());
            for (int i = 0; i < n; i++) {
                try {
                    out.put(new JSONObject(lines.get(i)));
                } catch (Exception ignored) {
                    // corrupt line: drop it
                }
            }
            List<String> rest = lines.subList(n, lines.size());
            if (rest.isEmpty()) {
                //noinspection ResultOfMethodCallIgnored
                f.delete();
            } else {
                try (Writer w = new OutputStreamWriter(new FileOutputStream(f, false), StandardCharsets.UTF_8)) {
                    for (String line : rest) {
                        w.write(line);
                        w.write('\n');
                    }
                } catch (Exception error) {
                    Log.w(TAG, "points not rewritten", error);
                }
            }
        }
        return out;
    }

    static void clearPoints(Context context) {
        synchronized (FILE_LOCK) {
            //noinspection ResultOfMethodCallIgnored
            new File(context.getFilesDir(), POINTS_FILE).delete();
        }
    }

    // ── persistence ──────────────────────────────────────────────────────────

    private static SharedPreferences prefs(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static WalkTracker loadTracker(Context context) {
        return WalkTracker.parse(prefs(context).getString(KEY_STATE, ""));
    }

    private static void saveTracker(Context context, WalkTracker t) {
        prefs(context).edit().putString(KEY_STATE, t.serialize()).apply();
    }

    static boolean hasFineLocation(Context context) {
        return ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    static boolean locationEnabled(Context context) {
        LocationManager lm = (LocationManager) context.getSystemService(Context.LOCATION_SERVICE);
        if (lm == null) return false;
        try {
            if (Build.VERSION.SDK_INT >= 28) return lm.isLocationEnabled();
            return lm.isProviderEnabled(LocationManager.GPS_PROVIDER) || lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER);
        } catch (Exception ignored) {
            return false;
        }
    }

    // ── lifecycle ────────────────────────────────────────────────────────────

    @Override
    public void onCreate() {
        super.onCreate();
        createChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        if (ACTION_STOP.equals(action)) {
            finishWalk(false, "user");
            return START_NOT_STICKY;
        }
        if (intent == null || !ACTION_START.equals(action)) {
            // A system restart without our intent: never resume GPS in the background.
            stopSelf();
            return START_NOT_STICKY;
        }
        if (!startInForeground()) {
            WalkTracker t = loadTracker(this);
            if (t.active) {
                t.finish(System.currentTimeMillis(), true);
                saveTracker(this, t);
            }
            stopSelf();
            return START_NOT_STICKY;
        }
        String walkId = intent.getStringExtra(EXTRA_WALK_ID);
        long autoEndMs = intent.getLongExtra(EXTRA_AUTO_END_MS, WalkTracker.DEFAULT_AUTO_END_MS);
        if (tracker != null && tracker.active) {
            return START_NOT_STICKY; // already recording (same walk)
        }
        MotionHub hub = MotionHub.get(this);
        String source = hub.hasStepCounter() ? "step_counter" : "accelerometer";
        long now = System.currentTimeMillis();
        stopping = false;
        clearPoints(this);
        tracker = new WalkTracker();
        tracker.start(walkId, now, source, autoEndMs);
        saveTracker(this, tracker);
        running = this;
        EvidenceTracker.SHARED.setWalkActive(true);
        // The automatic walking service isn't needed while a walk records.
        StepCaptureForegroundService.stop(this);
        hub.addListener(hubListener);
        hub.acquire(MotionHub.CLIENT_WALK);
        startLocation();
        renewWakeLock();
        main.removeCallbacks(tick);
        main.postDelayed(tick, TICK_MS);
        Log.i(TAG, "walk " + walkId + " started (" + source + ")");
        return START_NOT_STICKY;
    }

    private boolean startInForeground() {
        boolean fine = hasFineLocation(this);
        boolean activity = StepCaptureForegroundService.hasActivityRecognitionPermission(this);
        try {
            if (Build.VERSION.SDK_INT >= 34) {
                // location type needs the location permission; health needs ACTIVITY_RECOGNITION
                int types = 0;
                if (fine) types |= ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION;
                if (activity) types |= ServiceInfo.FOREGROUND_SERVICE_TYPE_HEALTH;
                if (types == 0) return false;
                startForeground(NOTIFICATION_ID, buildNotification(null), types);
            } else if (Build.VERSION.SDK_INT >= 29) {
                startForeground(NOTIFICATION_ID, buildNotification(null),
                    fine ? ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION : 0);
            } else {
                startForeground(NOTIFICATION_ID, buildNotification(null));
            }
            return true;
        } catch (RuntimeException error) {
            Log.w(TAG, "walk service could not start in the foreground", error);
            return false;
        }
    }

    @Override
    public void onDestroy() {
        main.removeCallbacks(tick);
        stopLocation();
        releaseWakeLock();
        MotionHub hub = MotionHub.get(this);
        hub.removeListener(hubListener);
        hub.release(MotionHub.CLIENT_WALK);
        if (tracker != null && tracker.active) {
            // destroyed without a stop (system): end the walk here
            tracker.finish(System.currentTimeMillis(), true);
            saveTracker(this, tracker);
        }
        recordLedger();
        EvidenceTracker.SHARED.setWalkActive(false);
        running = null;
        StepSyncScheduler.scheduleSoon(this, 30_000L, "walk_ended");
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private synchronized void finishWalk(boolean auto, String reason) {
        if (stopping) return;
        stopping = true;
        if (tracker != null && tracker.active) {
            tracker.finish(System.currentTimeMillis(), auto);
            saveTracker(this, tracker);
            Log.i(TAG, "walk " + tracker.walkId + " ended (" + reason + "), steps=" + tracker.steps);
        }
        EvidenceTracker.SHARED.setWalkActive(false);
        notifyUpdate();
        main.post(() -> {
            if (tracker != null && tracker.active) return; // a new walk started meanwhile
            stopLocation();
            try {
                stopForeground(STOP_FOREGROUND_REMOVE);
            } catch (RuntimeException ignored) {
                // no-op
            }
            stopSelf();
        });
    }

    // ── sensors ──────────────────────────────────────────────────────────────

    private final MotionHub.Listener hubListener = new MotionHub.Listener() {
        @Override
        public void onCounter(float raw, int delta, long wallMs) {
            WalkTracker t = tracker;
            if (t != null) t.onCounterSteps(delta, wallMs);
        }

        @Override
        public void onWindow(GaitClassifier.Result result, long wallMs) {
            WalkTracker t = tracker;
            if (t == null) return;
            int accelSteps = t.onWindow(result, wallMs);
            if (accelSteps > 0) {
                // No hardware counter on this phone: the walk's own steps go to the ledger.
                StepLedger.addWalkSteps(getApplicationContext(), accelSteps, wallMs - GaitWindowBuffer.HOP_MS, wallMs);
            }
        }
    };

    // ── location ─────────────────────────────────────────────────────────────

    private void startLocation() {
        stopLocation();
        if (!hasFineLocation(this)) {
            tracker.setGpsProblem("denied");
            return;
        }
        if (!locationEnabled(this)) {
            tracker.setGpsProblem("off");
        }
        try {
            if (GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(this) != ConnectionResult.SUCCESS) {
                tracker.setGpsProblem("unavailable");
                return;
            }
            fused = LocationServices.getFusedLocationProviderClient(this);
            LocationRequest request = new LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, LOCATION_INTERVAL_MS)
                .setMinUpdateIntervalMillis(2_000L)
                .setMaxUpdateDelayMillis(0L)
                .setWaitForAccurateLocation(false)
                .build();
            fused.requestLocationUpdates(request, locationCallback, Looper.getMainLooper());
            locationRequested = true;
        } catch (SecurityException denied) {
            tracker.setGpsProblem("denied");
        } catch (RuntimeException error) {
            Log.w(TAG, "location updates unavailable", error);
            tracker.setGpsProblem("unavailable");
        }
    }

    private void stopLocation() {
        if (locationRequested && fused != null) {
            try {
                fused.removeLocationUpdates(locationCallback);
            } catch (RuntimeException ignored) {
                // already removed
            }
        }
        locationRequested = false;
    }

    private final LocationCallback locationCallback = new LocationCallback() {
        @Override
        @SuppressWarnings("deprecation") // isFromMockProvider() below API 31
        public void onLocationResult(LocationResult result) {
            WalkTracker t = tracker;
            if (result == null || t == null) return;
            for (Location location : result.getLocations()) {
                boolean mock;
                if (Build.VERSION.SDK_INT >= 31) {
                    mock = location.isMock();
                } else {
                    //noinspection deprecation
                    mock = location.isFromMockProvider();
                }
                double acc = location.hasAccuracy() ? location.getAccuracy() : Double.NaN;
                double spd = location.hasSpeed() ? location.getSpeed() : Double.NaN;
                long when = location.getTime() > 0 ? location.getTime() : System.currentTimeMillis();
                WalkTracker.Point p = t.onLocation(when, location.getLatitude(), location.getLongitude(), acc, spd, mock, System.currentTimeMillis());
                if (p != null) appendPoint(getApplicationContext(), p);
            }
        }

        @Override
        public void onLocationAvailability(LocationAvailability availability) {
            WalkTracker t = tracker;
            if (t == null || availability == null) return;
            if (!availability.isLocationAvailable() && !locationEnabled(WalkSessionService.this)) {
                t.setGpsProblem("off");
            }
        }
    };

    // ── tick ─────────────────────────────────────────────────────────────────

    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            WalkTracker t = tracker;
            if (t == null || !t.active) return;
            long now = System.currentTimeMillis();
            if (!hasFineLocation(WalkSessionService.this)) {
                t.setGpsProblem("denied");
            } else if (!locationEnabled(WalkSessionService.this)) {
                t.setGpsProblem("off");
            }
            String end = t.tick(now, VehicleState.activeNow(WalkSessionService.this));
            if (t.gpsVehicleNow()) EvidenceTracker.SHARED.markWalkVehicle(now);
            if (now - lastLedgerAt >= LEDGER_EVERY_MS) {
                lastLedgerAt = now;
                recordLedger();
            }
            saveTracker(WalkSessionService.this, t);
            if (end != null) {
                finishWalk(true, end);
                return;
            }
            notifyUpdate();
            renewWakeLock();
            if (now - lastNotificationAt >= 10_000L) {
                lastNotificationAt = now;
                NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
                if (nm != null) {
                    try {
                        nm.notify(NOTIFICATION_ID, buildNotification(t));
                    } catch (RuntimeException ignored) {
                        // notification permission missing: the walk still records
                    }
                }
            }
            main.postDelayed(this, TICK_MS);
        }
    };

    /**
     * Short, renewed partial wake lock while the walk records (screen off in a pocket):
     * without it the tick, and the non-wakeup motion sensors, stall when the CPU suspends.
     * Never outlives the walk by more than a minute.
     */
    private void renewWakeLock() {
        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        if (pm == null) return;
        if (wakeLock == null) {
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "step2win:WalkSession");
            wakeLock.setReferenceCounted(false);
        }
        wakeLock.acquire(60_000L);
    }

    private void releaseWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        wakeLock = null;
    }

    private void recordLedger() {
        float raw = MotionHub.get(this).latestRaw();
        if (raw >= 0f) StepLedger.record(this, raw);
    }

    private void notifyUpdate() {
        UpdateListener l = updateListener;
        WalkTracker t = tracker;
        if (l == null || t == null) return;
        final JSONObject state = t.toJson(System.currentTimeMillis(), pendingPoints(this));
        main.post(() -> {
            UpdateListener current = updateListener;
            if (current != null) current.onWalkUpdate(state);
        });
    }

    // ── notification ─────────────────────────────────────────────────────────

    private Notification buildNotification(@Nullable WalkTracker t) {
        String text = "Recording your walk";
        if (t != null) {
            text = t.steps + " steps · " + String.format(java.util.Locale.ROOT, "%.2f km", t.distanceM / 1000.0);
        }
        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_step2win)
            .setColor(0xFF14855D)
            .setContentTitle("Walk in progress")
            .setContentText(text)
            .setCategory(NotificationCompat.CATEGORY_WORKOUT)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setSilent(true)
            .setOnlyAlertOnce(true)
            .setOngoing(true)
            .setUsesChronometer(true)
            .setWhen(t != null ? t.startedAt : System.currentTimeMillis());
        if (Build.VERSION.SDK_INT >= 31) {
            builder.setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE);
        }
        Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
        if (launch != null) {
            launch.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            builder.setContentIntent(PendingIntent.getActivity(this, 1, launch, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
        }
        return builder.build();
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "Walks", NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("Shown while a walk you started is being recorded.");
        channel.setShowBadge(false);
        channel.setSound(null, null);
        channel.enableVibration(false);
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) manager.createNotificationChannel(channel);
    }
}
