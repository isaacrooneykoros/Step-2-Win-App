import hashlib
import hmac
import json
import time

from django.conf import settings
from django.http import JsonResponse
from rest_framework_simplejwt.exceptions import TokenError
from rest_framework_simplejwt.tokens import AccessToken


class HMACSignatureMiddleware:
    """
    Step sync gate: every POST /api/steps/sync/ must carry a server-issued step
    session (session_id + session_token), which the view verifies (token hash,
    ownership, expiry, sequence, replay).

    A client-side HMAC ("X-App-Signature", HMAC-SHA256 over
    "{user_id}:{timestamp}:{body_sha256}") is NOT sufficient on its own: the
    secret used to ship inside the web/app bundle, so anyone could compute it.
    Every client since the session protocol (commit b8e9ed7) sends a session, so
    HMAC-only syncs are rejected with 403 SESSION_REQUIRED. The legacy HMAC-only
    path survives only behind settings.STEP_SYNC_ALLOW_HMAC_ONLY (default False)
    as an emergency switch; do not enable it with a secret that has shipped in a
    client.
    """

    PROTECTED_PATHS = ["/api/steps/sync/"]
    MAX_AGE_SECONDS = 300

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        if request.path in self.PROTECTED_PATHS and request.method == "POST":
            if self._has_session_credentials(request):
                # Session-authenticated sync (the app's protocol): the view verifies
                # the server-issued session token hash, session ownership/expiry, sequence
                # monotonicity and replay before accepting anything. An invalid or foreign
                # session is rejected there (400/401) and recorded as a replay event.
                # Any X-App-Signature header is ignored: it proves nothing.
                return self.get_response(request)
            if not getattr(settings, "STEP_SYNC_ALLOW_HMAC_ONLY", False):
                return JsonResponse(
                    {
                        "error": "Please update the app to keep syncing your steps.",
                        "code": "SESSION_REQUIRED",
                    },
                    status=403,
                )
            result = self._verify(request)
            if not result["valid"]:
                return JsonResponse(
                    {"error": "Invalid request", "code": result["code"]}, status=403
                )
        return self.get_response(request)

    def _verify(self, request):
        sig = request.headers.get("X-App-Signature")
        timestamp = request.headers.get("X-Timestamp")
        user_id = self._resolve_user_id(request)

        if not sig or not timestamp:
            return {"valid": False, "code": "MISSING_SIGNATURE"}

        try:
            if abs(time.time() - int(timestamp)) > self.MAX_AGE_SECONDS:
                return {"valid": False, "code": "EXPIRED_TIMESTAMP"}
        except ValueError:
            return {"valid": False, "code": "INVALID_TIMESTAMP"}

        body_hash = hashlib.sha256(request.body).hexdigest()
        message = f"{user_id}:{timestamp}:{body_hash}"
        signing_secret = getattr(settings, "APP_SIGNING_SECRET", "")
        if not signing_secret:
            return {"valid": False, "code": "SIGNING_SECRET_NOT_CONFIGURED"}
        secret = signing_secret.encode()
        expected = hmac.new(secret, message.encode(), hashlib.sha256).hexdigest()

        if not hmac.compare_digest(sig, expected):
            return {"valid": False, "code": "INVALID_SIGNATURE"}

        return {"valid": True, "code": "OK"}

    @staticmethod
    def _has_session_credentials(request) -> bool:
        try:
            body = json.loads(request.body or b"{}")
        except (ValueError, UnicodeDecodeError):
            return False
        if not isinstance(body, dict):
            return False
        session_id = str(body.get("session_id") or "").strip()
        session_token = str(body.get("session_token") or "").strip()
        return bool(session_id and session_token)

    @staticmethod
    def _resolve_user_id(request) -> str:
        if request.user.is_authenticated:
            return str(request.user.id)

        auth_header = request.headers.get("Authorization", "")
        if not auth_header.startswith("Bearer "):
            return ""

        token = auth_header.split(" ", 1)[1].strip()
        if not token:
            return ""

        try:
            payload = AccessToken(token)
            token_user_id = payload.get("user_id")
            return str(token_user_id) if token_user_id is not None else ""
        except TokenError:
            return ""
