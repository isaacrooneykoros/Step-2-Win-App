"""
Custom throttle classes for Step2Win.
Each sensitive endpoint gets its own named rate limit.
Rates are registered in settings.py REST_FRAMEWORK.DEFAULT_THROTTLE_RATES.
"""

import hashlib
import math
import random
import time

from rest_framework.throttling import (AnonRateThrottle, BaseThrottle,
                                       SimpleRateThrottle, UserRateThrottle)


class LoginRateThrottle(AnonRateThrottle):
    """5 login attempts per minute per IP — works alongside django-axes lockout."""

    scope = "login"


class RegisterRateThrottle(AnonRateThrottle):
    """3 registrations per minute per IP — prevents bulk fake account creation."""

    scope = "register"


class DepositRateThrottle(UserRateThrottle):
    """5 deposit initiations per minute per user — prevents accidental duplicates."""

    scope = "deposit"


class WithdrawalRateThrottle(UserRateThrottle):
    """3 withdrawal requests per minute per user."""

    scope = "withdrawal"


class PasswordResetRateThrottle(AnonRateThrottle):
    """Password reset code requests per IP — prevents email flooding."""

    scope = "password_reset"


class PasswordResetIdentifierRateThrottle(SimpleRateThrottle):
    """
    Password reset code requests per *identifier* (email / username / phone), whoever asks.
    Keyed by a hash of the normalised identifier so no address ends up in the cache keys.
    Applies equally to unknown identifiers, so a 429 reveals nothing about accounts.
    """

    scope = "password_reset_identifier"

    def get_cache_key(self, request, view):
        identifier = str(request.data.get("identifier") or "").strip().lower()
        if not identifier:
            return None
        digest = hashlib.sha256(identifier.encode("utf-8")).hexdigest()[:32]
        return self.cache_format % {"scope": self.scope, "ident": digest}


class PasswordResetVerifyRateThrottle(AnonRateThrottle):
    """Code verification attempts per IP (each code also locks after 5 wrong tries)."""

    scope = "password_reset_verify"


class PasswordResetConfirmRateThrottle(AnonRateThrottle):
    """New-password submissions per IP."""

    scope = "password_reset_confirm"


class _DefaultRateMixin:
    """
    Use the rate from settings.DEFAULT_THROTTLE_RATES when present, else `default_rate`.
    New sync scopes therefore work without a settings change, and ops can still tune
    them from settings.
    """

    default_rate: str | None = None

    def get_rate(self):
        rates = getattr(self, "THROTTLE_RATES", {}) or {}
        return rates.get(self.scope) or self.default_rate


class _JitteredWaitMixin:
    """
    Adds a random spread to Retry-After so that phones throttled in the same second do
    not all come back in the same second (thundering herd).
    """

    wait_jitter_fraction = 0.3

    def wait(self):
        base = super().wait()
        if base is None:
            return None
        return math.ceil(base * (1 + random.uniform(0, self.wait_jitter_fraction)))


class StepSyncRateThrottle(_DefaultRateMixin, _JitteredWaitMixin, UserRateThrottle):
    """
    Burst limit on daily step syncs per user (settings `step_sync`, 10/minute).
    The app syncs at most about once a minute while walking with the app open and
    every 15+ minutes in the background; a 7-day catch-up is paced to stay under this.
    """

    scope = "step_sync"
    default_rate = "10/minute"


class StepSyncSustainedThrottle(_DefaultRateMixin, _JitteredWaitMixin, UserRateThrottle):
    """Sustained per-user ceiling for daily step syncs (normal use is < 100/hour)."""

    scope = "step_sync_sustained"
    default_rate = "600/hour"


class StepHourlySyncRateThrottle(_DefaultRateMixin, _JitteredWaitMixin, UserRateThrottle):
    """Burst limit for hourly-bucket / route uploads per user."""

    scope = "step_sync_hourly"
    default_rate = "10/minute"


class StepSyncGlobalThrottle(BaseThrottle):
    """
    Whole-server load shedding for step syncs: a fixed-window counter shared by every user.
    When the fleet exceeds `step_sync_global` (default 1200 per minute, i.e. ~20/s on the
    single web instance) the extra requests get 429 with a *randomised* Retry-After
    (window remainder + up to 60 s) so the herd spreads out instead of retrying in lockstep.
    Phones keep the data and retry later, so shedding never loses steps.
    """

    scope = "step_sync_global"
    default_rate = "1200/minute"
    max_extra_spread_seconds = 60

    def __init__(self):
        self._wait = None

    def _limits(self):
        from django.conf import settings

        rates = (getattr(settings, "REST_FRAMEWORK", {}) or {}).get(
            "DEFAULT_THROTTLE_RATES", {}
        ) or {}
        rate = rates.get(self.scope) or self.default_rate
        num, period = rate.split("/")
        duration = {"s": 1, "m": 60, "h": 3600, "d": 86400}[period[0]]
        return int(num), duration

    def allow_request(self, request, view):
        from django.core.cache import cache

        limit, duration = self._limits()
        now = time.time()
        window = int(now // duration)
        key = f"throttle_step_sync_global_{window}"
        try:
            if cache.add(key, 1, timeout=duration + 5):
                count = 1
            else:
                count = cache.incr(key)
        except Exception:
            return True  # cache trouble must never block syncing
        if count <= limit:
            return True
        remaining = duration - (now - window * duration)
        self._wait = math.ceil(
            remaining + random.uniform(0, self.max_extra_spread_seconds)
        )
        return False

    def wait(self):
        return self._wait


class ChatMessageRateThrottle(UserRateThrottle):
    """30 chat messages per minute per user — prevents chat spam."""

    scope = "chat"


class AdminLoginRateThrottle(AnonRateThrottle):
    """Stricter admin login throttle to reduce credential stuffing impact."""

    scope = "admin_login"


class ProfilePictureUploadRateThrottle(UserRateThrottle):
    """Limit profile picture uploads to prevent storage abuse."""

    scope = "profile_picture_upload"


class DeviceBindRateThrottle(UserRateThrottle):
    """Throttle device binding attempts to reduce device-id probing."""

    scope = "device_bind"


class DashboardReadRateThrottle(UserRateThrottle):
    """Higher-throughput read throttle for mobile dashboard polling endpoints."""

    scope = "dashboard_read"


class SocialAuthRateThrottle(AnonRateThrottle):
    """Sign in with Google / Apple — per IP."""

    scope = "social_auth"


class AccountDeletionRateThrottle(UserRateThrottle):
    """Self-service account deletion (password re-check) — per user."""

    scope = "account_delete"


class AccountDeletionWebRateThrottle(AnonRateThrottle):
    """Public /account/delete/ page sign-in + delete — per IP."""

    scope = "account_delete_web"
