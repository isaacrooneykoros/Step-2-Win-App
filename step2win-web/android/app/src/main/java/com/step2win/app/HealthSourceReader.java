package com.step2win.app;

import org.json.JSONArray;
import org.json.JSONObject;

import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;

/**
 * Phase 1c: reads the last few days from Health Connect into per-day server payloads.
 * Pure orchestration over {@link HealthConnectGateway} (JVM-tested with a fake).
 *
 * <p>Nothing here may break step counting: every failure (Health Connect missing, too old,
 * permission denied or revoked mid-read, a crash, a timeout) ends in a status string and
 * whatever days were read before it. Incremental: with a changes token only the days
 * that changed (plus today) are re-read; an expired token or a deletion re-reads the
 * whole window (at most {@link #MAX_DAYS} days).</p>
 */
final class HealthSourceReader {
    private HealthSourceReader() {}

    static final int MAX_DAYS = 3;
    private static final int MAX_CHANGE_PAGES = 10;

    static final class Outcome {
        /** off | unsupported | not_installed | update_required | permission_denied | ok | partial | error */
        String status = "error";
        String message = "";
        /** date (ISO) -> payload ({@link HealthSourceCore#dayPayload}) */
        final Map<String, JSONObject> days = new HashMap<>();
        String nextToken;
        boolean fullRead;
        Set<String> granted = new TreeSet<>();
        boolean backgroundSupported;
    }

    static Outcome read(HealthConnectGateway gw, boolean optedIn, int sdkInt, ZoneId zone, LocalDate today,
                        String token, Set<String> cachedDates, long nowMs) {
        Outcome out = new Outcome();
        if (!optedIn) {
            out.status = "off";
            return out;
        }
        String availability;
        try {
            availability = HealthSourceCore.availability(gw.sdkStatus(), sdkInt);
        } catch (Exception e) {
            out.status = "error";
            out.message = "status: " + e.getClass().getSimpleName();
            return out;
        }
        if (!"available".equals(availability)) {
            out.status = availability;
            return out;
        }
        try {
            out.granted = new TreeSet<>(gw.grantedPermissions());
        } catch (Exception e) {
            out.status = "error";
            out.message = "permissions: " + e.getClass().getSimpleName();
            return out;
        }
        try {
            out.backgroundSupported = gw.backgroundReadSupported();
        } catch (Exception ignored) {
            out.backgroundSupported = false;
        }
        if (!out.granted.contains(HealthSourceCore.PERM_STEPS)) {
            out.status = "permission_denied";
            return out;
        }

        List<LocalDate> window = HealthSourceCore.window(today, MAX_DAYS);
        Set<LocalDate> toRead = new LinkedHashSet<>();
        String nextToken = null;
        boolean full = token == null || token.isEmpty();
        for (LocalDate d : window) {
            if (cachedDates == null || !cachedDates.contains(d.toString())) full = true;
        }
        if (!full) {
            try {
                String cur = token;
                for (int page = 0; page < MAX_CHANGE_PAGES; page++) {
                    HealthConnectGateway.Changes ch = gw.changes(cur);
                    if (ch.tokenExpired) {
                        full = true;
                        break;
                    }
                    if (ch.anyDeletion) full = true;
                    for (Instant t : ch.upserted) {
                        LocalDate d = t.atZone(zone).toLocalDate();
                        if (window.contains(d)) toRead.add(d);
                    }
                    cur = ch.nextToken;
                    if (!ch.hasMore) break;
                }
                nextToken = cur;
            } catch (Exception e) {
                full = true;
                nextToken = null;
            }
        }
        if (full) {
            toRead.clear();
            toRead.addAll(window);
            try {
                nextToken = gw.changesToken();
            } catch (Exception e) {
                nextToken = null; // next time reads the whole window again (3 days: cheap)
            }
        } else {
            toRead.add(today); // today is always refreshed
        }
        out.fullRead = full;

        boolean exercise = out.granted.contains(HealthSourceCore.PERM_EXERCISE);
        boolean routes = out.granted.contains(HealthSourceCore.PERM_ROUTES);
        int tzOffsetMinutes = zone.getRules().getOffset(Instant.ofEpochMilli(nowMs)).getTotalSeconds() / 60;
        boolean partial = false;
        for (LocalDate day : new TreeSet<>(toRead)) {
            Instant start = day.atStartOfDay(zone).toInstant();
            Instant end = day.plusDays(1).atStartOfDay(zone).toInstant();
            List<HealthSourceCore.StepSample> samples;
            try {
                samples = gw.readSteps(start, end);
            } catch (Exception e) {
                out.status = out.days.isEmpty() ? "error" : "partial";
                out.message = "steps: " + e.getClass().getSimpleName();
                out.nextToken = null; // re-read everything next time
                return out;
            }
            Map<String, long[]> aggregated = new HashMap<>();
            for (HealthSourceCore.StepSample s : samples) {
                if (aggregated.containsKey(s.origin) || s.origin.isEmpty()) continue;
                try {
                    aggregated.put(s.origin, gw.aggregateHourly(s.origin, day, zone));
                } catch (Exception e) {
                    aggregated.put(s.origin, null); // fall back to the raw records' sums
                    partial = true;
                }
            }
            List<HealthSourceCore.Workout> workouts = new ArrayList<>();
            if (exercise) {
                try {
                    workouts = gw.readWorkouts(start, end, routes);
                } catch (Exception e) {
                    partial = true;
                }
            }
            JSONArray hours = HealthSourceCore.buildHours(samples, aggregated, day, zone);
            JSONArray wk = HealthSourceCore.buildWorkouts(workouts);
            out.days.put(day.toString(), HealthSourceCore.dayPayload(hours, wk, Instant.ofEpochMilli(nowMs), tzOffsetMinutes));
        }
        out.nextToken = nextToken;
        out.status = partial ? "partial" : "ok";
        return out;
    }

    /** Short per-origin preview of one day's payload for the settings screen. */
    static JSONArray originPreview(JSONObject payload) {
        JSONArray out = new JSONArray();
        if (payload == null) return out;
        JSONArray hours = payload.optJSONArray("hours");
        if (hours == null) return out;
        Map<String, long[]> totals = new HashMap<>(); // origin -> {counted, manual}
        Map<String, String> devices = new HashMap<>();
        for (int i = 0; i < hours.length(); i++) {
            JSONObject o = hours.optJSONObject(i);
            if (o == null) continue;
            String origin = o.optString("origin");
            long[] t = totals.get(origin);
            if (t == null) {
                t = new long[2];
                totals.put(origin, t);
            }
            if ("manual".equals(o.optString("method"))) t[1] += o.optLong("steps");
            else t[0] += o.optLong("steps");
            if (!devices.containsKey(origin) || "phone".equals(devices.get(origin))) devices.put(origin, o.optString("device"));
        }
        try {
            for (String origin : new TreeSet<>(totals.keySet())) {
                JSONObject o = new JSONObject();
                o.put("origin", origin);
                o.put("steps", totals.get(origin)[0]);
                o.put("manual_steps", totals.get(origin)[1]);
                o.put("device", devices.get(origin));
                out.put(o);
            }
        } catch (Exception ignored) {
            // plain values
        }
        return out;
    }
}
