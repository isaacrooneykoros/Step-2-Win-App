"""
Custom throttle classes for Step2Win.
Each sensitive endpoint gets its own named rate limit.
Rates are registered in settings.py REST_FRAMEWORK.DEFAULT_THROTTLE_RATES.
"""

import hashlib

from rest_framework.throttling import (AnonRateThrottle, SimpleRateThrottle,
                                       UserRateThrottle)


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


class StepSyncRateThrottle(UserRateThrottle):
    """10 step syncs per minute per user — prevents anti-cheat bypass attempts."""

    scope = "step_sync"


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
