package com.step2win.app

import android.content.Context
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.HealthConnectFeatures
import androidx.health.connect.client.changes.DeletionChange
import androidx.health.connect.client.changes.UpsertionChange
import androidx.health.connect.client.records.ExerciseRouteResult
import androidx.health.connect.client.records.ExerciseSessionRecord
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.records.DistanceRecord
import androidx.health.connect.client.records.metadata.DataOrigin
import androidx.health.connect.client.request.AggregateGroupByDurationRequest
import androidx.health.connect.client.request.AggregateRequest
import androidx.health.connect.client.request.ChangesTokenRequest
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

/**
 * Phase 1c: the real Health Connect client (connect-client 1.1.0), read-only.
 *
 * Every call is blocking with a timeout (the callers run on background threads: the
 * plugin's executor or WorkManager) so a slow or hung provider can never stall step
 * sync. Exceptions propagate to [HealthSourceReader], which turns them into a status.
 */
class HealthConnectGatewayImpl(private val context: Context) : HealthConnectGateway {

    private val client: HealthConnectClient by lazy { HealthConnectClient.getOrCreate(context) }

    private fun <T> call(timeoutMs: Long = CALL_TIMEOUT_MS, block: suspend () -> T): T =
        runBlocking(Dispatchers.IO) { withTimeout(timeoutMs) { block() } }

    override fun sdkStatus(): Int =
        HealthConnectClient.getSdkStatus(context, HealthSourceCore.HC_PACKAGE)

    override fun grantedPermissions(): Set<String> =
        call { client.permissionController.getGrantedPermissions() }

    override fun backgroundReadSupported(): Boolean = try {
        client.features.getFeatureStatus(HealthConnectFeatures.FEATURE_READ_HEALTH_DATA_IN_BACKGROUND) ==
            HealthConnectFeatures.FEATURE_STATUS_AVAILABLE
    } catch (e: Exception) {
        false
    }

    override fun readSteps(start: Instant, end: Instant): List<HealthSourceCore.StepSample> {
        val out = ArrayList<HealthSourceCore.StepSample>()
        var pageToken: String? = null
        var pages = 0
        do {
            val response = call {
                client.readRecords(
                    ReadRecordsRequest(
                        recordType = StepsRecord::class,
                        timeRangeFilter = TimeRangeFilter.between(start, end),
                        pageSize = PAGE_SIZE,
                        pageToken = pageToken,
                    )
                )
            }
            for (r in response.records) {
                out.add(
                    HealthSourceCore.StepSample(
                        r.metadata.dataOrigin.packageName,
                        r.metadata.device?.type ?: 0,
                        r.metadata.recordingMethod,
                        r.startTime.toEpochMilli(),
                        r.endTime.toEpochMilli(),
                        r.count,
                    )
                )
            }
            pageToken = response.pageToken
            pages++
        } while (!pageToken.isNullOrEmpty() && pages < MAX_PAGES)
        return out
    }

    override fun aggregateHourly(origin: String, day: LocalDate, zone: ZoneId): LongArray {
        val start = day.atStartOfDay(zone).toInstant()
        val end = day.plusDays(1).atStartOfDay(zone).toInstant()
        val buckets = call {
            client.aggregateGroupByDuration(
                AggregateGroupByDurationRequest(
                    metrics = setOf(StepsRecord.COUNT_TOTAL),
                    timeRangeFilter = TimeRangeFilter.between(start, end),
                    timeRangeSlicer = Duration.ofHours(1),
                    dataOriginFilter = setOf(DataOrigin(origin)),
                )
            )
        }
        val hours = LongArray(24)
        for (b in buckets) {
            val hour = b.startTime.atZone(zone).hour
            hours[hour] += b.result[StepsRecord.COUNT_TOTAL] ?: 0L
        }
        return hours
    }

    override fun readWorkouts(start: Instant, end: Instant, withRoutes: Boolean): List<HealthSourceCore.Workout> {
        val sessions = call {
            client.readRecords(
                ReadRecordsRequest(
                    recordType = ExerciseSessionRecord::class,
                    timeRangeFilter = TimeRangeFilter.between(start, end),
                    pageSize = 50,
                )
            )
        }.records
        val out = ArrayList<HealthSourceCore.Workout>()
        for (s in sessions.take(20)) {
            val origin = s.metadata.dataOrigin.packageName
            var routePoints = 0
            var routeDistance: Double? = null
            if (withRoutes) {
                // Only routes the user allowed ("always" for our app); a route that needs
                // per-session consent (ConsentRequired) is simply treated as no route.
                val route = s.exerciseRouteResult
                if (route is ExerciseRouteResult.Data) {
                    val points = route.exerciseRoute.route
                    routePoints = points.size
                    val lat = DoubleArray(points.size) { points[it].latitude }
                    val lng = DoubleArray(points.size) { points[it].longitude }
                    routeDistance = HealthSourceCore.routeDistanceM(lat, lng)
                }
            }
            val window = TimeRangeFilter.between(s.startTime, s.endTime)
            val origins = setOf(DataOrigin(origin))
            val totals = try {
                call {
                    client.aggregate(
                        AggregateRequest(
                            metrics = setOf(StepsRecord.COUNT_TOTAL, DistanceRecord.DISTANCE_TOTAL),
                            timeRangeFilter = window,
                            dataOriginFilter = origins,
                        )
                    )
                }
            } catch (e: Exception) {
                null
            }
            out.add(
                HealthSourceCore.Workout(
                    origin,
                    s.metadata.device?.type ?: 0,
                    s.metadata.recordingMethod,
                    s.startTime.toEpochMilli(),
                    s.endTime.toEpochMilli(),
                    s.exerciseType,
                    totals?.get(DistanceRecord.DISTANCE_TOTAL)?.inMeters,
                    totals?.get(StepsRecord.COUNT_TOTAL),
                    routePoints,
                    routeDistance,
                )
            )
        }
        return out
    }

    override fun changesToken(): String = call {
        client.getChangesToken(
            ChangesTokenRequest(recordTypes = setOf(StepsRecord::class, ExerciseSessionRecord::class))
        )
    }

    override fun changes(token: String): HealthConnectGateway.Changes {
        val response = call { client.getChanges(token) }
        val upserted = ArrayList<Instant>()
        var deletion = false
        for (change in response.changes) {
            when (change) {
                is UpsertionChange -> when (val r = change.record) {
                    is StepsRecord -> upserted.add(r.startTime)
                    is ExerciseSessionRecord -> upserted.add(r.startTime)
                    else -> Unit
                }
                is DeletionChange -> deletion = true
            }
        }
        return HealthConnectGateway.Changes(
            response.changesTokenExpired,
            response.hasMore,
            response.nextChangesToken,
            upserted,
            deletion,
        )
    }

    companion object {
        private const val CALL_TIMEOUT_MS = 15_000L
        private const val PAGE_SIZE = 1000
        private const val MAX_PAGES = 10
    }
}
