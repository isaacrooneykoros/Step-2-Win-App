from django.core.cache import cache
from django.db import connection
from django.utils import timezone
from drf_spectacular.utils import extend_schema, inline_serializer
from rest_framework import serializers
from rest_framework.decorators import (api_view, permission_classes,
                                       throttle_classes)
from rest_framework.permissions import AllowAny
from rest_framework.response import Response


@extend_schema(
    responses={
        200: inline_serializer(
            name="HealthCheckResponse",
            fields={
                "status": serializers.CharField(),
                "service": serializers.CharField(),
                "timestamp": serializers.DateTimeField(),
            },
        )
    }
)
@api_view(["GET"])
@permission_classes([AllowAny])
@throttle_classes([])
def health_check(request):
    """Readiness endpoint for uptime checks and CI smoke tests.

    ``?deep=1`` also opens the database connection and touches the cache, so the
    app's warm-up ping (sent during splash/onboarding) leaves the whole stack
    ready before the user signs in. Failures are reported, never raised.
    """
    payload = {
        "status": "ok",
        "service": "step2win-backend",
        "timestamp": timezone.now().isoformat(),
    }
    if request.query_params.get("deep") == "1":
        payload["checks"] = {"database": _check_database(), "cache": _check_cache()}
    return Response(payload)


def _check_database() -> str:
    try:
        with connection.cursor() as cursor:
            cursor.execute("SELECT 1")
            cursor.fetchone()
        return "ok"
    except Exception:  # noqa: BLE001 - reported to the caller, not raised
        return "error"


def _check_cache() -> str:
    try:
        cache.get("health:warmup")
        return "ok"
    except Exception:  # noqa: BLE001
        return "error"
