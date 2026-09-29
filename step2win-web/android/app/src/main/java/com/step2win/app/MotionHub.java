package com.step2win.app;

import android.content.Context;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.SystemClock;
import android.util.Log;

import java.util.ArrayDeque;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * One process-wide set of sensor listeners, shared by everyone who needs live data:
 * "app" (the plugin while the app is open), "capture" (the automatic walking service) and
 * "walk" (a user walk session). Registered while at least one client holds it, released when
 * the last one lets go. Sharing matters: every live counter step is observed exactly once by
 * {@link EvidenceTracker}, however many clients are active.
 *
 * Feeds:
 * - TYPE_STEP_COUNTER -> step deltas (EvidenceTracker + clients), arrival-based cadence;
 * - TYPE_STEP_DETECTOR (if present) -> per-step SENSOR timestamps: burst_steps_5s and cadence
 *   become "live_timed" (real step times, even when the sensor hub batches delivery);
 * - TYPE_ACCELEROMETER (+ TYPE_GYROSCOPE / TYPE_GRAVITY when present, sample-and-hold) ->
 *   {@link GaitWindowBuffer} / {@link GaitClassifier} windows every 2.5 s -> EvidenceTracker,
 *   and the legacy {@link GaitAnalyzer} snapshot (upload fields kept for compatibility).
 * Motion sensors run at ~50 Hz with a 2 s maxReportLatency (hardware FIFO batching lets the
 * CPU sleep between batches on phones that support it). Sample times are the sensor
 * timestamps (elapsedRealtimeNanos base), never the arrival time.
 */
public final class MotionHub {
    private static final String TAG = "Step2WinMotionHub";
    static final String CLIENT_APP = "app";
    static final String CLIENT_CAPTURE = "capture";
    static final String CLIENT_WALK = "walk";

    private static final int MOTION_PERIOD_US = 20_000;          // 50 Hz
    private static final int MOTION_MAX_LATENCY_US = 2_000_000;  // batch up to 2 s
    private static final long HOLD_STALE_MS = 250L;              // gyro / gravity sample-and-hold

    public interface Listener {
        /** Hardware counter event: raw value and new steps since the previous event (0 on the first). */
        default void onCounter(float raw, int delta, long wallMs) {}

        /** A classified gait window. */
        default void onWindow(GaitClassifier.Result result, long wallMs) {}
    }

    private static MotionHub instance;

    static synchronized MotionHub get(Context context) {
        if (instance == null) instance = new MotionHub(context.getApplicationContext());
        return instance;
    }

    private final Context app;
    private final SensorManager sensorManager;
    private final Sensor counter, detector, accel, gyro, gravity;
    private final Set<String> clients = new HashSet<>();
    private final CopyOnWriteArrayList<Listener> listeners = new CopyOnWriteArrayList<>();
    private final GaitWindowBuffer windows = new GaitWindowBuffer();
    private HandlerThread thread;
    private Handler handler;
    private boolean registered;

    // sensor-thread state
    private float lastRaw = -1f;
    private long lastRawAtMs = 0L;
    private final ArrayDeque<Long> arrivalSteps = new ArrayDeque<>();
    private final ArrayDeque<Long> timedSteps = new ArrayDeque<>();
    private float gyroMag = Float.NaN;
    private long gyroAt = 0L;
    private final float[] grav = new float[] {Float.NaN, Float.NaN, Float.NaN};
    private long gravAt = 0L;
    private final float[] lowPass = new float[3];
    private boolean lowPassPrimed = false;
    private volatile long lastMovementAtMs = 0L;
    private volatile float latestRaw = -1f;

    private MotionHub(Context app) {
        this.app = app;
        sensorManager = (SensorManager) app.getSystemService(Context.SENSOR_SERVICE);
        if (sensorManager != null) {
            counter = sensorManager.getDefaultSensor(Sensor.TYPE_STEP_COUNTER);
            detector = sensorManager.getDefaultSensor(Sensor.TYPE_STEP_DETECTOR);
            accel = sensorManager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER);
            gyro = sensorManager.getDefaultSensor(Sensor.TYPE_GYROSCOPE);
            gravity = sensorManager.getDefaultSensor(Sensor.TYPE_GRAVITY);
        } else {
            counter = detector = accel = gyro = gravity = null;
        }
    }

    boolean hasStepCounter() {
        return counter != null;
    }

    boolean hasStepDetector() {
        return detector != null;
    }

    boolean hasAccelerometer() {
        return accel != null;
    }

    boolean hasGyroscope() {
        return gyro != null;
    }

    boolean hasGravity() {
        return gravity != null;
    }

    /** Latest raw counter value seen live (-1 if none). */
    float latestRaw() {
        return latestRaw;
    }

    /** Wall time of the last live counter step. */
    long lastMovementAt() {
        return lastMovementAtMs;
    }

    void addListener(Listener l) {
        if (l != null && !listeners.contains(l)) listeners.add(l);
    }

    void removeListener(Listener l) {
        listeners.remove(l);
    }

    synchronized void acquire(String client) {
        clients.add(client);
        if (!registered) register();
    }

    synchronized void release(String client) {
        clients.remove(client);
        if (clients.isEmpty() && registered) unregister();
    }

    synchronized boolean isHeld(String client) {
        return clients.contains(client);
    }

    private void register() {
        if (sensorManager == null) return;
        thread = new HandlerThread("Step2WinSensors");
        thread.start();
        handler = new Handler(thread.getLooper());
        lastRaw = -1f;
        windows.reset();
        lowPassPrimed = false;
        boolean any = false;
        try {
            if (counter != null) any |= sensorManager.registerListener(listener, counter, SensorManager.SENSOR_DELAY_NORMAL, handler);
            if (detector != null) any |= sensorManager.registerListener(listener, detector, SensorManager.SENSOR_DELAY_NORMAL, handler);
        } catch (SecurityException noPermission) {
            Log.i(TAG, "step sensors need ACTIVITY_RECOGNITION");
        }
        if (accel != null) any |= sensorManager.registerListener(listener, accel, MOTION_PERIOD_US, MOTION_MAX_LATENCY_US, handler);
        if (gyro != null) sensorManager.registerListener(listener, gyro, MOTION_PERIOD_US, MOTION_MAX_LATENCY_US, handler);
        if (gravity != null) sensorManager.registerListener(listener, gravity, MOTION_PERIOD_US, MOTION_MAX_LATENCY_US, handler);
        registered = true;
        Log.i(TAG, "sensors registered for " + clients + (any ? "" : " (none available)"));
    }

    private void unregister() {
        try {
            if (sensorManager != null) sensorManager.unregisterListener(listener);
        } catch (Exception ignored) {
            // already gone
        }
        if (thread != null) {
            thread.quitSafely();
            thread = null;
            handler = null;
        }
        registered = false;
        Log.i(TAG, "sensors released");
    }

    /** Sensor timestamp (ns, elapsedRealtime base on modern devices) -> monotonic ms. */
    private static long sensorMs(SensorEvent event) {
        long nowNs = SystemClock.elapsedRealtimeNanos();
        long ts = event.timestamp;
        if (ts <= 0 || Math.abs(nowNs - ts) > 10 * 60_000_000_000L) {
            return SystemClock.elapsedRealtime(); // not elapsedRealtime-based: use arrival
        }
        return ts / 1_000_000L;
    }

    /** Monotonic sensor ms -> wall ms. */
    private static long toWall(long sensorMs) {
        return System.currentTimeMillis() - (SystemClock.elapsedRealtime() - sensorMs);
    }

    private final SensorEventListener listener = new SensorEventListener() {
        @Override
        public void onSensorChanged(SensorEvent event) {
            if (event == null || event.sensor == null || event.values == null || event.values.length == 0) return;
            switch (event.sensor.getType()) {
                case Sensor.TYPE_STEP_COUNTER:
                    onCounter(event.values[0]);
                    break;
                case Sensor.TYPE_STEP_DETECTOR:
                    onDetector(toWall(sensorMs(event)));
                    break;
                case Sensor.TYPE_ACCELEROMETER:
                    if (event.values.length >= 3) onAccel(sensorMs(event), event.values);
                    break;
                case Sensor.TYPE_GYROSCOPE:
                    if (event.values.length >= 3) {
                        float x = event.values[0], y = event.values[1], z = event.values[2];
                        gyroMag = (float) Math.sqrt(x * x + y * y + z * z);
                        gyroAt = sensorMs(event);
                    }
                    break;
                case Sensor.TYPE_GRAVITY:
                    if (event.values.length >= 3) {
                        System.arraycopy(event.values, 0, grav, 0, 3);
                        gravAt = sensorMs(event);
                    }
                    break;
                default:
                    break;
            }
        }

        @Override
        public void onAccuracyChanged(Sensor sensor, int accuracy) {
            // no-op
        }
    };

    private void onCounter(float raw) {
        long now = System.currentTimeMillis();
        int delta = 0;
        if (lastRaw >= 0f && raw >= lastRaw) {
            int d = Math.round(raw - lastRaw);
            // same sanity clamp as the ledger: at most 4 steps per second since the last event
            long elapsed = Math.max(1L, now - lastRawAtMs);
            delta = Math.min(d, Math.max(1, (int) Math.ceil(elapsed / 250.0)));
            if (d <= 0) delta = 0;
        }
        lastRaw = raw;
        lastRawAtMs = now;
        latestRaw = raw;
        if (delta > 0) {
            lastMovementAtMs = now;
            EvidenceTracker.SHARED.onCounterSteps(now, delta);
            for (int i = 0; i < delta; i++) arrivalSteps.addLast(now);
        }
        trim(arrivalSteps, now - 60_000L);
        if (detector == null || timedSteps.isEmpty() || now - timedSteps.peekLast() > 10_000L) {
            // no per-step timestamps: arrival-batched numbers
            int burst = 0;
            for (Long t : arrivalSteps) if (t >= now - 5_000L) burst++;
            StepSyncEngine.publishLive(arrivalSteps.size(), burst, false, now);
        }
        for (Listener l : listeners) {
            try {
                l.onCounter(raw, delta, now);
            } catch (RuntimeException error) {
                Log.w(TAG, "counter listener failed", error);
            }
        }
    }

    private void onDetector(long stepWall) {
        timedSteps.addLast(stepWall);
        trim(timedSteps, stepWall - 60_000L);
        int burst = 0;
        for (Long t : timedSteps) if (t >= stepWall - 5_000L && t <= stepWall) burst++;
        StepSyncEngine.publishLive(timedSteps.size(), burst, true, System.currentTimeMillis());
    }

    private void onAccel(long tMs, float[] v) {
        boolean gyroFresh = gyro != null && !Float.isNaN(gyroMag) && Math.abs(tMs - gyroAt) <= HOLD_STALE_MS;
        boolean gravFresh = gravity != null && !Float.isNaN(grav[0]) && Math.abs(tMs - gravAt) <= HOLD_STALE_MS;
        GaitClassifier.Result r = windows.add(tMs, v[0], v[1], v[2],
            gyroFresh ? gyroMag : Float.NaN,
            gravFresh ? grav[0] : Float.NaN, gravFresh ? grav[1] : Float.NaN, gravFresh ? grav[2] : Float.NaN);

        // Legacy snapshot analyzer (upload fields kept for compatibility).
        if (!lowPassPrimed) {
            System.arraycopy(v, 0, lowPass, 0, 3);
            lowPassPrimed = true;
        } else {
            for (int i = 0; i < 3; i++) lowPass[i] = 0.92f * lowPass[i] + 0.08f * v[i];
        }
        float gx = gravFresh ? grav[0] : lowPass[0];
        float gy = gravFresh ? grav[1] : lowPass[1];
        float gz = gravFresh ? grav[2] : lowPass[2];
        long wall = toWall(tMs);
        GaitAnalyzer.SHARED.addSample(wall, v[0] - gx, v[1] - gy, v[2] - gz, gx, gy, gz, gyroFresh ? gyroMag : 0f);

        if (r != null) {
            EvidenceTracker.SHARED.onWindow(wall, r);
            for (Listener l : listeners) {
                try {
                    l.onWindow(r, wall);
                } catch (RuntimeException error) {
                    Log.w(TAG, "window listener failed", error);
                }
            }
        }
    }

    private static void trim(ArrayDeque<Long> q, long cutoff) {
        while (!q.isEmpty() && q.peekFirst() < cutoff) q.pollFirst();
    }
}
