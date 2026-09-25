package com.step2win.app;

import android.content.Context;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.os.Handler;
import android.os.HandlerThread;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Reads the hardware step counter once (for background work) and records it in the ledger.
 * Registering a TYPE_STEP_COUNTER listener delivers the current value almost immediately;
 * the listener is removed right after, so the sensor hub is only touched for a moment.
 */
public final class StepCounterReader {
    private StepCounterReader() {}

    /** Returns the raw value, or -1 if unavailable within the timeout. Must not run on the main thread. */
    public static float readOnce(Context context, long timeoutMs) {
        if (!StepCaptureForegroundService.hasActivityRecognitionPermission(context)) {
            return -1f;
        }
        SensorManager manager = (SensorManager) context.getSystemService(Context.SENSOR_SERVICE);
        if (manager == null) {
            return -1f;
        }
        Sensor sensor = manager.getDefaultSensor(Sensor.TYPE_STEP_COUNTER);
        if (sensor == null) {
            return -1f;
        }
        final CountDownLatch latch = new CountDownLatch(1);
        final AtomicReference<Float> value = new AtomicReference<>(-1f);
        SensorEventListener listener = new SensorEventListener() {
            @Override
            public void onSensorChanged(SensorEvent event) {
                if (event != null && event.values != null && event.values.length > 0) {
                    value.set(event.values[0]);
                    latch.countDown();
                }
            }

            @Override
            public void onAccuracyChanged(Sensor s, int accuracy) {
                // no-op
            }
        };
        HandlerThread thread = new HandlerThread("Step2WinCounterRead");
        thread.start();
        try {
            boolean ok = manager.registerListener(listener, sensor, SensorManager.SENSOR_DELAY_NORMAL, new Handler(thread.getLooper()));
            if (!ok) {
                return -1f;
            }
            latch.await(Math.max(500L, timeoutMs), TimeUnit.MILLISECONDS);
        } catch (InterruptedException ignored) {
            Thread.currentThread().interrupt();
        } catch (SecurityException ignored) {
            return -1f;
        } finally {
            try {
                manager.unregisterListener(listener);
            } catch (Exception ignored) {
                // already gone
            }
            thread.quitSafely();
        }
        return value.get();
    }

    /** Reads the counter and records it in the ledger. Returns the raw value or -1. */
    public static float readAndRecord(Context context, long timeoutMs) {
        float raw = readOnce(context, timeoutMs);
        if (raw >= 0f) {
            StepLedger.record(context, raw);
        }
        return raw;
    }
}
