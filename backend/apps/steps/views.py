from datetime import timedelta
import logging

import redis as redis_client
from django.conf import settings
from django.db import transaction
from django.db.models import Avg, Max, Sum
from django.utils import timezone
from django_ratelimit.decorators import ratelimit
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework import serializers
from drf_spectacular.utils import extend_schema, inline_serializer
from channels.layers import get_channel_layer
from asgiref.sync import async_to_sync

from .anti_cheat import DAILY_STEP_CAP, run_anti_cheat
from .models import FraudFlag, HealthRecord, SuspiciousActivity, TrustScore, HourlyStepRecord, LocationWaypoint
from .serializers import HealthRecordSerializer, HealthSyncSerializer, HourlyStepSerializer, LocationWaypointSerializer

logger = logging.getLogger(__name__)


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
    if _redis is None:
        return True

    redis_key = f"step2win:sync_tick:{user_id}"
    try:
        return _redis.set(redis_key, '1', nx=True, ex=max(1, min_seconds)) is not None
    except Exception:
        return True


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

    result = run_anti_cheat(
        user=user,
        steps=submitted_steps,
        date=date,
        distance_km=data.get('distance_km'),
        calories=data.get('calories_active'),
        active_minutes=data.get('active_minutes'),
        submitted_at=now,
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
    if trust.status == 'RESTRICT':
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

    record, _ = HealthRecord.objects.update_or_create(
        user=user,
        date=date,
        defaults={
            'source': data.get('source', 'google_fit'),
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

    from apps.challenges.models import Challenge, Participant
    from apps.challenges.services import finalize_expired_challenges

    finalize_expired_challenges(today=date)

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

        # ── Update tiebreaker tracking fields ─────────────────────────────────
        try:
            participant = Participant.objects.get(challenge=challenge, user=user)

            # 1. Set milestone_reached_at if just crossed threshold
            milestone_just_reached = False
            if (participant.milestone_reached_at is None
                    and participant.steps >= challenge.milestone):
                participant.milestone_reached_at = timezone.now()
                milestone_just_reached = True

            # 2. Update best_day_steps
            if record.steps > participant.best_day_steps:
                participant.best_day_steps = record.steps

            # 3. GPS percentage — placeholder for future GPS implementation
            # When GPS data is available, update gps_step_percentage here
            # For now, it defaults to 0

            participant.save(update_fields=[
                'milestone_reached_at',
                'best_day_steps',
            ])

            # Push celebration system message to group chat (private challenges only)
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

    return Response(payload)


@extend_schema(responses={200: HealthRecordSerializer})
@api_view(['GET'])
@permission_classes([IsAuthenticated])
def today_health(request):
    """Today's steps + distance + calories + active minutes."""
    today = timezone.now().date()
    record = HealthRecord.objects.filter(user=request.user, date=today).first()

    if record:
        return Response(HealthRecordSerializer(record).data)

    return Response({
        'date': str(today),
        'steps': 0,
        'distance_km': None,
        'calories_active': None,
        'active_minutes': None,
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

    data = {
        'date': str(day),
        'total_steps': total_steps,
        'total_km': total_km,
        'total_calories': int(total_calories),
        'active_minutes': active_minutes,
        'peak_hour': peak_hour,
        'peak_steps': peak_steps,
        'hourly': HourlyStepSerializer(hourly_qs, many=True).data,
        'waypoints': LocationWaypointSerializer(waypoints_qs, many=True).data,
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

    # Store waypoints — only keep last 500 per day to manage storage
    if waypoints:
        existing_count = LocationWaypoint.objects.filter(user=user, date=day).count()
        for wp in waypoints[:max(0, 500 - existing_count)]:
            try:
                LocationWaypoint.objects.get_or_create(
                    user=user,
                    date=day,
                    recorded_at=wp['recorded_at'],
                    defaults={
                        'hour': wp.get('hour', 0),
                        'latitude': float(wp['latitude']),
                        'longitude': float(wp['longitude']),
                        'accuracy_m': float(wp.get('accuracy_m', 0)),
                    }
                )
            except (KeyError, ValueError):
                continue

    return Response({'status': 'synced', 'hourly_count': len(hourly),
                     'waypoint_count': len(waypoints)})
