"""
Step-sync request validation middleware.

Replaced HMAC-with-shared-secret approach with a server-side single-use nonce.

Why the change:
- VITE_ env variables are compiled into the JS bundle and are extractable from
  the APK by anyone with apktool. A shared secret in the bundle offers no real
  protection — once extracted it can be used to forge requests indefinitely.
- A server-held nonce (Redis, 120 s TTL) is never embedded in client code.
  Each sync requires a fresh nonce fetched from GET /api/steps/sync/nonce/.
  This makes each request non-replayable without a new authenticated server
  round-trip.

Fallback: when Redis is unavailable the nonce store cannot be consulted, so
the middleware allows the request through rather than hard-blocking users.
This is intentional — anti-cheat logic in the view provides the real defence.
"""

import logging

import redis as redis_client
from django.conf import settings
from django.http import JsonResponse

logger = logging.getLogger(__name__)


def _get_redis():
    try:
        url = getattr(settings, 'REDIS_URL', None) or getattr(settings, 'CELERY_BROKER_URL', None)
        if url and not url.startswith('sqla+sqlite'):
            return redis_client.Redis.from_url(url, socket_connect_timeout=1)
    except Exception:
        pass
    return None


class SyncNonceMiddleware:
    """
    Validates that POST /api/steps/sync/ carries a valid server-issued nonce.

    Flow:
      1. Client calls GET /api/steps/sync/nonce/  (authenticated, returns UUID nonce)
         Backend stores: Redis key  step2win:sync_nonce:{user_id} → nonce  (TTL 120 s)
      2. Client POSTs /api/steps/sync/ with header  X-Sync-Nonce: <nonce>
      3. This middleware checks the header matches the stored nonce, then
         deletes it (one-time use) before letting the request through.

    If Redis is unavailable the middleware passes the request through so that
    temporary infrastructure issues do not block legitimate users.
    """

    PROTECTED_PATHS = ['/api/steps/sync/']

    def __init__(self, get_response):
        self.get_response = get_response
        self._redis = _get_redis()

    def __call__(self, request):
        if request.path in self.PROTECTED_PATHS and request.method == 'POST':
            result = self._verify(request)
            if not result['valid']:
                return JsonResponse(
                    {'error': 'Invalid request', 'code': result['code']},
                    status=403,
                )
        return self.get_response(request)

    def _verify(self, request):
        # Redis unavailable — degrade gracefully (anti-cheat in the view still runs)
        if self._redis is None:
            return {'valid': True, 'code': 'REDIS_UNAVAILABLE'}

        nonce = request.headers.get('X-Sync-Nonce', '').strip()
        if not nonce:
            return {'valid': False, 'code': 'MISSING_NONCE'}

        user_id = self._resolve_user_id(request)
        if not user_id:
            # Not yet authenticated — let auth middleware reject it properly
            return {'valid': True, 'code': 'NO_USER'}

        nonce_key = f'step2win:sync_nonce:{user_id}'
        try:
            stored = self._redis.get(nonce_key)
            if stored is None:
                return {'valid': False, 'code': 'NONCE_EXPIRED_OR_MISSING'}

            stored_nonce = stored.decode() if isinstance(stored, bytes) else stored
            if stored_nonce != nonce:
                return {'valid': False, 'code': 'NONCE_MISMATCH'}

            # Consume the nonce — one-time use only
            self._redis.delete(nonce_key)
        except Exception as exc:
            logger.warning(f'SyncNonceMiddleware Redis error: {exc}')
            return {'valid': True, 'code': 'REDIS_ERROR'}

        return {'valid': True, 'code': 'OK'}

    @staticmethod
    def _resolve_user_id(request) -> str:
        if hasattr(request, 'user') and request.user.is_authenticated:
            return str(request.user.id)

        auth_header = request.headers.get('Authorization', '')
        if not auth_header.startswith('Bearer '):
            return ''
        token = auth_header.split(' ', 1)[1].strip()
        if not token:
            return ''

        try:
            from rest_framework_simplejwt.tokens import AccessToken
            from rest_framework_simplejwt.exceptions import TokenError
            payload = AccessToken(token)
            uid = payload.get('user_id')
            return str(uid) if uid is not None else ''
        except Exception:
            return ''


# Keep the old class name as an alias so any external references don't break.
HMACSignatureMiddleware = SyncNonceMiddleware
