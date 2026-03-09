import hashlib
import hmac
import time

from django.conf import settings
from django.http import JsonResponse
from rest_framework_simplejwt.exceptions import TokenError
from rest_framework_simplejwt.tokens import AccessToken


class HMACSignatureMiddleware:
    """
    Validates sync requests came from the real app.
    Uses: HMAC-SHA256(secret, "{user_id}:{timestamp}:{body_sha256}")
    Rejects requests older than 5 minutes to prevent replay attacks.
    """

    PROTECTED_PATHS = ['/api/steps/sync/']
    MAX_AGE_SECONDS = 300

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        if request.path in self.PROTECTED_PATHS and request.method == 'POST':
            result = self._verify(request)
            if not result['valid']:
                return JsonResponse({'error': 'Invalid request', 'code': result['code']}, status=403)
        return self.get_response(request)

    def _verify(self, request):
        sig = request.headers.get('X-App-Signature')
        timestamp = request.headers.get('X-Timestamp')
        user_id = self._resolve_user_id(request)

        if not sig or not timestamp:
            return {'valid': False, 'code': 'MISSING_SIGNATURE'}

        try:
            if abs(time.time() - int(timestamp)) > self.MAX_AGE_SECONDS:
                return {'valid': False, 'code': 'EXPIRED_TIMESTAMP'}
        except ValueError:
            return {'valid': False, 'code': 'INVALID_TIMESTAMP'}

        body_hash = hashlib.sha256(request.body).hexdigest()
        message = f"{user_id}:{timestamp}:{body_hash}"
        secret = getattr(settings, 'APP_SIGNING_SECRET', '').encode()
        expected = hmac.new(secret, message.encode(), hashlib.sha256).hexdigest()

        if not hmac.compare_digest(sig, expected):
            return {'valid': False, 'code': 'INVALID_SIGNATURE'}

        return {'valid': True, 'code': 'OK'}

    @staticmethod
    def _resolve_user_id(request) -> str:
        if request.user.is_authenticated:
            return str(request.user.id)

        auth_header = request.headers.get('Authorization', '')
        if not auth_header.startswith('Bearer '):
            return ''

        token = auth_header.split(' ', 1)[1].strip()
        if not token:
            return ''

        try:
            payload = AccessToken(token)
            token_user_id = payload.get('user_id')
            return str(token_user_id) if token_user_id is not None else ''
        except TokenError:
            return ''
