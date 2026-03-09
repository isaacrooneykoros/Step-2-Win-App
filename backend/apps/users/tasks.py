"""
Celery tasks for user management and security.
"""
from celery import shared_task
from django.utils import timezone
from datetime import timedelta
import logging

logger = logging.getLogger(__name__)


@shared_task
def cleanup_inactive_sessions():
    """
    Runs nightly. Cleans up:
    1. Sessions inactive for more than 30 days
    2. Blacklisted tokens older than 60 days (keeps DB clean)
    """
    from apps.users.models import DeviceSession
    from rest_framework_simplejwt.token_blacklist.models import BlacklistedToken
    
    # Clean up old inactive sessions
    cutoff_sessions = timezone.now() - timedelta(days=30)
    deleted_sessions, _ = DeviceSession.objects.filter(
        is_active=False,
        last_active_at__lt=cutoff_sessions,
    ).delete()

    # Clean up old blacklisted tokens
    cutoff_tokens = timezone.now() - timedelta(days=60)
    deleted_tokens, _ = BlacklistedToken.objects.filter(
        blacklisted_at__lt=cutoff_tokens
    ).delete()

    logger.info(
        f'Cleanup: {deleted_sessions} old sessions, '
        f'{deleted_tokens} old blacklisted tokens removed'
    )
    
    return {
        'sessions_removed': deleted_sessions,
        'tokens_removed': deleted_tokens,
    }
