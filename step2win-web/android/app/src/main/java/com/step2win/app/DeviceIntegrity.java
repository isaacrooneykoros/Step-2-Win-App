package com.step2win.app;

import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.os.Build;
import android.provider.Settings;
import android.util.Log;

import com.google.android.gms.tasks.Task;
import com.google.android.gms.tasks.Tasks;
import com.google.android.play.core.integrity.IntegrityManager;
import com.google.android.play.core.integrity.IntegrityManagerFactory;
import com.google.android.play.core.integrity.IntegrityServiceException;
import com.google.android.play.core.integrity.IntegrityTokenRequest;
import com.google.android.play.core.integrity.IntegrityTokenResponse;

import org.json.JSONObject;

import java.io.File;
import java.lang.reflect.Method;
import java.util.Locale;
import java.util.concurrent.TimeUnit;

/**
 * Device integrity for Phase 1b.
 *
 * - {@link #signals}: supplementary heuristics (emulator, root, debuggable, adb, sensors). The
 *   server stores them as shadow signals only: easy to fake, never decisive on their own.
 * - {@link #requestToken}: Play Integrity (classic request with the server's nonce). Needs the
 *   Google Cloud project number at build time (gradle property / env
 *   PLAY_INTEGRITY_CLOUD_PROJECT_NUMBER -> BuildConfig); 0 = not configured. Never throws:
 *   phones without Play services (some Huawei, custom ROMs) just get no token.
 */
public final class DeviceIntegrity {
    private static final String TAG = "Step2WinIntegrity";

    private DeviceIntegrity() {}

    /** Token or error (exactly one is non-null). */
    public static final class TokenResult {
        public final String token;
        public final String error;

        TokenResult(String token, String error) {
            this.token = token;
            this.error = error;
        }
    }

    static long cloudProjectNumber() {
        try {
            return BuildConfig.PLAY_INTEGRITY_CLOUD_PROJECT_NUMBER;
        } catch (Throwable ignored) {
            return 0L;
        }
    }

    /** Starts a token request (callback on the main thread). */
    static Task<IntegrityTokenResponse> startTokenRequest(Context context, String nonce) {
        IntegrityManager manager = IntegrityManagerFactory.create(context.getApplicationContext());
        return manager.requestIntegrityToken(IntegrityTokenRequest.builder()
            .setNonce(nonce)
            .setCloudProjectNumber(cloudProjectNumber())
            .build());
    }

    /** Blocking (background threads only). */
    static TokenResult requestToken(Context context, String nonce, long timeoutMs) {
        if (nonce == null || nonce.length() < 16) return new TokenResult(null, "bad_nonce");
        if (cloudProjectNumber() <= 0) return new TokenResult(null, "not_configured");
        try {
            IntegrityTokenResponse response = Tasks.await(startTokenRequest(context, nonce), timeoutMs, TimeUnit.MILLISECONDS);
            String token = response != null ? response.token() : null;
            return token != null && !token.isEmpty() ? new TokenResult(token, null) : new TokenResult(null, "empty_token");
        } catch (Throwable error) {
            return new TokenResult(null, errorCode(error));
        }
    }

    static String errorCode(Throwable error) {
        Throwable cause = error;
        for (int i = 0; i < 3 && cause != null; i++) {
            if (cause instanceof IntegrityServiceException) {
                return "integrity_error_" + ((IntegrityServiceException) cause).getErrorCode();
            }
            cause = cause.getCause();
        }
        if (error instanceof java.util.concurrent.TimeoutException) return "timeout";
        Log.i(TAG, "integrity token failed: " + error.getClass().getSimpleName());
        return "unavailable";
    }

    // ── signals ──────────────────────────────────────────────────────────────

    static JSONObject signals(Context context) {
        JSONObject o = new JSONObject();
        MotionHub hub = MotionHub.get(context);
        try {
            o.put("emulator", isEmulator());
            o.put("rooted", isRooted(context));
            o.put("debuggable", (context.getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0);
            o.put("adb_enabled", adbEnabled(context));
            o.put("has_step_counter", hub.hasStepCounter());
            o.put("has_step_detector", hub.hasStepDetector());
            o.put("has_accelerometer", hub.hasAccelerometer());
            o.put("has_gyroscope", hub.hasGyroscope());
            o.put("has_gravity", hub.hasGravity());
        } catch (Exception ignored) {
            // partial signals are fine
        }
        return o;
    }

    static boolean isEmulator() {
        String fingerprint = lower(Build.FINGERPRINT);
        String model = lower(Build.MODEL);
        String hardware = lower(Build.HARDWARE);
        String product = lower(Build.PRODUCT);
        String brand = lower(Build.BRAND);
        String device = lower(Build.DEVICE);
        String manufacturer = lower(Build.MANUFACTURER);
        if (fingerprint.startsWith("generic") || fingerprint.startsWith("unknown") || fingerprint.contains("emulator")) return true;
        if (model.contains("google_sdk") || model.contains("emulator") || model.contains("android sdk built for x86")) return true;
        if (hardware.contains("goldfish") || hardware.contains("ranchu") || hardware.contains("vbox")) return true;
        if (product.equals("sdk") || product.startsWith("sdk_") || product.contains("sdk_gphone") || product.contains("emulator") || product.contains("simulator")) return true;
        if (manufacturer.contains("genymotion")) return true;
        if (brand.startsWith("generic") && device.startsWith("generic")) return true;
        String qemu = systemProperty("ro.kernel.qemu");
        if ("1".equals(qemu)) return true;
        String bootQemu = systemProperty("ro.boot.qemu");
        return "1".equals(bootQemu);
    }

    static boolean isRooted(Context context) {
        String tags = Build.TAGS;
        if (tags != null && tags.contains("test-keys")) return true;
        String[] paths = {
            "/system/bin/su", "/system/xbin/su", "/sbin/su", "/system/su", "/system/bin/.ext/su",
            "/system/usr/we-need-root/su", "/data/local/su", "/data/local/bin/su", "/data/local/xbin/su",
            "/su/bin/su", "/system/app/Superuser.apk", "/system/sbin/su", "/vendor/bin/su", "/cache/su",
            "/data/adb/magisk", "/sbin/.magisk"
        };
        for (String p : paths) {
            try {
                if (new File(p).exists()) return true;
            } catch (SecurityException ignored) {
                // not allowed to look: not evidence either way
            }
        }
        // Magisk manager (declared in <queries>; without QUERY_ALL_PACKAGES other packages are
        // invisible on Android 11+, so absence proves nothing).
        try {
            context.getPackageManager().getPackageInfo("com.topjohnwu.magisk", 0);
            return true;
        } catch (PackageManager.NameNotFoundException | RuntimeException ignored) {
            return false;
        }
    }

    static boolean adbEnabled(Context context) {
        try {
            return Settings.Global.getInt(context.getContentResolver(), Settings.Global.ADB_ENABLED, 0) == 1;
        } catch (Exception ignored) {
            return false;
        }
    }

    private static String systemProperty(String key) {
        try {
            Class<?> c = Class.forName("android.os.SystemProperties");
            Method get = c.getMethod("get", String.class);
            Object v = get.invoke(null, key);
            return v == null ? "" : v.toString();
        } catch (Throwable ignored) {
            return "";
        }
    }

    private static String lower(String s) {
        return s == null ? "" : s.toLowerCase(Locale.ROOT);
    }
}
