"""Phase 1c endpoints: Health Connect / Apple Health summaries (see health_sources.py).

POST   /api/steps/health-sources/   one day's summary from the phone (session required)
GET    /api/steps/health-sources/?days=N   the user's recent days: which apps contributed,
                                    what counted, what didn't (for "Connected sources")
DELETE /api/steps/health-sources/   "Remove imported data": deletes every stored summary
                                    and recomputes those days from our own sensor.
"""

from __future__ import annotations

import logging
from datetime import date as date_type
from datetime import timedelta

from django.db import transaction
from django.utils import timezone
from drf_spectacular.utils import extend_schema
from rest_framework import serializers, status
from rest_framework.decorators import api_view, permission_classes, throttle_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from apps.core.throttles import DashboardReadRateThrottle, StepSyncRateThrottle

from . import health_sources
from .evidence import clean_tz_offset, refresh_day
from .models import HealthRecord, HealthSourceDay, StepSession
from .security import verify_session_token

logger = logging.getLogger(__name__)

MAX_PAST_DAYS = 7
LIST_MAX_DAYS = 14


class HealthSourcesUploadSerializer(serializers.Serializer):
    session_id = serializers.UUIDField()
    session_token = serializers.CharField(max_length=255)
    date = serializers.DateField()
    tz_offset_minutes = serializers.IntegerField(
        min_value=-12 * 60, max_value=14 * 60, required=False, allow_null=True
    )
    health_sources = serializers.JSONField()


def store_upload(user, day, raw, *, platform: str, tz_offset_minutes, now=None, raise_errors=True):
    """Validate and store one day's summary (replaces that day's previous one: the
    phone always re-sends the whole day). Returns the HealthSourceDay or None."""
    now = now or timezone.now()
    try:
        if day < (now - timedelta(days=MAX_PAST_DAYS + 1)).date():
            raise health_sources.HealthSourcesError("day too old")
        cleaned = health_sources.clean_payload(
            raw, platform=platform, day=day, tz_offset_minutes=tz_offset_minutes, now=now
        )
    except health_sources.HealthSourcesError:
        if raise_errors:
            raise
        logger.info("health_sources ignored for user=%s day=%s", user.id, day)
        return None
    summary = health_sources.summarize(cleaned, health_sources.trusted_rules())
    stored, created = HealthSourceDay.objects.get_or_create(
        user=user,
        date=day,
        defaults={
            "platform": cleaned["platform"],
            "provider": cleaned["provider"],
            "data": cleaned,
            "summary": {},
            "uploads": 1,
        },
    )
    if not created:
        stored.platform = cleaned["platform"]
        stored.provider = cleaned["provider"]
        stored.data = cleaned
        stored.uploads = int(stored.uploads or 0) + 1
    # The admin timeline reads `summary` without re-running the rules.
    stored.summary = {
        "origins": summary["origins"],
        "not_counted": summary["not_counted"],
        "wearable_total": summary["wearable_total"],
        "phone_app_total": summary["phone_app_total"],
        "trusted_total": summary["trusted_total"],
        "dropped": cleaned["dropped"],
    }
    stored.save()
    return stored


def flag_disagreement(user, record) -> None:
    """Wild disagreement between a phone health app and everything else: a MEDIUM flag
    for review (payout holds' existing rules decide about money). No trust change."""
    health = (record.anticheat or {}).get("health") or {}
    from .views import _record_flag

    if health.get("wearable_review"):
        _record_flag(
            user,
            record.date,
            "health_wearable_far_above_phone",
            "medium",
            {
                "wearable_total": health.get("wearable_total"),
                "sensor_raw": health.get("sensor_raw"),
                "origins": [
                    {"label": o.get("label"), "kind": o.get("kind"), "steps": o.get("steps")}
                    for o in (health.get("origins") or [])[:6]
                ],
                "note": "Watch / band steps far above the phone's own count (credited; "
                "a phone left at home is common). Review before large payouts.",
            },
        )
    if not health.get("disagreement"):
        return

    _record_flag(
        user,
        record.date,
        "health_sources_disagree",
        "medium",
        {
            "trusted_total": health.get("trusted_total"),
            "wearable_total": health.get("wearable_total"),
            "sensor_raw": health.get("sensor_raw"),
            "withheld": health.get("withheld"),
            "origins": [
                {"label": o.get("label"), "kind": o.get("kind"), "steps": o.get("steps")}
                for o in (health.get("origins") or [])[:6]
            ],
            "note": "A phone health app reported far more steps than the phone's own "
            "counter or any wearable. The excess was not credited.",
        },
    )


def _apply_to_day(user, day, *, platform: str, now) -> HealthRecord:
    """Refresh the day with the stored summary (creating the day if the phone hasn't
    synced it yet, e.g. a watch-only day), then flag / recompute / XP."""
    from .anti_cheat import ANTICHEAT_DAY_VERSION
    from .daily_reset import update_streak
    from .views import recompute_challenge_progress

    with transaction.atomic():
        record = HealthRecord.objects.select_for_update().filter(user=user, date=day).first()
        if record is None:
            record = HealthRecord.objects.create(
                user=user,
                date=day,
                source="apple_health" if platform == "ios" else "google_fit",
                steps=0,
                anticheat={
                    "v": ANTICHEAT_DAY_VERSION,
                    "created_by": "health_sources",
                    "p1b": {"since": now.isoformat(), "grandfathered": 0},
                    "platform": platform,
                },
            )
        elif "p1b" not in (record.anticheat or {}):
            meta = dict(record.anticheat or {})
            # Same cut-over rule as the step sync: credit the day already had stays.
            meta["p1b"] = {"since": now.isoformat(), "grandfathered": int(record.steps or 0)}
            record.anticheat = meta
        previous_eligible = record.eligible_steps
        previous_steps = record.steps
        refresh_day(record)
        flag_disagreement(user, record)
    if previous_eligible != record.eligible_steps or previous_steps != record.steps:
        recompute_challenge_progress(user, day, record)
    if record.steps != previous_steps:
        if record.steps > int(getattr(user, "best_day_steps", 0) or 0):
            type(user).objects.filter(id=user.id).update(best_day_steps=record.steps)
        if not record.is_suspicious:
            try:
                from apps.gamification.tasks import award_daily_step_xp

                award_daily_step_xp(user, day, record.steps)
            except Exception:  # noqa: BLE001
                logger.exception("Step XP award failed for user=%s date=%s", user.id, day)
        try:
            update_streak(user)
        except Exception:  # noqa: BLE001
            logger.exception("Streak update failed for user=%s", user.id)
    return record


def _day_view(stored: HealthSourceDay, record: HealthRecord | None) -> dict:
    health = ((record.anticheat or {}).get("health") if record else None) or {}
    return {
        "date": str(stored.date),
        "provider": stored.provider,
        "read_at": (stored.data or {}).get("read_at"),
        "received_at": stored.updated_at.isoformat() if stored.updated_at else None,
        "origins": [
            {k: o.get(k) for k in ("label", "trust", "kind", "steps", "counted_steps")}
            for o in (stored.summary or {}).get("origins") or []
        ],
        "not_counted": (stored.summary or {}).get("not_counted") or {"manual": 0, "untrusted": 0},
        "counted_extra_steps": int(health.get("applied_extra", 0) or 0),
        "wearable_steps": int(record.tier_wearable or 0) if record else 0,
        "corroborated_steps": int(health.get("corroborated", 0) or 0),
        "workouts": health.get("workouts") or [],
        "under_review": bool(health.get("disagreement")),
    }


@extend_schema(request=HealthSourcesUploadSerializer, responses={200: dict})
@api_view(["GET", "POST", "DELETE"])
@permission_classes([IsAuthenticated])
@throttle_classes([StepSyncRateThrottle])
def health_sources_view(request):
    """Health Connect / Apple Health summaries (Phase 1c). See the module docstring."""
    user = request.user
    now = timezone.now()

    if request.method == "GET":
        try:
            days = max(1, min(LIST_MAX_DAYS, int(request.query_params.get("days", 7))))
        except (TypeError, ValueError):
            return Response({"error": "days must be a number."}, status=400)
        since = now.date() - timedelta(days=days)
        stored = list(HealthSourceDay.objects.filter(user=user, date__gte=since).order_by("-date"))
        records = {
            r.date: r
            for r in HealthRecord.objects.filter(user=user, date__in=[s.date for s in stored])
        }
        return Response({"days": [_day_view(s, records.get(s.date)) for s in stored]})

    if request.method == "DELETE":
        dates = list(HealthSourceDay.objects.filter(user=user).values_list("date", flat=True))
        deleted = HealthSourceDay.objects.filter(user=user).delete()[0]
        from .views import recompute_challenge_progress

        for day in dates:
            with transaction.atomic():
                record = HealthRecord.objects.select_for_update().filter(user=user, date=day).first()
                if record is None or not (record.anticheat or {}).get("health"):
                    continue
                previous_eligible = record.eligible_steps
                refresh_day(record)
            if previous_eligible != record.eligible_steps:
                recompute_challenge_progress(user, day, record)
        return Response({"deleted_days": deleted})

    serializer = HealthSourcesUploadSerializer(data=request.data)
    if not serializer.is_valid():
        return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)
    data = serializer.validated_data
    session = (
        StepSession.objects.select_related("device")
        .filter(id=data["session_id"], user=user)
        .first()
    )
    if session is None or not verify_session_token(data["session_token"], session.session_token_hash):
        return Response(
            {"detail": "Step session required.", "code": "SESSION_REQUIRED"},
            status=status.HTTP_403_FORBIDDEN,
        )
    if session.status != "active" or session.expires_at <= now:
        return Response(
            {"detail": "Step session expired.", "code": "SESSION_EXPIRED"},
            status=status.HTTP_403_FORBIDDEN,
        )
    # The platform comes from what the server registered, never from the payload.
    platform = (
        (session.device.platform if session.device else "") or (user.device_platform or "")
    ).lower()
    tz_offset = clean_tz_offset(data.get("tz_offset_minutes"))
    if tz_offset is None:
        tz_offset = session.tz_offset_minutes
    day: date_type = data["date"]
    try:
        stored = store_upload(
            user, day, data["health_sources"], platform=platform, tz_offset_minutes=tz_offset, now=now
        )
    except health_sources.HealthSourcesError as exc:
        return Response({"error": str(exc), "code": "HEALTH_SOURCES_INVALID"}, status=400)
    record = _apply_to_day(user, day, platform=platform, now=now)
    return Response(
        {
            "day": _day_view(stored, record),
            "verification": record.verification,
        }
    )
