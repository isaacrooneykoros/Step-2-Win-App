import dataclasses
import logging
import math
import uuid
from datetime import timedelta
from datetime import timezone as dt_timezone

import redis as redis_client
from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer
from django.conf import settings
from django.core.cache import cache
from django.db import IntegrityError, transaction
from django.db.models import Avg, Max, Sum
from django.utils import timezone
from drf_spectacular.utils import extend_schema, inline_serializer
from rest_framework import serializers
from rest_framework.decorators import (api_view, permission_classes,
                                       throttle_classes)
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from apps.admin_api.realtime import broadcast_admin_steps_update
from apps.core.throttles import (DashboardReadRateThrottle,
                                 StepHourlySyncRateThrottle,
                                 StepSyncGlobalThrottle, StepSyncRateThrottle,
                                 StepSyncSustainedThrottle)

from .anti_cheat import (ANTICHEAT_DAY_VERSION, DAILY_STEP_CAP,
                         SHAKE_POSITIVE_RULES, VerificationConfig,
                         assess_velocity,
                         cap_trust_deduction, decision_to_check_result,
                         evaluate_daily_submission, resolve_source_key)
from . import integrity as device_integrity
from .daily_reset import update_streak
from .evidence import (KNOWN_OFFSET_TOLERANCE_HOURS, challenge_total_steps,
                       clean_evidence_hours, clean_tz_offset, day_evidence,
                       refresh_day, resolve_day_offset, server_active_minutes,
                       store_stream_evidence)
from .verification import build_breakdown
from .models import (DailyVerificationSummary, FraudFlag, HealthRecord,
                     HourlyStepRecord, IntervalVerificationResult,
                     LocationWaypoint, StepSession, StepSyncEvent,
                     SuspiciousActivity, TrustScore)
from .security import compute_payload_hash, detect_replay, verify_session_token
from .serializers import (HealthRecordSerializer, HealthSyncSerializer,
                          HourlyStepSerializer, LocationWaypointSerializer)

logger = logging.getLogger(__name__)

WAYPOINT_MAX_ACCURACY_M = 75.0
WAYPOINT_MIN_DISTANCE_M = 2.0
WAYPOINT_MAX_SPEED_MPS = 8.0
# Phase 1b: GPS segments faster than this are vehicle speed (see walks.py).
VEHICLE_SPEED_MPS = 7.0
TELEPORT_SPEED_MPS = 70.0
ROUTE_DISTANCE_PER_STEP_MIN_KM = 0.0002
ROUTE_DISTANCE_PER_STEP_MAX_KM = 0.0030
HOURLY_MAX_ENTRIES = 24
HOURLY_MAX_STEPS = 50_000
WAYPOINT_MAX_PER_REQUEST = 1000


def _get_redis_client():
    try:
        return redis_client.Redis.from_url(
            getattr(settings, "REDIS_URL", settings.CELERY_BROKER_URL)
        )
    except Exception:
        return None


_redis = _get_redis_client()


def _check_idempotency(key: str, user_id: int) -> bool:
    """Returns True if fresh request, False if duplicate."""
    if not key:
        return True
    if _redis is None:
        return True

    redis_key = f"step2win:sync_idem:{user_id}:{key}"
    try:
        return _redis.set(redis_key, "1", nx=True, ex=3600) is not None
    except Exception:
        return True


def _allow_sync_tick(user_id: int, min_seconds: int = 1) -> bool:
    """Returns True when user is allowed to submit another sync tick."""
    redis_key = f"step2win:sync_tick:{user_id}"
    if _redis is None:
        return cache.add(redis_key, "1", timeout=max(1, min_seconds))

    try:
        return _redis.set(redis_key, "1", nx=True, ex=max(1, min_seconds)) is not None
    except Exception:
        return cache.add(redis_key, "1", timeout=max(1, min_seconds))


# health_sources (Phase 1c) is stored once, in HealthSourceDay, not in every event.
_PAYLOAD_SECRET_KEYS = ("session_token", "health_sources")


def _redact_payload(data) -> dict | None:
    """Copy of the request body safe to store: bearer secrets are never persisted."""
    try:
        payload = dict(data.items()) if hasattr(data, "items") else None
    except Exception:
        payload = None
    if payload is None:
        return None
    for key in _PAYLOAD_SECRET_KEYS:
        if payload.get(key):
            payload[key] = "[redacted]"
    return payload


_SEVERITY_RANK = {"low": 0, "medium": 1, "high": 2, "critical": 3}


def _record_flag(user, day, flag_type: str, severity: str, details: dict) -> FraudFlag:
    """
    One open FraudFlag per (user, day, rule): repeated hits from later syncs update the
    open flag (occurrence count, latest evidence, highest severity) instead of piling
    up a new row every few minutes. Reviewed flags are left alone (a new one opens).
    """
    existing = (
        FraudFlag.objects.filter(
            user=user, date=day, flag_type=flag_type, reviewed=False
        )
        .order_by("-created_at")
        .first()
    )
    if existing is None:
        return FraudFlag.objects.create(
            user=user,
            date=day,
            flag_type=flag_type,
            severity=severity,
            details={**(details or {}), "occurrences": 1},
        )
    merged = dict(existing.details or {})
    occurrences = int(merged.get("occurrences", 1) or 1) + 1
    merged.update(details or {})
    merged["occurrences"] = occurrences
    existing.details = merged
    if _SEVERITY_RANK.get(severity, 0) > _SEVERITY_RANK.get(existing.severity, 0):
        existing.severity = severity
    existing.save(update_fields=["details", "severity"])
    return existing


def _legacy_day_has_strong_flags(user, day) -> bool:
    """Open flags on a pre-Phase-0 day that would count as strong evidence today."""
    open_flags = FraudFlag.objects.filter(user=user, date=day, reviewed=False)
    if open_flags.filter(severity="critical").exists():
        return True
    if open_flags.filter(flag_type__in=SHAKE_POSITIVE_RULES).exists():
        return True
    high_types = set(
        open_flags.filter(severity="high")
        .exclude(
            flag_type__in=[
                "step_velocity_spike",
                "non_monotonic_steps",
                "route_step_mismatch_low_distance",
                "burst_impossible",
                "baseline_spike_hard",
                "gait_confidence_very_low",
            ]
        )
        .values_list("flag_type", flat=True)
    )
    return len(high_types) >= 2


def _trust_deducted_today(user, today_key: str) -> int:
    """Trust points already deducted from sync evidence on this server day."""
    total = 0
    since = timezone.now() - timedelta(days=2)
    for meta in HealthRecord.objects.filter(user=user, synced_at__gte=since).values_list(
        "anticheat", flat=True
    ):
        try:
            total += int(((meta or {}).get("trust_deductions") or {}).get(today_key, 0))
        except (TypeError, ValueError, AttributeError):
            continue
    return total


def _rejection_event_id(client_event_id: str) -> str:
    """
    Audit id for a *rejected* sync event. Rejections never claim the client's own
    client_event_id: (user, client_event_id) is unique, so claiming it would (a) crash
    with an IntegrityError when the rejected event is itself a duplicate and (b) make the
    phone's legitimate retry of the same reading (e.g. after renewing an expired
    session) look like a replay forever.
    """
    return f"{(client_event_id or 'event')[:200]}:rejected:{uuid.uuid4().hex[:12]}"


def _current_state_response(user, day, submitted_steps: int, **flags):
    """
    Cheap 200 for uploads that change nothing (idempotent retry, out-of-order older
    reading): one indexed lookup, no anti-cheat run, no writes.
    """
    record = HealthRecord.objects.filter(user=user, date=day).first()
    payload = (
        HealthRecordSerializer(record).data
        if record
        else {"date": str(day), "steps": 0}
    )
    payload.update(
        {
            "accepted": True,
            "approved_steps": record.steps if record else 0,
            "submitted_steps": submitted_steps,
            "user_id": user.id,
            **flags,
        }
    )
    return Response(payload)


def _acquire_periodic_lock(lock_key: str, ttl_seconds: int) -> bool:
    """Acquire a short-lived lock for periodic work (Redis, with cache fallback)."""
    ttl_seconds = max(1, int(ttl_seconds))
    if _redis is None:
        return cache.add(lock_key, "1", timeout=ttl_seconds)

    try:
        return _redis.set(lock_key, "1", nx=True, ex=ttl_seconds) is not None
    except Exception:
        return cache.add(lock_key, "1", timeout=ttl_seconds)


def _persist_verification_artifacts(
    *, user, day, decision, mode: str, version: str, trust_before: int, trust_after: int
) -> None:
    """Persist interval and daily anti-cheat v2 decisions for audit/ops."""
    try:
        DailyVerificationSummary.objects.update_or_create(
            user=user,
            date=day,
            mode=mode,
            defaults={
                "raw_steps_total": decision.raw_steps_total,
                "verified_steps_total": decision.verified_steps_total,
                "suspicious_steps_total": decision.suspicious_steps_total,
                "interval_count": decision.interval_count,
                "accepted_count": decision.accepted_count,
                "review_count": decision.review_count,
                "rejected_count": decision.rejected_count,
                "risk_score": decision.risk_score,
                "review_state": decision.review_state.value,
                "payout_state": decision.payout_state.value,
                "trust_score_before": trust_before,
                "trust_score_after": trust_after,
                "verification_version": version,
                "audit_snapshot": decision.audit_snapshot,
            },
        )

        IntervalVerificationResult.objects.filter(
            user=user, date=day, mode=mode
        ).delete()
        IntervalVerificationResult.objects.bulk_create(
            [
                IntervalVerificationResult(
                    user=user,
                    date=day,
                    interval_start=d.interval.interval_start,
                    interval_end=d.interval.interval_end,
                    source_platform=d.interval.source_platform,
                    source_device=d.interval.source_device or "",
                    source_app=d.interval.source_app or "",
                    raw_steps=d.interval.raw_steps,
                    normalized_steps=d.interval.normalized_steps,
                    verified_steps=d.verified_steps,
                    risk_score=d.risk_score,
                    confidence_score=d.confidence_score,
                    verification_status=d.status.value,
                    review_state=d.review_state.value,
                    payout_state=d.payout_state.value,
                    rule_hits_json=[
                        {
                            "rule_code": hit.rule_code,
                            "severity": hit.severity.value,
                            "risk_level": hit.risk_level.value,
                            "rule_score": hit.rule_score,
                            "weight": hit.weight,
                            "message": hit.message,
                            "evidence": hit.evidence,
                        }
                        for hit in d.rule_hits
                    ],
                    explainability_json=d.explainability,
                    trust_score_before=trust_before,
                    trust_score_after=trust_after,
                    mode=mode,
                    verification_version=version,
                )
                for d in decision.interval_decisions
            ]
        )
    except Exception as exc:
        logger.warning("Failed to persist anti-cheat v2 artifacts: %s", exc)


def _haversine_meters(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    radius_m = 6_371_000.0
    d_lat = math.radians(lat2 - lat1)
    d_lon = math.radians(lon2 - lon1)
    a = (
        math.sin(d_lat / 2) ** 2
        + math.cos(math.radians(lat1))
        * math.cos(math.radians(lat2))
        * math.sin(d_lon / 2) ** 2
    )
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return radius_m * c


def _waypoint_on_local_day(day, recorded_at, local_hour) -> bool:
    """
    Is this GPS fix on the device's local `day`? The fix time is an absolute instant;
    the phone's ledger attributes it to a local hour. The UTC offset implied by the two
    (whole hours, in the real-world range -12..+14) gives the local date, trusted only
    within +-1 day of the UTC date. Without a client hour, fall back to the UTC date.
    """
    utc = recorded_at.astimezone(dt_timezone.utc)
    if local_hour is None:
        return utc.date() == day
    if abs((utc.date() - day).days) > 1:
        return False
    base = (int(local_hour) - utc.hour) % 24  # 0..23
    for offset in (base - 24, base, base + 24):
        if -12 <= offset <= 14:
            local = utc + timedelta(hours=offset)
            if local.date() == day and local.hour == int(local_hour):
                return True
    return False


def _filter_waypoints_for_storage(day, waypoints: list) -> tuple[list[dict], dict]:
    accepted: list[dict] = []
    dropped_accuracy = 0
    dropped_speed = 0
    dropped_jitter = 0
    dropped_malformed = 0
    vehicle_segments: dict[str, list[int]] = {}
    last_fix = None

    for wp in waypoints:
        try:
            lat = float(wp["latitude"])
            lng = float(wp["longitude"])
            accuracy = max(0.0, float(wp.get("accuracy_m", 0.0)))
            recorded_at = timezone.datetime.fromisoformat(
                str(wp["recorded_at"]).replace("Z", "+00:00")
            )
            if timezone.is_naive(recorded_at):
                recorded_at = timezone.make_aware(recorded_at, dt_timezone.utc)
            client_hour = wp.get("hour")
            hour = int(client_hour if client_hour is not None else recorded_at.hour)
            hour = min(23, max(0, hour))
        except Exception:
            dropped_malformed += 1
            continue

        if not _waypoint_on_local_day(
            day, recorded_at, hour if client_hour is not None else None
        ):
            continue

        if accuracy > WAYPOINT_MAX_ACCURACY_M:
            dropped_accuracy += 1
            continue

        if last_fix is not None:
            # Phase 1b: vehicle-speed movement between consecutive fixes is evidence
            # (steps in that hour were likely vibration in a matatu / on a boda), not
            # something to discard silently. Measured fix to fix, kept or not.
            dt_fix = (recorded_at - last_fix[2]).total_seconds()
            if 0 < dt_fix <= 300:
                fix_speed = _haversine_meters(last_fix[0], last_fix[1], lat, lng) / dt_fix
                if VEHICLE_SPEED_MPS < fix_speed <= TELEPORT_SPEED_MPS:
                    # Keyed by the fix time so a re-sent upload isn't counted twice.
                    vehicle_segments[recorded_at.isoformat()] = [hour, int(dt_fix)]
        last_fix = (lat, lng, recorded_at)

        if accepted:
            prev = accepted[-1]
            dt_seconds = max(1.0, (recorded_at - prev["recorded_at"]).total_seconds())
            distance_m = _haversine_meters(
                prev["latitude"], prev["longitude"], lat, lng
            )
            if distance_m < WAYPOINT_MIN_DISTANCE_M:
                dropped_jitter += 1
                continue
            if (distance_m / dt_seconds) > WAYPOINT_MAX_SPEED_MPS:
                dropped_speed += 1
                continue

        accepted.append(
            {
                "hour": hour,
                "recorded_at": recorded_at,
                "latitude": lat,
                "longitude": lng,
                "accuracy_m": accuracy,
            }
        )

    return accepted, {
        "accepted": len(accepted),
        "dropped_accuracy": dropped_accuracy,
        "dropped_speed": dropped_speed,
        "dropped_jitter": dropped_jitter,
        "dropped_malformed": dropped_malformed,
        "vehicle_segments": vehicle_segments,
    }


def _route_distance_km(points: list[dict]) -> float:
    if len(points) < 2:
        return 0.0

    meters = 0.0
    for idx in range(1, len(points)):
        prev = points[idx - 1]
        curr = points[idx]
        meters += _haversine_meters(
            prev["latitude"], prev["longitude"], curr["latitude"], curr["longitude"]
        )
    return meters / 1000.0


ROUTE_CHECK_MIN_STEPS = 1_000
ROUTE_CHECK_MIN_POINTS = 5


def _check_route_against_hours(user, day, points: list[dict]) -> None:
    """
    Route vs steps over the hours the uploaded waypoints cover.

    - Little or no GPS movement for many steps (treadmill, indoor walking, GPS off
      part of the hour) is legitimate: at most an informational LOW note.
    - A route far longer than those hours' steps allow (vehicle) is MEDIUM.
    One open flag per user per day and type (later uploads update it).
    Never a HIGH flag, never trust or suspicion on its own.
    """
    if len(points) < ROUTE_CHECK_MIN_POINTS:
        return
    hours = sorted({int(p["hour"]) for p in points})
    span_steps = (
        HourlyStepRecord.objects.filter(user=user, date=day, hour__in=hours).aggregate(
            total=Sum("steps")
        )["total"]
        or 0
    )
    route_km = _route_distance_km(points)
    if span_steps < ROUTE_CHECK_MIN_STEPS:
        return
    ratio_km_per_step = route_km / span_steps
    details = {
        "hours": hours,
        "span_steps": span_steps,
        "route_km": round(route_km, 3),
        "ratio_km_per_step": round(ratio_km_per_step, 6),
    }
    if ratio_km_per_step < ROUTE_DISTANCE_PER_STEP_MIN_KM:
        _record_flag(
            user,
            day,
            "route_step_mismatch_low_distance",
            "low",
            {
                **details,
                "min_expected_km_per_step": ROUTE_DISTANCE_PER_STEP_MIN_KM,
                "note": "Little GPS movement for these hours' steps (treadmill/indoor "
                "walking is legitimate). Informational only.",
            },
        )
    elif ratio_km_per_step > ROUTE_DISTANCE_PER_STEP_MAX_KM:
        _record_flag(
            user,
            day,
            "route_step_mismatch_high_distance",
            "medium",
            {
                **details,
                "max_expected_km_per_step": ROUTE_DISTANCE_PER_STEP_MAX_KM,
                "note": "Route distance is unusually long for these hours' steps.",
            },
        )


def _encode_polyline(points: list[tuple[float, float]]) -> str:
    if not points:
        return ""

    def _encode_value(value: int) -> str:
        value = ~(value << 1) if value < 0 else (value << 1)
        out = []
        while value >= 0x20:
            out.append(chr((0x20 | (value & 0x1F)) + 63))
            value >>= 5
        out.append(chr(value + 63))
        return "".join(out)

    last_lat = 0
    last_lng = 0
    encoded = []
    for lat, lng in points:
        lat_i = int(round(lat * 1e5))
        lng_i = int(round(lng * 1e5))
        encoded.append(_encode_value(lat_i - last_lat))
        encoded.append(_encode_value(lng_i - last_lng))
        last_lat = lat_i
        last_lng = lng_i
    return "".join(encoded)


def user_local_today(user):
    """The user's current local date from the time zone their phone last reported
    (Phase 1b); the server (UTC) date when it never did."""
    offset = (
        StepSession.objects.filter(user=user, tz_offset_minutes__isnull=False)
        .order_by("-started_at")
        .values_list("tz_offset_minutes", flat=True)
        .first()
    )
    now = timezone.now()
    if offset is None:
        return now.date()
    return (now + timedelta(minutes=int(offset))).date()


def recompute_challenge_progress(user, day, record=None) -> None:
    """Recompute the user's active challenge entries that include `day`.

    Challenge progress counts money-eligible steps only (evidence tiers, see
    apps/steps/evidence.py) of days not under review; goals / streaks / XP keep using
    every credited step. Qualification follows from the total; payouts read it.
    """
    from apps.challenges.models import Participant

    from .evidence import money_steps

    best_day = money_steps(record) if record is not None and not record.is_suspicious else 0
    # One query for the user's active entries (challenge joined in), then one aggregate +
    # one save per entry.
    active_entries = Participant.objects.filter(
        user=user,
        challenge__status="active",
        challenge__start_date__lte=day,
        challenge__end_date__gte=day,
    ).select_related("challenge")
    for participant in active_entries:
        challenge = participant.challenge
        total = challenge_total_steps(user, challenge.start_date, challenge.end_date)
        try:
            participant.steps = total
            participant.qualified = total >= challenge.milestone

            milestone_just_reached = False
            if (
                participant.milestone_reached_at is None
                and participant.steps >= challenge.milestone
            ):
                participant.milestone_reached_at = timezone.now()
                milestone_just_reached = True

            if best_day > participant.best_day_steps:
                participant.best_day_steps = best_day

            participant.save(
                update_fields=["steps", "qualified", "milestone_reached_at", "best_day_steps"]
            )

            if milestone_just_reached and challenge.is_private:
                try:
                    from apps.challenges.consumers import push_system_message

                    milestone_k = challenge.milestone // 1000
                    async_to_sync(push_system_message)(
                        challenge.id,
                        f"{user.username} just hit {milestone_k}K steps and qualified!",
                    )
                except Exception as e:
                    logger.warning(f"System message push failed: {e}")
        except Exception as e:
            logger.warning(f"Tiebreaker update failed for user {user.id}: {e}")


def _day_integrity(current, session, platform: str, now) -> dict:
    """Integrity state of a day from the sessions that uploaded to it (Phase 1b).

    `blocked` (steps count for goals only) only under the admin "enforce" policy:
    a failed Android session is sticky for the day; an Android session that never sent
    a token (once the verifier is configured) blocks until a verified session syncs.
    """
    state = dict(current or {})
    sessions = dict(state.get("sessions") or {})
    blocked_now = False
    if session is not None:
        status = session.integrity_status or "unchecked"
        sessions[str(session.id)] = status
        if len(sessions) > 10:
            sessions = dict(list(sessions.items())[-10:])
        if status == "failed" and platform == "android":
            state["failed_android"] = True
        blocked_now = device_integrity.blocks_money(
            status, platform=platform, started_at=session.started_at, now=now
        )
    state["sessions"] = sessions
    enforce = device_integrity.current_policy() == "enforce"
    state["policy"] = "enforce" if enforce else "shadow"
    state["blocked"] = bool(enforce and (blocked_now or state.get("failed_android")))
    return state


def _record_secondary_stream(*, user, record, stream_key, submitted_steps, data, platform, tz_meta):
    """A second install / phone reported less than the day already has: store its
    raw total and evidence (merged per hour, never summed), credit nothing new."""
    with transaction.atomic():
        record = HealthRecord.objects.select_for_update().get(pk=record.pk)
        meta = dict(record.anticheat or {})
        streams = dict(meta.get("streams_raw") or {})
        streams[stream_key] = max(int(streams.get(stream_key) or 0), submitted_steps)
        meta["streams_raw"] = streams
        if tz_meta.get("tz"):
            meta["tz"] = tz_meta["tz"]
        source = data.get("evidence_source")
        if source == "android_gait_v1" and platform == "android":
            hours = clean_evidence_hours(data.get("evidence_hours"))
            if hours:
                store_stream_evidence(meta, stream_key, hours)
                meta.setdefault("evidence_source", source)
        record.anticheat = meta
        if "p1b" in meta:
            refresh_day(record)
        else:
            HealthRecord.objects.filter(pk=record.pk).update(anticheat=meta)
    return _current_state_response(user, record.date, submitted_steps, secondary_stream=True)


@extend_schema(
    responses={
        200: inline_serializer(
            name="StepResumeResponse",
            fields={
                "date": serializers.DateField(),
                "last_raw_steps": serializers.IntegerField(),
                "synced_at": serializers.DateTimeField(allow_null=True),
            },
        )
    }
)
@api_view(["GET"])
@permission_classes([IsAuthenticated])
@throttle_classes([DashboardReadRateThrottle])
def resume_day(request):
    """
    Reinstall / cleared-data resume (Phase 1b).

    GET /api/steps/resume/?date=YYYY-MM-DD -> {date, last_raw_steps, synced_at}
    The server's last raw total for that day (max over the account's installs). A fresh
    install whose ledger has nothing for today resumes from it, so an honest reinstall
    never reports a lower total (no non-monotonic rejection).
    """
    import datetime

    date_param = request.query_params.get("date")
    try:
        day = datetime.date.fromisoformat(date_param) if date_param else timezone.now().date()
    except ValueError:
        return Response({"error": "Invalid date format. Use YYYY-MM-DD."}, status=400)
    record = HealthRecord.objects.filter(user=request.user, date=day).first()
    if record is None:
        return Response({"date": str(day), "last_raw_steps": 0, "synced_at": None})
    streams = (record.anticheat or {}).get("streams_raw") or {}
    # Steps credited from Health Connect / Apple Health are not our counter's steps.
    health_extra = int(((record.anticheat or {}).get("health") or {}).get("applied_extra", 0) or 0)
    sensor_credit = max(0, int(record.steps or 0) - health_extra)
    raw = max([int(record.last_raw_steps or 0), sensor_credit] + [int(v or 0) for v in streams.values()])
    return Response(
        {
            "date": str(day),
            "last_raw_steps": raw,
            "synced_at": record.synced_at.isoformat() if record.synced_at else None,
        }
    )


@extend_schema(
    request=HealthSyncSerializer,
    responses={
        200: inline_serializer(
            name="HealthSyncResponse",
            fields={
                "id": serializers.IntegerField(),
                "date": serializers.DateField(),
                "source": serializers.CharField(),
                "synced_at": serializers.DateTimeField(),
                "steps": serializers.IntegerField(),
                "distance_km": serializers.FloatField(allow_null=True),
                "calories_active": serializers.IntegerField(allow_null=True),
                "active_minutes": serializers.IntegerField(allow_null=True),
                "is_suspicious": serializers.BooleanField(),
                "approved_steps": serializers.IntegerField(),
                "submitted_steps": serializers.IntegerField(),
                "trust_score": serializers.IntegerField(),
                "trust_status": serializers.CharField(),
                "flags_raised": serializers.IntegerField(),
            },
        )
    },
)
@api_view(["POST"])
@permission_classes([IsAuthenticated])
# 429 + (jittered) Retry-After instead of django-ratelimit's 403, so phones back off
# instead of treating a busy server as a permission problem.
@throttle_classes(
    [StepSyncGlobalThrottle, StepSyncRateThrottle, StepSyncSustainedThrottle]
)
def sync_health(request):
    """
    Receives steps + distance + calories + active minutes from device.
    Applies anti-cheat and upserts the daily record.
    """
    serializer = HealthSyncSerializer(data=request.data)
    serializer.is_valid(raise_exception=True)
    data = serializer.validated_data
    session = None
    session_token = data.get("session_token")
    session_id = data.get("session_id")
    client_event_id = data.get("client_event_id")
    sequence_number = data.get("sequence_number")
    timestamp_client = data.get("timestamp_client")
    payload_hash = compute_payload_hash(
        {
            "session_id": str(session_id) if session_id else None,
            "client_event_id": client_event_id,
            "sequence_number": sequence_number,
            "timestamp_client": (
                timestamp_client.isoformat() if timestamp_client else None
            ),
            "steps_delta": data.get("steps_delta"),
            "steps_total": data.get("steps_total") or data.get("steps"),
            "ml_motion_label": data.get("ml_motion_label"),
            "ml_walk_probability": data.get("ml_walk_probability"),
            "ml_shake_probability": data.get("ml_shake_probability"),
            "ml_model_version": data.get("ml_model_version"),
        }
    )

    if not request.user.device_id:
        with transaction.atomic():
            user = request.user.__class__.objects.select_for_update().get(
                id=request.user.id
            )
            if not user.device_id:
                user.device_id = str(uuid.uuid4())
                user.device_platform = "web"
                user.save()
                request.user.device_id = user.device_id
                request.user.device_platform = user.device_platform

    user = request.user
    submitted_steps = data.get("steps", 0)
    now = timezone.now()
    date = data.get("date", now.date())

    # Idempotent resubmission: the phone retries a reading whose first upload reached the
    # server but whose response was lost (timeout, network drop, app killed). Same
    # client_event_id + same reading => answer with the current state, change nothing.
    # (Session and sequence may differ on the retry, so compare the reading itself.)
    if client_event_id:
        prior = (
            StepSyncEvent.objects.filter(user=user, client_event_id=client_event_id)
            .only("accepted", "raw_steps_total", "timestamp_client")
            .first()
        )
        if (
            prior is not None
            and prior.accepted
            and prior.raw_steps_total == (data.get("steps_total") or submitted_steps)
            and prior.timestamp_client == timestamp_client
        ):
            return _current_state_response(
                user, date, submitted_steps, duplicate=True
            )

    # Optional session-based replay protection. Legacy clients continue through.
    if session_id and session_token:
        try:
            session = StepSession.objects.get(id=session_id, user=user)
        except StepSession.DoesNotExist:
            StepSyncEvent.objects.create(
                user=user,
                session=None,
                device=None,
                client_event_id=_rejection_event_id(client_event_id or str(session_id)),
                sequence_number=sequence_number or 0,
                timestamp_client=timestamp_client,
                payload_hash=payload_hash,
                signature_valid=False,
                replay_detected=True,
                steps_delta=data.get("steps_delta") or 0,
                raw_steps_total=data.get("steps_total") or submitted_steps,
                ml_motion_label=data.get("ml_motion_label"),
                ml_walk_probability=data.get("ml_walk_probability"),
                ml_shake_probability=data.get("ml_shake_probability"),
                ml_model_version=data.get("ml_model_version"),
                interval_risk_score=100.0,
                accepted=False,
                rejection_reason="session_not_found",
                raw_payload=_redact_payload(request.data),
            )
            return Response(
                {
                    "accepted": False,
                    "steps_credited": 0,
                    "replay_detected": True,
                    "interval_risk_score": 100,
                    "message": "This activity could not be verified.",
                },
                status=400,
            )

        if (
            session.user_id != user.id
            or session.status != "active"
            or session.expires_at <= now
        ):
            StepSyncEvent.objects.create(
                user=user,
                session=session,
                device=session.device,
                client_event_id=_rejection_event_id(client_event_id or str(session_id)),
                sequence_number=sequence_number or 0,
                timestamp_client=timestamp_client,
                payload_hash=payload_hash,
                signature_valid=False,
                replay_detected=True,
                steps_delta=data.get("steps_delta") or 0,
                raw_steps_total=data.get("steps_total") or submitted_steps,
                ml_motion_label=data.get("ml_motion_label"),
                ml_walk_probability=data.get("ml_walk_probability"),
                ml_shake_probability=data.get("ml_shake_probability"),
                ml_model_version=data.get("ml_model_version"),
                interval_risk_score=100.0,
                accepted=False,
                rejection_reason="invalid_or_expired_session",
                raw_payload=_redact_payload(request.data),
            )
            return Response(
                {
                    "accepted": False,
                    "steps_credited": 0,
                    "replay_detected": True,
                    "interval_risk_score": 100,
                    "message": "This activity could not be verified.",
                },
                status=400,
            )

        if not verify_session_token(session_token, session.session_token_hash):
            StepSyncEvent.objects.create(
                user=user,
                session=session,
                device=session.device,
                client_event_id=_rejection_event_id(client_event_id or str(session_id)),
                sequence_number=sequence_number or 0,
                timestamp_client=timestamp_client,
                payload_hash=payload_hash,
                signature_valid=False,
                replay_detected=True,
                steps_delta=data.get("steps_delta") or 0,
                raw_steps_total=data.get("steps_total") or submitted_steps,
                ml_motion_label=data.get("ml_motion_label"),
                ml_walk_probability=data.get("ml_walk_probability"),
                ml_shake_probability=data.get("ml_shake_probability"),
                ml_model_version=data.get("ml_model_version"),
                interval_risk_score=100.0,
                accepted=False,
                rejection_reason="invalid_session_token",
                raw_payload=_redact_payload(request.data),
            )
            return Response(
                {
                    "accepted": False,
                    "steps_credited": 0,
                    "replay_detected": True,
                    "interval_risk_score": 100,
                    "message": "This activity could not be verified.",
                },
                status=401,
            )

        replay_detected, replay_reason = detect_replay(
            user.id,
            str(session.id),
            client_event_id or "",
            sequence_number,
            payload_hash,
        )
        if replay_detected or (
            sequence_number is not None
            and sequence_number <= session.last_sequence_number
        ):
            StepSyncEvent.objects.create(
                user=user,
                session=session,
                device=session.device,
                client_event_id=_rejection_event_id(client_event_id or str(session_id)),
                sequence_number=sequence_number or 0,
                timestamp_client=timestamp_client,
                payload_hash=payload_hash,
                signature_valid=True,
                replay_detected=True,
                steps_delta=data.get("steps_delta") or 0,
                raw_steps_total=data.get("steps_total") or submitted_steps,
                ml_motion_label=data.get("ml_motion_label"),
                ml_walk_probability=data.get("ml_walk_probability"),
                ml_shake_probability=data.get("ml_shake_probability"),
                ml_model_version=data.get("ml_model_version"),
                interval_risk_score=95.0,
                accepted=False,
                rejection_reason=replay_reason or "sequence_replay_detected",
                raw_payload=_redact_payload(request.data),
            )
            session.last_sequence_number = max(
                session.last_sequence_number, sequence_number or 0
            )
            session.status = "rejected"
            session.save(update_fields=["last_sequence_number", "status", "updated_at"])
            return Response(
                {
                    "accepted": False,
                    "steps_credited": 0,
                    "replay_detected": True,
                    "interval_risk_score": 95,
                    "message": "This activity could not be verified.",
                },
                status=400,
            )

    idem_key = request.headers.get("X-Idempotency-Key")
    if idem_key and not _check_idempotency(idem_key, user.id):
        return Response({"error": "Duplicate request"}, status=409)

    if not _allow_sync_tick(user.id, min_seconds=1):
        return Response(
            {"error": "Sync too frequent. Maximum 1 request per second."},
            status=429,
            headers={"Retry-After": "2"},
        )

    existing_record = HealthRecord.objects.filter(user=user, date=date).first()
    existing_meta = dict(existing_record.anticheat or {}) if existing_record else {}
    # Days written before Phase 0 hold a discounted total and no raw figure. The first
    # sync after the upgrade re-evaluates such a day from scratch (as the old engine did
    # on every sync); from then on the day is tracked incrementally, raw vs raw.
    legacy_day = (
        existing_record is not None
        and existing_meta.get("v") != ANTICHEAT_DAY_VERSION
    )
    # Phase 1c: steps credited from Health Connect / Apple Health beyond our sensor are
    # re-derived by refresh_day on every change; the sensor path works on its own credit.
    health_extra = int((existing_meta.get("health") or {}).get("applied_extra", 0) or 0)
    prev_raw = 0
    if existing_record is not None:
        prev_raw = max(existing_record.last_raw_steps or 0, 0) or max(
            0, existing_record.steps - health_extra
        )

    # Phase 1b: where this reading comes from. One "stream" per app install (a reinstall
    # or a second phone is a new stream). A stream's own counter never goes down; a
    # different stream reporting less than the day's total is not tampering (fresh
    # install, second phone): the day keeps the MAX over streams, never the sum.
    platform = (
        (session.device.platform if session is not None and session.device else "")
        or (user.device_platform or "")
    ).lower()
    install_id = (data.get("install_id") or "").strip()[:64] or (
        session.install_id if session is not None else ""
    )
    if install_id:
        stream_key = f"i:{install_id}"
    elif session is not None and session.device is not None:
        stream_key = f"d:{session.device.device_id}"[:80]
    else:
        stream_key = "legacy"
    streams_raw = dict(existing_meta.get("streams_raw") or {})
    stream_prev = streams_raw.get(stream_key)

    # Phone time zone (minutes east of UTC) for this day's boundaries.
    tz_offset = clean_tz_offset(data.get("tz_offset_minutes"))
    tz_name = (data.get("tz_name") or "").strip()[:64] or None
    if tz_offset is None and session is not None:
        tz_offset = session.tz_offset_minutes
    if tz_offset is not None:
        local_today = (now + timedelta(minutes=tz_offset)).date()
        if date > local_today:
            return Response({"date": ["Date is in the future."]}, status=400)
    tz_meta = {"tz": existing_meta.get("tz")} if existing_meta.get("tz") else {}
    day_offset, tz_hopping = resolve_day_offset(tz_meta, tz_offset, tz_name)

    if existing_record:
        last_ts = existing_record.last_client_timestamp
        if (
            timestamp_client is not None
            and last_ts is not None
            and timestamp_client <= last_ts
        ):
            # Out-of-order delivery: a reading taken *before* the one already applied
            # arrived late (e.g. a queued retry landing after a newer background upload).
            # A day's counter only grows, so it carries nothing new; applying it would
            # lower the stored total. Not tampering either, so no flag.
            return _current_state_response(user, date, submitted_steps, stale=True)
        if submitted_steps < prev_raw:
            if stream_prev is not None and submitted_steps < int(stream_prev):
                # Raw vs raw: the same install's day counter never goes down.
                _record_flag(
                    user,
                    date,
                    "non_monotonic_steps",
                    "high",
                    {
                        "submitted_steps": submitted_steps,
                        "previous_steps": int(stream_prev),
                        "stream": stream_key[:24],
                        "note": "Submitted steps decreased compared to this install's "
                        "previous total for the same day.",
                    },
                )
                return Response(
                    {
                        "error": "Submitted steps cannot be lower than previously synced steps."
                    },
                    status=400,
                )
            # Another install / phone that counted less than the day already has: keep
            # its evidence, credit nothing new, no flag (max per stream, never a sum).
            return _record_secondary_stream(
                user=user,
                record=existing_record,
                stream_key=stream_key,
                submitted_steps=submitted_steps,
                data=data,
                platform=platform,
                tz_meta=tz_meta,
            )

    fresh_day = (
        existing_record is None
        or legacy_day
        # Phase 1c: a day first created by a Health Connect / Apple Health upload has no
        # sensor reading yet; its first sync is bounded by the time since local midnight.
        or (
            existing_meta.get("created_by") == "health_sources"
            and not existing_meta.get("streams_raw")
        )
    )
    velocity = assess_velocity(
        day=date,
        now=now,
        submitted=submitted_steps,
        prev_raw=0 if fresh_day else prev_raw,
        prev_unverified=0 if fresh_day else existing_record.unverified_steps,
        last_synced_at=None if fresh_day else existing_record.synced_at,
        last_client_ts=None if fresh_day else existing_record.last_client_timestamp,
        client_ts=timestamp_client,
        # The phone's own UTC offset when it sent one (Phase 1b); else the default.
        default_offset_hours=(
            day_offset / 60.0
            if day_offset is not None
            else getattr(settings, "STEP_DEVICE_DEFAULT_UTC_OFFSET_HOURS", None)
        ),
        offset_tolerance_hours=(
            KNOWN_OFFSET_TOLERANCE_HOURS if day_offset is not None else None
        ),
    )
    if velocity.impossible:
        # Clearly impossible for the elapsed time (beyond twice a sprint, sustained, with
        # a large allowance). Borderline excess is not rejected: it is kept unverified.
        _record_flag(
            user,
            date,
            "step_velocity_spike",
            "high",
            {
                **velocity.details,
                "note": "Increase is physically impossible for the elapsed time.",
            },
        )
        return Response(
            {"error": "Step delta too high for the elapsed time window."},
            status=400,
        )
    if tz_hopping:
        # More than one time-zone change in a day: informational (travel exists), the
        # day bound already uses the most conservative offset seen.
        _record_flag(
            user,
            date,
            "timezone_hopping",
            "low",
            {
                "offsets_seen": (tz_meta.get("tz") or {}).get("seen"),
                "note": "The phone's time zone changed more than once on this day.",
            },
        )

    # Walking evidence (Phase 1b). The server only accepts evidence that matches what it
    # knows about the uploader's platform; it caps it by the credited steps later.
    evidence_source = data.get("evidence_source")
    if evidence_source == "android_gait_v1" and platform != "android":
        evidence_source = None
    if evidence_source == "ios_coremotion" and platform != "ios":
        evidence_source = None
    incoming_hours = (
        clean_evidence_hours(data.get("evidence_hours"))
        if evidence_source == "android_gait_v1"
        else None
    )
    evidence_meta = {"evidence_streams": dict(existing_meta.get("evidence_streams") or {})}
    if incoming_hours:
        store_stream_evidence(evidence_meta, stream_key, incoming_hours)
    hourly_now = dict(
        HourlyStepRecord.objects.filter(user=user, date=date).values_list("hour", "steps")
    )
    # Active minutes are computed by the server (hourly buckets + evidence), never
    # taken from the client; the steps-per-minute rules divide by these.
    server_minutes = max(
        1, server_active_minutes(hourly_now, day_evidence(evidence_meta), submitted_steps)
    )

    anti_v2_enabled = bool(getattr(settings, "STEP_ANTICHEAT_V2_ENABLED", False))
    anti_v2_shadow = bool(getattr(settings, "STEP_ANTICHEAT_V2_SHADOW_MODE", True))
    anti_v2_version = str(getattr(settings, "STEP_ANTICHEAT_V2_VERSION", "v2"))
    anti_cfg = VerificationConfig.from_settings(settings)
    # Confidence comes from what the server knows about the uploader (verified session
    # on a registered phone), never from the free `source` label, which can only lower it.
    source_key = resolve_source_key(session=session, user=user)

    trust_score_before = 0
    approved_steps = submitted_steps
    record = None
    event_id = uuid.uuid4()

    v2_payload = {
        "steps": submitted_steps,
        "steps_delta_credit": velocity.credit_delta,
        "client_source": data.get("source"),
        "burst_source": data.get("burst_source"),
        "distance_km": data.get("distance_km"),
        "calories_active": data.get("calories_active"),
        "active_minutes": int(server_minutes),
        "cadence_spm": data.get("cadence_spm"),
        "burst_steps_5s": data.get("burst_steps_5s"),
        "gait_state": data.get("gait_state"),
        "gait_confidence": data.get("gait_confidence"),
        "gait_dominant_freq_hz": data.get("gait_dominant_freq_hz"),
        "gait_autocorr": data.get("gait_autocorr"),
        "gait_interval_std_ms": data.get("gait_interval_std_ms"),
        "gait_valid_peaks_2s": data.get("gait_valid_peaks_2s"),
        "gait_gyro_variance": data.get("gait_gyro_variance"),
        "gait_jerk_rms": data.get("gait_jerk_rms"),
        "carry_mode": data.get("carry_mode"),
        "ml_motion_label": data.get("ml_motion_label"),
        "ml_walk_probability": data.get("ml_walk_probability"),
        "ml_shake_probability": data.get("ml_shake_probability"),
        "ml_model_version": data.get("ml_model_version"),
    }

    try:
        with transaction.atomic():
            trust, _ = TrustScore.objects.select_for_update().get_or_create(user=user)
            if trust.status == "BAN":
                return Response(
                    {"error": "Account suspended. Contact support."}, status=403
                )
            if trust.status == "SUSPEND":
                return Response(
                    {"error": "Challenge participation paused."}, status=403
                )

            trust_score_before = trust.score

            # One engine for both modes; "shadow" vs "active" only labels the stored
            # verification artifacts (admin v2 screens).
            v2_decision = evaluate_daily_submission(
                user=user,
                payload=v2_payload,
                day=date,
                submitted_at=now,
                trust_score=trust.score,
                trust_status=trust.status,
                source_platform=source_key,
                source_device=user.device_platform,
                source_app="steps.sync_health",
                config=anti_cfg,
            )
            result = decision_to_check_result(v2_decision, anti_cfg)

            today_key = str(now.date())
            deduct_cache_key = f"step2win:trust_sync_deducted:{user.id}:{today_key}"
            already_today = max(
                int(cache.get(deduct_cache_key) or 0),
                _trust_deducted_today(user, today_key),
            )
            deduction = cap_trust_deduction(
                requested=result.trust_deduction,
                has_critical=result.has_critical,
                already_today=already_today,
                current_score=trust.score,
            )

            def _apply_deduction():
                if deduction > 0:
                    trust.deduct(deduction)
                    cache.set(
                        deduct_cache_key, already_today + deduction, timeout=2 * 86_400
                    )

            def _mark_suspicion(meta: dict) -> dict:
                suspicion = dict(meta.get("suspicion") or {})
                suspicion["sticky"] = True
                reasons = list(suspicion.get("reasons") or [])
                for reason in result.strong_reasons:
                    if reason not in reasons:
                        reasons.append(reason)
                suspicion["reasons"] = reasons[-30:]
                events = list(suspicion.get("sync_events") or [])
                events.append(str(event_id))
                suspicion["sync_events"] = events[-50:]
                suspicion.setdefault("first_at", now.isoformat())
                suspicion["last_at"] = now.isoformat()
                meta["suspicion"] = suspicion
                return meta

            def _add_deduction(meta: dict) -> dict:
                if deduction > 0:
                    ledger = dict(meta.get("trust_deductions") or {})
                    ledger[today_key] = int(ledger.get(today_key, 0)) + deduction
                    meta["trust_deductions"] = ledger
                return meta

            if result.should_block:
                # CRITICAL / reject-level risk: nothing from this sync is credited, the
                # evidence is recorded, and the day is excluded (sticky).
                for flag in result.flags:
                    _record_flag(
                        user,
                        date,
                        flag["flag_type"],
                        flag["severity"],
                        {**flag["details"], "sync_event_id": str(event_id)},
                    )
                _apply_deduction()
                block_meta = existing_meta if not legacy_day else {}
                block_meta["v"] = ANTICHEAT_DAY_VERSION
                block_meta["blocked_uploads"] = int(block_meta.get("blocked_uploads", 0)) + 1
                block_meta = _add_deduction(_mark_suspicion(block_meta))
                if existing_record is not None:
                    blocked_record = existing_record
                    blocked_record.is_suspicious = True
                    blocked_record.anticheat = block_meta
                    if legacy_day:
                        # Keep the (old) figure but start raw tracking from it.
                        blocked_record.last_raw_steps = prev_raw
                    HealthRecord.objects.filter(pk=existing_record.pk).update(
                        is_suspicious=True,
                        anticheat=block_meta,
                        last_raw_steps=blocked_record.last_raw_steps,
                        verification=build_breakdown(blocked_record),
                    )
                else:
                    blocked_record = HealthRecord.objects.create(
                        user=user,
                        date=date,
                        source=data.get("source", "device_sensor"),
                        steps=0,
                        is_suspicious=True,
                        anticheat=block_meta,
                    )
                    HealthRecord.objects.filter(pk=blocked_record.pk).update(
                        verification=build_breakdown(blocked_record)
                    )
                SuspiciousActivity.objects.create(
                    user=user,
                    reason="Critical anti-cheat block",
                    steps_submitted=submitted_steps,
                    date=date,
                )
                return Response(
                    {
                        "error": "Submission could not be processed. Contact support if this is an error."
                    },
                    status=400,
                )

            anti_flags_count = len(result.flags)
            # HIGH/CRITICAL hits are always recorded (deduplicated per day). MEDIUM hits
            # only as supporting evidence of a day excluded on strong evidence.
            for flag in result.flags:
                if flag["severity"] in ("high", "critical") or result.strong_evidence:
                    _record_flag(
                        user,
                        date,
                        flag["flag_type"],
                        flag["severity"],
                        {**flag["details"], "sync_event_id": str(event_id)},
                    )

            has_high_hits = any(
                flag["severity"] in ("high", "critical") for flag in result.flags
            )
            if deduction > 0:
                _apply_deduction()
            elif not has_high_hits and not result.strong_evidence:
                trust.recover(1)

            # No extra RESTRICT halving here: a low trust score already lowers the
            # confidence multiplier (REVIEW 0.90, RESTRICT 0.75, ...), and payout holds
            # (apps/challenges/payout_holds.py) keep a restricted user's winnings from
            # reaching the wallet until staff review them. Halving on top was a double
            # penalty for users who are only under review.
            credited_delta = int(v2_decision.verified_steps_total)
            prev_credit = (
                0 if fresh_day else max(0, int(existing_record.steps) - health_extra)
            )
            uncapped = prev_credit + credited_delta
            # Plausible daily maximum: credit stops at DAILY_STEP_CAP; the rest is kept
            # as unverified volume. High volume alone is no penalty (workers, runners).
            approved_steps = min(DAILY_STEP_CAP, uncapped)
            over_cap = max(0, uncapped - max(DAILY_STEP_CAP, prev_credit))

            if submitted_steps > DAILY_STEP_CAP and not SuspiciousActivity.objects.filter(
                user=user, date=date, reason="Exceeds daily step cap"
            ).exists():
                SuspiciousActivity.objects.create(
                    user=user,
                    reason="Exceeds daily step cap",
                    steps_submitted=submitted_steps,
                    date=date,
                )

            # Suspicion is sticky per day: a later clean sync cannot clear a day that
            # was excluded on strong evidence (only an admin can, by clearing
            # is_suspicious). Days flagged by the pre-Phase-0 engine are re-decided.
            prior_sticky = bool(
                existing_record is not None
                and existing_record.is_suspicious
                and not legacy_day
                and (existing_meta.get("suspicion") or {}).get("sticky")
            )
            if (
                legacy_day
                and existing_record.is_suspicious
                and _legacy_day_has_strong_flags(user, date)
            ):
                # Flagged before Phase 0 on evidence that is still "strong" today:
                # re-evaluating with a clean snapshot must not launder it.
                prior_sticky = True
            is_suspicious = bool(result.strong_evidence or prior_sticky)
            previous_suspicious = (
                bool(existing_record.is_suspicious) if existing_record else False
            )

            meta = {} if fresh_day else dict(existing_meta)
            if legacy_day:
                meta["reevaluated_from_legacy"] = now.isoformat()
            meta["v"] = ANTICHEAT_DAY_VERSION
            if result.strong_evidence:
                meta = _mark_suspicion(meta)
            elif legacy_day and prior_sticky:
                meta["suspicion"] = {
                    "sticky": True,
                    "reasons": ["pre_phase0_flags"],
                    "sync_events": [],
                    "first_at": now.isoformat(),
                    "last_at": now.isoformat(),
                }
            meta = _add_deduction(meta)
            # Gait coverage of the credited steps (P1b: null gait is not yet penalised).
            coverage = dict(
                meta.get("gait_coverage")
                or {
                    "gait_steps": 0,
                    "rest_snapshot_steps": 0,
                    "no_gait_steps": 0,
                    "syncs_gait": 0,
                    "syncs_rest_snapshot": 0,
                    "syncs_no_gait": 0,
                }
            )
            if velocity.credit_delta > 0:
                if "gait_not_measured" in result.notes:
                    bucket = "no_gait"
                elif "gait_snapshot_at_rest" in result.notes:
                    bucket = "rest_snapshot"
                else:
                    bucket = "gait"
                coverage[f"{bucket}_steps"] = (
                    int(coverage.get(f"{bucket}_steps", 0)) + velocity.credit_delta
                )
                syncs_key = f"syncs_{bucket}"
                coverage[syncs_key] = int(coverage.get(syncs_key, 0)) + 1
            meta["gait_coverage"] = coverage
            if over_cap:
                meta["over_cap_steps"] = int(meta.get("over_cap_steps", 0)) + over_cap
            reduced = max(0, velocity.credit_delta - credited_delta)
            if reduced:
                meta["reduced_steps"] = int(meta.get("reduced_steps", 0)) + reduced
            if velocity.unverified:
                meta["velocity"] = velocity.details
            meta["last_sync"] = {
                "event_id": str(event_id),
                "at": now.isoformat(),
                "source_key": source_key,
                "risk": round(result.risk_score, 2),
                "credit_delta": velocity.credit_delta,
                "credited": credited_delta,
                "multiplier": round(result.credit_multiplier, 4),
                "strong_evidence": result.strong_evidence,
                "notes": result.notes,
            }

            # ── Phase 1b bookkeeping (see apps/steps/evidence.py) ──────────────
            if "p1b" not in meta:
                # Cut-over: whatever the day was already credited before Phase 1b saw
                # it keeps full challenge credit (grandfathered); nothing is stripped.
                grandfathered = (
                    int(existing_record.steps or 0)
                    if existing_record is not None and "p1b" not in existing_meta
                    else 0
                )
                meta["p1b"] = {"since": now.isoformat(), "grandfathered": grandfathered}
            if tz_meta.get("tz"):
                meta["tz"] = tz_meta["tz"]
            streams_raw[stream_key] = max(int(stream_prev or 0), submitted_steps)
            if len(streams_raw) > 6:
                streams_raw = dict(
                    sorted(streams_raw.items(), key=lambda kv: kv[1], reverse=True)[:6]
                )
            meta["streams_raw"] = streams_raw
            meta["evidence_streams"] = evidence_meta["evidence_streams"]
            if evidence_source:
                meta["evidence_source"] = evidence_source
            meta["platform"] = "web" if source_key == "web" else platform
            meta["integrity"] = _day_integrity(meta.get("integrity"), session, platform, now)
            if meta.get("health"):
                # `steps` below is our sensor's credit only; refresh_day re-adds what
                # trusted health sources saw beyond it.
                meta["health"] = {**meta["health"], "applied_extra": 0}

            previous_steps = existing_record.steps if existing_record else None
            previous_eligible = (
                existing_record.eligible_steps if existing_record else None
            )

            newest_client_ts = timestamp_client
            if newest_client_ts is not None:
                # A phone clock set ahead must not freeze the day: never remember a
                # reading time more than a few minutes past the server clock.
                newest_client_ts = min(newest_client_ts, now + timedelta(minutes=5))
            if existing_record and existing_record.last_client_timestamp:
                if (
                    newest_client_ts is None
                    or existing_record.last_client_timestamp > newest_client_ts
                ):
                    newest_client_ts = existing_record.last_client_timestamp

            record, _ = HealthRecord.objects.update_or_create(
                user=user,
                date=date,
                defaults={
                    "last_client_timestamp": newest_client_ts,
                    "source": data.get("source", "device_sensor"),
                    "steps": approved_steps,
                    "last_raw_steps": submitted_steps,
                    "unverified_steps": velocity.unverified,
                    "anticheat": meta,
                    "distance_km": data.get("distance_km"),
                    "calories_active": data.get("calories_active"),
                    "is_suspicious": is_suspicious,
                },
            )
            suspicion_changed = previous_suspicious != is_suspicious
            # Phase 1c: an optional Health Connect / Apple Health summary riding along
            # (the app normally uses POST /api/steps/health-sources/). A bad summary
            # never fails the step sync.
            if data.get("health_sources"):
                from .health_source_views import store_upload

                store_upload(
                    user,
                    date,
                    data.get("health_sources"),
                    platform=platform,
                    tz_offset_minutes=day_offset,
                    now=now,
                    raise_errors=False,
                )
            # Evidence tiers, money-eligible steps, server active minutes and the
            # user-facing breakdown.
            refresh_day(record)
            if (record.anticheat or {}).get("health"):
                from .health_source_views import flag_disagreement

                flag_disagreement(user, record)
            eligible_changed = previous_eligible != record.eligible_steps

            if record.steps > request.user.best_day_steps:
                request.user.__class__.objects.filter(id=request.user.id).update(
                    best_day_steps=record.steps
                )

            # Persist step event + session aggregates for verified or legacy syncs.
            event_steps_delta = int(
                data.get("steps_delta") or max(0, submitted_steps - prev_raw)
            )
            event = StepSyncEvent.objects.create(
                id=event_id,
                user=user,
                session=session,
                device=session.device if session else None,
                client_event_id=client_event_id
                or f"legacy-{user.id}-{date}-{submitted_steps}",
                sequence_number=sequence_number
                or (session.last_sequence_number + 1 if session else 0),
                timestamp_client=timestamp_client,
                payload_hash=payload_hash,
                signature_valid=bool(session),
                replay_detected=False,
                steps_delta=event_steps_delta,
                raw_steps_total=data.get("steps_total") or submitted_steps,
                ml_motion_label=data.get("ml_motion_label"),
                ml_walk_probability=data.get("ml_walk_probability"),
                ml_shake_probability=data.get("ml_shake_probability"),
                ml_model_version=data.get("ml_model_version"),
                interval_risk_score=float(result.risk_score),
                accepted=True,
                rejection_reason=None,
                raw_payload=_redact_payload(request.data),
            )

            if session:
                session.total_steps += event_steps_delta
                session.accepted_steps += max(0, approved_steps - (previous_steps or 0))
                session.last_sequence_number = max(
                    session.last_sequence_number,
                    sequence_number or session.last_sequence_number + 1,
                )
                session.policy_version = session.policy_version or anti_v2_version
                session.ml_model_version = session.ml_model_version or data.get(
                    "ml_model_version"
                )
                if data.get("ml_walk_probability") is not None:
                    prev = session.avg_walk_probability or 0.0
                    session.avg_walk_probability = (
                        (prev + float(data.get("ml_walk_probability"))) / 2.0
                        if prev
                        else float(data.get("ml_walk_probability"))
                    )
                if data.get("ml_shake_probability") is not None:
                    prev = session.avg_shake_probability or 0.0
                    session.avg_shake_probability = (
                        (prev + float(data.get("ml_shake_probability"))) / 2.0
                        if prev
                        else float(data.get("ml_shake_probability"))
                    )
                session.avg_risk_score = (
                    (session.avg_risk_score + event.interval_risk_score) / 2.0
                    if session.avg_risk_score is not None
                    else event.interval_risk_score
                )
                session.session_risk_score = max(
                    session.session_risk_score, event.interval_risk_score
                )
                session.save(
                    update_fields=[
                        "total_steps",
                        "accepted_steps",
                        "rejected_steps",
                        "last_sequence_number",
                        "policy_version",
                        "ml_model_version",
                        "avg_walk_probability",
                        "avg_shake_probability",
                        "avg_risk_score",
                        "session_risk_score",
                        "updated_at",
                    ]
                )

            if anti_v2_enabled or anti_v2_shadow:
                # Day-level totals, so drift monitoring compares like with like.
                _persist_verification_artifacts(
                    user=user,
                    day=date,
                    decision=dataclasses.replace(
                        v2_decision,
                        raw_steps_total=submitted_steps,
                        verified_steps_total=record.steps,
                        suspicious_steps_total=max(0, submitted_steps - record.steps),
                    ),
                    mode="active" if anti_v2_enabled else "shadow",
                    version=anti_v2_version,
                    trust_before=trust_score_before,
                    trust_after=trust.score,
                )

            # Keep streak counters fresh whenever step sync updates a daily record.
            update_streak(user)
    except IntegrityError:
        logger.warning("Duplicate step sync rejected for user=%s date=%s", user.id, date)
        return Response({"error": "Duplicate sync request."}, status=409)

    # XP for the day's accepted steps (admin: xp_per_step / daily_goal_bonus_xp).
    # Flagged or blocked syncs earn nothing; re-syncs only add the difference.
    if not is_suspicious and not result.should_block:
        try:
            from apps.gamification.tasks import award_daily_step_xp

            award_daily_step_xp(user, date, record.steps)
        except Exception:
            logger.exception("Step XP award failed for user=%s date=%s", user.id, date)

    from apps.challenges.services import finalize_expired_challenges

    if _acquire_periodic_lock("step2win:finalize_expired_challenges", 60):
        # The phone's `date` may be a day ahead of the server (time zones) or simply
        # wrong; never let a client date finalize challenges early. With the server's
        # (UTC) date, phones east of UTC also get a grace window after local midnight
        # for their final end-day uploads to land.
        finalize_expired_challenges(today=min(date, timezone.now().date()))

    # A change of the day's suspicion or of its money-eligible steps must reach challenge
    # totals right away (the 15-second coalescing lock only applies to ordinary step
    # increases).
    should_recompute_challenges = suspicion_changed or eligible_changed or (
        (previous_steps is None or approved_steps != previous_steps)
        and _acquire_periodic_lock(f"step2win:participant_recompute:{user.id}", 15)
    )

    if should_recompute_challenges:
        recompute_challenge_progress(user, date, record)


    payload = HealthRecordSerializer(record).data
    payload.update(
        {
            "approved_steps": approved_steps,
            "submitted_steps": submitted_steps,
            "trust_score": trust.score,
            "trust_status": trust.status,
            "flags_raised": anti_flags_count,
            "user_id": user.id,
            "username": user.username,
            "accepted": not result.should_block,
            "verification_level": (
                "session_verified" if session else "legacy_low_confidence"
            ),
            "session_id": str(session.id) if session else None,
            "policy_version": (
                getattr(session, "policy_version", None) if session else None
            ),
        }
    )

    channel_layer = get_channel_layer()
    if channel_layer:
        try:
            async_to_sync(channel_layer.group_send)(
                f"user_steps_{user.id}",
                {
                    "type": "steps_update",
                    "payload": payload,
                },
            )
        except Exception:
            pass

    try:
        broadcast_admin_steps_update(
            {
                "user_id": user.id,
                "username": user.username,
                "date": payload.get("date"),
                "synced_at": payload.get("synced_at"),
                "steps": payload.get("steps", 0),
                "approved_steps": approved_steps,
                "submitted_steps": submitted_steps,
                "source": payload.get("source"),
                "distance_km": payload.get("distance_km"),
                "calories_active": payload.get("calories_active"),
                "active_minutes": payload.get("active_minutes"),
                "is_suspicious": is_suspicious,
                "trust_score": trust.score,
                "trust_status": trust.status,
                "flags_raised": anti_flags_count,
            }
        )
    except Exception:
        pass

    return Response(payload)


@extend_schema(responses={200: HealthRecordSerializer})
@api_view(["GET"])
@permission_classes([IsAuthenticated])
@throttle_classes([DashboardReadRateThrottle])
def today_health(request):
    """Today's steps + distance + calories + active minutes."""
    today = user_local_today(request.user)
    record = HealthRecord.objects.filter(user=request.user, date=today).first()

    if record:
        return Response(HealthRecordSerializer(record).data)

    return Response(
        {
            "date": str(today),
            "steps": 0,
            "distance_km": 0,
            "calories_active": 0,
            "active_minutes": 0,
            "is_suspicious": False,
        }
    )


@extend_schema(
    responses={
        200: inline_serializer(
            name="HealthSummaryResponse",
            fields={
                "today_steps": serializers.IntegerField(),
                "today_goal": serializers.IntegerField(),
                "remaining_today": serializers.IntegerField(),
                "percent_complete": serializers.IntegerField(),
                "today_distance": serializers.FloatField(allow_null=True),
                "today_calories": serializers.IntegerField(allow_null=True),
                "today_active_mins": serializers.IntegerField(allow_null=True),
                "week_total_steps": serializers.IntegerField(),
                "week_avg_steps": serializers.IntegerField(),
                "week_distance": serializers.FloatField(),
                "week_calories": serializers.IntegerField(),
                "week_active_mins": serializers.IntegerField(),
                "best_day_steps": serializers.IntegerField(),
            },
        )
    }
)
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def health_summary(request):
    """
    Aggregated stats for the Steps Detail screen and Home dashboard.
    """
    today = user_local_today(request.user)
    week_start = today - timedelta(days=6)

    week_qs = HealthRecord.objects.filter(user=request.user, date__gte=week_start)
    today_record = week_qs.filter(date=today).first()
    today_steps = today_record.steps if today_record else 0

    # Daily target is the user's own goal. Challenge milestones are multi-day totals
    # and are reported by the challenge endpoints, not as a daily goal.
    milestone = request.user.daily_goal or 10000

    agg = week_qs.aggregate(
        week_steps=Sum("steps"),
        avg_steps=Avg("steps"),
        total_distance=Sum("distance_km"),
        total_calories=Sum("calories_active"),
        total_active=Sum("active_minutes"),
    )

    best_day = (
        HealthRecord.objects.filter(user=request.user).aggregate(best=Max("steps"))[
            "best"
        ]
        or 0
    )

    return Response(
        {
            "today_steps": today_steps,
            "today_goal": milestone,
            "remaining_today": max(0, milestone - today_steps),
            "percent_complete": (
                min(100, round((today_steps / milestone) * 100)) if milestone else 0
            ),
            "today_distance": today_record.distance_km if today_record else None,
            "today_calories": today_record.calories_active if today_record else None,
            "today_active_mins": today_record.active_minutes if today_record else None,
            "week_total_steps": agg["week_steps"] or 0,
            "week_avg_steps": int(agg["avg_steps"] or 0),
            "week_distance": (
                round(agg["total_distance"], 1) if agg["total_distance"] else 0
            ),
            "week_calories": agg["total_calories"] or 0,
            "week_active_mins": agg["total_active"] or 0,
            "best_day_steps": best_day,
        }
    )


@extend_schema(responses={200: HealthRecordSerializer(many=True)})
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def health_history(request):
    """History list filtered by period for StepsHistoryScreen."""
    period = request.query_params.get("period", "1w")
    today = timezone.now().date()

    period_map = {
        "1d": today,
        "1w": today - timedelta(days=7),
        "1m": today - timedelta(days=30),
        "3m": today - timedelta(days=90),
        "1y": today - timedelta(days=365),
    }

    qs = HealthRecord.objects.filter(user=request.user)
    if period in period_map:
        qs = qs.filter(date__gte=period_map[period])

    return Response(HealthRecordSerializer(qs, many=True).data)


@extend_schema(
    responses={
        200: inline_serializer(
            name="WeeklyStepsItem",
            fields={
                "date": serializers.DateField(),
                "steps": serializers.IntegerField(),
            },
            many=True,
        )
    }
)
@api_view(["GET"])
@permission_classes([IsAuthenticated])
@throttle_classes([DashboardReadRateThrottle])
def weekly_steps(request):
    """7-day step array for the home screen bar chart."""
    today = user_local_today(request.user)
    week = [today - timedelta(days=i) for i in range(6, -1, -1)]
    records = {
        r.date: r.steps
        for r in HealthRecord.objects.filter(user=request.user, date__gte=week[0])
    }
    return Response([{"date": str(d), "steps": records.get(d, 0)} for d in week])


@extend_schema(
    responses={
        200: inline_serializer(
            name="DayDetailResponse",
            fields={
                "date": serializers.CharField(),
                "total_steps": serializers.IntegerField(),
                "total_km": serializers.FloatField(),
                "total_calories": serializers.IntegerField(),
                "active_minutes": serializers.IntegerField(),
                "peak_hour": serializers.IntegerField(allow_null=True),
                "peak_steps": serializers.IntegerField(),
                "hourly": serializers.ListField(),
                "waypoints": serializers.ListField(),
                "route_distance_km": serializers.FloatField(),
                "encoded_polyline": serializers.CharField(),
                "goal": serializers.IntegerField(),
                "goal_achieved": serializers.BooleanField(),
            },
        )
    }
)
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def day_detail(request, date_str):
    """
    Returns full detail for a single day:
    - Hourly step breakdown (24 hours)
    - GPS waypoints for the route map
    - Aggregated stats (total steps, km, calories, active minutes)

    URL: GET /api/steps/day/<date_str>/
    Example: GET /api/steps/day/2026-03-04/
    """
    import datetime

    from django.db.models import Sum

    user = request.user

    # Parse date
    try:
        day = datetime.date.fromisoformat(date_str)
    except ValueError:
        return Response({"error": "Invalid date format. Use YYYY-MM-DD."}, status=400)

    # Fetch hourly records
    hourly_qs = HourlyStepRecord.objects.filter(user=user, date=day)

    # Fetch waypoints
    waypoints_qs = LocationWaypoint.objects.filter(user=user, date=day)

    # Aggregate totals
    agg = hourly_qs.aggregate(
        total_steps=Sum("steps"),
        total_km=Sum("distance_km"),
        total_calories=Sum("calories"),
    )

    total_steps = agg["total_steps"] or 0
    total_km = round(agg["total_km"] or 0, 2)
    total_calories = round(agg["total_calories"] or 0)

    # Peak hour
    peak_record = hourly_qs.order_by("-steps").first()
    peak_hour = peak_record.hour if peak_record else None
    peak_steps = peak_record.steps if peak_record else 0

    # Active minutes = hours where steps > 0, multiplied by 60
    active_hours = hourly_qs.filter(steps__gt=0).count()
    active_minutes = active_hours * 60

    # Daily target is the user's own goal (challenge milestones are multi-day totals).
    goal = user.daily_goal or 10_000

    # Also check daily model for total (use if more accurate than hourly sum)
    daily_record = HealthRecord.objects.filter(user=user, date=day).first()
    if daily_record and daily_record.steps > total_steps:
        total_steps = daily_record.steps
    if daily_record and daily_record.active_minutes is not None:
        # Server-computed (Phase 1b): hourly buckets + on-device evidence.
        active_minutes = daily_record.active_minutes

    waypoint_payload = LocationWaypointSerializer(waypoints_qs, many=True).data
    route_points = [
        (float(wp["latitude"]), float(wp["longitude"]))
        for wp in waypoint_payload
        if wp.get("latitude") is not None and wp.get("longitude") is not None
    ]
    route_distance_km = 0.0
    if len(route_points) >= 2:
        route_distance_km = round(
            sum(
                _haversine_meters(
                    route_points[idx - 1][0],
                    route_points[idx - 1][1],
                    route_points[idx][0],
                    route_points[idx][1],
                )
                for idx in range(1, len(route_points))
            )
            / 1000.0,
            3,
        )

    data = {
        "date": str(day),
        "total_steps": total_steps,
        "total_km": total_km,
        "total_calories": int(total_calories),
        "active_minutes": active_minutes,
        "peak_hour": peak_hour,
        "peak_steps": peak_steps,
        "hourly": HourlyStepSerializer(hourly_qs, many=True).data,
        "waypoints": waypoint_payload,
        "route_distance_km": route_distance_km,
        "encoded_polyline": _encode_polyline(route_points),
        "goal": goal,
        "goal_achieved": total_steps >= goal,
    }
    return Response(data)


@extend_schema(
    request=inline_serializer(
        name="SyncHourlyStepsRequest",
        fields={
            "date": serializers.CharField(),
            "hourly": serializers.ListField(),
            "waypoints": serializers.ListField(required=False),
        },
    ),
    responses={
        200: inline_serializer(
            name="SyncHourlyStepsResponse",
            fields={
                "message": serializers.CharField(),
                "hourly_synced": serializers.IntegerField(),
                "waypoints_synced": serializers.IntegerField(),
            },
        )
    },
)
@api_view(["POST"])
@permission_classes([IsAuthenticated])
@throttle_classes([StepSyncGlobalThrottle, StepHourlySyncRateThrottle])
def sync_hourly_steps(request):
    """
    Syncs hourly step data from Google Fit / Apple Health.
    Called alongside the main sync_health endpoint.

    Request body:
    {
      "date": "2026-03-04",
      "hourly": [
        { "hour": 8, "steps": 320, "distance_km": 0.26, "calories": 12.0 },
        { "hour": 9, "steps": 180, "distance_km": 0.14, "calories": 7.0 },
        ...
      ],
      "waypoints": [
        { "hour": 8, "recorded_at": "2026-03-04T08:12:00Z",
          "latitude": -1.2921, "longitude": 36.8219, "accuracy_m": 12.0 },
        ...
      ]
    }
    """
    import datetime

    user = request.user
    date_str = request.data.get("date")
    hourly = request.data.get("hourly", [])
    waypoints = request.data.get("waypoints", [])

    try:
        day = datetime.date.fromisoformat(date_str)
    except (ValueError, TypeError):
        return Response({"error": "Invalid date"}, status=400)
    if day > timezone.now().date() + timedelta(days=1):
        return Response({"error": "Date is in the future."}, status=400)
    if not isinstance(hourly, list) or not isinstance(waypoints, list):
        return Response({"error": "hourly and waypoints must be lists."}, status=400)
    # Payload caps: one day has 24 hours, and the phone keeps at most 500 route points
    # per day. Anything bigger is a bug or abuse; reject before touching the database.
    if len(hourly) > HOURLY_MAX_ENTRIES or len(waypoints) > WAYPOINT_MAX_PER_REQUEST:
        return Response({"error": "Payload too large."}, status=413)

    # Upsert hourly records in bulk (was 2 queries per hour). A bucket never goes down:
    # an older upload arriving after a newer one (retry, out-of-order) can't erase steps.
    incoming = {}
    for h in hourly:
        if not isinstance(h, dict):
            continue
        try:
            hour = int(h.get("hour"))
            steps_value = max(0, min(HOURLY_MAX_STEPS, int(h.get("steps", 0) or 0)))
            distance_value = max(0.0, float(h.get("distance_km", 0) or 0))
            calories_value = max(0.0, float(h.get("calories", 0) or 0))
        except (TypeError, ValueError):
            continue
        if not (0 <= hour <= 23):
            continue
        incoming[hour] = (steps_value, distance_value, calories_value)

    if incoming:
        existing_hours = {
            rec.hour: rec
            for rec in HourlyStepRecord.objects.filter(
                user=user, date=day, hour__in=list(incoming)
            )
        }
        to_create, to_update = [], []
        for hour, (steps_value, distance_value, calories_value) in incoming.items():
            rec = existing_hours.get(hour)
            if rec is None:
                to_create.append(
                    HourlyStepRecord(
                        user=user,
                        date=day,
                        hour=hour,
                        steps=steps_value,
                        distance_km=distance_value,
                        calories=calories_value,
                    )
                )
            elif steps_value > rec.steps:
                rec.steps = steps_value
                rec.distance_km = distance_value
                rec.calories = calories_value
                to_update.append(rec)
        if to_create:
            # ignore_conflicts: a concurrent upload for the same hour already won.
            HourlyStepRecord.objects.bulk_create(to_create, ignore_conflicts=True)
        if to_update:
            HourlyStepRecord.objects.bulk_update(
                to_update, ["steps", "distance_km", "calories"]
            )

    stored_waypoints = 0
    waypoint_quality = {
        "accepted": 0,
        "dropped_accuracy": 0,
        "dropped_speed": 0,
        "dropped_jitter": 0,
        "dropped_malformed": 0,
    }

    # Store waypoints with quality filtering — keeps route realistic and prevents teleport spikes.
    if waypoints:
        filtered, waypoint_quality = _filter_waypoints_for_storage(day, waypoints)
        # One query for what's already stored, one bulk insert (was 2 queries per point).
        # Re-sent points (retries) are recognised by their timestamp and skipped.
        existing_times = set(
            LocationWaypoint.objects.filter(user=user, date=day).values_list(
                "recorded_at", flat=True
            )
        )
        budget = max(0, 500 - len(existing_times))
        new_points = []
        for wp in filtered:
            if len(new_points) >= budget:
                break
            if wp["recorded_at"] in existing_times:
                continue
            existing_times.add(wp["recorded_at"])
            new_points.append(
                LocationWaypoint(
                    user=user,
                    date=day,
                    recorded_at=wp["recorded_at"],
                    hour=wp["hour"],
                    latitude=wp["latitude"],
                    longitude=wp["longitude"],
                    accuracy_m=wp["accuracy_m"],
                )
            )
        if new_points:
            LocationWaypoint.objects.bulk_create(new_points)
        stored_waypoints = len(new_points)

        # Route plausibility: compare the uploaded route with the steps of the SAME
        # hours (the phone's hourly buckets), not with the whole day.
        _check_route_against_hours(user, day, filtered)

    # Phase 1b: vehicle-speed movement per hour and the new hourly buckets change the
    # day's evidence tiers and server-computed active minutes.
    segments = waypoint_quality.pop("vehicle_segments", None) or {}
    if incoming or segments:
        with transaction.atomic():
            record = (
                HealthRecord.objects.select_for_update().filter(user=user, date=day).first()
            )
            if record is not None and "p1b" in (record.anticheat or {}):
                meta = dict(record.anticheat or {})
                if segments:
                    stored = dict(meta.get("vehicle_segments") or {})
                    stored.update(segments)
                    if len(stored) > 600:
                        stored = dict(sorted(stored.items())[-600:])
                    meta["vehicle_segments"] = stored
                    by_hour: dict[str, int] = {}
                    for hour_value, secs in stored.values():
                        by_hour[str(hour_value)] = by_hour.get(str(hour_value), 0) + int(secs)
                    meta["vehicle_seconds_by_hour"] = by_hour
                record.anticheat = meta
                previous_eligible = record.eligible_steps
                refresh_day(record)
                if previous_eligible != record.eligible_steps:
                    recompute_challenge_progress(user, day, record)

    return Response(
        {
            "status": "synced",
            "hourly_count": len(hourly),
            "waypoint_count": stored_waypoints,
            "waypoint_quality": waypoint_quality,
        }
    )


VERIFICATION_MAX_DAYS = 14


@extend_schema(
    responses={
        200: inline_serializer(
            name="StepVerificationResponse",
            fields={
                "days": serializers.ListField(child=serializers.DictField()),
            },
        )
    }
)
@api_view(["GET"])
@permission_classes([IsAuthenticated])
@throttle_classes([DashboardReadRateThrottle])
def step_verification(request):
    """
    Why do (or don't) my steps count? Per-day breakdown for the requesting user only.

    GET /api/steps/verification/?date=YYYY-MM-DD      -> one day
    GET /api/steps/verification/?days=N (1..14)       -> the last N days (default 7)

    Each day: counted_steps (what the phone reported), credited_steps (what counts
    toward challenges), unverified_steps (counted but not credited) and reasons
    [{code, steps_affected, severity, user_message}]. Days without a record are
    omitted. No internal anti-cheat evidence is exposed.
    """
    import datetime

    today = timezone.now().date()
    date_param = request.query_params.get("date")
    if date_param:
        try:
            day = datetime.date.fromisoformat(date_param)
        except ValueError:
            return Response({"error": "Invalid date format. Use YYYY-MM-DD."}, status=400)
        days = [day]
    else:
        try:
            count = int(request.query_params.get("days", 7))
        except (TypeError, ValueError):
            return Response({"error": "days must be a number."}, status=400)
        count = max(1, min(VERIFICATION_MAX_DAYS, count))
        # +1: a phone east of UTC can already be on tomorrow's date.
        days = [today + timedelta(days=1) - timedelta(days=i) for i in range(count + 1)]

    records = HealthRecord.objects.filter(user=request.user, date__in=days).order_by(
        "-date"
    )
    return Response({"days": [build_breakdown(record) for record in records]})
