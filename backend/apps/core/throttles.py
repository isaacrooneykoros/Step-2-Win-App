"""
Custom throttle classes for Step2Win.
Each sensitive endpoint gets its own named rate limit.
Rates are registered in settings.py REST_FRAMEWORK.DEFAULT_THROTTLE_RATES.
"""
from rest_framework.throttling import UserRateThrottle, AnonRateThrottle


class LoginRateThrottle(AnonRateThrottle):
    """5 login attempts per minute per IP — works alongside django-axes lockout."""
    scope = 'login'


class RegisterRateThrottle(AnonRateThrottle):
    """3 registrations per minute per IP — prevents bulk fake account creation."""
    scope = 'register'


class DepositRateThrottle(UserRateThrottle):
    """5 deposit initiations per minute per user — prevents accidental duplicates."""
    scope = 'deposit'


class WithdrawalRateThrottle(UserRateThrottle):
    """3 withdrawal requests per minute per user."""
    scope = 'withdrawal'


class PasswordResetRateThrottle(AnonRateThrottle):
    """3 password reset requests per hour per IP — prevents email flooding."""
    scope = 'password_reset'


class StepSyncRateThrottle(UserRateThrottle):
    """10 step syncs per minute per user — prevents anti-cheat bypass attempts."""
    scope = 'step_sync'


class ChatMessageRateThrottle(UserRateThrottle):
    """30 chat messages per minute per user — prevents chat spam."""
    scope = 'chat'
