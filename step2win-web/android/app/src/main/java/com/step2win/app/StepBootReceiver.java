package com.step2win.app;

import android.Manifest;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;

import androidx.core.content.ContextCompat;

public class StepBootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || intent.getAction() == null) {
            return;
        }

        String action = intent.getAction();
        if (!Intent.ACTION_BOOT_COMPLETED.equals(action) && !Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) {
            return;
        }

        SharedPreferences prefs = context.getSharedPreferences(StepCaptureForegroundService.PREFS, Context.MODE_PRIVATE);
        boolean shouldRunInBackground = prefs.getBoolean(StepCaptureForegroundService.KEY_BACKGROUND_RUNNING, false);
        if (!shouldRunInBackground) {
            return;
        }

        if (!StepCaptureForegroundService.hasActivityRecognitionPermission(context)) {
            return;
        }

        Intent serviceIntent = new Intent(context, StepCaptureForegroundService.class);
        try {
            ContextCompat.startForegroundService(context, serviceIntent);
        } catch (RuntimeException ignored) {
            // Background start not allowed (e.g. restricted app); capture restarts on next app open.
        }
    }
}
