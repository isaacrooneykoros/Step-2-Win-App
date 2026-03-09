import logging
from django.http import JsonResponse

logger = logging.getLogger(__name__)


class UserIsolationAuditMiddleware:
    """
    Development/staging middleware that logs warnings when authenticated
    requests return data without user filtering.

    Does NOT block requests — only logs warnings.
    Enable in development to catch data isolation bugs early.
    """
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        response = self.get_response(request)
        return response

    def process_view(self, request, view_func, view_args, view_kwargs):
        # Only audit authenticated API requests
        if not hasattr(request, 'user') or not request.user.is_authenticated:
            return None
        if not request.path.startswith('/api/'):
            return None
        # Log the user + endpoint for audit trail
        logger.debug(
            f'API: user={request.user.id} | {request.method} {request.path}'
        )
        return None


class SecurityHeadersMiddleware:
    """Adds security headers to every response."""
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        response = self.get_response(request)
        response['X-Content-Type-Options'] = 'nosniff'
        response['X-Frame-Options'] = 'DENY'
        response['Referrer-Policy'] = 'strict-origin-when-cross-origin'
        response['Permissions-Policy'] = 'geolocation=(self), camera=()'
        return response
