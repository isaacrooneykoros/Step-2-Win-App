package com.step2win.app;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.view.WindowManager;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.getcapacitor.PermissionState;

/**
 * Small bridge for OS-level screens and window flags the official Capacitor plugins don't cover:
 * app / notification / security settings deep links and the recents privacy screen used by the
 * biometric lock.
 */
@CapacitorPlugin(
    name = "AppSystem",
    permissions = { @Permission(alias = "camera", strings = { Manifest.permission.CAMERA }) }
)
public class AppSystemPlugin extends Plugin {

    @PluginMethod
    public void setPrivacyScreen(PluginCall call) {
        final boolean enabled = Boolean.TRUE.equals(call.getBoolean("enabled", false));
        final Activity activity = getActivity();
        if (activity == null) {
            call.reject("No activity");
            return;
        }
        activity.runOnUiThread(() -> {
            String mode;
            if (Build.VERSION.SDK_INT >= 33) {
                // Hides the app's content in the recents switcher without blocking screenshots.
                activity.setRecentsScreenshotEnabled(!enabled);
                mode = "recents";
            } else {
                // Older Android has no recents-only switch; FLAG_SECURE also blocks screenshots.
                if (enabled) {
                    activity.getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
                } else {
                    activity.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SECURE);
                }
                mode = "secure";
            }
            JSObject ret = new JSObject();
            ret.put("enabled", enabled);
            ret.put("mode", mode);
            call.resolve(ret);
        });
    }

    /** Camera runtime permission (QR invite scanning). The WebView prompt reuses this grant. */
    @PluginMethod
    public void checkCameraPermission(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("camera", getPermissionState("camera").toString());
        call.resolve(ret);
    }

    @PluginMethod
    public void requestCameraPermission(PluginCall call) {
        if (getPermissionState("camera") == PermissionState.GRANTED) {
            checkCameraPermission(call);
            return;
        }
        requestPermissionForAlias("camera", call, "cameraPermissionCallback");
    }

    @PermissionCallback
    private void cameraPermissionCallback(PluginCall call) {
        checkCameraPermission(call);
    }

    @PluginMethod
    public void openSecuritySettings(PluginCall call) {
        Intent intent;
        if (Build.VERSION.SDK_INT >= 30) {
            intent = new Intent(Settings.ACTION_BIOMETRIC_ENROLL);
            intent.putExtra(Settings.EXTRA_BIOMETRIC_AUTHENTICATORS_ALLOWED,
                android.hardware.biometrics.BiometricManager.Authenticators.BIOMETRIC_WEAK
                    | android.hardware.biometrics.BiometricManager.Authenticators.DEVICE_CREDENTIAL);
        } else {
            intent = new Intent(Settings.ACTION_SECURITY_SETTINGS);
        }
        if (!startSafely(intent) && !startSafely(new Intent(Settings.ACTION_SECURITY_SETTINGS))) {
            resolveOpened(call, startSafely(new Intent(Settings.ACTION_SETTINGS)));
            return;
        }
        resolveOpened(call, true);
    }

    @PluginMethod
    public void openAppSettings(PluginCall call) {
        Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
        intent.setData(Uri.fromParts("package", getContext().getPackageName(), null));
        resolveOpened(call, startSafely(intent));
    }

    @PluginMethod
    public void openNotificationSettings(PluginCall call) {
        Intent intent = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS);
        intent.putExtra(Settings.EXTRA_APP_PACKAGE, getContext().getPackageName());
        if (!startSafely(intent)) {
            Intent fallback = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
            fallback.setData(Uri.fromParts("package", getContext().getPackageName(), null));
            resolveOpened(call, startSafely(fallback));
            return;
        }
        resolveOpened(call, true);
    }

    private boolean startSafely(Intent intent) {
        try {
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            return true;
        } catch (Exception ignored) {
            return false;
        }
    }

    private void resolveOpened(PluginCall call, boolean opened) {
        JSObject ret = new JSObject();
        ret.put("opened", opened);
        call.resolve(ret);
    }
}
