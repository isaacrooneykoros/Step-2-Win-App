"""
Custom authentication views with device session tracking.
These views handle login, logout, token refresh, and session management.
"""
from rest_framework_simplejwt.views import TokenObtainPairView, TokenRefreshView
from rest_framework_simplejwt.tokens import RefreshToken
from rest_framework_simplejwt.token_blacklist.models import OutstandingToken, BlacklistedToken
from rest_framework_simplejwt.exceptions import TokenError
from rest_framework.views import APIView
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework import status
from django.contrib.auth import authenticate, get_user_model
from django.core.cache import cache
from django.conf import settings
from django.utils import timezone
from apps.users.models import DeviceSession
from apps.users.serializers import UserProfileSerializer
import logging

logger = logging.getLogger(__name__)
UserModel = get_user_model()


def get_client_ip(request) -> str:
    """Extract the real client IP, accounting for proxies."""
    x_forwarded = request.META.get('HTTP_X_FORWARDED_FOR')
    if x_forwarded:
        return x_forwarded.split(',')[0].strip()
    return request.META.get('REMOTE_ADDR', '')


class CustomLoginView(TokenObtainPairView):
    """
    Login endpoint. Creates a DeviceSession on every successful login.

    Request body:
        { "username": "...", "password": "...",
          "device_name": "Samsung Galaxy S21",
          "device_type": "android",
          "app_version": "1.0.0" }

    Response:
        { "access": "...", "refresh": "...",
          "session_id": "...", "user": {...} }
    """

    def post(self, request, *args, **kwargs):
        # ── Check brute force lockout ─────────────────────────────────────
        username = request.data.get('username', '')
        cache_key = f'login_attempts:{username}'
        attempts = cache.get(cache_key, 0)

        max_attempts = getattr(settings, 'MAX_LOGIN_ATTEMPTS', 5)
        lockout_minutes = getattr(settings, 'LOGIN_LOCKOUT_MINUTES', 15)

        if attempts >= max_attempts:
            return Response(
                {'error': f'Account temporarily locked. Try again in {lockout_minutes} minutes.'},
                status=status.HTTP_429_TOO_MANY_REQUESTS
            )

        # ── Attempt login ─────────────────────────────────────────────────
        response = super().post(request, *args, **kwargs)

        if response.status_code != 200:
            # Increment failed attempts
            cache.set(cache_key, attempts + 1, timeout=lockout_minutes * 60)
            return response

        # ── Successful login — clear lockout counter ──────────────────────
        cache.delete(cache_key)

        # ── Create DeviceSession ──────────────────────────────────────────
        try:
            refresh_token = response.data.get('refresh')
            refresh_obj = RefreshToken(refresh_token)
            jti = refresh_obj.get('jti')
            user = UserModel.objects.get(id=refresh_obj.get('user_id'))

            session = DeviceSession.objects.create(
                user=user,
                refresh_jti=jti,
                device_type=request.data.get('device_type', 'unknown'),
                device_name=request.data.get('device_name', ''),
                app_version=request.data.get('app_version', ''),
                ip_address=get_client_ip(request),
            )

            # Add session_id to response so frontend can store it
            response.data['session_id'] = str(session.id)
            response.data['user'] = UserProfileSerializer(user).data

            logger.info(
                f'Login: user={user.username} | device={session.device_name} | '
                f'ip={session.ip_address}'
            )

        except Exception as e:
            logger.error(f'DeviceSession creation failed: {e}')
            # Don't fail the login just because session tracking failed

        return response


class CustomLogoutView(APIView):
    """
    Logout endpoint. Blacklists the refresh token and deactivates the DeviceSession.

    Request body:
        { "refresh": "..." }

    Always returns 200 — even if token is already invalid.
    """
    permission_classes = [IsAuthenticated]

    def post(self, request):
        refresh_token = request.data.get('refresh')
        if not refresh_token:
            return Response({'error': 'refresh token required'}, status=status.HTTP_400_BAD_REQUEST)

        try:
            token = RefreshToken(refresh_token)
            jti = token.get('jti')

            # Blacklist the token — makes it immediately invalid
            token.blacklist()

            # Deactivate the DeviceSession
            DeviceSession.objects.filter(
                user=request.user, refresh_jti=jti
            ).update(is_active=False)

            logger.info(f'Logout: user={request.user.username} | jti={jti[:8]}...')

        except TokenError:
            # Token already expired or invalid — still return 200
            pass
        except Exception as e:
            logger.error(f'Logout error: {e}')

        return Response({'message': 'Logged out successfully.'})


class CustomRefreshView(TokenRefreshView):
    """
    Token refresh endpoint.
    Updates DeviceSession.last_active_at on every successful refresh.
    Rejects refresh tokens from deactivated sessions (force-logout works).
    """

    def post(self, request, *args, **kwargs):
        refresh_token = request.data.get('refresh')

        # ── Check if this session has been force-revoked ──────────────────
        if refresh_token:
            try:
                token = RefreshToken(refresh_token)
                jti = token.get('jti')

                session = DeviceSession.objects.filter(refresh_jti=jti).first()
                if session and not session.is_active:
                    return Response(
                        {'error': 'Session has been revoked. Please log in again.'},
                        status=status.HTTP_401_UNAUTHORIZED
                    )
            except Exception:
                pass  # Let simplejwt handle invalid tokens

        response = super().post(request, *args, **kwargs)

        # ── Update session activity on successful refresh ─────────────────
        if response.status_code == 200 and refresh_token:
            try:
                old_token = RefreshToken(refresh_token)
                old_jti = old_token.get('jti')

                new_refresh = response.data.get('refresh')
                if new_refresh:
                    new_token = RefreshToken(new_refresh)
                    new_jti = new_token.get('jti')

                    # Update session with new JTI (since we rotate tokens)
                    DeviceSession.objects.filter(refresh_jti=old_jti).update(
                        refresh_jti=new_jti,
                        last_active_at=timezone.now(),
                    )
            except Exception as e:
                logger.error(f'Session refresh update error: {e}')

        return response


class ActiveSessionsView(APIView):
    """
    Returns all active sessions for the current user.
    User sees this in their Profile → Security → Active Devices screen.
    """
    permission_classes = [IsAuthenticated]

    def get(self, request):
        sessions = DeviceSession.objects.filter(
            user=request.user, is_active=True
        ).order_by('-last_active_at')

        return Response([
            {
                'id': str(s.id),
                'device_name': s.display_name,
                'device_type': s.device_type,
                'ip_address': s.ip_address,
                'last_active_at': s.last_active_at.isoformat(),
                'created_at': s.created_at.isoformat(),
                'is_current': False,  # Frontend marks current session
            }
            for s in sessions
        ])


class RevokeSessionView(APIView):
    """
    Revokes a specific device session.
    User can log out their phone from their tablet, etc.

    URL: POST /api/users/sessions/<session_id>/revoke/
    """
    permission_classes = [IsAuthenticated]

    def post(self, request, session_id):
        try:
            session = DeviceSession.objects.get(
                id=session_id,
                user=request.user,  # CRITICAL: user can only revoke their own sessions
            )
        except DeviceSession.DoesNotExist:
            return Response({'error': 'Session not found'}, status=status.HTTP_404_NOT_FOUND)

        if not session.is_active:
            return Response({'message': 'Session already revoked'})

        try:
            # Blacklist the refresh token
            outstanding = OutstandingToken.objects.filter(
                jti=session.refresh_jti
            ).first()
            if outstanding:
                BlacklistedToken.objects.get_or_create(token=outstanding)
        except Exception as e:
            logger.error(f'Token blacklist error during revoke: {e}')

        session.is_active = False
        session.save(update_fields=['is_active'])

        logger.info(
            f'Session revoked: user={request.user.username} | '
            f'device={session.display_name} | by_user=True'
        )
        return Response({'message': f'"{session.display_name}" has been logged out.'})


class RevokeAllSessionsView(APIView):
    """
    Logs out ALL devices except the current one.
    Used when user changes password or suspects account compromise.

    Request body:
        { "current_refresh": "..." }   ← current device's refresh token (kept active)
    """
    permission_classes = [IsAuthenticated]

    def post(self, request):
        current_refresh = request.data.get('current_refresh')
        current_jti = None

        if current_refresh:
            try:
                current_jti = RefreshToken(current_refresh).get('jti')
            except Exception:
                pass

        # Get all OTHER active sessions
        other_sessions = DeviceSession.objects.filter(
            user=request.user,
            is_active=True,
        ).exclude(refresh_jti=current_jti) if current_jti else DeviceSession.objects.filter(
            user=request.user,
            is_active=True,
        )

        revoked_count = 0
        for session in other_sessions:
            try:
                outstanding = OutstandingToken.objects.filter(
                    jti=session.refresh_jti
                ).first()
                if outstanding:
                    BlacklistedToken.objects.get_or_create(token=outstanding)
                session.is_active = False
                session.save(update_fields=['is_active'])
                revoked_count += 1
            except Exception as e:
                logger.error(f'Error revoking session {session.id}: {e}')

        logger.info(
            f'All sessions revoked: user={request.user.username} | '
            f'count={revoked_count}'
        )
        return Response({
            'message': f'{revoked_count} other devices logged out.',
            'revoked_count': revoked_count,
        })


class CustomChangePasswordView(APIView):
    """
    Changes the user's password AND logs out all other devices.
    This is critical security — if password is changed, old sessions must die.
    """
    permission_classes = [IsAuthenticated]

    def post(self, request):
        old_password = request.data.get('old_password')
        new_password = request.data.get('new_password')

        if not old_password or not new_password:
            return Response(
                {'error': 'old_password and new_password are required'},
                status=status.HTTP_400_BAD_REQUEST
            )

        if not request.user.check_password(old_password):
            return Response(
                {'error': 'Current password is incorrect'},
                status=status.HTTP_400_BAD_REQUEST
            )

        if len(new_password) < 8:
            return Response(
                {'error': 'Password must be at least 8 characters'},
                status=status.HTTP_400_BAD_REQUEST
            )

        # Change password
        request.user.set_password(new_password)
        request.user.save(update_fields=['password'])

        # Revoke ALL sessions (user must log in again on all devices)
        all_sessions = DeviceSession.objects.filter(
            user=request.user, is_active=True
        )
        for session in all_sessions:
            try:
                outstanding = OutstandingToken.objects.filter(
                    jti=session.refresh_jti
                ).first()
                if outstanding:
                    BlacklistedToken.objects.get_or_create(token=outstanding)
            except Exception:
                pass

        all_sessions.update(is_active=False)

        logger.info(
            f'Password changed: user={request.user.username} | '
            f'all sessions revoked'
        )
        return Response({
            'message': 'Password changed. Please log in again on all devices.'
        })
