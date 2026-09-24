"""
Sign in with Google / Sign in with Apple.

The client never sends us a password or an access token. It sends the provider's
OpenID Connect ID token (a JWT signed by Google or Apple). We verify it locally:

- signature against the provider's published JWKS (cached, refreshed on unknown kid),
- ``iss`` is the provider,
- ``aud`` is one of OUR client ids (settings.GOOGLE_OAUTH_CLIENT_IDS /
  settings.APPLE_CLIENT_IDS) - this is what stops a token minted for another app
  from being replayed here (token substitution),
- ``exp`` / ``iat`` (small clock leeway),
- ``nonce``: the app generates a random raw nonce, gives the provider its SHA-256
  (hex) and sends us the raw value; the token must carry the hash. Required for
  Apple, checked for Google whenever the app sends one.
- the email is only trusted when the provider says it is verified.

Accounts are linked by the provider's stable subject (``sub``) in SocialAccount,
then by verified email, and only then created (respecting the admin
"new sign-ups" switch).
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import threading
from dataclasses import dataclass

import jwt
from django.conf import settings
from django.db import IntegrityError, transaction

logger = logging.getLogger(__name__)

GOOGLE = "google"
APPLE = "apple"

GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs"
GOOGLE_ISSUERS = ("https://accounts.google.com", "accounts.google.com")
APPLE_JWKS_URL = "https://appleid.apple.com/auth/keys"
APPLE_ISSUER = "https://appleid.apple.com"

CLOCK_SKEW_SECONDS = 60
JWKS_CACHE_SECONDS = 60 * 60
JWKS_TIMEOUT_SECONDS = 5


class SocialAuthError(Exception):
    """A sign-in failure with a stable machine code and a customer-facing message."""

    status_code = 400

    def __init__(self, code: str, message: str, status_code: int | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        if status_code is not None:
            self.status_code = status_code


@dataclass(frozen=True)
class VerifiedIdentity:
    provider: str
    subject: str
    email: str
    email_verified: bool
    given_name: str = ""
    family_name: str = ""
    full_name: str = ""


# ── configuration ────────────────────────────────────────────────────────────


def _client_ids(setting_name: str) -> list[str]:
    raw = getattr(settings, setting_name, None) or []
    if isinstance(raw, str):
        raw = raw.split(",")
    return [c.strip() for c in raw if c and c.strip()]


def google_client_ids() -> list[str]:
    return _client_ids("GOOGLE_OAUTH_CLIENT_IDS")


def apple_client_ids() -> list[str]:
    return _client_ids("APPLE_CLIENT_IDS")


def _not_configured(provider_label: str) -> SocialAuthError:
    return SocialAuthError(
        "provider_not_configured",
        f"{provider_label} sign-in isn't set up on the server yet. Please use your email and password.",
        status_code=503,
    )


# ── JWKS (cached per process) ────────────────────────────────────────────────

_jwks_clients: dict[str, jwt.PyJWKClient] = {}
_jwks_lock = threading.Lock()


def _jwks_client(url: str) -> jwt.PyJWKClient:
    with _jwks_lock:
        client = _jwks_clients.get(url)
        if client is None:
            client = jwt.PyJWKClient(
                url,
                cache_jwk_set=True,
                lifespan=JWKS_CACHE_SECONDS,
                timeout=JWKS_TIMEOUT_SECONDS,
            )
            _jwks_clients[url] = client
        return client


def reset_jwks_cache() -> None:
    """Drop cached key sets (tests, key-rotation incidents)."""
    with _jwks_lock:
        _jwks_clients.clear()


def _signing_key(url: str, token: str, provider_label: str):
    try:
        return _jwks_client(url).get_signing_key_from_jwt(token).key
    except jwt.PyJWKClientConnectionError as exc:
        logger.warning("%s JWKS fetch failed: %s", provider_label, exc)
        raise SocialAuthError(
            "provider_unavailable",
            f"We couldn't reach {provider_label} to confirm your sign-in. Please try again.",
            status_code=503,
        ) from exc
    except (jwt.PyJWKClientError, jwt.DecodeError) as exc:
        raise SocialAuthError(
            "invalid_token", f"{provider_label} sign-in couldn't be verified. Please try again."
        ) from exc


def hash_nonce(raw_nonce: str) -> str:
    return hashlib.sha256(raw_nonce.encode("utf-8")).hexdigest()


def _check_nonce(claims: dict, raw_nonce: str | None, *, required: bool, label: str) -> None:
    token_nonce = claims.get("nonce")
    if not raw_nonce:
        if required:
            raise SocialAuthError("invalid_nonce", f"{label} sign-in couldn't be verified. Please try again.")
        return
    if not isinstance(token_nonce, str) or not hmac.compare_digest(
        token_nonce, hash_nonce(raw_nonce)
    ):
        raise SocialAuthError("invalid_nonce", f"{label} sign-in couldn't be verified. Please try again.")


def _decode(token: str, *, url: str, audience: list[str], issuer, label: str) -> dict:
    key = _signing_key(url, token, label)
    try:
        return jwt.decode(
            token,
            key=key,
            algorithms=["RS256"],
            audience=audience,
            issuer=issuer,
            leeway=CLOCK_SKEW_SECONDS,
            options={"require": ["iss", "aud", "exp", "iat", "sub"]},
        )
    except jwt.ExpiredSignatureError as exc:
        raise SocialAuthError(
            "token_expired", f"Your {label} sign-in expired. Please try again."
        ) from exc
    except jwt.InvalidTokenError as exc:
        # Wrong audience/issuer, bad signature, malformed, missing claims.
        logger.info("%s ID token rejected: %s", label, exc)
        raise SocialAuthError(
            "invalid_token", f"{label} sign-in couldn't be verified. Please try again."
        ) from exc


def _truthy(value) -> bool:
    # Apple sends booleans as strings ("true") in some tokens.
    return value is True or (isinstance(value, str) and value.lower() == "true")


# ── provider verification ────────────────────────────────────────────────────


def verify_google_id_token(token: str, raw_nonce: str | None = None) -> VerifiedIdentity:
    audience = google_client_ids()
    if not audience:
        raise _not_configured("Google")
    claims = _decode(
        token, url=GOOGLE_JWKS_URL, audience=audience, issuer=list(GOOGLE_ISSUERS), label="Google"
    )
    _check_nonce(claims, raw_nonce, required=False, label="Google")
    email = (claims.get("email") or "").strip().lower()
    return VerifiedIdentity(
        provider=GOOGLE,
        subject=str(claims["sub"]),
        email=email,
        email_verified=bool(email) and _truthy(claims.get("email_verified")),
        given_name=(claims.get("given_name") or "")[:150],
        family_name=(claims.get("family_name") or "")[:150],
        full_name=(claims.get("name") or "")[:300],
    )


def verify_apple_identity_token(
    token: str, raw_nonce: str | None, given_name: str = "", family_name: str = ""
) -> VerifiedIdentity:
    audience = apple_client_ids()
    if not audience:
        raise _not_configured("Apple")
    claims = _decode(token, url=APPLE_JWKS_URL, audience=audience, issuer=APPLE_ISSUER, label="Apple")
    _check_nonce(claims, raw_nonce, required=True, label="Apple")
    email = (claims.get("email") or "").strip().lower()
    # Apple only shares the name with the app (never in the token), and only on the
    # first authorisation, so the client forwards it. It is display data only.
    given = (given_name or "").strip()[:150]
    family = (family_name or "").strip()[:150]
    return VerifiedIdentity(
        provider=APPLE,
        subject=str(claims["sub"]),
        email=email,
        email_verified=bool(email) and _truthy(claims.get("email_verified")),
        given_name=given,
        family_name=family,
        full_name=f"{given} {family}".strip(),
    )


# ── account resolution ───────────────────────────────────────────────────────


@dataclass
class ResolvedUser:
    user: object
    created: bool
    linked: bool


def _staff_blocked():
    return SocialAuthError(
        "staff_account",
        "Staff accounts must sign in with their password.",
        status_code=403,
    )


def resolve_user(identity: VerifiedIdentity) -> ResolvedUser:
    """(provider, subject) → verified email (link) → create (if sign-ups are open)."""
    from apps.admin_api.platform import feature_enabled, feature_disabled_payload

    from .models import SocialAccount, User

    account = (
        SocialAccount.objects.select_related("user")
        .filter(provider=identity.provider, subject=identity.subject)
        .first()
    )
    if account:
        if account.user.is_staff or account.user.is_superuser:
            raise _staff_blocked()
        account.touch()
        return ResolvedUser(account.user, created=False, linked=False)

    if not identity.email:
        raise SocialAuthError(
            "email_required",
            "We need your email address to create your Step2Win account. Please allow email sharing and try again.",
        )
    if not identity.email_verified:
        raise SocialAuthError(
            "email_not_verified",
            "Your email address isn't verified with this provider. Verify it, or sign up with email and password.",
        )

    existing = User.objects.filter(email__iexact=identity.email).first()
    if existing:
        if existing.is_staff or existing.is_superuser:
            raise _staff_blocked()
        try:
            with transaction.atomic():
                SocialAccount.objects.create(
                    user=existing,
                    provider=identity.provider,
                    subject=identity.subject,
                    email=identity.email,
                )
        except IntegrityError:
            pass  # a parallel request linked it first
        return ResolvedUser(existing, created=False, linked=True)

    if not feature_enabled("registrations"):
        payload = feature_disabled_payload("registrations")
        err = SocialAuthError(payload["code"], payload["error"], status_code=403)
        err.extra = {"feature": payload["feature"]}
        raise err

    from .views import _build_unique_username

    try:
        with transaction.atomic():
            user = User(
                username=_build_unique_username(email=identity.email, full_name=identity.full_name),
                email=identity.email,
                first_name=identity.given_name,
                last_name=identity.family_name,
                is_active=True,
            )
            user.set_unusable_password()
            user.save()
            SocialAccount.objects.create(
                user=user,
                provider=identity.provider,
                subject=identity.subject,
                email=identity.email,
            )
    except IntegrityError:
        # Lost a race with a parallel sign-in for the same identity: use the winner.
        account = (
            SocialAccount.objects.select_related("user")
            .filter(provider=identity.provider, subject=identity.subject)
            .first()
        )
        if account is None:
            raise
        return ResolvedUser(account.user, created=False, linked=False)
    return ResolvedUser(user, created=True, linked=False)
