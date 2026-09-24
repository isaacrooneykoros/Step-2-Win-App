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
    # referral_program_enabled is deliberately NOT a feature here: there is no
    # referral programme yet, so the switch is hidden from the admin console and
    # the app. The DB column is kept (dropping it would need a destructive
    # migration); wire it back in here when a referral feature ships.
}

# Challenge entry fee range (whole shillings). Used when the stored settings are
# missing or unusable; the server cap mirrors Challenge.entry_fee's validator.
ENTRY_FEE_DEFAULT_MIN = 50
ENTRY_FEE_DEFAULT_MAX = 10000
ENTRY_FEE_SERVER_CAP = 10000
ENTRY_FEE_SUGGESTIONS = [100, 250, 500, 1000, 2000]
_NICE_FEES = [10, 20, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000]

# Challenge size bounds; the upper one mirrors Challenge.max_participants' validator.
PARTICIPANTS_FLOOR = 2
PARTICIPANTS_SERVER_CAP = 1000

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


def entry_fee_range() -> tuple[int, int]:
    """(min, max) whole-shilling entry fee for new challenges."""
    import math

    s = current_settings()
    try:
        lo = math.ceil(Decimal(str(s.min_challenge_entry_fee)))
        hi = math.floor(Decimal(str(s.max_challenge_entry_fee)))
    except Exception:
        return ENTRY_FEE_DEFAULT_MIN, ENTRY_FEE_DEFAULT_MAX
    lo = max(1, lo)
    hi = min(ENTRY_FEE_SERVER_CAP, hi)
    if lo >= hi:
        return ENTRY_FEE_DEFAULT_MIN, ENTRY_FEE_DEFAULT_MAX
    return lo, hi


def entry_fee_suggestions(lo: int, hi: int) -> list[int]:
    """Quick-pick amounts inside [lo, hi]: the usual ladder, or a spread of round numbers."""
    picks = [v for v in ENTRY_FEE_SUGGESTIONS if lo <= v <= hi]
    if len(picks) >= 3:
        return picks
    pool = sorted({lo, hi, *(v for v in _NICE_FEES if lo < v < hi)})
    if len(pool) <= 5:
        return pool
    return [pool[i] for i in sorted({round(i * (len(pool) - 1) / 4) for i in range(5)})]


def max_challenge_participants() -> int:
    stored = int(current_settings().max_challenge_participants or PARTICIPANTS_SERVER_CAP)
    return min(PARTICIPANTS_SERVER_CAP, max(PARTICIPANTS_FLOOR, stored))


def challenge_needs_approval(is_public: bool) -> bool:
    """New public challenges wait in the admin approval queue when the switch is on.

    Private (invite-only) challenges never need approval: they are not listed in
    the public lobby, only people with the code can join.
    """
    return bool(is_public) and bool(current_settings().challenge_approval_required)


def xp_rates() -> tuple[Decimal, int]:
    """(XP per accepted step, bonus XP for reaching the daily step goal)."""
    s = current_settings()
    per_step = max(Decimal("0"), Decimal(str(s.xp_per_step or 0)))
    return per_step, max(0, int(s.daily_goal_bonus_xp or 0))


def withdrawal_processing_hours() -> int:
    return max(1, int(current_settings().withdrawal_processing_time or 24))


def withdrawal_review_phrase() -> str:
    """'within 24 hours' / 'within 2 days' for customer-facing copy."""
    hours = withdrawal_processing_hours()
    if hours % 24 == 0 and hours >= 48:
        return f"within {hours // 24} days"
    return f"within {hours} hour{'s' if hours != 1 else ''}"


def notifications_email_enabled() -> bool:
    """Master switch for operational notification emails (admin alerts etc.).

    Every notification send should check this. Emails a customer explicitly asks
    for (e.g. a password reset link) are not notifications and must not be gated.
    """
    try:
        return bool(current_settings().email_notifications_enabled)
    except Exception:  # settings table unavailable: keep alerts flowing
        logger.exception("Could not read email_notifications_enabled")
        return True


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
                "processing_hours": withdrawal_processing_hours(),
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
    "/api/auth/account/",  # account deletion must work even during maintenance
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
