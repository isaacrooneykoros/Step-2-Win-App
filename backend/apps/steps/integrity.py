"""Device integrity for step sessions and walks (Phase 1b).

Android: Google Play Integrity (classic requests). The server issues a nonce when a
step session or a walk starts; the app asks Google Play for an integrity token bound to
that nonce and sends it back; the server has Google decrypt and verify the token
(``decodeIntegrityToken``) with a service account and records the verdict on the
session / walk.

- Not configured (no service account / package name in the environment): every check
  is recorded as ``unavailable`` and nothing is ever blocked (SHADOW by construction).
- Policy (admin setting ``SystemSettings.device_integrity_policy``, default "shadow"):
  shadow  -> verdicts are recorded only;
  enforce -> steps from a session / walk that FAILED integrity (or an Android session
             that never sent a token once the verifier is configured) count for goals
             only, not toward challenges (see evidence.compute_tiers). Never a fraud
             flag, never a trust deduction.
- Emulator / root heuristics sent by the app (``device_signals``) are supplementary
  SHADOW signals: stored, never enforced (they are trivially spoofable).

iOS: App Attest is designed but not implemented (it needs an Apple developer account
and the DeviceCheck entitlement). TODO(App Attest): see backend/ANTICHEAT.md
("Device integrity"). iOS sessions stay ``unchecked`` and are never blocked.

Statuses: unchecked (no token yet) | verified | failed | unavailable (verifier not
configured) | error (Google unreachable: never blocks).
"""

from __future__ import annotations

import base64
import json
import logging
import secrets
import time
from typing import Any

from django.conf import settings
from django.core.cache import cache
from django.utils import timezone

logger = logging.getLogger(__name__)

PLAY_INTEGRITY_SCOPE = "https://www.googleapis.com/auth/playintegrity"
DECODE_URL = "https://playintegrity.googleapis.com/v1/{package}:decodeIntegrityToken"
DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token"
ACCESS_TOKEN_CACHE_KEY = "step2win:play_integrity:access_token"
# A token older than this (from its own request timestamp) is not accepted.
MAX_TOKEN_AGE_S = 15 * 60
# Android sessions get this long to deliver their token before "unchecked" counts as
# "not verified" under the enforce policy (the round trip to Google takes seconds).
UNCHECKED_GRACE_S = 10 * 60

STATUSES = ("unchecked", "verified", "failed", "unavailable", "error")


class IntegrityServiceError(Exception):
    """Google could not be reached / answered with an error (never blocks users)."""


# ── Configuration ────────────────────────────────────────────────────────────


def package_name() -> str:
    return str(getattr(settings, "PLAY_INTEGRITY_PACKAGE_NAME", "") or "").strip()


def _service_account_info() -> dict | None:
    raw = str(getattr(settings, "PLAY_INTEGRITY_SERVICE_ACCOUNT_JSON", "") or "").strip()
    path = str(getattr(settings, "PLAY_INTEGRITY_SERVICE_ACCOUNT_FILE", "") or "").strip()
    try:
        if raw:
            if not raw.startswith("{"):
                raw = base64.b64decode(raw).decode("utf-8")
            info = json.loads(raw)
        elif path:
            with open(path, encoding="utf-8") as fh:
                info = json.load(fh)
        else:
            return None
    except Exception:  # noqa: BLE001 - misconfiguration must never break syncing
        logger.warning("Play Integrity service account is set but unreadable.")
        return None
    if not info.get("client_email") or not info.get("private_key"):
        return None
    return info


def verifier_configured() -> bool:
    return bool(package_name()) and _service_account_info() is not None


def current_policy() -> str:
    """"shadow" (default) or "enforce" (admin setting, env fallback)."""
    try:
        from apps.admin_api.platform import current_settings

        value = getattr(current_settings(), "device_integrity_policy", None)
    except Exception:  # noqa: BLE001
        value = None
    value = (value or getattr(settings, "STEP_INTEGRITY_POLICY", "shadow") or "shadow").lower()
    return "enforce" if value == "enforce" else "shadow"


def new_nonce() -> str:
    """Base64url (no padding) nonce, 43 chars: valid as a Play Integrity nonce."""
    return secrets.token_urlsafe(32)


# ── Google API ───────────────────────────────────────────────────────────────


def _access_token(info: dict) -> str:
    cached = cache.get(ACCESS_TOKEN_CACHE_KEY)
    if cached:
        return cached
    import jwt
    import requests

    now = int(time.time())
    token_uri = info.get("token_uri") or DEFAULT_TOKEN_URI
    assertion = jwt.encode(
        {
            "iss": info["client_email"],
            "scope": PLAY_INTEGRITY_SCOPE,
            "aud": token_uri,
            "iat": now,
            "exp": now + 3600,
        },
        info["private_key"],
        algorithm="RS256",
        headers={"kid": info.get("private_key_id")} if info.get("private_key_id") else None,
    )
    try:
        resp = requests.post(
            token_uri,
            data={
                "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
                "assertion": assertion,
            },
            timeout=10,
        )
    except Exception as exc:  # noqa: BLE001
        raise IntegrityServiceError(f"token endpoint unreachable: {type(exc).__name__}") from exc
    if resp.status_code != 200:
        raise IntegrityServiceError(f"token endpoint HTTP {resp.status_code}")
    body = resp.json()
    token = body.get("access_token")
    if not token:
        raise IntegrityServiceError("no access token")
    ttl = max(60, int(body.get("expires_in", 3600)) - 300)
    cache.set(ACCESS_TOKEN_CACHE_KEY, token, ttl)
    return token


def decode_token(integrity_token: str) -> dict[str, Any]:
    """Ask Google to decrypt + verify the token. Returns tokenPayloadExternal."""
    import requests

    info = _service_account_info()
    pkg = package_name()
    if info is None or not pkg:
        raise IntegrityServiceError("not configured")
    access = _access_token(info)
    try:
        resp = requests.post(
            DECODE_URL.format(package=pkg),
            json={"integrity_token": integrity_token},
            headers={"Authorization": f"Bearer {access}"},
            timeout=10,
        )
    except Exception as exc:  # noqa: BLE001
        raise IntegrityServiceError(f"decode unreachable: {type(exc).__name__}") from exc
    if resp.status_code == 400:
        # Malformed / foreign token: Google refuses it. That is a failed check.
        return {"_invalid_token": True}
    if resp.status_code != 200:
        if resp.status_code == 401:
            cache.delete(ACCESS_TOKEN_CACHE_KEY)
        raise IntegrityServiceError(f"decode HTTP {resp.status_code}")
    return resp.json().get("tokenPayloadExternal") or {}


# ── Verdict evaluation (pure, unit-tested) ────────────────────────────────────


def evaluate_payload(
    payload: dict[str, Any], *, expected_nonce: str, expected_package: str, now_ms: int | None = None
) -> tuple[str, dict[str, Any]]:
    """Decide verified / failed from Google's decoded payload. Returns (status, verdict).

    The verdict keeps only what staff need (no raw token)."""
    now_ms = int(time.time() * 1000) if now_ms is None else now_ms
    if payload.get("_invalid_token"):
        return "failed", {"reasons": ["invalid_token"]}
    request = payload.get("requestDetails") or {}
    app = payload.get("appIntegrity") or {}
    device = payload.get("deviceIntegrity") or {}
    account = payload.get("accountDetails") or {}
    device_verdicts = list(device.get("deviceRecognitionVerdict") or [])
    verdict: dict[str, Any] = {
        "app_recognition": app.get("appRecognitionVerdict"),
        "device_recognition": device_verdicts,
        "app_licensing": account.get("appLicensingVerdict"),
        "version_code": app.get("versionCode"),
        "request_age_s": None,
    }
    reasons: list[str] = []

    if request.get("nonce") != expected_nonce:
        reasons.append("nonce_mismatch")
    if expected_package and request.get("requestPackageName") != expected_package:
        reasons.append("package_mismatch")
    try:
        age_s = (now_ms - int(request.get("timestampMillis"))) / 1000.0
        verdict["request_age_s"] = round(age_s, 1)
        if age_s > MAX_TOKEN_AGE_S or age_s < -300:
            reasons.append("stale_token")
    except (TypeError, ValueError):
        reasons.append("stale_token")

    app_verdict = app.get("appRecognitionVerdict")
    allowed_certs = {
        c.strip().replace(":", "").lower()
        for c in str(getattr(settings, "PLAY_INTEGRITY_ALLOWED_CERT_SHA256", "") or "").split(",")
        if c.strip()
    }
    certs = {
        str(c).replace(":", "").lower() for c in (app.get("certificateSha256Digest") or [])
    }
    if app_verdict != "PLAY_RECOGNIZED":
        # A build signed with our own key but installed outside Play (UNRECOGNIZED_VERSION)
        # is accepted when its signing certificate is allow-listed.
        if not (allowed_certs and certs and certs <= allowed_certs):
            reasons.append("app_not_recognized")

    accept_basic = bool(getattr(settings, "PLAY_INTEGRITY_ACCEPT_BASIC", False))
    good_device = "MEETS_DEVICE_INTEGRITY" in device_verdicts or "MEETS_STRONG_INTEGRITY" in device_verdicts
    if not good_device and not (accept_basic and "MEETS_BASIC_INTEGRITY" in device_verdicts):
        reasons.append("device_not_recognized")

    verdict["reasons"] = reasons
    return ("failed" if reasons else "verified"), verdict


def verify_token(integrity_token: str, *, expected_nonce: str) -> tuple[str, dict[str, Any]]:
    """Full check. Never raises; unconfigured -> "unavailable", Google down -> "error"."""
    if not verifier_configured():
        return "unavailable", {"reasons": ["verifier_not_configured"]}
    if not integrity_token or not expected_nonce:
        return "failed", {"reasons": ["missing_token"]}
    try:
        payload = decode_token(integrity_token)
    except IntegrityServiceError as exc:
        logger.warning("Play Integrity check could not complete: %s", exc)
        return "error", {"reasons": ["service_error"], "detail": str(exc)[:120]}
    except Exception:  # noqa: BLE001
        logger.exception("Play Integrity check crashed")
        return "error", {"reasons": ["service_error"]}
    return evaluate_payload(payload, expected_nonce=expected_nonce, expected_package=package_name())


def record_integrity(obj, integrity_token: str, *, nonce_field: str) -> str:
    """Verify a token for a StepSession (nonce field server_nonce) or WalkSession
    (integrity_nonce) and store the verdict. Returns the status."""
    nonce = getattr(obj, nonce_field, "") or ""
    status, verdict = verify_token(integrity_token, expected_nonce=nonce)
    merged = dict(getattr(obj, "integrity_verdict", None) or {})
    merged.update(verdict)
    merged["checked_at"] = timezone.now().isoformat()
    merged["policy"] = current_policy()
    obj.integrity_status = status
    obj.integrity_verdict = merged
    fields = ["integrity_status", "integrity_verdict", "updated_at"]
    if hasattr(obj, "integrity_checked_at"):
        obj.integrity_checked_at = timezone.now()
        fields.append("integrity_checked_at")
    obj.save(update_fields=fields)
    return status


# ── Heuristics (shadow only) ─────────────────────────────────────────────────

SIGNAL_KEYS = (
    "emulator",
    "rooted",
    "debuggable",
    "adb_enabled",
    "has_step_counter",
    "has_step_detector",
    "has_accelerometer",
    "has_gyroscope",
    "has_gravity",
)


def clean_device_signals(raw) -> dict[str, bool] | None:
    if not isinstance(raw, dict):
        return None
    out = {k: bool(raw.get(k)) for k in SIGNAL_KEYS if k in raw}
    return out or None


def heuristic_flags(signals: dict | None) -> list[str]:
    """Supplementary shadow signals (never enforced)."""
    if not signals:
        return []
    return [k for k in ("emulator", "rooted", "debuggable") if signals.get(k)]


# ── Policy decision ──────────────────────────────────────────────────────────


def blocks_money(status: str, *, platform: str, started_at=None, now=None) -> bool:
    """Under the enforce policy, does this integrity status make the steps
    goals-only? Never in shadow. iOS/web are never blocked (no attestation yet)."""
    if current_policy() != "enforce":
        return False
    if (platform or "").lower() != "android":
        return False
    if status == "failed":
        return True
    if status == "unchecked" and verifier_configured():
        now = now or timezone.now()
        if started_at is None:
            return True
        return (now - started_at).total_seconds() > UNCHECKED_GRACE_S
    return False
