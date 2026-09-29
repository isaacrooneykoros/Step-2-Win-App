"""Walk session endpoints ("Start a walk", Phase 1b). Logic lives in walks.py."""

from __future__ import annotations

import logging
import uuid
from datetime import timedelta

from django.db import transaction
from django.utils import timezone
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import extend_schema
from rest_framework import status
from rest_framework.decorators import api_view, permission_classes, throttle_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from apps.core.throttles import DashboardReadRateThrottle, StepWalkRateThrottle

from . import integrity, walks
from .evidence import clean_tz_offset
from .models import DeviceRegistration, WalkPrivacyZone, WalkSession

logger = logging.getLogger(__name__)

STEP_SOURCES = ("step_counter", "accelerometer", "cmpedometer")
PLATFORMS = ("android", "ios", "web")


def _zone(user):
    return WalkPrivacyZone.objects.filter(user=user).first()


def _own_walk(request, walk_id):
    try:
        walk_uuid = uuid.UUID(str(walk_id))
    except ValueError:
        return None
    return WalkSession.objects.filter(id=walk_uuid, user=request.user).first()


def _not_found():
    return Response({"error": "Walk not found."}, status=status.HTTP_404_NOT_FOUND)


@extend_schema(request=OpenApiTypes.OBJECT, responses={201: OpenApiTypes.OBJECT})
@api_view(["POST"])
@permission_classes([IsAuthenticated])
@throttle_classes([StepWalkRateThrottle])
def start_walk(request):
    data = request.data if isinstance(request.data, dict) else {}
    now = timezone.now()
    started_at = walks._parse_time(data.get("started_at")) or now
    # The phone clock may be off: never earlier than 10 min ago or later than now.
    started_at = min(max(started_at, now - timedelta(minutes=10)), now)
    offset = clean_tz_offset(data.get("tz_offset_minutes"))
    # Platform from what the server knows (the bound device), not the client's claim:
    # it decides which checks apply (gait, integrity).
    device = None
    if request.user.device_id:
        device = DeviceRegistration.objects.filter(
            user=request.user, device_id=request.user.device_id
        ).first()
    platform = ((device.platform if device else "") or request.user.device_platform or "").lower()
    if platform not in PLATFORMS:
        claimed = str(data.get("platform") or "").lower()
        platform = claimed if claimed in PLATFORMS else ""
    step_source = str(data.get("step_source") or "")
    if platform == "android":
        step_source = step_source if step_source in ("step_counter", "accelerometer") else "step_counter"
    elif platform == "ios":
        step_source = "cmpedometer"
    else:
        step_source = step_source if step_source in STEP_SOURCES else ""
    client_walk_id = str(data.get("client_walk_id") or "")[:64]

    with transaction.atomic():
        if client_walk_id:
            existing = WalkSession.objects.filter(
                user=request.user, client_walk_id=client_walk_id
            ).first()
            if existing is not None:
                # Idempotent retry of the same start.
                body = walks.walk_summary(existing, zone=_zone(request.user))
                body.update(
                    {
                        "integrity_nonce": existing.integrity_nonce,
                        "integrity_requested": platform == "android"
                        and integrity.verifier_configured(),
                    }
                )
                return Response(body, status=status.HTTP_200_OK)
        # One active walk per user: an older one left open (app killed) is abandoned.
        WalkSession.objects.filter(user=request.user, status="active").update(
            status="abandoned", updated_at=now
        )
        walk = WalkSession.objects.create(
            user=request.user,
            device=device,
            client_walk_id=client_walk_id,
            platform=platform,
            install_id=str(data.get("install_id") or "")[:64],
            started_at=started_at,
            local_date=walks.local_date_for(started_at, offset),
            tz_offset_minutes=offset,
            step_source=step_source,
            integrity_nonce=integrity.new_nonce(),
            integrity_status="unchecked" if integrity.verifier_configured() else "unavailable",
        )
    body = walks.walk_summary(walk)
    body.update(
        {
            "integrity_nonce": walk.integrity_nonce,
            "integrity_requested": platform == "android" and integrity.verifier_configured(),
        }
    )
    return Response(body, status=status.HTTP_201_CREATED)


@extend_schema(request=OpenApiTypes.OBJECT, responses={200: OpenApiTypes.OBJECT})
@api_view(["POST"])
@permission_classes([IsAuthenticated])
@throttle_classes([StepWalkRateThrottle])
def walk_points(request, walk_id):
    data = request.data if isinstance(request.data, dict) else {}
    with transaction.atomic():
        walk = _own_walk(request, walk_id)
        if walk is None:
            return _not_found()
        walk = WalkSession.objects.select_for_update().get(pk=walk.pk)
        if walk.status != "active":
            return Response(
                {"error": "This walk has already ended.", "status": walk.status},
                status=status.HTTP_409_CONFLICT,
            )
        raw = data.get("points") or []
        if isinstance(raw, list) and len(raw) > walks.MAX_POINTS_PER_CALL:
            return Response({"error": "Too many points."}, status=413)
        walks.apply_counters(walk, data)
        walks.add_points(walk, raw)
        offset = walk.tz_offset_minutes if walk.tz_offset_minutes is not None else walks.DEFAULT_OFFSET_MINUTES
        metrics = walks.route_metrics(walk.raw_points or [], tz_offset_minutes=offset)
        walk.distance_m = round(metrics["distance_m"], 1)
        walk.duration_s = int((timezone.now() - walk.started_at).total_seconds())
        walk.save()
    return Response(
        {
            "points_count": walk.points_count,
            "distance_m": walk.distance_m,
            "duration_s": walk.duration_s,
        }
    )


@extend_schema(request=OpenApiTypes.OBJECT, responses={200: OpenApiTypes.OBJECT})
@api_view(["POST"])
@permission_classes([IsAuthenticated])
@throttle_classes([StepWalkRateThrottle])
def finish_walk(request, walk_id):
    data = request.data if isinstance(request.data, dict) else {}
    raw = data.get("points") or []
    if isinstance(raw, list) and len(raw) > walks.MAX_POINTS_PER_CALL:
        return Response({"error": "Too many points."}, status=413)
    with transaction.atomic():
        walk = _own_walk(request, walk_id)
        if walk is None:
            return _not_found()
        walk = WalkSession.objects.select_for_update().get(pk=walk.pk)
        if walk.status == "finished":
            return Response(walks.walk_summary(walk, zone=_zone(request.user)))
        # An abandoned walk (a newer one started) can still be finished by its phone.
        walks.finish_walk(walk, data)
    return Response(walks.walk_summary(walk, zone=_zone(request.user)))


@extend_schema(request=OpenApiTypes.OBJECT, responses={200: OpenApiTypes.OBJECT})
@api_view(["POST"])
@permission_classes([IsAuthenticated])
@throttle_classes([StepWalkRateThrottle])
def walk_integrity(request, walk_id):
    walk = _own_walk(request, walk_id)
    if walk is None:
        return _not_found()
    token = str((request.data or {}).get("integrity_token") or "")
    if not token:
        return Response({"error": "integrity_token is required."}, status=400)
    status_value = integrity.record_integrity(walk, token, nonce_field="integrity_nonce")
    if walk.status == "finished":
        # A late verdict re-decides the walk (and the day's tiers).
        walks.finish_walk(walk, {"ended_at": walk.ended_at.isoformat() if walk.ended_at else None})
    return Response({"integrity_status": status_value})


@extend_schema(responses={200: OpenApiTypes.OBJECT})
@api_view(["GET"])
@permission_classes([IsAuthenticated])
@throttle_classes([DashboardReadRateThrottle])
def list_walks(request):
    try:
        limit = max(1, min(50, int(request.query_params.get("limit", 20))))
    except (TypeError, ValueError):
        limit = 20
    zone = _zone(request.user)
    qs = WalkSession.objects.filter(user=request.user).order_by("-started_at")[:limit]
    return Response({"walks": [walks.walk_summary(w, zone=zone) for w in qs]})


@extend_schema(responses={200: OpenApiTypes.OBJECT})
@api_view(["GET"])
@permission_classes([IsAuthenticated])
@throttle_classes([DashboardReadRateThrottle])
def walk_detail(request, walk_id):
    walk = _own_walk(request, walk_id)
    if walk is None:
        return _not_found()
    return Response(walks.walk_summary(walk, zone=_zone(request.user)))


@extend_schema(request=OpenApiTypes.OBJECT, responses={200: OpenApiTypes.OBJECT})
@api_view(["GET", "PUT", "DELETE"])
@permission_classes([IsAuthenticated])
@throttle_classes([DashboardReadRateThrottle])
def privacy_zone(request):
    if request.method == "GET":
        zone = _zone(request.user)
        return Response(
            {"enabled": zone is not None, "radius_m": zone.radius_m if zone else None}
        )
    if request.method == "DELETE":
        WalkPrivacyZone.objects.filter(user=request.user).delete()
        return Response(status=status.HTTP_204_NO_CONTENT)
    data = request.data if isinstance(request.data, dict) else {}
    try:
        lat = float(data.get("latitude"))
        lng = float(data.get("longitude"))
    except (TypeError, ValueError):
        return Response({"error": "latitude and longitude are required."}, status=400)
    if not (-90 <= lat <= 90 and -180 <= lng <= 180):
        return Response({"error": "Invalid coordinates."}, status=400)
    try:
        radius = int(data.get("radius_m") or 300)
    except (TypeError, ValueError):
        return Response({"error": "radius_m must be a number."}, status=400)
    if not 100 <= radius <= 1000:
        return Response({"error": "radius_m must be between 100 and 1000."}, status=400)
    # Only salted cell hashes are stored: the coordinates are not kept.
    zone = walks.set_privacy_zone(request.user, lat, lng, radius)
    return Response({"enabled": True, "radius_m": zone.radius_m})
