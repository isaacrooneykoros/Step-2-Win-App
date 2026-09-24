"""
Runtime enforcement of the admin-editable SystemSettings.

- current_settings(): cached singleton read (one cache hit per request; the
  cache is cleared by SystemSettings.save(), and expires after a short TTL so
  other processes pick up changes even with a per-process cache).
- feature_block(): the consistent "feature switched off" response used by the
  customer endpoints that each switch controls.
- minimum_withdrawal_kes(): stored minimum, never below the server floor.
- app_config: public config for the customer app (GET /api/app/config/).
- MaintenanceModeMiddleware: 503 for customer API routes while maintenance is
  on. Admin API, staff sign-in, health checks and payment gateway callbacks
  always pass, so the console keeps working and money keeps reconciling.
"""

from __future__ import annotations

import logging
from decimal import Decimal

from django.conf import settings as django_settings
from django.core.cache import cache
from django.http import JsonResponse
from rest_framework import status
from rest_framework.decorators import (api_view, authentication_classes,
                                       permission_classes, throttle_classes)
from rest_framework.permissions import AllowAny
from rest_framework.response import Response

from apps.admin_api.models import SETTINGS_CACHE_KEY, SystemSettings

logger = logging.getLogger(__name__)

CACHE_TTL_SECONDS = 15

# feature -> (SystemSettings field, message shown to the customer)
FEATURES = {
    "registrations": (
        "registrations_enabled",
        "New sign-ups are paused for a short while. Please try again later.",
    ),
    "challenges": (
        "challenges_enabled",
        "Creating new challenges is paused for a short while. Your current challenges are not affected.",
    ),
    "withdrawals": (
        "withdrawals_enabled",
        "Withdrawals are paused for a short while. Your balance is safe; please try again later.",
    ),
    "referrals": (
        "referral_program_enabled",
        "The referral programme is not available right now.",
    ),
}

DEFAULT_MAINTENANCE_MESSAGE = (
    "Step2Win is getting a quick upgrade. We'll be right back."
)


def current_settings() -> SystemSettings:
    obj = cache.get(SETTINGS_CACHE_KEY)
    if obj is None:
        obj = SystemSettings.load()
        cache.set(SETTINGS_CACHE_KEY, obj, CACHE_TTL_SECONDS)
    return obj


def feature_enabled(feature: str) -> bool:
    field, _ = FEATURES[feature]
    return bool(getattr(current_settings(), field, True))


def feature_disabled_payload(feature: str) -> dict:
    _, message = FEATURES[feature]
    return {"error": message, "code": "feature_disabled", "feature": feature}


def feature_block(feature: str) -> Response | None:
    """Return a 403 response when the feature is switched off, else None."""
    if feature_enabled(feature):
        return None
    return Response(feature_disabled_payload(feature), status=status.HTTP_403_FORBIDDEN)


def minimum_withdrawal_kes() -> Decimal:
    stored = Decimal(str(current_settings().minimum_withdrawal_amount or 0))
    floor = Decimal(str(getattr(django_settings, "MIN_WITHDRAWAL_KES", 0) or 0))
    return max(stored, floor)


def maintenance_message(s: SystemSettings | None = None) -> str:
    s = s or current_settings()
    return (s.maintenance_message or "").strip() or DEFAULT_MAINTENANCE_MESSAGE


@api_view(["GET"])
@authentication_classes([])
@permission_classes([AllowAny])
@throttle_classes([])
def app_config(request):
    """Public runtime config for the customer app. Always reachable."""
    s = current_settings()
    return Response(
        {
            "maintenance": {
                "enabled": bool(s.maintenance_mode),
                "message": maintenance_message(s) if s.maintenance_mode else "",
            },
            "features": {name: bool(getattr(s, field)) for name, (field, _) in FEATURES.items()},
            "withdrawals": {
                "minimum_kes": str(minimum_withdrawal_kes()),
                "maximum_kes": str(getattr(django_settings, "MAX_WITHDRAWAL_KES", "")),
                "processing_hours": s.withdrawal_processing_time,
            },
            "support_email": s.support_email,
            # Lets the app hide a sign-in button the server can't verify yet.
            "auth_providers": {
                "google": bool(getattr(django_settings, "GOOGLE_OAUTH_CLIENT_IDS", None)),
                "apple": bool(getattr(django_settings, "APPLE_CLIENT_IDS", None)),
            },
        }
    )


# Paths that keep working during maintenance. Prefix match on request.path.
MAINTENANCE_ALLOWED_PREFIXES = (
    "/api/admin/",  # admin console (incl. /api/admin/auth/login/)
    "/api/legal/admin/",  # admin content editor
    "/api/auth/refresh/",  # staff token refresh
    "/api/auth/logout/",
    "/api/health/",
    "/api/app/config/",  # lets the customer app learn when maintenance ends
    "/api/payments/mpesa/",  # IntaSend deposit / payout / withdrawal callbacks
)


def _is_staff_bearer(request) -> bool:
    """True when the request carries a valid JWT for a staff account."""
    header = request.META.get("HTTP_AUTHORIZATION", "")
    if not header.lower().startswith("bearer "):
        return False
    try:
        from rest_framework_simplejwt.authentication import JWTAuthentication

        auth = JWTAuthentication()
        validated = auth.get_validated_token(header.split(" ", 1)[1].strip())
        user = auth.get_user(validated)
        return bool(user and user.is_active and user.is_staff)
    except Exception:
        return False


class MaintenanceModeMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        path = request.path
        if path.startswith("/api/") and not path.startswith(MAINTENANCE_ALLOWED_PREFIXES):
            try:
                s = current_settings()
                on = bool(s.maintenance_mode)
            except Exception:  # settings table unavailable: never lock everyone out
                logger.exception("Could not read maintenance mode")
                on = False
            if on and request.method != "OPTIONS" and not _is_staff_bearer(request):
                response = JsonResponse(
                    {
                        "error": maintenance_message(s),
                        "code": "maintenance",
                        "maintenance": True,
                    },
                    status=503,
                )
                response["Retry-After"] = "120"
                return response
        return self.get_response(request)
