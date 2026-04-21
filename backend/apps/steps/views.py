from datetime import timedelta
import logging
import math

import redis as redis_client
from django.conf import settings
from django.core.cache import cache
from django.db import transaction
from django.db.models import Avg, Max, Sum
from django.utils import timezone
from django_ratelimit.decorators import ratelimit
from rest_framework.decorators import api_view, permission_classes, throttle_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework import serializers
from drf_spectacular.utils import extend_schema, inline_serializer
from channels.layers import get_channel_layer
from asgiref.sync import async_to_sync

from .anti_cheat import (
    DAILY_STEP_CAP,
    VerificationConfig,
    decision_to_check_result,
    evaluate_daily_submission,
    run_anti_cheat,
)
from .daily_reset import update_streak
from apps.core.throttles import DashboardReadRateThrottle
from apps.admin_api.realtime import broadcast_admin_steps_update
from .models import (
    DailyVerificationSummary,
    FraudFlag,
    HealthRecord,
    HourlyStepRecord,
    IntervalVerificationResult,
    LocationWaypoint,
    SuspiciousActivity,
    TrustScore,
)
from .serializers import HealthRecordSerializer, HealthSyncSerializer, HourlyStepSerializer, LocationWaypointSerializer

logger = logging.getLogger(__name__)

WAYPOINT_MAX_ACCURACY_M = 75.0
WAYPOINT_MIN_DISTANCE_M = 2.0
WAYPOINT_MAX_SPEED_MPS = 8.0
ROUTE_DISTANCE_PER_STEP_MIN_KM = 0.0002
ROUTE_DISTANCE_PER_STEP_MAX_KM = 0.0030


def _get_redis_client():
    try:
        return redis_client.Redis.from_url(getattr(settings, 'REDIS_URL', settings.CELERY_BROKER_URL))
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
        return _redis.set(redis_key, '1', nx=True, ex=3600) is not None
    except Exception:
        return True


def _allow_sync_tick(user_id: int, min_seconds: int = 1) -> bool:
    """Returns True when user is allowed to submit another sync tick."""
    redis_key = f"step2win:sync_tick:{user_id}"
    if _redis is None:
        return cache.add(redis_key, '1', timeout=max(1, min_seconds))

    try:
        return _redis.set(redis_key, '1', nx=True, ex=max(1, min_seconds)) is not None
    except Exception:
        return cache.add(redis_key, '1', timeout=max(1, min_seconds))


def _acquire_periodic_lock(lock_key: str, ttl_seconds: int) -> bool:
    """Acquire a short-lived lock for periodic work (Redis, with cache fallback)."""
    ttl_seconds = max(1, int(ttl_seconds))
    if _redis is None:
        return cache.add(lock_key, '1', timeout=ttl_seconds)

    try:
        return _redis.set(lock_key, '1', nx=True, ex=ttl_seconds) is not None
    except Exception:
        return cache.add(lock_key, '1', timeout=ttl_seconds)


def _persist_verification_artifacts(*, user, day, decision, mode: str, version: str, trust_before: int, trust_after: int) -> None:
    """Persist interval and daily anti-cheat v2 decisions for audit/ops."""
    try:
        DailyVerificationSummary.objects.update_or_create(
            user=user,
            date=day,
            mode=mode,
            defaults={
                'raw_steps_total': decision.raw_steps_total,
                'verified_steps_total': decision.verified_steps_total,
                'suspicious_steps_total': decision.suspicious_steps_total,
                'interval_count': decision.interval_count,
                'accepted_count': decision.accepted_count,
                'review_count': decision.review_count,
                'rejected_count': decision.rejected_count,
                'risk_score': decision.risk_score,
                'review_state': decision.review_state.value,
                'payout_state': decision.payout_state.value,
                'trust_score_before': trust_before,
                'trust_score_after': trust_after,
                'verification_version': version,
                'audit_snapshot': decision.audit_snapshot,
            },
        )

        IntervalVerificationResult.objects.filter(user=user, date=day, mode=mode).delete()
        IntervalVerificationResult.objects.bulk_create([
            IntervalVerificationResult(
                user=user,
                date=day,
                interval_start=d.interval.interval_start,
                interval_end=d.interval.interval_end,
                source_platform=d.interval.source_platform,
                source_device=d.interval.source_device or '',
                source_app=d.interval.source_app or '',
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
                        'rule_code': hit.rule_code,
                        'severity': hit.severity.value,
                        'risk_level': hit.risk_level.value,
                        'rule_score': hit.rule_score,
                        'weight': hit.weight,
                        'message': hit.message,
                        'evidence': hit.evidence,
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
        ])
    except Exception as exc:
        logger.warning('Failed to persist anti-cheat v2 artifacts: %s', exc)


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


def _filter_waypoints_for_storage(day, waypoints: list) -> tuple[list[dict], dict]:
    accepted: list[dict] = []
    dropped_accuracy = 0
    dropped_speed = 0
    dropped_jitter = 0
    dropped_malformed = 0

    for wp in waypoints:
        try:
            lat = float(wp['latitude'])
            lng = float(wp['longitude'])
            accuracy = max(0.0, float(wp.get('accuracy_m', 0.0)))
            recorded_at = timezone.datetime.fromisoformat(str(wp['recorded_at']).replace('Z', '+00:00'))
            if timezone.is_naive(recorded_at):
                recorded_at = timezone.make_aware(recorded_at, timezone.utc)
            hour = int(wp.get('hour', recorded_at.hour))
            hour = min(23, max(0, hour))
        except Exception:
            dropped_malformed += 1
            continue

        if recorded_at.date() != day:
            continue

        if accuracy > WAYPOINT_MAX_ACCURACY_M:
            dropped_accuracy += 1
            continue

        if accepted:
            prev = accepted[-1]
            dt_seconds = max(1.0, (recorded_at - prev['recorded_at']).total_seconds())
            distance_m = _haversine_meters(prev['latitude'], prev['longitude'], lat, lng)
            if distance_m < WAYPOINT_MIN_DISTANCE_M:
                dropped_jitter += 1
                continue
            if (distance_m / dt_seconds) > WAYPOINT_MAX_SPEED_MPS:
                dropped_speed += 1
                continue

        accepted.append({
            'hour': hour,
            'recorded_at': recorded_at,
            'latitude': lat,
            'longitude': lng,
            'accuracy_m': accuracy,
        })

    return accepted, {
        'accepted': len(accepted),
        'dropped_accuracy': dropped_accuracy,
        'dropped_speed': dropped_speed,
        'dropped_jitter': dropped_jitter,
        'dropped_malformed': dropped_malformed,
    }


def _route_distance_km(points: list[dict]) -> float:
    if len(points) < 2:
        return 0.0

    meters = 0.0
    for idx in range(1, len(points)):
        prev = points[idx - 1]
        curr = points[idx]
        meters += _haversine_meters(prev['latitude'], prev['longitude'], curr['latitude'], curr['longitude'])
    return meters / 1000.0


def _encode_polyline(points: list[tuple[float, float]]) -> str:
    if not points:
        return ''

    def _encode_value(value: int) -> str:
        value = ~(value << 1) if value < 0 else (value << 1)
        out = []
        while value >= 0x20:
            out.append(chr((0x20 | (value & 0x1F)) + 63))
            value >>= 5
        out.append(chr(value + 63))
        return ''.join(out)

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
    return ''.join(encoded)


@extend_schema(
    request=HealthSyncSerializer,
    responses={
        200: inline_serializer(
            name='HealthSyncResponse',
            fields={
                'id': serializers.IntegerField(),
                'date': serializers.DateField(),
                'source': serializers.CharField(),
                'synced_at': serializers.DateTimeField(),
                'steps': serializers.IntegerField(),
                'distance_km': serializers.FloatField(allow_null=True),
                'calories_active': serializers.IntegerField(allow_null=True),
                'active_minutes': serializers.IntegerField(allow_null=True),
                'is_suspicious': serializers.BooleanField(),
                'approved_steps': serializers.IntegerField(),
                'submitted_steps': serializers.IntegerField(),
                'trust_score': serializers.IntegerField(),
                'trust_status': serializers.CharField(),
                'flags_raised': serializers.IntegerField(),
            },
        )
    },
)
@api_view(['POST'])
@permission_classes([IsAuthenticated])
@ratelimit(key='user', rate='3600/h', method='POST', block=True)
def sync_health(request):
    """
    Receives steps + distance + calories + active minutes from device.
    Applies anti-cheat and upserts the daily record.
    """
    serializer = HealthSyncSerializer(data=request.data)
    serializer.is_valid(raise_exception=True)
    data = serializer.validated_data

    if not request.user.device_id:
        import uuid
        with transaction.atomic():
            user = request.user.__class__.objects.select_for_update().get(id=request.user.id)
            if not user.device_id:
                user.device_id = str(uuid.uuid4())
                user.device_platform = 'web'
                user.save()
                request.user.device_id = user.device_id
                request.user.device_platform = user.device_platform

    user = request.user
    submitted_steps = data.get('steps', 0)
    now = timezone.now()
    date = data.get('date', now.date())

    idem_key = request.headers.get('X-Idempotency-Key')
    if idem_key and not _check_idempotency(idem_key, user.id):
        return Response({'error': 'Duplicate request'}, status=409)

    if not _allow_sync_tick(user.id, min_seconds=1):
        return Response({'error': 'Sync too frequent. Maximum 1 request per second.'}, status=429)

    existing_record = HealthRecord.objects.filter(user=user, date=date).first()
    if existing_record:
        if submitted_steps < existing_record.steps:
            FraudFlag.objects.create(
                user=user,
                date=date,
                flag_type='non_monotonic_steps',
                severity='high',
                details={
                    'submitted_steps': submitted_steps,
                    'previous_steps': existing_record.steps,
                    'note': 'Submitted steps decreased compared to existing total for the same day.',
                },
            )
            return Response({'error': 'Submitted steps cannot be lower than previously synced steps.'}, status=400)

        elapsed_seconds = max(1.0, (now - existing_record.synced_at).total_seconds())
        delta_steps = submitted_steps - existing_record.steps
        max_delta = int(elapsed_seconds * 5) + 200
        if delta_steps > max_delta:
            FraudFlag.objects.create(
                user=user,
                date=date,
                flag_type='step_velocity_spike',
                severity='high',
                details={
                    'submitted_steps': submitted_steps,
                    'previous_steps': existing_record.steps,
                    'delta_steps': delta_steps,
                    'elapsed_seconds': round(elapsed_seconds, 2),
                    'max_allowed_delta': max_delta,
                    'note': 'Delta exceeds allowed step increase for elapsed sync interval.',
                },
            )
            return Response({'error': 'Step delta too high for the elapsed time window.'}, status=400)

    trust, _ = TrustScore.objects.get_or_create(user=user)
    if trust.status == 'BAN':
        return Response({'error': 'Account suspended. Contact support.'}, status=403)
    if trust.status == 'SUSPEND':
        return Response({'error': 'Challenge participation paused.'}, status=403)

    anti_v2_enabled = bool(getattr(settings, 'STEP_ANTICHEAT_V2_ENABLED', False))
    anti_v2_shadow = bool(getattr(settings, 'STEP_ANTICHEAT_V2_SHADOW_MODE', True))
    anti_v2_version = str(getattr(settings, 'STEP_ANTICHEAT_V2_VERSION', 'v2'))
    anti_cfg = VerificationConfig.from_settings(settings)

    trust_score_before = trust.score
    v2_payload = {
        'steps': submitted_steps,
        'distance_km': data.get('distance_km'),
        'calories_active': data.get('calories_active'),
        'active_minutes': data.get('active_minutes'),
        'cadence_spm': data.get('cadence_spm'),
        'burst_steps_5s': data.get('burst_steps_5s'),
        'gait_state': data.get('gait_state'),
        'gait_confidence': data.get('gait_confidence'),
        'gait_dominant_freq_hz': data.get('gait_dominant_freq_hz'),
        'gait_autocorr': data.get('gait_autocorr'),
        'gait_interval_std_ms': data.get('gait_interval_std_ms'),
        'gait_valid_peaks_2s': data.get('gait_valid_peaks_2s'),
        'gait_gyro_variance': data.get('gait_gyro_variance'),
        'gait_jerk_rms': data.get('gait_jerk_rms'),
        'carry_mode': data.get('carry_mode'),
        'ml_motion_label': data.get('ml_motion_label'),
        'ml_walk_probability': data.get('ml_walk_probability'),
        'ml_shake_probability': data.get('ml_shake_probability'),
        'ml_model_version': data.get('ml_model_version'),
    }
    v2_decision = None

    if anti_v2_enabled:
        v2_decision = evaluate_daily_submission(
            user=user,
            payload=v2_payload,
            day=date,
            submitted_at=now,
            trust_score=trust.score,
            trust_status=trust.status,
            source_platform=data.get('source', 'device_sensor'),
            source_device=user.device_platform,
            source_app='steps.sync_health',
            config=anti_cfg,
        )
        result = decision_to_check_result(v2_decision)
    else:
        result = run_anti_cheat(
            user=user,
            steps=submitted_steps,
            date=date,
            distance_km=data.get('distance_km'),
            calories=data.get('calories_active'),
            active_minutes=data.get('active_minutes'),
            cadence_spm=data.get('cadence_spm'),
            burst_steps_5s=data.get('burst_steps_5s'),
            gait_state=data.get('gait_state'),
            gait_confidence=data.get('gait_confidence'),
            gait_dominant_freq_hz=data.get('gait_dominant_freq_hz'),
            gait_autocorr=data.get('gait_autocorr'),
            gait_interval_std_ms=data.get('gait_interval_std_ms'),
            gait_valid_peaks_2s=data.get('gait_valid_peaks_2s'),
            gait_gyro_variance=data.get('gait_gyro_variance'),
            gait_jerk_rms=data.get('gait_jerk_rms'),
            carry_mode=data.get('carry_mode'),
            ml_motion_label=data.get('ml_motion_label'),
            ml_walk_probability=data.get('ml_walk_probability'),
            ml_shake_probability=data.get('ml_shake_probability'),
            ml_model_version=data.get('ml_model_version'),
            submitted_at=now,
        )
        if anti_v2_shadow:
            v2_decision = evaluate_daily_submission(
                user=user,
                payload=v2_payload,
                day=date,
                submitted_at=now,
                trust_score=trust.score,
                trust_status=trust.status,
                source_platform=data.get('source', 'device_sensor'),
                source_device=user.device_platform,
                source_app='steps.sync_health',
                config=anti_cfg,
            )

    if result.should_block:
        for flag in result.flags:
            FraudFlag.objects.create(user=user, date=date, **flag)
        trust.deduct(result.trust_deduction)
        SuspiciousActivity.objects.create(
            user=user,
            reason='Critical anti-cheat block',
            steps_submitted=submitted_steps,
            date=date,
        )
        return Response(
            {'error': 'Submission could not be processed. Contact support if this is an error.'},
            status=400,
        )

    anti_flags_count = len(result.flags)
    anti_is_suspicious = anti_flags_count > 0
    for flag in result.flags:
        FraudFlag.objects.create(user=user, date=date, **flag)

    if result.trust_deduction > 0:
        trust.deduct(result.trust_deduction)
    else:
        trust.recover(1)

    approved_steps = result.approved_steps
    if trust.status == 'RESTRICT' and not anti_v2_enabled:
        approved_steps = int(approved_steps * 0.5)

    legacy_is_suspicious = False

    if submitted_steps > DAILY_STEP_CAP:
        SuspiciousActivity.objects.create(
            user=user,
            reason='Exceeds daily step cap',
            steps_submitted=submitted_steps,
            date=date,
        )
        legacy_is_suspicious = True

    recent_avg = HealthRecord.objects.filter(
        user=user,
        date__gte=date - timedelta(days=7),
    ).exclude(date=date).aggregate(avg=Avg('steps'))['avg'] or 0

    if recent_avg > 0 and approved_steps > recent_avg * 10:
        SuspiciousActivity.objects.create(
            user=user,
            reason='Step spike  10 recent average',
            steps_submitted=approved_steps,
            date=date,
        )
        legacy_is_suspicious = True

    is_suspicious = anti_is_suspicious or legacy_is_suspicious

    previous_steps = existing_record.steps if existing_record else None

    record, _ = HealthRecord.objects.update_or_create(
        user=user,
        date=date,
        defaults={
            'source': data.get('source', 'device_sensor'),
            'steps': approved_steps,
            'distance_km': data.get('distance_km'),
            'calories_active': data.get('calories_active'),
            'active_minutes': data.get('active_minutes'),
            'is_suspicious': is_suspicious,
        },
    )

    if record.steps > request.user.best_day_steps:
        request.user.__class__.objects.filter(id=request.user.id).update(
            best_day_steps=record.steps
        )

    if v2_decision is not None:
        _persist_verification_artifacts(
            user=user,
            day=date,
            decision=v2_decision,
            mode='active' if anti_v2_enabled else 'shadow',
            version=anti_v2_version,
            trust_before=trust_score_before,
            trust_after=trust.score,
        )

    # Keep streak counters fresh whenever step sync updates a daily record.
    update_streak(user)

    from apps.challenges.models import Challenge, Participant
    from apps.challenges.services import finalize_expired_challenges

    if _acquire_periodic_lock('step2win:finalize_expired_challenges', 60):
        finalize_expired_challenges(today=date)

    should_recompute_challenges = (
        previous_steps is None or approved_steps != previous_steps
    ) and _acquire_periodic_lock(f'step2win:participant_recompute:{user.id}', 15)

    if should_recompute_challenges:
        active_challenges = Challenge.objects.filter(
            participants__user=user,
            status='active',
            start_date__lte=date,
            end_date__gte=date,
        )
        for challenge in active_challenges:
            total = HealthRecord.objects.filter(
                user=user,
                date__gte=challenge.start_date,
                date__lte=challenge.end_date,
                is_suspicious=False,
            ).aggregate(total=Sum('steps'))['total'] or 0

            Participant.objects.filter(challenge=challenge, user=user).update(
                steps=total,
                qualified=total >= challenge.milestone,
            )

            # ── Update tiebreaker tracking fields ─────────────────────────────
            try:
                participant = Participant.objects.get(challenge=challenge, user=user)

                milestone_just_reached = False
                if (participant.milestone_reached_at is None
                        and participant.steps >= challenge.milestone):
                    participant.milestone_reached_at = timezone.now()
                    milestone_just_reached = True

                if record.steps > participant.best_day_steps:
                    participant.best_day_steps = record.steps

                participant.save(update_fields=[
                    'milestone_reached_at',
                    'best_day_steps',
                ])

                if milestone_just_reached and challenge.is_private:
                    try:
                        from asgiref.sync import async_to_sync
                        from apps.challenges.consumers import push_system_message
                        milestone_k = challenge.milestone // 1000
                        async_to_sync(push_system_message)(
                            challenge.id,
                            f'🎉 {user.username} just hit {milestone_k}K steps and qualified!'
                        )
                    except Exception as e:
                        logger.warning(f'System message push failed: {e}')

            except Participant.DoesNotExist:
                pass
            except Exception as e:
                logger.warning(f'Tiebreaker update failed for user {user.id}: {e}')

    payload = HealthRecordSerializer(record).data
    payload.update({
        'approved_steps': approved_steps,
        'submitted_steps': submitted_steps,
        'trust_score': trust.score,
        'trust_status': trust.status,
        'flags_raised': anti_flags_count,
        'user_id': user.id,
        'username': user.username,
    })

    channel_layer = get_channel_layer()
    if channel_layer:
        try:
            async_to_sync(channel_layer.group_send)(
                f'user_steps_{user.id}',
                {
                    'type': 'steps_update',
                    'payload': payload,
                }
            )
        except Exception:
            pass

    try:
        broadcast_admin_steps_update({
            'user_id': user.id,
            'username': user.username,
            'date': payload.get('date'),
            'synced_at': payload.get('synced_at'),
            'steps': payload.get('steps', 0),
            'approved_steps': approved_steps,
            'submitted_steps': submitted_steps,
            'source': payload.get('source'),
            'distance_km': payload.get('distance_km'),
            'calories_active': payload.get('calories_active'),
            'active_minutes': payload.get('active_minutes'),
            'is_suspicious': is_suspicious,
            'trust_score': trust.score,
            'trust_status': trust.status,
            'flags_raised': anti_flags_count,
        })
    except Exception:
        pass

    return Response(payload)


@extend_schema(responses={200: HealthRecordSerializer})
@api_view(['GET'])
@permission_classes([IsAuthenticated])
@throttle_classes([DashboardReadRateThrottle])
def today_health(request):
    """Today's steps + distance + calories + active minutes."""
    today = timezone.now().date()
    record = HealthRecord.objects.filter(user=request.user, date=today).first()

    if record:
        return Response(HealthRecordSerializer(record).data)

    return Response({
        'date': str(today),
        'steps': 0,
        'distance_km': 0,
        'calories_active': 0,
        'active_minutes': 0,
        'is_suspicious': False,
    })


@extend_schema(
    responses={
        200: inline_serializer(
            name='HealthSummaryResponse',
            fields={
                'today_steps': serializers.IntegerField(),
                'today_goal': serializers.IntegerField(),
                'remaining_today': serializers.IntegerField(),
                'percent_complete': serializers.IntegerField(),
                'today_distance': serializers.FloatField(allow_null=True),
                'today_calories': serializers.IntegerField(allow_null=True),
                'today_active_mins': serializers.IntegerField(allow_null=True),
                'week_total_steps': serializers.IntegerField(),
                'week_avg_steps': serializers.IntegerField(),
                'week_distance': serializers.FloatField(),
                'week_calories': serializers.IntegerField(),
                'week_active_mins': serializers.IntegerField(),
                'best_day_steps': serializers.IntegerField(),
            },
        )
    }
)
@api_view(['GET'])
@permission_classes([IsAuthenticated])
def health_summary(request):
    """
    Aggregated stats for the Steps Detail screen and Home dashboard.
    """
    today = timezone.now().date()
    week_start = today - timedelta(days=6)

    week_qs = HealthRecord.objects.filter(user=request.user, date__gte=week_start)
    today_record = week_qs.filter(date=today).first()
    today_steps = today_record.steps if today_record else 0

    from apps.challenges.models import Challenge
    active = Challenge.objects.filter(
        participants__user=request.user,
        status='active'
    ).first()
    milestone = active.milestone if active else 10000

    agg = week_qs.aggregate(
        week_steps=Sum('steps'),
        avg_steps=Avg('steps'),
        total_distance=Sum('distance_km'),
        total_calories=Sum('calories_active'),
        total_active=Sum('active_minutes'),
    )

    best_day = HealthRecord.objects.filter(user=request.user).aggregate(best=Max('steps'))['best'] or 0

    return Response({
        'today_steps': today_steps,
        'today_goal': milestone,
        'remaining_today': max(0, milestone - today_steps),
        'percent_complete': min(100, round((today_steps / milestone) * 100)) if milestone else 0,
        'today_distance': today_record.distance_km if today_record else None,
        'today_calories': today_record.calories_active if today_record else None,
        'today_active_mins': today_record.active_minutes if today_record else None,
        'week_total_steps': agg['week_steps'] or 0,
        'week_avg_steps': int(agg['avg_steps'] or 0),
        'week_distance': round(agg['total_distance'], 1) if agg['total_distance'] else 0,
        'week_calories': agg['total_calories'] or 0,
        'week_active_mins': agg['total_active'] or 0,
        'best_day_steps': best_day,
    })


@extend_schema(responses={200: HealthRecordSerializer(many=True)})
@api_view(['GET'])
@permission_classes([IsAuthenticated])
def health_history(request):
    """History list filtered by period for StepsHistoryScreen."""
    period = request.query_params.get('period', '1w')
    today = timezone.now().date()

    period_map = {
        '1d': today,
        '1w': today - timedelta(days=7),
        '1m': today - timedelta(days=30),
        '3m': today - timedelta(days=90),
        '1y': today - timedelta(days=365),
    }

    qs = HealthRecord.objects.filter(user=request.user)
    if period in period_map:
        qs = qs.filter(date__gte=period_map[period])

    return Response(HealthRecordSerializer(qs, many=True).data)


@extend_schema(
    responses={
        200: inline_serializer(
            name='WeeklyStepsItem',
            fields={
                'date': serializers.DateField(),
                'steps': serializers.IntegerField(),
            },
            many=True,
        )
    }
)
@api_view(['GET'])
@permission_classes([IsAuthenticated])
@throttle_classes([DashboardReadRateThrottle])
def weekly_steps(request):
    """7-day step array for the home screen bar chart."""
    today = timezone.now().date()
    week = [today - timedelta(days=i) for i in range(6, -1, -1)]
    records = {
        r.date: r.steps
        for r in HealthRecord.objects.filter(user=request.user, date__gte=week[0])
    }
    return Response([
        {'date': str(d), 'steps': records.get(d, 0)}
        for d in week
    ])


@extend_schema(
    responses={
        200: inline_serializer(
            name='DayDetailResponse',
            fields={
                'date': serializers.CharField(),
                'total_steps': serializers.IntegerField(),
                'total_km': serializers.FloatField(),
                'total_calories': serializers.IntegerField(),
                'active_minutes': serializers.IntegerField(),
                'peak_hour': serializers.IntegerField(allow_null=True),
                'peak_steps': serializers.IntegerField(),
                'hourly': serializers.ListField(),
                'waypoints': serializers.ListField(),
                'route_distance_km': serializers.FloatField(),
                'encoded_polyline': serializers.CharField(),
                'goal': serializers.IntegerField(),
                'goal_achieved': serializers.BooleanField(),
            },
        )
    }
)
@api_view(['GET'])
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
        return Response({'error': 'Invalid date format. Use YYYY-MM-DD.'}, status=400)

    # Fetch hourly records
    hourly_qs = HourlyStepRecord.objects.filter(user=user, date=day)

    # Fetch waypoints
    waypoints_qs = LocationWaypoint.objects.filter(user=user, date=day)

    # Aggregate totals
    agg = hourly_qs.aggregate(
        total_steps=Sum('steps'),
        total_km=Sum('distance_km'),
        total_calories=Sum('calories'),
    )

    total_steps = agg['total_steps'] or 0
    total_km = round(agg['total_km'] or 0, 2)
    total_calories = round(agg['total_calories'] or 0)

    # Peak hour
    peak_record = hourly_qs.order_by('-steps').first()
    peak_hour = peak_record.hour if peak_record else None
    peak_steps = peak_record.steps if peak_record else 0

    # Active minutes = hours where steps > 0, multiplied by 60
    active_hours = hourly_qs.filter(steps__gt=0).count()
    active_minutes = active_hours * 60

    # Goal from active challenge
    from apps.challenges.models import Challenge
    active_challenge = Challenge.objects.filter(
        participants__user=user, status='active'
    ).first()
    goal = active_challenge.milestone if active_challenge else 10_000

    # Also check daily model for total (use if more accurate than hourly sum)
    daily_record = HealthRecord.objects.filter(user=user, date=day).first()
    if daily_record and daily_record.steps > total_steps:
        total_steps = daily_record.steps

    waypoint_payload = LocationWaypointSerializer(waypoints_qs, many=True).data
    route_points = [
        (float(wp['latitude']), float(wp['longitude']))
        for wp in waypoint_payload
        if wp.get('latitude') is not None and wp.get('longitude') is not None
    ]
    route_distance_km = 0.0
    if len(route_points) >= 2:
        route_distance_km = round(sum(
            _haversine_meters(route_points[idx - 1][0], route_points[idx - 1][1], route_points[idx][0], route_points[idx][1])
            for idx in range(1, len(route_points))
        ) / 1000.0, 3)

    data = {
        'date': str(day),
        'total_steps': total_steps,
        'total_km': total_km,
        'total_calories': int(total_calories),
        'active_minutes': active_minutes,
        'peak_hour': peak_hour,
        'peak_steps': peak_steps,
        'hourly': HourlyStepSerializer(hourly_qs, many=True).data,
        'waypoints': waypoint_payload,
        'route_distance_km': route_distance_km,
        'encoded_polyline': _encode_polyline(route_points),
        'goal': goal,
        'goal_achieved': total_steps >= goal,
    }
    return Response(data)


@extend_schema(
    request=inline_serializer(
        name='SyncHourlyStepsRequest',
        fields={
            'date': serializers.CharField(),
            'hourly': serializers.ListField(),
            'waypoints': serializers.ListField(required=False),
        },
    ),
    responses={200: inline_serializer(name='SyncHourlyStepsResponse', fields={'message': serializers.CharField(), 'hourly_synced': serializers.IntegerField(), 'waypoints_synced': serializers.IntegerField()})},
)
@api_view(['POST'])
@permission_classes([IsAuthenticated])
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
    date_str = request.data.get('date')
    hourly = request.data.get('hourly', [])
    waypoints = request.data.get('waypoints', [])

    try:
        day = datetime.date.fromisoformat(date_str)
    except (ValueError, TypeError):
        return Response({'error': 'Invalid date'}, status=400)

    # Upsert hourly records
    for h in hourly:
        hour = h.get('hour')
        if hour is None or not (0 <= hour <= 23):
            continue
        HourlyStepRecord.objects.update_or_create(
            user=user, date=day, hour=hour,
            defaults={
                'steps': max(0, int(h.get('steps', 0))),
                'distance_km': max(0.0, float(h.get('distance_km', 0))),
                'calories': max(0.0, float(h.get('calories', 0))),
            }
        )

    stored_waypoints = 0
    waypoint_quality = {
        'accepted': 0,
        'dropped_accuracy': 0,
        'dropped_speed': 0,
        'dropped_jitter': 0,
        'dropped_malformed': 0,
    }

    # Store waypoints with quality filtering — keeps route realistic and prevents teleport spikes.
    if waypoints:
        filtered, waypoint_quality = _filter_waypoints_for_storage(day, waypoints)
        existing_count = LocationWaypoint.objects.filter(user=user, date=day).count()
        budget = max(0, 500 - existing_count)
        for wp in filtered[:budget]:
            _, created = LocationWaypoint.objects.get_or_create(
                user=user,
                date=day,
                recorded_at=wp['recorded_at'],
                defaults={
                    'hour': wp['hour'],
                    'latitude': wp['latitude'],
                    'longitude': wp['longitude'],
                    'accuracy_m': wp['accuracy_m'],
                }
            )
            if created:
                stored_waypoints += 1

        # Route plausibility check: compare route distance against synced steps.
        route_km = _route_distance_km(filtered)
        daily_record = HealthRecord.objects.filter(user=user, date=day).first()
        if daily_record and daily_record.steps > 0 and route_km > 0:
            ratio_km_per_step = route_km / daily_record.steps
            if ratio_km_per_step < ROUTE_DISTANCE_PER_STEP_MIN_KM:
                FraudFlag.objects.create(
                    user=user,
                    date=day,
                    flag_type='route_step_mismatch_low_distance',
                    severity='high',
                    details={
                        'steps': daily_record.steps,
                        'route_km': round(route_km, 3),
                        'ratio_km_per_step': round(ratio_km_per_step, 6),
                        'min_expected_km_per_step': ROUTE_DISTANCE_PER_STEP_MIN_KM,
                        'note': 'Route distance is too short for submitted step volume.',
                    },
                )
            elif ratio_km_per_step > ROUTE_DISTANCE_PER_STEP_MAX_KM:
                FraudFlag.objects.create(
                    user=user,
                    date=day,
                    flag_type='route_step_mismatch_high_distance',
                    severity='medium',
                    details={
                        'steps': daily_record.steps,
                        'route_km': round(route_km, 3),
                        'ratio_km_per_step': round(ratio_km_per_step, 6),
                        'max_expected_km_per_step': ROUTE_DISTANCE_PER_STEP_MAX_KM,
                        'note': 'Route distance is unusually long for submitted step volume.',
                    },
                )

    return Response({
        'status': 'synced',
        'hourly_count': len(hourly),
        'waypoint_count': stored_waypoints,
        'waypoint_quality': waypoint_quality,
    })
