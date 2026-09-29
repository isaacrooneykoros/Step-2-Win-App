package com.step2win.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Map;
import java.util.Set;

/**
 * Phase 1c: Health Connect as an extra, opt-in, read-only step source (Android).
 *
 * <p>State lives in its own SharedPreferences: the opt-in, the changes token, the last
 * few days' payloads and which of them the server already has (per signed-in user). The
 * reading happens on app open / resume (plugin) and in the WorkManager sync job when
 * Health Connect allows background reads. Our own step counting never waits on it and
 * never depends on it: late Health Connect data only confirms.</p>
 */
final class HealthSources {
    private static final String TAG = "Step2WinHealth";
    private static final String PREFS = "step2win_health_sources";
    private static final String KEY_OPTED_IN = "opted_in";
    private static final String KEY_TOKEN = "changes_token";
    private static final String KEY_DAYS = "days";
    private static final String KEY_UPLOADED = "uploaded_";
    private static final String KEY_LAST_READ = "last_read_at";
    private static final String KEY_LAST_STATUS = "last_status";
    private static final String KEY_LAST_MESSAGE = "last_message";
    private static final String KEY_GRANTED = "granted";
    private static final String KEY_BG_SUPPORTED = "background_supported";
    private static final String KEY_LAST_UPLOAD = "last_upload_at";
    /** Background reads at most this often (battery / data). */
    static final long BACKGROUND_MIN_INTERVAL_MS = 30 * 60_000L;
    static final long FOREGROUND_MIN_INTERVAL_MS = 2 * 60_000L;

    private HealthSources() {}

    static SharedPreferences prefs(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static boolean optedIn(Context context) {
        return prefs(context).getBoolean(KEY_OPTED_IN, false);
    }

    static void setOptedIn(Context context, boolean on) {
        SharedPreferences.Editor e = prefs(context).edit().putBoolean(KEY_OPTED_IN, on);
        if (!on) {
            e.remove(KEY_TOKEN).remove(KEY_DAYS).remove(KEY_GRANTED);
        }
        e.apply();
    }

    static HealthConnectGateway gateway(Context context) {
        return new HealthConnectGatewayImpl(context.getApplicationContext());
    }

    static String availability(Context context) {
        try {
            return HealthSourceCore.availability(gateway(context).sdkStatus(), Build.VERSION.SDK_INT);
        } catch (Throwable t) {
            return "unsupported";
        }
    }

    static Set<String> requestedPermissions() {
        Set<String> perms = new HashSet<>();
        perms.add(HealthSourceCore.PERM_STEPS);
        perms.add(HealthSourceCore.PERM_EXERCISE);
        perms.add(HealthSourceCore.PERM_ROUTES);
        perms.add(HealthSourceCore.PERM_BACKGROUND);
        return perms;
    }

    /**
     * Read the last few days now (blocking; call off the main thread). Returns the
     * status. {@code background}: skip when reads aren't allowed in the background or
     * the last read is recent.
     */
    static synchronized String refresh(Context context, boolean background, boolean force) {
        Context app = context.getApplicationContext();
        SharedPreferences p = prefs(app);
        if (!p.getBoolean(KEY_OPTED_IN, false)) return "off";
        long now = System.currentTimeMillis();
        long last = p.getLong(KEY_LAST_READ, 0L);
        long minInterval = background ? BACKGROUND_MIN_INTERVAL_MS : FOREGROUND_MIN_INTERVAL_MS;
        if (!force && now - last < minInterval) return p.getString(KEY_LAST_STATUS, "ok");
        if (background) {
            Set<String> granted = p.getStringSet(KEY_GRANTED, new HashSet<>());
            if (!granted.contains(HealthSourceCore.PERM_BACKGROUND) || !p.getBoolean(KEY_BG_SUPPORTED, false)) {
                return "background_not_allowed"; // read on the next app open instead
            }
        }
        JSONObject days = readJson(p, KEY_DAYS);
        Set<String> cached = new HashSet<>();
        for (Iterator<String> it = days.keys(); it.hasNext(); ) cached.add(it.next());
        HealthSourceReader.Outcome out;
        try {
            out = HealthSourceReader.read(gateway(app), true, Build.VERSION.SDK_INT, ZoneId.systemDefault(),
                LocalDate.now(), p.getString(KEY_TOKEN, null), cached, now);
        } catch (Throwable t) {
            // e.g. NoClassDefFoundError on a very old system image: never crash the app.
            Log.w(TAG, "health connect read failed", t);
            p.edit().putString(KEY_LAST_STATUS, "error").putString(KEY_LAST_MESSAGE, t.getClass().getSimpleName()).apply();
            return "error";
        }
        SharedPreferences.Editor e = p.edit()
            .putString(KEY_LAST_STATUS, out.status)
            .putString(KEY_LAST_MESSAGE, out.message)
            .putStringSet(KEY_GRANTED, out.granted)
            .putBoolean(KEY_BG_SUPPORTED, out.backgroundSupported);
        if ("ok".equals(out.status) || "partial".equals(out.status)) {
            try {
                for (Map.Entry<String, JSONObject> d : out.days.entrySet()) {
                    HealthSourceCore.keepKnownRoutes(d.getValue(), days.optJSONObject(d.getKey()));
                    days.put(d.getKey(), d.getValue());
                }
                prune(days, LocalDate.now().minusDays(HealthSourceReader.MAX_DAYS + 4));
            } catch (Exception ignored) {
                // keep what we have
            }
            e.putString(KEY_DAYS, days.toString()).putLong(KEY_LAST_READ, now);
            if (out.nextToken != null) e.putString(KEY_TOKEN, out.nextToken);
            else e.remove(KEY_TOKEN);
        } else if ("permission_denied".equals(out.status)) {
            // Revoked in Health Connect: forget what we read, keep the opt-in so the screen
            // can say "allow access again".
            e.remove(KEY_DAYS).remove(KEY_TOKEN);
        }
        e.apply();
        Log.i(TAG, "health connect read " + out.status + " days=" + out.days.keySet());
        return out.status;
    }

    private static void prune(JSONObject days, LocalDate oldest) {
        Set<String> drop = new HashSet<>();
        for (Iterator<String> it = days.keys(); it.hasNext(); ) {
            String k = it.next();
            try {
                if (LocalDate.parse(k).isBefore(oldest)) drop.add(k);
            } catch (Exception ex) {
                drop.add(k);
            }
        }
        for (String k : drop) days.remove(k);
    }

    /** Days whose payload the server doesn't have yet (for this user). date -> payload. */
    static JSONObject pendingUploads(Context context, String userKey) {
        SharedPreferences p = prefs(context);
        JSONObject out = new JSONObject();
        if (userKey == null || !p.getBoolean(KEY_OPTED_IN, false)) return out;
        JSONObject days = readJson(p, KEY_DAYS);
        JSONObject uploaded = readJson(p, KEY_UPLOADED + userKey);
        try {
            for (Iterator<String> it = days.keys(); it.hasNext(); ) {
                String date = it.next();
                JSONObject payload = days.optJSONObject(date);
                if (payload == null) continue;
                String hash = HealthSourceCore.contentHash(payload);
                if (!hash.equals(uploaded.optString(date, ""))) out.put(date, payload);
            }
        } catch (Exception ignored) {
            // partial is fine
        }
        return out;
    }

    static void markUploaded(Context context, String userKey, String date, JSONObject payload) {
        SharedPreferences p = prefs(context);
        JSONObject uploaded = readJson(p, KEY_UPLOADED + userKey);
        try {
            uploaded.put(date, HealthSourceCore.contentHash(payload));
            prune(uploaded, LocalDate.now().minusDays(14));
        } catch (Exception ignored) {
            return;
        }
        p.edit().putString(KEY_UPLOADED + userKey, uploaded.toString())
            .putLong(KEY_LAST_UPLOAD, System.currentTimeMillis()).apply();
    }

    /** Status for the "Connected sources" screen. */
    static JSONObject status(Context context) {
        SharedPreferences p = prefs(context);
        JSONObject out = new JSONObject();
        try {
            boolean optedIn = p.getBoolean(KEY_OPTED_IN, false);
            String availability = availability(context);
            Set<String> granted = p.getStringSet(KEY_GRANTED, new HashSet<>());
            out.put("platform", "android");
            out.put("provider", "health_connect");
            out.put("availability", availability);
            out.put("optedIn", optedIn);
            out.put("state", HealthSourceCore.connectionState(optedIn, availability, granted));
            JSONObject perms = new JSONObject();
            perms.put("steps", granted.contains(HealthSourceCore.PERM_STEPS));
            perms.put("exercise", granted.contains(HealthSourceCore.PERM_EXERCISE));
            perms.put("routes", granted.contains(HealthSourceCore.PERM_ROUTES));
            perms.put("background", granted.contains(HealthSourceCore.PERM_BACKGROUND));
            out.put("permissions", perms);
            out.put("backgroundSupported", p.getBoolean(KEY_BG_SUPPORTED, false));
            long last = p.getLong(KEY_LAST_READ, 0L);
            out.put("lastReadAt", last > 0 ? Instant.ofEpochMilli(last).toString() : JSONObject.NULL);
            long up = p.getLong(KEY_LAST_UPLOAD, 0L);
            out.put("lastUploadAt", up > 0 ? Instant.ofEpochMilli(up).toString() : JSONObject.NULL);
            out.put("lastStatus", p.getString(KEY_LAST_STATUS, ""));
            JSONObject days = readJson(p, KEY_DAYS);
            JSONObject todayPayload = days.optJSONObject(LocalDate.now().toString());
            out.put("todayOrigins", HealthSourceReader.originPreview(todayPayload));
            long sourcesToday = 0;
            if (todayPayload != null) {
                long[] max = HealthSourceCore.hourlyMax(
                    HealthSourceCore.countedByOrigin(todayPayload.optJSONArray("hours") == null ? new JSONArray() : todayPayload.optJSONArray("hours")).values());
                sourcesToday = HealthSourceCore.dayCounted(0, max);
            }
            out.put("todaySourceSteps", sourcesToday);
        } catch (Exception ignored) {
            // partial status is fine
        }
        return out;
    }

    private static JSONObject readJson(SharedPreferences p, String key) {
        try {
            return new JSONObject(p.getString(key, "{}"));
        } catch (Exception e) {
            return new JSONObject();
        }
    }
}
