package com.step2win.app;

import org.json.JSONObject;

import java.time.Instant;
import java.util.ArrayDeque;

/**
 * Pure-Java state of one user-started walk ("Start a walk"): steps, gait buckets, GPS points,
 * distance, vehicle seconds, mock location and auto-end. The Android service
 * ({@link WalkSessionService}) feeds it sensor / location events and persists it.
 *
 * GPS rules:
 * - fixes with accuracy > {@link #MAX_ACCURACY_M} are dropped (never shown or uploaded) but
 *   still counted in {@link #badFixes};
 * - fast fixes are KEPT and flagged by their speed (the server judges them); speed > 7 m/s on
 *   two consecutive fixes counts as vehicle speed and adds to vehicleSeconds;
 * - a fix from a mock provider sets mock=true on the point and mockLocation on the walk.
 * Steps: hardware counter deltas when the phone has TYPE_STEP_COUNTER, else accelerometer
 * step estimation (cadence of gait windows x time). Each step is put in the gait bucket of
 * the last ~30 s of analysis (verified / shake / unknown; see {@link WindowTally}).
 */
public final class WalkTracker {
    public static final double MAX_ACCURACY_M = 75.0;
    public static final double VEHICLE_SPEED_MPS = 7.0;
    public static final long MAX_DURATION_MS = 4 * 60 * 60_000L;
    public static final long DEFAULT_AUTO_END_MS = 10 * 60_000L;
    public static final int MAX_POINTS = 5000;
    static final long GPS_STALE_MS = 20_000L;
    static final int SMOOTH_WINDOWS = 12; // ~30 s of 2.5 s windows

    public String walkId;
    public boolean active;
    public long startedAt;
    public long endedAt;
    public int steps;
    public int gaitVerified;
    public int gaitShake;
    public int gaitUnknown;
    public double vehicleSeconds;
    public boolean mockLocation;
    public boolean autoEnded;
    public String stepSource = "step_counter";
    public String gpsStatus = "searching";
    public double distanceM;
    public int pointsRecorded;
    public int badFixes;
    public long lastMovementAt;
    public long lastTickAt;
    public long autoEndMs = DEFAULT_AUTO_END_MS;

    // GPS state
    private double lastLat = Double.NaN, lastLng = Double.NaN;
    private long lastFixAt;
    private double anchorLat = Double.NaN, anchorLng = Double.NaN, anchorAcc;
    private long lastGoodFixAt;
    private boolean lastFixFast;
    private boolean gpsVehicle;
    private double accelStepCarry;

    private final ArrayDeque<GaitClassifier.Result> recent = new ArrayDeque<>();

    /** One kept GPS point. spd NaN = unknown. */
    public static final class Point {
        public final long t;
        public final double lat, lng, acc, spd;
        public final boolean mock;

        Point(long t, double lat, double lng, double acc, double spd, boolean mock) {
            this.t = t;
            this.lat = lat;
            this.lng = lng;
            this.acc = acc;
            this.spd = spd;
            this.mock = mock;
        }

        public JSONObject toJson() {
            JSONObject o = new JSONObject();
            try {
                o.put("t", Instant.ofEpochMilli(t).toString());
                o.put("lat", lat);
                o.put("lng", lng);
                o.put("acc", Math.round(acc * 10) / 10.0);
                o.put("spd", Double.isNaN(spd) ? JSONObject.NULL : Math.round(spd * 100) / 100.0);
                o.put("mock", mock);
            } catch (Exception ignored) {
                // no-op
            }
            return o;
        }
    }

    public synchronized void start(String walkId, long now, String stepSource, long autoEndMs) {
        this.walkId = walkId;
        this.active = true;
        this.startedAt = now;
        this.endedAt = 0;
        this.steps = 0;
        this.gaitVerified = 0;
        this.gaitShake = 0;
        this.gaitUnknown = 0;
        this.vehicleSeconds = 0;
        this.mockLocation = false;
        this.autoEnded = false;
        this.stepSource = stepSource;
        this.gpsStatus = "searching";
        this.distanceM = 0;
        this.pointsRecorded = 0;
        this.badFixes = 0;
        this.lastMovementAt = now;
        this.lastTickAt = now;
        this.autoEndMs = autoEndMs > 0 ? autoEndMs : DEFAULT_AUTO_END_MS;
        recent.clear();
        lastLat = lastLng = anchorLat = anchorLng = Double.NaN;
        lastFixAt = lastGoodFixAt = 0;
        lastFixFast = gpsVehicle = false;
        accelStepCarry = 0;
    }

    // ── steps and gait ───────────────────────────────────────────────────────

    /** Gait bucket of the last ~30 s (WindowTally.VERIFIED / SHAKE / UNKNOWN). */
    public synchronized int currentGaitBucket() {
        WindowTally t = new WindowTally();
        for (GaitClassifier.Result r : recent) t.add(r);
        return t.verdict(-1);
    }

    public synchronized void onCounterSteps(int delta, long now) {
        if (!active || delta <= 0) return;
        addSteps(delta);
        lastMovementAt = now;
    }

    private void addSteps(int delta) {
        steps += delta;
        int b = currentGaitBucket();
        if (b == WindowTally.VERIFIED) gaitVerified += delta;
        else if (b == WindowTally.SHAKE) gaitShake += delta;
        else gaitUnknown += delta;
    }

    /**
     * A gait window. Returns the accelerometer steps added (only when stepSource is
     * "accelerometer"), 0 otherwise.
     */
    public synchronized int onWindow(GaitClassifier.Result r, long now) {
        if (!active || r == null) return 0;
        recent.addLast(r);
        while (recent.size() > SMOOTH_WINDOWS) recent.pollFirst();
        if (r.verdict != GaitClassifier.Verdict.IDLE && r.rms >= GaitClassifier.IDLE_RMS * 2) {
            lastMovementAt = now;
        }
        if (!"accelerometer".equals(stepSource)) return 0;
        boolean countable = r.verdict.isGait() || (r.verdict == GaitClassifier.Verdict.SHAKE && r.stepFreqHz > 0);
        if (!countable || r.stepFreqHz <= 0) return 0;
        accelStepCarry += r.stepFreqHz * GaitWindowBuffer.HOP_MS / 1000.0;
        int whole = (int) Math.floor(accelStepCarry);
        if (whole > 0) {
            accelStepCarry -= whole;
            addSteps(whole);
        }
        return whole;
    }

    // ── GPS ──────────────────────────────────────────────────────────────────

    /**
     * A location fix. speed NaN = the fix has none (derived from the previous fix). Returns the
     * point to keep, or null when dropped (bad accuracy / walk inactive / point cap reached).
     */
    public synchronized Point onLocation(long t, double lat, double lng, double accuracy, double speed, boolean mock, long now) {
        if (!active) return null;
        if (mock) mockLocation = true;
        if (Double.isNaN(accuracy) || accuracy > MAX_ACCURACY_M || Double.isNaN(lat) || Double.isNaN(lng)) {
            badFixes++;
            return null;
        }
        lastGoodFixAt = now;
        gpsStatus = "ok";
        double spd = speed;
        if (Double.isNaN(spd) && !Double.isNaN(lastLat) && t > lastFixAt) {
            spd = haversine(lastLat, lastLng, lat, lng) / ((t - lastFixAt) / 1000.0);
        }
        boolean fast = !Double.isNaN(spd) && spd > VEHICLE_SPEED_MPS;
        gpsVehicle = fast && lastFixFast; // sustained: two consecutive fast fixes
        lastFixFast = fast;
        // distance: only count real displacement, not GPS jitter while standing
        if (Double.isNaN(anchorLat)) {
            anchorLat = lat;
            anchorLng = lng;
            anchorAcc = accuracy;
        } else {
            double d = haversine(anchorLat, anchorLng, lat, lng);
            if (d >= Math.max(5.0, 0.5 * (anchorAcc + accuracy))) {
                distanceM += d;
                anchorLat = lat;
                anchorLng = lng;
                anchorAcc = accuracy;
                if (d >= 25.0 || !fast) lastMovementAt = now;
            }
        }
        lastLat = lat;
        lastLng = lng;
        lastFixAt = t;
        if (pointsRecorded >= MAX_POINTS) return null;
        pointsRecorded++;
        return new Point(t, lat, lng, accuracy, spd, mock);
    }

    public synchronized boolean gpsVehicleNow() {
        return gpsVehicle;
    }

    /** Location unavailable: "off" (location services off), "denied", "unavailable". */
    public synchronized void setGpsProblem(String status) {
        if (active) gpsStatus = status;
    }

    // ── time ─────────────────────────────────────────────────────────────────

    /**
     * Called about every 2 s. Accumulates vehicle seconds (GPS vehicle speed or Activity
     * Recognition vehicle), refreshes the GPS status and returns an auto-end reason
     * ("inactive" / "max_duration") or null.
     */
    public synchronized String tick(long now, boolean arVehicle) {
        if (!active) return null;
        long dt = Math.max(0, Math.min(10_000L, now - lastTickAt));
        lastTickAt = now;
        if (gpsVehicle && now - lastGoodFixAt > GPS_STALE_MS) gpsVehicle = false;
        if (gpsVehicle || arVehicle) vehicleSeconds += dt / 1000.0;
        if ("ok".equals(gpsStatus) && now - lastGoodFixAt > GPS_STALE_MS) gpsStatus = "searching";
        if (now - startedAt >= MAX_DURATION_MS) return "max_duration";
        if (now - lastMovementAt >= autoEndMs) return "inactive";
        return null;
    }

    public synchronized void finish(long now, boolean auto) {
        if (!active) return;
        active = false;
        endedAt = now;
        autoEnded = auto;
    }

    // ── state ────────────────────────────────────────────────────────────────

    public synchronized JSONObject toJson(long now, int pointsPending) {
        JSONObject o = new JSONObject();
        try {
            o.put("active", active);
            o.put("walkId", walkId == null ? JSONObject.NULL : walkId);
            o.put("startedAt", startedAt > 0 ? Instant.ofEpochMilli(startedAt).toString() : JSONObject.NULL);
            o.put("endedAt", endedAt > 0 ? Instant.ofEpochMilli(endedAt).toString() : JSONObject.NULL);
            long end = active ? now : (endedAt > 0 ? endedAt : now);
            o.put("elapsedS", startedAt > 0 ? Math.max(0, (end - startedAt) / 1000) : 0);
            o.put("steps", steps);
            o.put("distanceM", Math.round(distanceM * 10) / 10.0);
            o.put("gaitVerifiedSteps", gaitVerified);
            o.put("gaitShakeSteps", gaitShake);
            o.put("gaitUnknownSteps", gaitUnknown);
            o.put("vehicleSeconds", (int) Math.round(vehicleSeconds));
            o.put("mockLocation", mockLocation);
            o.put("autoEnded", autoEnded);
            o.put("gpsStatus", gpsStatus);
            o.put("stepSource", stepSource);
            o.put("pointsPending", pointsPending);
        } catch (Exception ignored) {
            // no-op
        }
        return o;
    }

    /** Persistence (process death): counters only; GPS continuity restarts after a restore. */
    public synchronized String serialize() {
        JSONObject o = new JSONObject();
        try {
            o.put("walkId", walkId == null ? "" : walkId);
            o.put("active", active);
            o.put("startedAt", startedAt);
            o.put("endedAt", endedAt);
            o.put("steps", steps);
            o.put("gv", gaitVerified);
            o.put("gs", gaitShake);
            o.put("gu", gaitUnknown);
            o.put("veh", vehicleSeconds);
            o.put("mock", mockLocation);
            o.put("auto", autoEnded);
            o.put("src", stepSource);
            o.put("gps", gpsStatus);
            o.put("dist", distanceM);
            o.put("pts", pointsRecorded);
            o.put("bad", badFixes);
            o.put("move", lastMovementAt);
            o.put("tick", lastTickAt);
            o.put("autoEndMs", autoEndMs);
        } catch (Exception ignored) {
            // no-op
        }
        return o.toString();
    }

    public static WalkTracker parse(String text) {
        WalkTracker w = new WalkTracker();
        if (text == null || text.isEmpty()) return w;
        try {
            JSONObject o = new JSONObject(text);
            String id = o.optString("walkId", "");
            w.walkId = id.isEmpty() ? null : id;
            w.active = o.optBoolean("active", false);
            w.startedAt = o.optLong("startedAt", 0);
            w.endedAt = o.optLong("endedAt", 0);
            w.steps = o.optInt("steps", 0);
            w.gaitVerified = o.optInt("gv", 0);
            w.gaitShake = o.optInt("gs", 0);
            w.gaitUnknown = o.optInt("gu", 0);
            w.vehicleSeconds = o.optDouble("veh", 0);
            w.mockLocation = o.optBoolean("mock", false);
            w.autoEnded = o.optBoolean("auto", false);
            w.stepSource = o.optString("src", "step_counter");
            w.gpsStatus = o.optString("gps", "searching");
            w.distanceM = o.optDouble("dist", 0);
            w.pointsRecorded = o.optInt("pts", 0);
            w.badFixes = o.optInt("bad", 0);
            w.lastMovementAt = o.optLong("move", 0);
            w.lastTickAt = o.optLong("tick", 0);
            w.autoEndMs = o.optLong("autoEndMs", DEFAULT_AUTO_END_MS);
        } catch (Exception ignored) {
            // corrupt: empty state
        }
        return w;
    }

    static double haversine(double lat1, double lon1, double lat2, double lon2) {
        double r = 6371000.0;
        double dLat = Math.toRadians(lat2 - lat1);
        double dLon = Math.toRadians(lon2 - lon1);
        double a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
            + Math.cos(Math.toRadians(lat1)) * Math.cos(Math.toRadians(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
        return r * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }
}
