package com.step2win.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.provider.Settings;
import android.util.Base64;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.util.List;
import java.util.Locale;
import java.util.Random;
import java.util.UUID;
import java.util.concurrent.locks.ReentrantLock;

/**
 * The one uploader for step data on Android. Every trigger (app open / walking in the app,
 * WorkManager with the app closed or killed, the walking service) goes through here, under
 * one lock, so nothing is ever sent twice concurrently.
 *
 * Durable, state-based outbox: the ledger holds each day's total; this class remembers, per
 * signed-in user, what the server has acknowledged. "Pending" = ledger total above the
 * acknowledged total. Nothing is lost when the app is killed mid-upload; the next run just
 * sends the latest total again. Each reading carries a stable client_event_id and
 * timestamp_client, so a retry of a reading the server already applied is answered as a
 * duplicate (idempotent), and an older reading can never lower a newer total.
 *
 * Network etiquette for thousands of phones:
 * - honours 429/503 Retry-After (plus random jitter) for every trigger, including "Sync now"
 * - exponential backoff with full jitter on network / 5xx errors (30 s .. 30 min)
 * - per-day backoff after a hard rejection (400) so a bad day can't loop
 * - requests within a run are paced (1-1.8 s apart), oldest day first, at most 8 days
 */
public final class StepSyncEngine {
    private static final String TAG = "Step2WinSync";
    private static final String CAP_STORAGE = "CapacitorStorage";
    private static final String KEY_ACKED = "acked_";          // + userKey -> JSON {date: {s, hh}}
    private static final String KEY_PENDING = "pending_";      // + userKey -> JSON {date: {t, ts, id}}
    private static final String KEY_DAY_BACKOFF = "day_backoff_"; // + userKey -> JSON {date: {until, n}}
    private static final String KEY_LAST_SUCCESS = "last_success_at";
    private static final String KEY_LAST_ATTEMPT = "last_attempt_at";
    private static final String KEY_NEXT_ALLOWED = "next_allowed_at";
    private static final String KEY_FAILURES = "failure_count";
    private static final String KEY_LAST_STATUS = "last_status";
    private static final String KEY_LAST_HOURLY = "last_hourly_at";

    private static final int CONNECT_TIMEOUT_MS = 15_000;
    private static final int READ_TIMEOUT_MS = 45_000; // a sleeping free-tier server takes ~30 s to wake
    private static final long BACKOFF_BASE_MS = 30_000L;
    private static final long BACKOFF_MAX_MS = 30 * 60_000L;
    private static final long DAY_BACKOFF_BASE_MS = 30 * 60_000L;
    private static final long DAY_BACKOFF_MAX_MS = 6 * 60 * 60_000L;
    private static final long GAIT_FRESH_MS = 10 * 60_000L;
    private static final long SAVER_HOURLY_EVERY_MS = 2 * 60 * 60_000L;
    private static final int MAX_REQUESTS_PER_RUN = 20;

    private static final ReentrantLock LOCK = new ReentrantLock();
    private static final Random RANDOM = new Random();

    /** Live cadence numbers published by whoever is listening to the step counter. */
    static volatile int liveCadenceSpm = 0;
    static volatile int liveBurst5s = 0;
    static volatile long liveUpdatedAt = 0L;

    private StepSyncEngine() {}

    public static final class Options {
        boolean force;        // user asked ("Sync now") or app resume: skip nothing but Retry-After
        boolean foreground;   // the web layer is alive and handles JWT refresh
        String reason = "unspecified";
    }

    public static final class Result {
        String status = "nothing";
        int uploaded = 0;
        int pendingDays = 0;
        long retryAt = 0L;
        String message = "";

        JSONObject toJson() {
            JSONObject o = new JSONObject();
            try {
                o.put("status", status);
                o.put("uploaded", uploaded);
                o.put("pendingDays", pendingDays);
                o.put("retryAt", retryAt > 0 ? Instant.ofEpochMilli(retryAt).toString() : JSONObject.NULL);
                o.put("message", message);
            } catch (Exception ignored) {
                // no-op
            }
            return o;
        }
    }

    private static final class HttpResult {
        int code = -1;
        String body = "";
        long retryAfterMs = -1L;
        boolean networkError = false;
    }

    // ── public API ───────────────────────────────────────────────────────────

    public static Result run(Context context, Options options) {
        Context app = context.getApplicationContext();
        Result result = new Result();
        if (!LOCK.tryLock()) {
            result.status = "busy";
            return result;
        }
        try {
            return runLocked(app, options, result);
        } catch (Exception error) {
            Log.w(TAG, "sync run failed", error);
            result.status = "error";
            result.message = String.valueOf(error.getMessage());
            return result;
        } finally {
            SyncPolicy.prefs(app).edit().putString(KEY_LAST_STATUS, result.status).apply();
            LOCK.unlock();
        }
    }

    static long lastSuccessAt(Context context) {
        return SyncPolicy.prefs(context).getLong(KEY_LAST_SUCCESS, 0L);
    }

    static long nextAllowedAt(Context context) {
        return SyncPolicy.prefs(context).getLong(KEY_NEXT_ALLOWED, 0L);
    }

    /** Stable key for the signed-in user (JWT user_id), or null when signed out. */
    static String currentUserKey(Context context) {
        String access = capStorage(context).getString("access_token", null);
        String refresh = capStorage(context).getString("refresh_token", null);
        String fromAccess = jwtUserId(access);
        if (fromAccess != null) return fromAccess;
        return jwtUserId(refresh);
    }

    static int ackedSteps(Context context, String userKey, String date) {
        JSONObject acked = readJson(SyncPolicy.prefs(context), KEY_ACKED + userKey);
        JSONObject day = acked.optJSONObject(date);
        return day == null ? 0 : day.optInt("s", 0);
    }

    /** Status for the "Step sync" screen. */
    static JSONObject status(Context context) {
        Context app = context.getApplicationContext();
        SharedPreferences prefs = SyncPolicy.prefs(app);
        JSONObject out = new JSONObject();
        try {
            String userKey = currentUserKey(app);
            JSONArray pending = new JSONArray();
            if (userKey != null) {
                JSONObject backoff = readJson(prefs, KEY_DAY_BACKOFF + userKey);
                for (StepLedger.Day day : StepLedger.getDays(app)) {
                    int acked = ackedSteps(app, userKey, day.date);
                    if (day.total <= acked) continue;
                    JSONObject item = new JSONObject();
                    item.put("date", day.date);
                    item.put("steps", day.total);
                    item.put("ackedSteps", acked);
                    JSONObject b = backoff.optJSONObject(day.date);
                    item.put("retries", b == null ? 0 : b.optInt("n", 0));
                    long until = b == null ? 0L : b.optLong("until", 0L);
                    item.put("nextAttemptAt", until > System.currentTimeMillis() ? Instant.ofEpochMilli(until).toString() : JSONObject.NULL);
                    pending.put(item);
                }
            }
            out.put("pending", pending);
            out.put("signedIn", userKey != null);
            out.put("todaySteps", StepLedger.todayTotal(app));
            long last = prefs.getLong(KEY_LAST_SUCCESS, 0L);
            out.put("lastSuccessAt", last > 0 ? Instant.ofEpochMilli(last).toString() : JSONObject.NULL);
            long attempt = prefs.getLong(KEY_LAST_ATTEMPT, 0L);
            out.put("lastAttemptAt", attempt > 0 ? Instant.ofEpochMilli(attempt).toString() : JSONObject.NULL);
            long next = prefs.getLong(KEY_NEXT_ALLOWED, 0L);
            out.put("nextAllowedAt", next > System.currentTimeMillis() ? Instant.ofEpochMilli(next).toString() : JSONObject.NULL);
            out.put("failureCount", prefs.getInt(KEY_FAILURES, 0));
            out.put("lastStatus", prefs.getString(KEY_LAST_STATUS, ""));
            long lastReading = StepLedger.lastReadingAt(app);
            out.put("lastReadingAt", lastReading > 0 ? Instant.ofEpochMilli(lastReading).toString() : JSONObject.NULL);
            out.put("saverMode", SyncPolicy.saverMode(app));
            out.put("nearDeadline", SyncPolicy.nearDeadline(app));
            out.put("challengeActiveToday", SyncPolicy.challengeActiveToday(app));
            out.put("backgroundIntervalMinutes", StepSyncScheduler.currentIntervalMinutes(app));
        } catch (Exception ignored) {
            // partial status is fine
        }
        return out;
    }

    // ── core ─────────────────────────────────────────────────────────────────

    private static Result runLocked(Context context, Options options, Result result) {
        SharedPreferences prefs = SyncPolicy.prefs(context);
        long now = System.currentTimeMillis();
        String apiBase = SyncPolicy.apiBase(context);
        if (apiBase.isEmpty()) {
            result.status = "not_configured";
            return result;
        }
        String userKey = currentUserKey(context);
        if (userKey == null) {
            result.status = "signed_out";
            return result;
        }

        List<StepLedger.Day> days = StepLedger.getDays(context);
        JSONObject acked = readJson(prefs, KEY_ACKED + userKey);
        JSONObject dayBackoff = readJson(prefs, KEY_DAY_BACKOFF + userKey);
        boolean saver = SyncPolicy.saverMode(context);
        boolean hourlyDue = !saver || options.force
            || now - prefs.getLong(KEY_LAST_HOURLY, 0L) >= SAVER_HOURLY_EVERY_MS;
        String today = StepLedger.today();

        int dirty = 0;
        for (StepLedger.Day day : days) {
            if (isDirty(day, acked, hourlyDue || day.date.compareTo(today) < 0)) dirty++;
        }
        result.pendingDays = dirty;
        if (dirty == 0) {
            result.status = "nothing";
            return result;
        }

        long nextAllowed = prefs.getLong(KEY_NEXT_ALLOWED, 0L);
        if (now < nextAllowed) {
            // Retry-After / backoff applies to every trigger, including "Sync now".
            result.status = "backoff";
            result.retryAt = nextAllowed;
            return result;
        }
        if (!SyncPolicy.online(context)) {
            result.status = "offline";
            return result;
        }

        prefs.edit().putLong(KEY_LAST_ATTEMPT, now).apply();
        int requests = 0;
        boolean anySuccess = false;

        for (StepLedger.Day day : days) {
            boolean final_ = day.date.compareTo(today) < 0;
            if (!isDirty(day, acked, hourlyDue || final_)) continue;
            JSONObject b = dayBackoff.optJSONObject(day.date);
            if (!options.force && b != null && b.optLong("until", 0L) > now) continue;
            if (requests >= MAX_REQUESTS_PER_RUN) break;

            JSONObject ackedDay = acked.optJSONObject(day.date);
            int ackedTotal = ackedDay == null ? 0 : ackedDay.optInt("s", 0);

            // 1) Daily total (what challenges count).
            if (day.total > ackedTotal) {
                if (requests > 0) pace();
                requests++;
                String outcome = uploadDay(context, apiBase, userKey, day, ackedTotal, options);
                if ("ok".equals(outcome)) {
                    anySuccess = true;
                    result.uploaded++;
                    acked = readJson(prefs, KEY_ACKED + userKey);
                    clearDayBackoff(prefs, userKey, day.date);
                } else if ("rejected".equals(outcome)) {
                    bumpDayBackoff(prefs, userKey, day.date);
                    dayBackoff = readJson(prefs, KEY_DAY_BACKOFF + userKey);
                    continue;
                } else {
                    return finishWithStop(prefs, result, outcome, anySuccess);
                }
            }

            // 2) Hourly breakdown (+ route points unless saving data/battery).
            ackedDay = acked.optJSONObject(day.date);
            String hash = hourlyHash(day);
            boolean hourlyDirty = ackedDay == null || !hash.equals(ackedDay.optString("hh", ""));
            if (hourlyDirty && day.total > 0 && (hourlyDue || final_)) {
                if (requests > 0) pace();
                requests++;
                String outcome = uploadHourly(context, apiBase, day, !saver, options);
                if ("ok".equals(outcome)) {
                    anySuccess = true;
                    markHourlyAcked(prefs, userKey, day.date, hash);
                    acked = readJson(prefs, KEY_ACKED + userKey);
                    prefs.edit().putLong(KEY_LAST_HOURLY, System.currentTimeMillis()).apply();
                } else if (!"rejected".equals(outcome)) {
                    return finishWithStop(prefs, result, outcome, anySuccess);
                }
            }
        }

        if (anySuccess) {
            prefs.edit()
                .putLong(KEY_LAST_SUCCESS, System.currentTimeMillis())
                .putInt(KEY_FAILURES, 0)
                .putLong(KEY_NEXT_ALLOWED, 0L)
                .apply();
        }
        int remaining = 0;
        acked = readJson(prefs, KEY_ACKED + userKey);
        for (StepLedger.Day day : StepLedger.getDays(context)) {
            JSONObject a = acked.optJSONObject(day.date);
            if (day.total > (a == null ? 0 : a.optInt("s", 0))) remaining++;
        }
        result.pendingDays = remaining;
        result.status = anySuccess ? "ok" : (remaining > 0 ? "pending" : "nothing");
        return result;
    }

    private static boolean isDirty(StepLedger.Day day, JSONObject acked, boolean includeHourly) {
        JSONObject a = acked.optJSONObject(day.date);
        int ackedTotal = a == null ? 0 : a.optInt("s", 0);
        if (day.total > ackedTotal) return true;
        return includeHourly && day.total > 0 && (a == null || !hourlyHash(day).equals(a.optString("hh", "")));
    }

    private static Result finishWithStop(SharedPreferences prefs, Result result, String outcome, boolean anySuccess) {
        if (anySuccess) {
            prefs.edit().putLong(KEY_LAST_SUCCESS, System.currentTimeMillis()).apply();
        }
        result.status = outcome; // throttled / offline / error / auth / signed_out
        long next = prefs.getLong(KEY_NEXT_ALLOWED, 0L);
        if (next > System.currentTimeMillis()) result.retryAt = next;
        return result;
    }

    /** Returns ok | rejected | throttled | error | offline | auth | signed_out. */
    private static String uploadDay(Context context, String apiBase, String userKey, StepLedger.Day day, int ackedTotal, Options options) {
        SharedPreferences prefs = SyncPolicy.prefs(context);
        // The reading being uploaded keeps its id/timestamp until the server confirms it,
        // so a retry is recognised as the same reading (idempotent).
        JSONObject pendingAll = readJson(prefs, KEY_PENDING + userKey);
        JSONObject reading = pendingAll.optJSONObject(day.date);
        if (reading == null || reading.optInt("t", -1) != day.total) {
            reading = new JSONObject();
            try {
                reading.put("t", day.total);
                reading.put("ts", Instant.now().toString());
                reading.put("id", UUID.randomUUID().toString());
                pendingAll.put(day.date, reading);
            } catch (Exception ignored) {
                return "error";
            }
            prefs.edit().putString(KEY_PENDING + userKey, pendingAll.toString()).commit();
        }

        for (int attempt = 0; attempt < 3; attempt++) {
            JSONObject session = ensureSession(context, apiBase, options);
            if (session == null) {
                return lastSessionOutcome;
            }
            JSONObject body = buildDayPayload(context, day, ackedTotal, reading, session);
            HttpResult http = post(context, apiBase + "/api/steps/sync/", body.toString(), options);
            String outcome = classify(context, http, options);
            if ("ok".equals(outcome) || http.code == 409) {
                markDayAcked(prefs, userKey, day.date, day.total);
                return "ok";
            }
            if ("session".equals(outcome)) {
                clearSession(context); // expired / rejected session: start a new one and retry once
                continue;
            }
            if ("retry_auth".equals(outcome)) {
                continue; // token was refreshed
            }
            return outcome;
        }
        return "error";
    }

    private static String uploadHourly(Context context, String apiBase, StepLedger.Day day, boolean withRoute, Options options) {
        JSONObject body = new JSONObject();
        String lastPointAt = null;
        try {
            double stride = clamp(SyncPolicy.prefs(context).getFloat(SyncPolicy.KEY_STRIDE_CM, 78f), 40, 130);
            double weight = clamp(SyncPolicy.prefs(context).getFloat(SyncPolicy.KEY_WEIGHT_KG, 70f), 30, 220);
            JSONArray hourly = new JSONArray();
            for (int h = 0; h < 24; h++) {
                int steps = day.hours[h];
                if (steps <= 0) continue;
                JSONObject item = new JSONObject();
                item.put("hour", h);
                item.put("steps", steps);
                item.put("distance_km", round(steps * stride / 100.0 / 1000.0, 3));
                int minutes = Math.max(1, Math.round(steps / 120f));
                item.put("calories", round(metFor(0, steps) * 3.5 * weight / 200.0 * minutes, 1));
                hourly.put(item);
            }
            body.put("date", day.date);
            body.put("hourly", hourly);
            JSONArray points = new JSONArray();
            if (withRoute) {
                JSONObject pending = StepCaptureForegroundService.readPendingWaypoints(context);
                if (day.date.equals(pending.optString("date"))) {
                    points = pending.optJSONArray("waypoints");
                    if (points == null) points = new JSONArray();
                    for (int i = 0; i < points.length(); i++) {
                        JSONObject p = points.optJSONObject(i);
                        if (p != null) lastPointAt = p.optString("recorded_at", lastPointAt);
                    }
                }
            }
            body.put("waypoints", points);
        } catch (Exception ignored) {
            return "error";
        }
        for (int attempt = 0; attempt < 2; attempt++) {
            HttpResult http = post(context, apiBase + "/api/steps/sync/hourly/", body.toString(), options);
            String outcome = classify(context, http, options);
            if ("ok".equals(outcome)) {
                if (lastPointAt != null) {
                    StepCaptureForegroundService.clearWaypointsUpTo(context, day.date, lastPointAt);
                }
                return "ok";
            }
            if ("retry_auth".equals(outcome)) continue;
            if (http.code == 413) {
                // Too big: keep the route points on the phone, send the hours alone.
                try {
                    body.put("waypoints", new JSONArray());
                } catch (Exception ignored) {
                    return "rejected";
                }
                lastPointAt = null;
                continue;
            }
            return "session".equals(outcome) ? "rejected" : outcome;
        }
        return "error";
    }

    /**
     * ok | session (renew and retry) | retry_auth (token refreshed) | rejected (400-type,
     * back off this day) | throttled | error | offline | auth (JWT expired while the app
     * is open: the web layer refreshes it) | signed_out.
     */
    private static String classify(Context context, HttpResult http, Options options) {
        SharedPreferences prefs = SyncPolicy.prefs(context);
        if (http.networkError) {
            scheduleBackoff(prefs);
            return SyncPolicy.online(context) ? "error" : "offline";
        }
        int code = http.code;
        if (code >= 200 && code < 300) {
            return "ok";
        }
        String lower = http.body == null ? "" : http.body.toLowerCase(Locale.ROOT);
        if (code == 429 || code == 503) {
            long wait = http.retryAfterMs > 0 ? http.retryAfterMs : backoffDelay(prefs.getInt(KEY_FAILURES, 0));
            // Add up to 30% random spread on top of the server's value so phones throttled
            // together don't return together.
            long jitter = (long) (wait * 0.3 * RANDOM.nextDouble());
            long until = System.currentTimeMillis() + Math.max(2_000L, wait + jitter);
            prefs.edit().putLong(KEY_NEXT_ALLOWED, until).apply();
            return "throttled";
        }
        if (code == 401 || code == 400) {
            if (lower.contains("replay_detected") || lower.contains("could not be verified")) {
                return "session";
            }
        }
        if (code == 401) {
            if (options.foreground) {
                return "auth"; // the web layer refreshes tokens while it's running
            }
            return refreshAccessToken(context) ? "retry_auth" : "signed_out";
        }
        if (code == 409) {
            return "ok";
        }
        if (code == 400 || code == 403 || code == 404 || code == 413 || code == 422) {
            return "rejected";
        }
        scheduleBackoff(prefs); // 5xx and anything unexpected
        return "error";
    }

    private static void scheduleBackoff(SharedPreferences prefs) {
        int failures = prefs.getInt(KEY_FAILURES, 0) + 1;
        long until = System.currentTimeMillis() + backoffDelay(failures);
        prefs.edit().putInt(KEY_FAILURES, failures).putLong(KEY_NEXT_ALLOWED, until).apply();
    }

    /** Exponential backoff with "equal jitter": 30 s, 1 min, 2 min ... capped at 30 min. */
    private static long backoffDelay(int failures) {
        long ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS << Math.min(10, Math.max(0, failures - 1)));
        return ceiling / 2 + (long) (RANDOM.nextDouble() * (ceiling / 2));
    }

    private static void bumpDayBackoff(SharedPreferences prefs, String userKey, String date) {
        JSONObject all = readJson(prefs, KEY_DAY_BACKOFF + userKey);
        JSONObject entry = all.optJSONObject(date);
        int n = entry == null ? 1 : entry.optInt("n", 0) + 1;
        long delay = Math.min(DAY_BACKOFF_MAX_MS, DAY_BACKOFF_BASE_MS << Math.min(6, n - 1));
        try {
            JSONObject next = new JSONObject();
            next.put("n", n);
            next.put("until", System.currentTimeMillis() + delay);
            all.put(date, next);
        } catch (Exception ignored) {
            return;
        }
        prefs.edit().putString(KEY_DAY_BACKOFF + userKey, all.toString()).apply();
    }

    private static void clearDayBackoff(SharedPreferences prefs, String userKey, String date) {
        JSONObject all = readJson(prefs, KEY_DAY_BACKOFF + userKey);
        if (all.has(date)) {
            all.remove(date);
            prefs.edit().putString(KEY_DAY_BACKOFF + userKey, all.toString()).apply();
        }
    }

    private static void markDayAcked(SharedPreferences prefs, String userKey, String date, int total) {
        JSONObject acked = readJson(prefs, KEY_ACKED + userKey);
        try {
            JSONObject day = acked.optJSONObject(date);
            if (day == null) day = new JSONObject();
            day.put("s", Math.max(total, day.optInt("s", 0)));
            acked.put(date, day);
            pruneByDate(acked);
        } catch (Exception ignored) {
            return;
        }
        JSONObject pending = readJson(prefs, KEY_PENDING + userKey);
        JSONObject reading = pending.optJSONObject(date);
        if (reading != null && reading.optInt("t", -1) <= total) {
            pending.remove(date);
        }
        pruneByDate(pending);
        prefs.edit()
            .putString(KEY_ACKED + userKey, acked.toString())
            .putString(KEY_PENDING + userKey, pending.toString())
            .commit();
    }

    private static void markHourlyAcked(SharedPreferences prefs, String userKey, String date, String hash) {
        JSONObject acked = readJson(prefs, KEY_ACKED + userKey);
        try {
            JSONObject day = acked.optJSONObject(date);
            if (day == null) day = new JSONObject();
            day.put("hh", hash);
            acked.put(date, day);
        } catch (Exception ignored) {
            return;
        }
        prefs.edit().putString(KEY_ACKED + userKey, acked.toString()).commit();
    }

    private static void pruneByDate(JSONObject byDate) {
        String oldest = java.time.LocalDate.now().minusDays(StepLedger.KEEP_DAYS + 2).toString();
        JSONArray names = byDate.names();
        if (names == null) return;
        for (int i = 0; i < names.length(); i++) {
            String key = names.optString(i);
            if (key.compareTo(oldest) < 0) byDate.remove(key);
        }
    }

    private static String hourlyHash(StepLedger.Day day) {
        StringBuilder sb = new StringBuilder();
        for (int h : day.hours) sb.append(h).append(',');
        return Integer.toHexString(sb.toString().hashCode());
    }

    // ── payload ──────────────────────────────────────────────────────────────

    private static JSONObject buildDayPayload(Context context, StepLedger.Day day, int ackedTotal, JSONObject reading, JSONObject session) {
        SharedPreferences cfg = SyncPolicy.prefs(context);
        JSONObject p = new JSONObject();
        try {
            int steps = reading.optInt("t", day.total);
            double stride = clamp(cfg.getFloat(SyncPolicy.KEY_STRIDE_CM, 78f), 40, 130);
            double weight = clamp(cfg.getFloat(SyncPolicy.KEY_WEIGHT_KG, 70f), 30, 220);
            boolean isToday = day.date.equals(StepLedger.today());
            long now = System.currentTimeMillis();
            boolean liveFresh = isToday && now - liveUpdatedAt < 2 * 60_000L;
            int cadence = liveFresh ? liveCadenceSpm : 0;
            int burst = liveFresh ? liveBurst5s : 0;

            p.put("date", day.date);
            p.put("source", "device_sensor");
            p.put("steps", steps);
            p.put("distance_km", steps > 0 ? round(steps * stride / 100.0 / 1000.0, 2) : JSONObject.NULL);
            int activeMinutes = steps > 0 ? Math.max(1, Math.round(steps / 120f)) : 0;
            p.put("active_minutes", steps > 0 ? activeMinutes : JSONObject.NULL);
            p.put("calories_active", activeMinutes > 0
                ? (int) Math.round(metFor(cadence, steps) * 3.5 * weight / 200.0 * activeMinutes)
                : JSONObject.NULL);
            p.put("cadence_spm", clamp(cadence, 0, 400));
            p.put("burst_steps_5s", Math.max(0, Math.min(100, burst)));

            // Gait / on-device ML features only when they describe *this* walking (fresh
            // samples today). Otherwise null = "not measured", exactly like iOS, so the
            // server skips those checks instead of scoring stale or zero values.
            GaitAnalyzer gait = GaitAnalyzer.SHARED;
            boolean gaitFresh = isToday && now - gait.getLastSampleTsMs() < GAIT_FRESH_MS;
            GaitAnalyzer.Snapshot s = gait.getSnapshot();
            p.put("gait_state", gaitFresh ? s.gaitState : JSONObject.NULL);
            p.put("gait_confidence", gaitFresh ? clamp(s.confidence, 0, 100) : JSONObject.NULL);
            p.put("gait_dominant_freq_hz", gaitFresh ? clamp(s.dominantFreqHz, 0, 10) : JSONObject.NULL);
            p.put("gait_autocorr", gaitFresh ? clamp(s.autocorr, 0, 1) : JSONObject.NULL);
            p.put("gait_interval_std_ms", gaitFresh ? clamp(s.intervalStdMs, 0, 5000) : JSONObject.NULL);
            p.put("gait_valid_peaks_2s", gaitFresh ? Math.max(0, Math.min(30, s.validPeaks2s)) : JSONObject.NULL);
            p.put("gait_gyro_variance", gaitFresh ? clamp(s.gyroVariance, 0, 1000) : JSONObject.NULL);
            p.put("gait_jerk_rms", gaitFresh ? clamp(s.jerkRms, 0, 1000) : JSONObject.NULL);
            p.put("carry_mode", gaitFresh ? s.carryMode : JSONObject.NULL);
            p.put("ml_motion_label", gaitFresh ? s.mlMotionLabel : JSONObject.NULL);
            p.put("ml_walk_probability", gaitFresh ? round(clamp(s.mlWalkProbability, 0, 1), 4) : JSONObject.NULL);
            p.put("ml_shake_probability", gaitFresh ? round(clamp(s.mlShakeProbability, 0, 1), 4) : JSONObject.NULL);
            p.put("smoothed_walk_probability", gaitFresh ? round(clamp(s.smoothedWalkProbability, 0, 1), 4) : JSONObject.NULL);
            p.put("smoothed_shake_probability", gaitFresh ? round(clamp(s.smoothedShakeProbability, 0, 1), 4) : JSONObject.NULL);
            p.put("ml_window_count", gaitFresh ? s.mlWindowCount : JSONObject.NULL);
            p.put("ml_confidence_stability", gaitFresh ? round(clamp(s.mlConfidenceStability, 0, 1), 4) : JSONObject.NULL);
            p.put("motion_entropy", gaitFresh ? round(clamp(s.motionEntropy, 0, 10), 4) : JSONObject.NULL);
            p.put("ml_model_version", s.mlModelVersion != null ? s.mlModelVersion : "shakewalk-logreg-v1");

            int sequence = claimSequence(context);
            p.put("device_id", deviceId(context));
            p.put("session_id", session.optString("session_id"));
            p.put("session_token", session.optString("session_token"));
            p.put("client_event_id", reading.optString("id"));
            p.put("sequence_number", sequence);
            p.put("timestamp_client", reading.optString("ts"));
            p.put("steps_total", steps);
            p.put("steps_delta", Math.max(0, steps - ackedTotal));
            p.put("payload_hash", sha256(session.optString("session_id") + "|" + reading.optString("id") + "|"
                + sequence + "|" + reading.optString("ts") + "|" + steps));
        } catch (Exception ignored) {
            // A partially built payload is still validated by the server.
        }
        return p;
    }

    private static double metFor(int cadence, int steps) {
        double c = cadence > 0 ? cadence : (steps > 0 ? Math.min(160, Math.max(60, steps / 60.0)) : 0);
        return c >= 130 ? 6.5 : c >= 110 ? 4.8 : c >= 90 ? 3.5 : 2.5;
    }

    // ── session (replay protection) ─────────────────────────────────────────

    private static volatile String lastSessionOutcome = "error";

    private static JSONObject ensureSession(Context context, String apiBase, Options options) {
        SharedPreferences prefs = sessionPrefs(context);
        synchronized (StepSyncEngine.class) {
            String id = prefs.getString("step_session_id", null);
            String token = prefs.getString("step_session_token", null);
            String expires = prefs.getString("step_session_expires_at", null);
            boolean valid = id != null && token != null && expires != null;
            if (valid) {
                try {
                    valid = Instant.parse(normalizeIso(expires)).toEpochMilli() - System.currentTimeMillis() > 2 * 60_000L;
                } catch (Exception ignored) {
                    valid = false;
                }
            }
            if (valid) {
                JSONObject s = new JSONObject();
                try {
                    s.put("session_id", id);
                    s.put("session_token", token);
                } catch (Exception ignored) {
                    return null;
                }
                return s;
            }
        }
        JSONObject req = new JSONObject();
        try {
            req.put("device_id", deviceId(context));
            req.put("platform", "android");
            req.put("app_version", appVersion(context));
            req.put("ml_model_version", GaitAnalyzer.SHARED.getSnapshot().mlModelVersion);
        } catch (Exception ignored) {
            lastSessionOutcome = "error";
            return null;
        }
        for (int attempt = 0; attempt < 2; attempt++) {
            HttpResult http = post(context, apiBase + "/api/steps/session/start/", req.toString(), options);
            String outcome = classify(context, http, options);
            if ("retry_auth".equals(outcome)) continue;
            if (!"ok".equals(outcome)) {
                lastSessionOutcome = "session".equals(outcome) ? "rejected" : outcome;
                return null;
            }
            try {
                JSONObject res = new JSONObject(http.body);
                synchronized (StepSyncEngine.class) {
                    prefs.edit()
                        .putString("step_session_id", res.getString("session_id"))
                        .putString("step_session_token", res.getString("session_token"))
                        .putString("step_session_expires_at", res.getString("expires_at"))
                        .putInt("step_session_next_sequence", Math.max(1, res.optInt("sequence_start", 1)))
                        .commit();
                }
                JSONObject s = new JSONObject();
                s.put("session_id", res.getString("session_id"));
                s.put("session_token", res.getString("session_token"));
                return s;
            } catch (Exception ignored) {
                lastSessionOutcome = "error";
                return null;
            }
        }
        lastSessionOutcome = "error";
        return null;
    }

    static void clearSession(Context context) {
        synchronized (StepSyncEngine.class) {
            sessionPrefs(context).edit()
                .remove("step_session_id")
                .remove("step_session_token")
                .remove("step_session_expires_at")
                .remove("step_session_next_sequence")
                .remove("step_session_last_total")
                .commit();
        }
    }

    /** Next sequence number for the active session (strictly increasing, shared by every caller). */
    static int claimSequence(Context context) {
        synchronized (StepSyncEngine.class) {
            SharedPreferences prefs = sessionPrefs(context);
            int next = Math.max(1, prefs.getInt("step_session_next_sequence", 1));
            prefs.edit().putInt("step_session_next_sequence", next + 1).commit();
            return next;
        }
    }

    private static SharedPreferences sessionPrefs(Context context) {
        return context.getApplicationContext().getSharedPreferences(StepCaptureForegroundService.PREFS, Context.MODE_PRIVATE);
    }

    static String deviceId(Context context) {
        SharedPreferences prefs = sessionPrefs(context);
        String stored = prefs.getString("device_id", null);
        if (stored != null && !stored.isEmpty()) return stored;
        String androidId = Settings.Secure.getString(context.getContentResolver(), Settings.Secure.ANDROID_ID);
        String id = (androidId != null && !androidId.trim().isEmpty()) ? androidId : UUID.randomUUID().toString();
        prefs.edit().putString("device_id", id).apply();
        return id;
    }

    private static String appVersion(Context context) {
        try {
            PackageInfo info = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
            return info.versionName != null ? info.versionName : "unknown";
        } catch (Exception ignored) {
            return "unknown";
        }
    }

    // ── auth (tokens live in Capacitor Preferences = SharedPreferences "CapacitorStorage") ──

    private static SharedPreferences capStorage(Context context) {
        return context.getApplicationContext().getSharedPreferences(CAP_STORAGE, Context.MODE_PRIVATE);
    }

    private static String jwtUserId(String token) {
        JSONObject claims = jwtClaims(token);
        if (claims == null) return null;
        Object id = claims.opt("user_id");
        return id == null || id == JSONObject.NULL ? null : String.valueOf(id);
    }

    private static JSONObject jwtClaims(String token) {
        if (token == null) return null;
        String[] parts = token.split("\\.");
        if (parts.length < 2) return null;
        try {
            byte[] decoded = Base64.decode(parts[1], Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
            return new JSONObject(new String(decoded, StandardCharsets.UTF_8));
        } catch (Exception ignored) {
            return null;
        }
    }

    private static boolean tokenFresh(String token) {
        JSONObject claims = jwtClaims(token);
        if (claims == null) return false;
        long exp = claims.optLong("exp", 0L) * 1000L;
        return exp - System.currentTimeMillis() > 60_000L;
    }

    /**
     * Background only (the web layer isn't running): rotate the refresh token and store both
     * tokens where the app reads them, so the next app start stays signed in.
     */
    private static synchronized boolean refreshAccessToken(Context context) {
        SharedPreferences store = capStorage(context);
        String access = store.getString("access_token", null);
        if (tokenFresh(access)) return true; // someone else already refreshed
        String refresh = store.getString("refresh_token", null);
        if (refresh == null || SyncPolicy.appInForeground) return false;
        JSONObject body = new JSONObject();
        try {
            body.put("refresh", refresh);
        } catch (Exception ignored) {
            return false;
        }
        HttpResult http = rawPost(SyncPolicy.apiBase(context) + "/api/auth/refresh/", body.toString(), null);
        if (http.code != 200) return false;
        try {
            JSONObject res = new JSONObject(http.body);
            SharedPreferences.Editor editor = store.edit().putString("access_token", res.getString("access"));
            if (res.has("refresh")) editor.putString("refresh_token", res.getString("refresh"));
            return editor.commit();
        } catch (Exception ignored) {
            return false;
        }
    }

    // ── HTTP ─────────────────────────────────────────────────────────────────

    private static HttpResult post(Context context, String url, String json, Options options) {
        String access = capStorage(context).getString("access_token", null);
        if (!tokenFresh(access) && !options.foreground && refreshAccessToken(context)) {
            access = capStorage(context).getString("access_token", null);
        }
        return rawPost(url, json, access);
    }

    private static HttpResult rawPost(String url, String json, String bearer) {
        HttpResult result = new HttpResult();
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
            conn.setReadTimeout(READ_TIMEOUT_MS);
            conn.setRequestMethod("POST");
            conn.setDoOutput(true);
            conn.setRequestProperty("Content-Type", "application/json");
            conn.setRequestProperty("Accept", "application/json");
            conn.setRequestProperty("X-Client", "step2win-android-sync");
            if (bearer != null) conn.setRequestProperty("Authorization", "Bearer " + bearer);
            byte[] bytes = json.getBytes(StandardCharsets.UTF_8);
            conn.setFixedLengthStreamingMode(bytes.length);
            try (OutputStream out = conn.getOutputStream()) {
                out.write(bytes);
            }
            result.code = conn.getResponseCode();
            result.retryAfterMs = parseRetryAfter(conn.getHeaderField("Retry-After"));
            InputStream in = result.code >= 400 ? conn.getErrorStream() : conn.getInputStream();
            result.body = readAll(in);
        } catch (Exception error) {
            result.networkError = true;
            Log.i(TAG, "POST " + url + " failed: " + error.getClass().getSimpleName());
        } finally {
            if (conn != null) conn.disconnect();
        }
        Log.i(TAG, "POST " + url.replaceAll("^https?://[^/]+", "") + " -> " + result.code);
        return result;
    }

    private static long parseRetryAfter(String header) {
        if (header == null || header.trim().isEmpty()) return -1L;
        try {
            return Math.max(0L, Long.parseLong(header.trim())) * 1000L;
        } catch (NumberFormatException ignored) {
            try {
                ZonedDateTime at = ZonedDateTime.parse(header.trim(), DateTimeFormatter.RFC_1123_DATE_TIME);
                return Math.max(0L, at.toInstant().toEpochMilli() - System.currentTimeMillis());
            } catch (Exception ignoredToo) {
                return -1L;
            }
        }
    }

    private static String readAll(InputStream in) {
        if (in == null) return "";
        try (InputStream stream = in; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buf = new byte[4096];
            int n;
            int total = 0;
            while ((n = stream.read(buf)) > 0 && total < 256 * 1024) {
                out.write(buf, 0, n);
                total += n;
            }
            return out.toString("UTF-8");
        } catch (Exception ignored) {
            return "";
        }
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    private static void pace() {
        try {
            Thread.sleep(1000L + RANDOM.nextInt(800));
        } catch (InterruptedException ignored) {
            Thread.currentThread().interrupt();
        }
    }

    private static JSONObject readJson(SharedPreferences prefs, String key) {
        try {
            return new JSONObject(prefs.getString(key, "{}"));
        } catch (Exception ignored) {
            return new JSONObject();
        }
    }

    private static double clamp(double value, double min, double max) {
        if (Double.isNaN(value)) return min;
        return Math.max(min, Math.min(max, value));
    }

    private static double round(double value, int digits) {
        double f = Math.pow(10, digits);
        return Math.round(value * f) / f;
    }

    private static String normalizeIso(String value) {
        // Server timestamps may carry +00:00 instead of Z, and microseconds.
        return value.replace("+00:00", "Z");
    }

    private static String sha256(String value) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hash = digest.digest(value.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            for (byte b : hash) sb.append(String.format(Locale.ROOT, "%02x", b));
            return sb.toString();
        } catch (Exception ignored) {
            return "";
        }
    }
}
