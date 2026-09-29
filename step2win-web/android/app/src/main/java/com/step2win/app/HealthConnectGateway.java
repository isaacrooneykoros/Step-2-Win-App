package com.step2win.app;

import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.List;
import java.util.Set;

/**
 * Phase 1c: the Health Connect SDK behind an interface, so the reading logic
 * ({@link HealthSourceReader}) is testable on the JVM with a fake. The real
 * implementation is {@code HealthConnectGatewayImpl} (Kotlin: the SDK is coroutine-based).
 * Every call may throw (Health Connect missing, permission revoked, the provider crashed,
 * a timeout, a background read without the background permission): callers catch.
 */
public interface HealthConnectGateway {
    /** HealthConnectClient.getSdkStatus(): 1 unavailable, 2 update required, 3 available. */
    int sdkStatus();

    Set<String> grantedPermissions() throws Exception;

    /** HealthConnectFeatures.FEATURE_READ_HEALTH_DATA_IN_BACKGROUND is available. */
    boolean backgroundReadSupported();

    List<HealthSourceCore.StepSample> readSteps(Instant start, Instant end) throws Exception;

    /** Health Connect's own hourly aggregate for one origin over one local day (24 values). */
    long[] aggregateHourly(String origin, LocalDate day, ZoneId zone) throws Exception;

    List<HealthSourceCore.Workout> readWorkouts(Instant start, Instant end, boolean withRoutes) throws Exception;

    String changesToken() throws Exception;

    Changes changes(String token) throws Exception;

    /** One page of the Health Connect changes API, reduced to what we need. */
    public final class Changes {
        final boolean tokenExpired;
        final boolean hasMore;
        final String nextToken;
        /** Start times of upserted steps / exercise records. */
        final List<Instant> upserted;
        final boolean anyDeletion;

        public Changes(boolean tokenExpired, boolean hasMore, String nextToken, List<Instant> upserted, boolean anyDeletion) {
            this.tokenExpired = tokenExpired;
            this.hasMore = hasMore;
            this.nextToken = nextToken;
            this.upserted = upserted;
            this.anyDeletion = anyDeletion;
        }
    }
}
