package com.step2win.app;

import org.json.JSONArray;
import org.json.JSONObject;

import java.security.MessageDigest;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;

/**
 * Phase 1c: Health Connect provenance and per-hour summaries. Pure Java (no Android or
 * Health Connect classes) so the logic is covered by JVM unit tests; the SDK sits behind
 * {@link HealthConnectGateway}.
 *
 * <p>The phone only describes what it read: per local hour and data origin (the app that
 * wrote it), the device type and the recording method. The server decides what counts
 * (trusted-origin allowlist, manual entries never count). Nothing here is money logic.</p>
 */
public final class HealthSourceCore {
    private HealthSourceCore() {}

    static final String HC_PACKAGE = "com.google.android.apps.healthdata";
    static final String OWN_PACKAGE = "com.step2win.app";

    // HealthConnectClient.SDK_* (connect-client 1.1.0)
    static final int SDK_UNAVAILABLE = 1;
    static final int SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED = 2;
    static final int SDK_AVAILABLE = 3;

    // Read-only permissions (manifest + request). Routes and background are optional.
    static final String PERM_STEPS = "android.permission.health.READ_STEPS";
    static final String PERM_EXERCISE = "android.permission.health.READ_EXERCISE";
    static final String PERM_ROUTES = "android.permission.health.READ_EXERCISE_ROUTES";
    static final String PERM_BACKGROUND = "android.permission.health.READ_HEALTH_DATA_IN_BACKGROUND";

    // Device.TYPE_* (connect-client 1.1.0)
    static String deviceName(int type) {
        switch (type) {
            case 1: return "watch";
            case 2: return "phone";
            case 3: return "scale";
            case 4: return "ring";
            case 5: return "head_mounted";
            case 6: return "band";
            case 7: return "chest_strap";
            case 8: return "display";
            default: return "unknown";
        }
    }

    // Metadata.RECORDING_METHOD_* (connect-client 1.1.0)
    static String methodName(int method) {
        switch (method) {
            case 1: return "active";
            case 2: return "automatic";
            case 3: return "manual";
            default: return "unknown";
        }
    }

    // ExerciseSessionRecord.EXERCISE_TYPE_* (connect-client 1.1.0)
    static String exerciseName(int type) {
        switch (type) {
            case 79: return "walking";
            case 56: return "running";
            case 57: return "treadmill";
            case 37: return "hiking";
            case 82: return "wheelchair";
            default: return "other";
        }
    }

    /**
     * Where Health Connect stands on this phone: available | update_required |
     * not_installed (Android 9-13 without the Health Connect app: offer the Play Store) |
     * unsupported (older than Android 9, or unavailable on Android 14+, e.g. a work profile).
     */
    static String availability(int sdkStatus, int sdkInt) {
        if (sdkStatus == SDK_AVAILABLE) return "available";
        if (sdkStatus == SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED) return "update_required";
        if (sdkInt < 28) return "unsupported";
        if (sdkInt >= 34) return "unsupported"; // built into Android 14+: nothing to install
        return "not_installed";
    }

    /**
     * What the "Connected sources" screen shows: off (user hasn't opted in) | unavailable
     * | needs_install | needs_update | permission_denied (steps not allowed, e.g. revoked
     * in Health Connect) | connected.
     */
    static String connectionState(boolean optedIn, String availability, Set<String> granted) {
        if (!optedIn) return "off";
        if ("not_installed".equals(availability)) return "needs_install";
        if ("update_required".equals(availability)) return "needs_update";
        if (!"available".equals(availability)) return "unavailable";
        if (granted == null || !granted.contains(PERM_STEPS)) return "permission_denied";
        return "connected";
    }

    /** One StepsRecord as read from Health Connect. */
    public static final class StepSample {
        final String origin;
        final int deviceType;
        final int method;
        final long startMs;
        final long endMs;
        final long count;

        public StepSample(String origin, int deviceType, int method, long startMs, long endMs, long count) {
            this.origin = origin == null ? "" : origin;
            this.deviceType = deviceType;
            this.method = method;
            this.startMs = startMs;
            this.endMs = Math.max(startMs, endMs);
            this.count = Math.max(0, count);
        }
    }

    /** One ExerciseSessionRecord (route reduced to a point count and a distance). */
    public static final class Workout {
        final String origin;
        final int deviceType;
        final int method;
        final long startMs;
        final long endMs;
        final int exerciseType;
        final Double distanceM;
        final Long steps;
        final int routePoints;
        final Double routeDistanceM;

        public Workout(String origin, int deviceType, int method, long startMs, long endMs, int exerciseType,
                Double distanceM, Long steps, int routePoints, Double routeDistanceM) {
            this.origin = origin == null ? "" : origin;
            this.deviceType = deviceType;
            this.method = method;
            this.startMs = startMs;
            this.endMs = endMs;
            this.exerciseType = exerciseType;
            this.distanceM = distanceM;
            this.steps = steps;
            this.routePoints = routePoints;
            this.routeDistanceM = routeDistanceM;
        }
    }

    /** Distance along a route (haversine). The coordinates never leave the phone. */
    public static double routeDistanceM(double[] lat, double[] lng) {
        if (lat == null || lng == null) return 0;
        double total = 0;
        for (int i = 1; i < Math.min(lat.length, lng.length); i++) {
            total += haversine(lat[i - 1], lng[i - 1], lat[i], lng[i]);
        }
        return total;
    }

    static double haversine(double lat1, double lon1, double lat2, double lon2) {
        double r = 6_371_000.0;
        double p1 = Math.toRadians(lat1), p2 = Math.toRadians(lat2);
        double dp = Math.toRadians(lat2 - lat1), dl = Math.toRadians(lon2 - lon1);
        double a = Math.sin(dp / 2) * Math.sin(dp / 2) + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
        return 2 * r * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    /**
     * Spread a sample's steps over the local hours of {@code day} it overlaps
     * (proportionally to time; an instantaneous sample goes to its hour).
     */
    static double[] splitByHour(StepSample s, LocalDate day, ZoneId zone) {
        double[] out = new double[24];
        long dayStart = day.atStartOfDay(zone).toInstant().toEpochMilli();
        long dayEnd = day.plusDays(1).atStartOfDay(zone).toInstant().toEpochMilli();
        if (s.count <= 0 || s.endMs < dayStart || s.startMs >= dayEnd) return out;
        long span = s.endMs - s.startMs;
        if (span <= 0) {
            int h = hourOf(s.startMs, zone);
            if (s.startMs >= dayStart && s.startMs < dayEnd) out[h] += s.count;
            return out;
        }
        long cur = Math.max(s.startMs, dayStart);
        long end = Math.min(s.endMs, dayEnd);
        while (cur < end) {
            ZonedDateTime z = Instant.ofEpochMilli(cur).atZone(zone);
            long nextHour = z.withMinute(0).withSecond(0).withNano(0).plusHours(1).toInstant().toEpochMilli();
            long segEnd = Math.min(end, nextHour);
            out[z.getHour()] += s.count * (double) (segEnd - cur) / span;
            cur = segEnd;
        }
        return out;
    }

    static int hourOf(long ms, ZoneId zone) {
        return Instant.ofEpochMilli(ms).atZone(zone).getHour();
    }

    private static final class Cell {
        double manual;
        final Map<String, Double> manualDevices = new HashMap<>();
        /** Non-manual steps per device type, and per device the steps by recording method. */
        final Map<String, Double> byDevice = new TreeMap<>();
        final Map<String, Map<String, Double>> methodsByDevice = new HashMap<>();
    }

    /**
     * Per (local hour, origin, device type) entries for the server:
     * {hour, origin, steps, device, method}.
     *
     * <p>One entry per device type, so a Galaxy Watch and the phone's own count inside
     * Samsung Health stay apart (the server merges them by max, never a sum, and only the
     * watch part is "wearable"). When Health Connect's per-origin hourly aggregate is
     * available it bounds every entry (it de-duplicates overlapping records of one origin).
     * Manual steps are always their own entry (the server never counts them). Our own
     * package is skipped.</p>
     */
    static JSONArray buildHours(List<StepSample> samples, Map<String, long[]> aggregated, LocalDate day, ZoneId zone) {
        Map<String, Cell[]> byOrigin = new TreeMap<>();
        for (StepSample s : samples) {
            if (s.origin.isEmpty() || OWN_PACKAGE.equals(s.origin)) continue;
            double[] parts = splitByHour(s, day, zone);
            Cell[] cells = byOrigin.get(s.origin);
            if (cells == null) {
                cells = new Cell[24];
                byOrigin.put(s.origin, cells);
            }
            boolean manual = s.method == 3;
            String device = deviceName(s.deviceType);
            String method = methodName(s.method);
            for (int h = 0; h < 24; h++) {
                if (parts[h] <= 0) continue;
                if (cells[h] == null) cells[h] = new Cell();
                Cell c = cells[h];
                if (manual) {
                    c.manual += parts[h];
                    c.manualDevices.merge(device, parts[h], Double::sum);
                } else {
                    c.byDevice.merge(device, parts[h], Double::sum);
                    Map<String, Double> methods = c.methodsByDevice.get(device);
                    if (methods == null) {
                        methods = new HashMap<>();
                        c.methodsByDevice.put(device, methods);
                    }
                    methods.merge(method, parts[h], Double::sum);
                }
            }
        }
        JSONArray out = new JSONArray();
        try {
            for (Map.Entry<String, Cell[]> e : byOrigin.entrySet()) {
                long[] agg = aggregated == null ? null : aggregated.get(e.getKey());
                for (int h = 0; h < 24; h++) {
                    Cell c = e.getValue()[h];
                    if (c == null) continue;
                    long manual = Math.round(c.manual);
                    long bound = Long.MAX_VALUE;
                    if (agg != null && agg.length == 24) {
                        long total = Math.max(0, agg[h]);
                        manual = Math.min(manual, total);
                        bound = total - manual;
                    }
                    for (Map.Entry<String, Double> d : c.byDevice.entrySet()) {
                        long steps = Math.min(Math.round(d.getValue()), bound);
                        if (steps > 0) {
                            out.put(entry(h, e.getKey(), steps, d.getKey(), dominant(c.methodsByDevice.get(d.getKey()), "unknown")));
                        }
                    }
                    if (manual > 0) out.put(entry(h, e.getKey(), manual, dominant(c.manualDevices, "unknown"), "manual"));
                }
            }
        } catch (Exception ignored) {
            // JSON puts of plain values don't fail
        }
        return out;
    }

    private static JSONObject entry(int hour, String origin, long steps, String device, String method) throws Exception {
        JSONObject o = new JSONObject();
        o.put("hour", hour);
        o.put("origin", origin);
        o.put("steps", Math.min(14_400L, steps));
        o.put("device", device);
        o.put("method", method);
        return o;
    }

    private static String dominant(Map<String, Double> weights, String fallback) {
        String best = fallback;
        double bestW = -1;
        for (Map.Entry<String, Double> e : new TreeMap<>(weights).entrySet()) {
            if (e.getValue() > bestW) {
                best = e.getKey();
                bestW = e.getValue();
            }
        }
        return best;
    }

    static JSONArray buildWorkouts(List<Workout> workouts) {
        JSONArray out = new JSONArray();
        try {
            for (Workout w : workouts) {
                if (w.origin.isEmpty() || OWN_PACKAGE.equals(w.origin) || w.endMs <= w.startMs) continue;
                JSONObject o = new JSONObject();
                o.put("start", Instant.ofEpochMilli(w.startMs).toString());
                o.put("end", Instant.ofEpochMilli(w.endMs).toString());
                o.put("type", exerciseName(w.exerciseType));
                o.put("origin", w.origin);
                o.put("device", deviceName(w.deviceType));
                o.put("method", methodName(w.method));
                o.put("distance_m", w.distanceM == null ? JSONObject.NULL : Math.round(w.distanceM * 10) / 10.0);
                o.put("steps", w.steps == null ? JSONObject.NULL : w.steps);
                if (w.routePoints > 0 && w.routeDistanceM != null) {
                    JSONObject route = new JSONObject();
                    route.put("points", w.routePoints);
                    route.put("distance_m", Math.round(w.routeDistanceM * 10) / 10.0);
                    o.put("route", route);
                } else {
                    o.put("route", JSONObject.NULL);
                }
                out.put(o);
                if (out.length() >= 20) break;
            }
        } catch (Exception ignored) {
            // plain values
        }
        return out;
    }

    /** The server payload for one day ("health_sources"). */
    static JSONObject dayPayload(JSONArray hours, JSONArray workouts, Instant readAt, int tzOffsetMinutes) {
        JSONObject p = new JSONObject();
        try {
            p.put("provider", "health_connect");
            p.put("platform", "android");
            p.put("read_at", readAt.toString());
            p.put("tz_offset_minutes", tzOffsetMinutes);
            p.put("hours", hours);
            p.put("workouts", workouts);
        } catch (Exception ignored) {
            // plain values
        }
        return p;
    }

    /**
     * Health Connect never returns another app's route to a background read (it answers
     * "consent required"). Keep the route summary an earlier foreground read found for
     * the same workout (same origin, start and end), so a background read doesn't make a
     * verified run look route-less until the next app open.
     */
    static void keepKnownRoutes(JSONObject fresh, JSONObject cached) {
        if (fresh == null || cached == null) return;
        JSONArray now = fresh.optJSONArray("workouts");
        JSONArray before = cached.optJSONArray("workouts");
        if (now == null || before == null) return;
        try {
            for (int i = 0; i < now.length(); i++) {
                JSONObject w = now.optJSONObject(i);
                if (w == null || w.optJSONObject("route") != null) continue;
                for (int j = 0; j < before.length(); j++) {
                    JSONObject b = before.optJSONObject(j);
                    if (b == null || b.optJSONObject("route") == null) continue;
                    if (b.optString("origin").equals(w.optString("origin"))
                        && b.optString("start").equals(w.optString("start"))
                        && b.optString("end").equals(w.optString("end"))) {
                        w.put("route", b.getJSONObject("route"));
                        break;
                    }
                }
            }
        } catch (Exception ignored) {
            // keep the fresh payload as it is
        }
    }

    /** Stable content hash (read time excluded): re-upload only when the data changed. */
    static String contentHash(JSONObject payload) {
        try {
            String basis = payload.optJSONArray("hours") + "|" + payload.optJSONArray("workouts");
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] d = md.digest(basis.getBytes("UTF-8"));
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < 12; i++) sb.append(String.format(Locale.ROOT, "%02x", d[i]));
            return sb.toString();
        } catch (Exception e) {
            return String.valueOf(payload.toString().hashCode());
        }
    }

    // ── Local preview (the server decides; this only mirrors "max, never sum") ────

    /** Per hour, the max over origins (never the sum: a watch and a phone app see the same steps). */
    static long[] hourlyMax(Collection<long[]> perOrigin) {
        long[] out = new long[24];
        for (long[] hours : perOrigin) {
            if (hours == null) continue;
            for (int h = 0; h < Math.min(24, hours.length); h++) out[h] = Math.max(out[h], hours[h]);
        }
        return out;
    }

    /** The day's counted steps: max(our sensor's day total, the sources' per-hour max total). */
    static long dayCounted(long sensorTotal, long[] sourcesHourlyMax) {
        long sum = 0;
        if (sourcesHourlyMax != null) for (long v : sourcesHourlyMax) sum += Math.max(0, v);
        return Math.max(Math.max(0, sensorTotal), sum);
    }

    /** Per origin, per hour steps (non-manual only; device entries merged by max) from {@link #buildHours}. */
    static Map<String, long[]> countedByOrigin(JSONArray hours) {
        Map<String, long[]> out = new TreeMap<>();
        for (int i = 0; i < hours.length(); i++) {
            JSONObject o = hours.optJSONObject(i);
            if (o == null || "manual".equals(o.optString("method"))) continue;
            long[] arr = out.get(o.optString("origin"));
            if (arr == null) {
                arr = new long[24];
                out.put(o.optString("origin"), arr);
            }
            int h = o.optInt("hour", -1);
            if (h >= 0 && h < 24) arr[h] = Math.max(arr[h], o.optLong("steps", 0)); // devices: max, never sum
        }
        return out;
    }

    /** The local dates of the last {@code days} days, today last. */
    static List<LocalDate> window(LocalDate today, int days) {
        List<LocalDate> out = new ArrayList<>();
        for (int i = Math.max(1, days) - 1; i >= 0; i--) out.add(today.minusDays(i));
        return out;
    }
}
