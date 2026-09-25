"""Admin realtime support endpoints."""

from datetime import timedelta

from django.contrib.auth import get_user_model
from django.utils import timezone
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import extend_schema
from rest_framework import permissions
from rest_framework.decorators import api_view, permission_classes
from rest_framework.response import Response

from apps.core.realtime import hub


class IsStaff(permissions.BasePermission):
    def has_permission(self, request, view):
        user = request.user
        return bool(user and user.is_authenticated and user.is_active and user.is_staff)


def _count(fn):
    """Run a count; None if the model/field is unavailable (another app changed it)."""
    try:
        return fn()
    except Exception:  # noqa: BLE001
        return None


@extend_schema(responses={200: OpenApiTypes.OBJECT}, tags=["admin-realtime"])
@api_view(["GET"])
@permission_classes([permissions.IsAuthenticated, IsStaff])
def realtime_pulse(request):
    """
    Live activity counters for the dashboard, refetched when step/user events arrive.
    Four indexed COUNT queries; cheap enough to call every few seconds.
    """
    from apps.steps.models import HealthRecord, StepSyncEvent
    from apps.users.models import DeviceSession

    now = timezone.now()
    hour_ago = now - timedelta(hours=1)
    day_ago = now - timedelta(hours=24)
    User = get_user_model()
    return Response(
        {
            "generated_at": now.isoformat(),
            "step_syncs_last_hour": _count(
                lambda: StepSyncEvent.objects.filter(created_at__gte=hour_ago).count()
            ),
            "users_synced_last_hour": _count(
                lambda: HealthRecord.objects.filter(synced_at__gte=hour_ago).values("user_id").distinct().count()
            ),
            "signups_last_24h": _count(lambda: User.objects.filter(date_joined__gte=day_ago).count()),
            "logins_last_hour": _count(lambda: DeviceSession.objects.filter(created_at__gte=hour_ago).count()),
            "realtime": {
                "layer": hub.snapshot()["layer"],
                "admins_connected": hub.connections,
            },
        }
    )


@extend_schema(responses={200: OpenApiTypes.OBJECT}, tags=["admin-realtime"])
@api_view(["GET"])
@permission_classes([permissions.IsAuthenticated, IsStaff])
def realtime_status(request):
    """Hub counters for this process (diagnostics / load tests)."""
    return Response(hub.snapshot())
