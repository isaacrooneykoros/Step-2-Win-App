"""
"Forgot password" with a 6-digit email code.

Flow (views in password_reset_views.py, under /api/auth/password-reset/):
  1. request  {identifier}           -> always the same 200 (no account enumeration)
  2. verify   {identifier, code}     -> short-lived single-use reset token, or a generic 400
  3. confirm  {reset_token, new_password, confirm_password} -> password set, every session
                                                              signed out, notice emailed

Security properties:
  - Code: 6 digits from ``secrets``; only a salted hash (Django password hasher) is stored;
    valid 15 min; 5 wrong tries locks it; a new request supersedes older codes.
  - Reset token: 32 random bytes, only its SHA-256 is stored; valid 10 min; single use.
  - Identical response + equivalent work (the code is hashed, a dummy hash checked) whether
    or not an account exists; mail goes out on a background thread so SMTP latency can't
    leak it either. Wrong-code answers for unknown identifiers count down "attempts left"
    from a cache counter so they look like the real thing.
  - Eligible: active, not deleted, customer (non-staff) accounts with a real email.
    Staff/admin accounts get nothing (a superuser resets them in the admin console).
    Google/Apple-only accounts (no usable password) get an email telling them to use
    "Continue with Google" instead of a code.
  - Completing a reset blacklists every refresh token, deactivates every DeviceSession,
    clears login lockouts, emails a "password changed" notice and writes an AuditLog entry
    (user id only).
  - Maintenance mode blocks these endpoints exactly like /api/auth/login/ (they're not in
    MAINTENANCE_ALLOWED_PREFIXES): a reset is useless while customers can't sign in.
"""

from __future__ import annotations

import hashlib
import logging
import secrets
from dataclasses import dataclass, field
from datetime import timedelta
from functools import lru_cache

from django.contrib.auth.hashers import check_password, make_password
from django.contrib.auth.password_validation import validate_password
from django.core.cache import cache
from django.core.exceptions import ValidationError
from django.db import transaction
from django.db.models import F
from django.utils import timezone

from apps.core.emails import send_branded_email
from apps.users.account_deletion import DELETED_EMAIL_DOMAIN, _revoke_all_tokens

logger = logging.getLogger(__name__)

CODE_LENGTH = 6
CODE_TTL = timedelta(minutes=15)
TOKEN_TTL = timedelta(minutes=10)
MAX_ATTEMPTS = 5
# The app offers "Resend" after 60 s; a slightly shorter server cooldown avoids clock skew
# turning a legitimate resend into a silent no-op.
RESEND_COOLDOWN = timedelta(seconds=45)
GENERIC_REQUEST_MESSAGE = (
    "If an account matches, we've sent a 6-digit code to the email address on it."
)

KIND_PASSWORD = "password"
KIND_SOCIAL = "social"


# ── Lookup / eligibility ─────────────────────────────────────────────────────


def normalise_identifier(raw) -> str:
    return str(raw or "").strip()[:254]


def _phone_candidates(identifier: str) -> list[str]:
    digits = "".join(ch for ch in identifier if ch.isdigit())
    if not digits or len(digits) < 9 or len(digits) > 15:
        return []
    cands = {identifier, digits, f"+{digits}"}
    if digits.startswith("0") and len(digits) == 10:  # 07XX... -> 2547XX...
        cands |= {f"254{digits[1:]}", f"+254{digits[1:]}"}
    return list(cands)


def find_account(identifier: str):
    """Username (exact), email (case-insensitive) or phone number -> User or None."""
    from apps.users.models import User

    if not identifier:
        return None
    user = User.objects.filter(username=identifier).first()
    if user is None and "@" in identifier:
        user = User.objects.filter(email__iexact=identifier).first()
    if user is None:
        cands = _phone_candidates(identifier)
        if cands:
            user = User.objects.filter(phone_number__in=cands).first()
    return user


def reset_kind(user) -> str | None:
    """KIND_PASSWORD, KIND_SOCIAL (Google/Apple-only) or None (send nothing)."""
    if user is None or not user.is_active or getattr(user, "deleted_at", None) is not None:
        return None
    if user.is_staff or user.is_superuser:
        return None
    email = (user.email or "").strip()
    if not email or "@" not in email or email.lower().endswith("@" + DELETED_EMAIL_DOMAIN):
        return None
    if user.has_usable_password():
        return KIND_PASSWORD
    if user.social_accounts.exists():
        return KIND_SOCIAL
    return None


# ── Helpers ──────────────────────────────────────────────────────────────────


def _generate_code() -> str:
    return f"{secrets.randbelow(10 ** CODE_LENGTH):0{CODE_LENGTH}d}"


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


@lru_cache(maxsize=1)
def _dummy_code_hash() -> str:
    return make_password(_generate_code())


def _miss_key(identifier: str) -> str:
    digest = hashlib.sha256(identifier.lower().encode("utf-8")).hexdigest()[:32]
    return f"pwreset:miss:{digest}"


def _count_miss(identifier: str) -> int:
    """Wrong-code counter for identifiers with no live code (unknown account, expired code)."""
    key = _miss_key(identifier)
    cache.add(key, 0, timeout=int(CODE_TTL.total_seconds()))
    try:
        return int(cache.incr(key))
    except ValueError:  # evicted between add and incr
        cache.set(key, 1, timeout=int(CODE_TTL.total_seconds()))
        return 1


# ── 1. Request ───────────────────────────────────────────────────────────────


def request_reset(identifier: str, *, ip: str | None = None) -> None:
    """Issue + email a code if appropriate. Returns nothing: the caller answers generically."""
    identifier = normalise_identifier(identifier)
    user = find_account(identifier)
    kind = reset_kind(user)
    code = _generate_code()
    code_hash = make_password(code)  # always hash, so both paths cost the same
    cache.delete(_miss_key(identifier))

    if kind is None:
        return

    if kind == KIND_SOCIAL:
        providers = sorted(set(user.social_accounts.values_list("provider", flat=True)))
        label = "Google" if "google" in providers or not providers else providers[0].title()
        send_branded_email(
            kind="password_reset_social",
            to=user.email,
            subject="Signing in to Step2Win",
            heading="You sign in with " + label,
            paragraphs=[
                "Someone asked to reset the password for your Step2Win account.",
                f"Your account doesn't use a password. It's linked to {label}, so there is "
                f"nothing to reset: open Step2Win and tap \"Continue with {label}\".",
                "If you didn't ask for this, you can ignore this email. Your account is safe.",
            ],
        )
        logger.info("Password reset requested for social-only account user=%s", user.pk)
        return

    from apps.users.models import PasswordResetCode

    now = timezone.now()
    with transaction.atomic():
        recent = PasswordResetCode.objects.filter(
            user=user, used_at__isnull=True, verified_at__isnull=True,
            created_at__gte=now - RESEND_COOLDOWN,
        ).exists()
        if recent:
            # Double tap / impatient resend: the code we just sent is still valid.
            logger.info("Password reset request within cooldown user=%s", user.pk)
            return
        PasswordResetCode.objects.filter(user=user, used_at__isnull=True).update(used_at=now)
        PasswordResetCode.objects.create(
            user=user,
            code_hash=code_hash,
            expires_at=now + CODE_TTL,
            request_ip=ip or None,
        )

    minutes = int(CODE_TTL.total_seconds() // 60)
    send_branded_email(
        kind="password_reset_code",
        to=user.email,
        subject=f"{code} is your Step2Win reset code",
        heading="Reset your password",
        paragraphs=[
            "Use this code in the Step2Win app to choose a new password:",
            f"It expires in {minutes} minutes and can only be used once.",
            "If you didn't ask to reset your password, ignore this email. Your password "
            "stays the same and nobody can change it without this code.",
        ],
        code=code,
    )
    logger.info("Password reset code issued user=%s", user.pk)


# ── 2. Verify ────────────────────────────────────────────────────────────────


@dataclass
class ResetError(Exception):
    code: str
    message: str
    attempts_left: int | None = None
    errors: dict = field(default_factory=dict)
    status_code: int = 400

    def as_dict(self) -> dict:
        data = {"error": self.message, "code": self.code}
        if self.attempts_left is not None:
            data["attempts_left"] = self.attempts_left
        if self.errors:
            data["errors"] = self.errors
        return data


def _verify_error(attempts_left: int) -> ResetError:
    if attempts_left <= 0:
        return ResetError(
            "too_many_attempts",
            "Too many incorrect tries. Request a new code to continue.",
            attempts_left=0,
        )
    return ResetError(
        "invalid_code", "That code is incorrect or has expired.", attempts_left=attempts_left
    )


def verify_code(identifier: str, code: str) -> str:
    """Return a reset token, or raise ResetError (same shape for every failure)."""
    from apps.users.models import PasswordResetCode

    identifier = normalise_identifier(identifier)
    code = "".join(str(code or "").split())
    user = find_account(identifier)
    now = timezone.now()

    row_id = None
    if reset_kind(user) == KIND_PASSWORD:
        row_id = (
            PasswordResetCode.objects.filter(
                user=user, used_at__isnull=True, verified_at__isnull=True, expires_at__gt=now
            )
            .order_by("-created_at")
            .values_list("id", flat=True)
            .first()
        )

    if row_id is None:
        check_password(code, _dummy_code_hash())  # same cost as a real check
        raise _verify_error(MAX_ATTEMPTS - _count_miss(identifier))

    with transaction.atomic():
        row = PasswordResetCode.objects.select_for_update().get(pk=row_id)
        if row.used_at or row.verified_at or row.expires_at <= now:
            ok, attempts_left = False, MAX_ATTEMPTS - row.attempts
        elif row.attempts >= MAX_ATTEMPTS:
            ok, attempts_left = False, 0
        else:
            ok = (
                len(code) == CODE_LENGTH
                and code.isdigit()
                and check_password(code, row.code_hash)
            )
            if not ok:
                PasswordResetCode.objects.filter(pk=row.pk).update(attempts=F("attempts") + 1)
                attempts_left = MAX_ATTEMPTS - (row.attempts + 1)
                if attempts_left <= 0:
                    # Burn it so it can never be used again.
                    PasswordResetCode.objects.filter(pk=row.pk).update(used_at=now)
        token = None
        if ok:
            token = secrets.token_urlsafe(32)
            row.verified_at = now
            row.reset_token_hash = _token_hash(token)
            row.token_expires_at = now + TOKEN_TTL
            row.save(update_fields=["verified_at", "reset_token_hash", "token_expires_at"])

    if not ok:
        logger.info("Password reset code rejected user=%s attempts_left=%s", user.pk, attempts_left)
        raise _verify_error(attempts_left)
    logger.info("Password reset code verified user=%s", user.pk)
    return token


# ── 3. Confirm ───────────────────────────────────────────────────────────────


def _invalid_token() -> ResetError:
    return ResetError("invalid_token", "This reset has expired. Start again to get a new code.")


def confirm_reset(token: str, new_password: str, confirm_password: str):
    """Set the new password; raise ResetError on a bad/expired token or a weak password."""
    from apps.admin_api.models import AuditLog
    from apps.users.models import PasswordResetCode

    token = str(token or "").strip()
    new_password = new_password or ""
    if not token or len(token) > 200:
        raise _invalid_token()

    now = timezone.now()
    with transaction.atomic():
        row = (
            PasswordResetCode.objects.select_for_update()
            .select_related("user")
            .filter(reset_token_hash=_token_hash(token), used_at__isnull=True, token_expires_at__gt=now)
            .first()
        )
        if row is None or reset_kind(row.user) != KIND_PASSWORD:
            raise _invalid_token()
        user = row.user

        if not new_password:
            raise ResetError("invalid_password", "Enter a new password.",
                             errors={"new_password": ["Enter a new password."]})
        if new_password != (confirm_password or ""):
            raise ResetError("password_mismatch", "The passwords don't match.",
                             errors={"confirm_password": ["The passwords don't match."]})
        try:
            validate_password(new_password, user)
        except ValidationError as exc:
            messages = list(exc.messages)
            raise ResetError("invalid_password", messages[0], errors={"new_password": messages})

        user.set_password(new_password)
        user.save(update_fields=["password"])
        PasswordResetCode.objects.filter(user=user, used_at__isnull=True).update(used_at=now)
        revoked = _revoke_all_tokens(user)
        AuditLog.objects.create(
            admin=None,
            admin_username="self-service",
            action="reset_password",
            resource_type="user",
            resource_id=user.pk,
            resource_name=f"user #{user.pk}",
            description="Password reset by the account owner with an email code. "
            "All sessions were signed out.",
            changes={"channel": "email_code", "revoked_tokens": revoked},
        )

    # A fresh password should also lift any failed-login lockout.
    cache.delete(f"login_attempts:{user.username}")
    try:
        from axes.utils import reset as axes_reset

        axes_reset(username=user.username)
    except Exception:
        logger.warning("Password reset: could not clear axes lockout user=%s", user.pk)

    send_branded_email(
        kind="password_changed_notice",
        to=user.email,
        subject="Your Step2Win password was changed",
        heading="Your password was changed",
        paragraphs=[
            "The password for your Step2Win account was just reset using a code sent to "
            "this email address. You've been signed out on all devices.",
            "If this was you, there's nothing else to do.",
            "If it wasn't you, reset your password again right away from the sign-in "
            "screen (\"Forgot password?\") and contact Step2Win support from the app.",
        ],
    )
    logger.info("Password reset completed user=%s revoked_tokens=%s", user.pk, revoked)
    return user
