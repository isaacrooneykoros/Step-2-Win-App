package com.step2win.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Phase 1c: Health Connect provenance, hourly reconciliation and failure states. */
public class HealthSourceTest {
    private static final ZoneId EAT = ZoneId.of("Africa/Nairobi");
    private static final LocalDate DAY = LocalDate.of(2026, 9, 28);
    private static final String SAMSUNG = "com.sec.android.app.shealth";
    private static final String FIT = "com.google.android.apps.fitness";

    private static long at(int hour, int minute) {
        return DAY.atTime(hour, minute).atZone(EAT).toInstant().toEpochMilli();
    }

    private static HealthSourceCore.StepSample sample(String origin, int device, int method, int h1, int m1, int h2, int m2, long count) {
        return new HealthSourceCore.StepSample(origin, device, method, at(h1, m1), at(h2, m2), count);
    }

    private static JSONObject find(JSONArray hours, int hour, String origin, String method) {
        for (int i = 0; i < hours.length(); i++) {
            JSONObject o = hours.optJSONObject(i);
            if (o.optInt("hour") == hour && o.optString("origin").equals(origin) && o.optString("method").equals(method)) return o;
        }
        return null;
    }

    // ── provenance mapping ─────────────────────────────────────────────────

    @Test
    public void deviceAndMethodNamesFollowTheSdkConstants() {
        assertEquals("watch", HealthSourceCore.deviceName(1));
        assertEquals("phone", HealthSourceCore.deviceName(2));
        assertEquals("ring", HealthSourceCore.deviceName(4));
        assertEquals("band", HealthSourceCore.deviceName(6));
        assertEquals("unknown", HealthSourceCore.deviceName(0));
        assertEquals("unknown", HealthSourceCore.deviceName(99));
        assertEquals("active", HealthSourceCore.methodName(1));
        assertEquals("automatic", HealthSourceCore.methodName(2));
        assertEquals("manual", HealthSourceCore.methodName(3));
        assertEquals("unknown", HealthSourceCore.methodName(0));
        assertEquals("walking", HealthSourceCore.exerciseName(79));
        assertEquals("running", HealthSourceCore.exerciseName(56));
        assertEquals("treadmill", HealthSourceCore.exerciseName(57));
        assertEquals("hiking", HealthSourceCore.exerciseName(37));
        assertEquals("other", HealthSourceCore.exerciseName(8));
    }

    @Test
    public void manualEntriesAreSeparateAndOwnPackageIsSkipped() {
        List<HealthSourceCore.StepSample> samples = Arrays.asList(
            sample(SAMSUNG, 1, 2, 9, 0, 9, 30, 3000),   // watch, automatic
            sample(SAMSUNG, 2, 3, 9, 40, 9, 41, 5000),  // typed in by hand
            sample(HealthSourceCore.OWN_PACKAGE, 2, 2, 9, 0, 9, 30, 900)
        );
        JSONArray hours = HealthSourceCore.buildHours(samples, null, DAY, EAT);
        assertEquals(2, hours.length());
        JSONObject auto = find(hours, 9, SAMSUNG, "automatic");
        assertNotNull(auto);
        assertEquals(3000, auto.optLong("steps"));
        assertEquals("watch", auto.optString("device"));
        JSONObject manual = find(hours, 9, SAMSUNG, "manual");
        assertNotNull(manual);
        assertEquals(5000, manual.optLong("steps"));
    }

    @Test
    public void watchAndPhoneOfOneAppStayApartAndMergeByMax() {
        // Samsung Health holds both the Galaxy Watch's and the phone's count of one walk.
        List<HealthSourceCore.StepSample> samples = Arrays.asList(
            sample(SAMSUNG, 1, 2, 9, 0, 9, 40, 4000),
            sample(SAMSUNG, 2, 2, 9, 0, 9, 40, 3800));
        long[] agg = new long[24];
        agg[9] = 4000; // Health Connect's de-duplicated total for the origin
        Map<String, long[]> aggregated = new HashMap<>();
        aggregated.put(SAMSUNG, agg);
        JSONArray hours = HealthSourceCore.buildHours(samples, aggregated, DAY, EAT);
        assertEquals(2, hours.length());
        Map<String, Long> byDevice = new HashMap<>();
        for (int i = 0; i < hours.length(); i++) byDevice.put(hours.optJSONObject(i).optString("device"), hours.optJSONObject(i).optLong("steps"));
        assertEquals(Long.valueOf(4000), byDevice.get("watch"));
        assertEquals(Long.valueOf(3800), byDevice.get("phone"));
        assertEquals(4000, HealthSourceCore.countedByOrigin(hours).get(SAMSUNG)[9]);
    }

    @Test
    public void samplesSpanningHoursAreSplitByTime() {
        List<HealthSourceCore.StepSample> samples = Collections.singletonList(sample(FIT, 2, 2, 9, 30, 10, 30, 2000));
        JSONArray hours = HealthSourceCore.buildHours(samples, null, DAY, EAT);
        assertEquals(1000, find(hours, 9, FIT, "automatic").optLong("steps"));
        assertEquals(1000, find(hours, 10, FIT, "automatic").optLong("steps"));
    }

    @Test
    public void samplesOutsideTheDayAreIgnored() {
        HealthSourceCore.StepSample late = new HealthSourceCore.StepSample(FIT, 2, 2,
            DAY.plusDays(1).atTime(0, 10).atZone(EAT).toInstant().toEpochMilli(),
            DAY.plusDays(1).atTime(0, 20).atZone(EAT).toInstant().toEpochMilli(), 500);
        assertEquals(0, HealthSourceCore.buildHours(Collections.singletonList(late), null, DAY, EAT).length());
    }

    @Test
    public void healthConnectAggregateWinsOverOverlappingRawRecords() {
        // Two overlapping records of the same origin (e.g. a re-sync): raw sum 6,000,
        // Health Connect's de-duplicated aggregate says 3,500 of which 500 were typed in.
        List<HealthSourceCore.StepSample> samples = Arrays.asList(
            sample(SAMSUNG, 2, 2, 8, 0, 8, 30, 3000),
            sample(SAMSUNG, 2, 2, 8, 0, 8, 30, 2500),
            sample(SAMSUNG, 2, 3, 8, 40, 8, 41, 500)
        );
        long[] agg = new long[24];
        agg[8] = 3500;
        Map<String, long[]> aggregated = new HashMap<>();
        aggregated.put(SAMSUNG, agg);
        JSONArray hours = HealthSourceCore.buildHours(samples, aggregated, DAY, EAT);
        assertEquals(3000, find(hours, 8, SAMSUNG, "automatic").optLong("steps"));
        assertEquals(500, find(hours, 8, SAMSUNG, "manual").optLong("steps"));
    }

    @Test
    public void hourIsCappedAtFourStepsPerSecond() {
        List<HealthSourceCore.StepSample> samples = Collections.singletonList(sample(FIT, 2, 2, 7, 0, 7, 59, 90_000));
        assertEquals(14_400, find(HealthSourceCore.buildHours(samples, null, DAY, EAT), 7, FIT, "automatic").optLong("steps"));
    }

    // ── hourly reconciliation (max, never sum) ─────────────────────────────

    @Test
    public void hourlyMaxNeverSumsOrigins() {
        long[] watch = new long[24];
        long[] phoneApp = new long[24];
        watch[9] = 4000;
        phoneApp[9] = 3800; // the same walk seen by Samsung Health's phone count
        phoneApp[14] = 2000;
        long[] max = HealthSourceCore.hourlyMax(Arrays.asList(watch, phoneApp));
        assertEquals(4000, max[9]);
        assertEquals(2000, max[14]);
        assertEquals(6000, HealthSourceCore.dayCounted(5000, max));
        assertEquals(9000, HealthSourceCore.dayCounted(9000, max)); // our sensor saw more
    }

    @Test
    public void countedByOriginExcludesManualEntries() {
        List<HealthSourceCore.StepSample> samples = Arrays.asList(
            sample(SAMSUNG, 1, 2, 9, 0, 9, 30, 3000),
            sample(SAMSUNG, 2, 3, 9, 40, 9, 41, 5000));
        Map<String, long[]> counted = HealthSourceCore.countedByOrigin(HealthSourceCore.buildHours(samples, null, DAY, EAT));
        assertEquals(3000, counted.get(SAMSUNG)[9]);
    }

    @Test
    public void routeDistanceAndKnownRoutesAreKept() throws Exception {
        double d = HealthSourceCore.routeDistanceM(new double[]{-1.2921, -1.2921}, new double[]{36.8219, 36.8319});
        assertTrue(d > 1100 && d < 1120);
        JSONObject cached = new JSONObject("{\"workouts\":[{\"origin\":\"com.strava\",\"start\":\"a\",\"end\":\"b\",\"route\":{\"points\":300,\"distance_m\":5000}}]}");
        JSONObject fresh = new JSONObject("{\"workouts\":[{\"origin\":\"com.strava\",\"start\":\"a\",\"end\":\"b\",\"route\":null}]}");
        HealthSourceCore.keepKnownRoutes(fresh, cached);
        assertEquals(300, fresh.getJSONArray("workouts").getJSONObject(0).getJSONObject("route").getInt("points"));
    }

    @Test
    public void contentHashIgnoresReadTime() throws Exception {
        JSONArray hours = new JSONArray("[{\"hour\":9,\"origin\":\"x\",\"steps\":5}]");
        JSONObject a = HealthSourceCore.dayPayload(hours, new JSONArray(), Instant.ofEpochMilli(1), 180);
        JSONObject b = HealthSourceCore.dayPayload(hours, new JSONArray(), Instant.ofEpochMilli(99999), 180);
        assertEquals(HealthSourceCore.contentHash(a), HealthSourceCore.contentHash(b));
        assertEquals("health_connect", a.getString("provider"));
    }

    // ── availability / permission states ───────────────────────────────────

    @Test
    public void availabilityCoversEveryPhone() {
        assertEquals("available", HealthSourceCore.availability(3, 30));
        assertEquals("update_required", HealthSourceCore.availability(2, 30));
        assertEquals("not_installed", HealthSourceCore.availability(1, 30));   // Android 11: offer the Play Store
        assertEquals("not_installed", HealthSourceCore.availability(1, 28));   // Android 9
        assertEquals("unsupported", HealthSourceCore.availability(1, 26));     // Android 8
        assertEquals("unsupported", HealthSourceCore.availability(1, 34));     // built in, but unavailable (work profile)
    }

    @Test
    public void connectionStates() {
        Set<String> steps = new HashSet<>(Collections.singletonList(HealthSourceCore.PERM_STEPS));
        assertEquals("off", HealthSourceCore.connectionState(false, "available", steps));
        assertEquals("needs_install", HealthSourceCore.connectionState(true, "not_installed", null));
        assertEquals("needs_update", HealthSourceCore.connectionState(true, "update_required", null));
        assertEquals("unavailable", HealthSourceCore.connectionState(true, "unsupported", null));
        assertEquals("permission_denied", HealthSourceCore.connectionState(true, "available", new HashSet<>()));
        assertEquals("connected", HealthSourceCore.connectionState(true, "available", steps));
    }

    // ── reader with a fake gateway ─────────────────────────────────────────

    private static final class FakeGateway implements HealthConnectGateway {
        int sdk = 3;
        Set<String> granted = new HashSet<>(Arrays.asList(HealthSourceCore.PERM_STEPS, HealthSourceCore.PERM_EXERCISE));
        List<HealthSourceCore.StepSample> samples = new ArrayList<>();
        boolean stepsThrow;
        boolean permissionsThrow;
        boolean aggregateThrows;
        boolean workoutsThrow;
        Changes changes;
        final List<String> readDays = new ArrayList<>();

        @Override public int sdkStatus() { return sdk; }
        @Override public Set<String> grantedPermissions() throws Exception {
            if (permissionsThrow) throw new SecurityException("revoked");
            return granted;
        }
        @Override public boolean backgroundReadSupported() { return true; }
        @Override public List<HealthSourceCore.StepSample> readSteps(Instant start, Instant end) throws Exception {
            if (stepsThrow) throw new IllegalStateException("provider crashed");
            readDays.add(start.atZone(EAT).toLocalDate().toString());
            List<HealthSourceCore.StepSample> out = new ArrayList<>();
            for (HealthSourceCore.StepSample s : samples) if (s.startMs >= start.toEpochMilli() && s.startMs < end.toEpochMilli()) out.add(s);
            return out;
        }
        @Override public long[] aggregateHourly(String origin, LocalDate day, ZoneId zone) throws Exception {
            if (aggregateThrows) throw new java.util.concurrent.TimeoutException("slow");
            long[] out = new long[24];
            for (HealthSourceCore.StepSample s : samples) {
                if (!s.origin.equals(origin)) continue;
                double[] parts = HealthSourceCore.splitByHour(s, day, zone);
                for (int h = 0; h < 24; h++) out[h] += Math.round(parts[h]);
            }
            return out;
        }
        @Override public List<HealthSourceCore.Workout> readWorkouts(Instant start, Instant end, boolean withRoutes) throws Exception {
            if (workoutsThrow) throw new IllegalStateException("exercise read failed");
            return new ArrayList<>();
        }
        @Override public String changesToken() { return "token-1"; }
        @Override public Changes changes(String token) { return changes; }
    }

    private static final LocalDate TODAY = DAY;

    private static HealthSourceReader.Outcome read(FakeGateway gw, boolean optedIn, String token, Set<String> cached) {
        return HealthSourceReader.read(gw, optedIn, 34, EAT, TODAY, token, cached, at(12, 0));
    }

    @Test
    public void offMissingOldAndUnsupportedNeverRead() {
        FakeGateway gw = new FakeGateway();
        assertEquals("off", read(gw, false, null, null).status);
        gw.sdk = 1;
        assertEquals("unsupported", HealthSourceReader.read(gw, true, 34, EAT, TODAY, null, null, at(12, 0)).status);
        assertEquals("not_installed", HealthSourceReader.read(gw, true, 31, EAT, TODAY, null, null, at(12, 0)).status);
        gw.sdk = 2;
        assertEquals("update_required", read(gw, true, null, null).status);
        assertTrue(gw.readDays.isEmpty());
    }

    @Test
    public void deniedOrRevokedPermissionsAreAState() {
        FakeGateway gw = new FakeGateway();
        gw.granted = new HashSet<>();
        assertEquals("permission_denied", read(gw, true, null, null).status);
        gw.permissionsThrow = true;
        assertEquals("error", read(gw, true, null, null).status);
        assertTrue(gw.readDays.isEmpty());
    }

    @Test
    public void crashWhileReadingKeepsNothingAndResetsTheToken() {
        FakeGateway gw = new FakeGateway();
        gw.stepsThrow = true;
        HealthSourceReader.Outcome out = read(gw, true, "old-token", null);
        assertEquals("error", out.status);
        assertTrue(out.days.isEmpty());
        assertNull(out.nextToken);
    }

    @Test
    public void firstReadCoversTheWindowAndSlowAggregatesFallBack() {
        FakeGateway gw = new FakeGateway();
        gw.samples.add(sample(SAMSUNG, 1, 2, 9, 0, 9, 30, 3000));
        gw.aggregateThrows = true;
        gw.workoutsThrow = true;
        HealthSourceReader.Outcome out = read(gw, true, null, null);
        assertEquals("partial", out.status);
        assertTrue(out.fullRead);
        assertEquals(HealthSourceReader.MAX_DAYS, out.days.size());
        assertEquals("token-1", out.nextToken);
        JSONObject today = out.days.get(TODAY.toString());
        assertEquals(3000, find(today.optJSONArray("hours"), 9, SAMSUNG, "automatic").optLong("steps"));
        assertEquals(180, today.optInt("tz_offset_minutes"));
    }

    @Test
    public void incrementalReadOnlyTouchesChangedDaysPlusToday() {
        FakeGateway gw = new FakeGateway();
        Set<String> cached = new HashSet<>(Arrays.asList(TODAY.toString(), TODAY.minusDays(1).toString(), TODAY.minusDays(2).toString()));
        gw.changes = new HealthConnectGateway.Changes(false, false, "token-2",
            Collections.singletonList(TODAY.minusDays(2).atTime(20, 0).atZone(EAT).toInstant()), false);
        HealthSourceReader.Outcome out = read(gw, true, "token-1", cached);
        assertEquals("ok", out.status);
        assertFalse(out.fullRead);
        assertEquals(new HashSet<>(Arrays.asList(TODAY.toString(), TODAY.minusDays(2).toString())), out.days.keySet());
        assertEquals("token-2", out.nextToken);
    }

    @Test
    public void expiredTokenOrDeletionRereadsTheWindow() {
        FakeGateway gw = new FakeGateway();
        Set<String> cached = new HashSet<>(Arrays.asList(TODAY.toString(), TODAY.minusDays(1).toString(), TODAY.minusDays(2).toString()));
        gw.changes = new HealthConnectGateway.Changes(true, false, null, new ArrayList<>(), false);
        assertEquals(3, read(gw, true, "token-1", cached).days.size());
        gw.changes = new HealthConnectGateway.Changes(false, false, "token-3", new ArrayList<>(), true);
        HealthSourceReader.Outcome out = read(gw, true, "token-1", cached);
        assertTrue(out.fullRead);
        assertEquals(3, out.days.size());
    }

    @Test
    public void originPreviewSeparatesManualSteps() {
        FakeGateway gw = new FakeGateway();
        gw.samples.add(sample(SAMSUNG, 1, 2, 9, 0, 9, 30, 3000));
        gw.samples.add(sample(SAMSUNG, 2, 3, 10, 0, 10, 1, 700));
        JSONArray preview = HealthSourceReader.originPreview(read(gw, true, null, null).days.get(TODAY.toString()));
        assertEquals(1, preview.length());
        assertEquals(3000, preview.optJSONObject(0).optLong("steps"));
        assertEquals(700, preview.optJSONObject(0).optLong("manual_steps"));
    }
}
