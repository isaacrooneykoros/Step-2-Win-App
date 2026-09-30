"""In-app social notifications (the Friends inbox).

The customer app has no server push; it polls ``/api/social/notifications/summary/``
(cheap: one indexed COUNT) and, when the user allows notifications on the device,
shows a local notification for new items. Each kind respects the recipient's social
notification preferences (SocialProfile.notify_*): a switched-off kind is not stored
at all, so it can't surface later either.
"""

from __future__ import annotations

import logging

from django.db import transaction

from .models import SocialNotification, SocialProfile

logger = logging.getLogger(__name__)

PREFERENCE_FOR_KIND = {
    SocialNotification.FRIEND_REQUEST: "notify_friend_requests",
    SocialNotification.FRIEND_ACCEPTED: "notify_friend_requests",
    SocialNotification.WEEKLY_RESULTS: "notify_weekly_results",
    SocialNotification.REACTION: "notify_reactions",
}
# Per-recipient cap on unread items of one kind (reactions could otherwise pile up).
MAX_UNREAD_PER_KIND = 50


def wants(profile: SocialProfile | None, kind: str) -> bool:
    field = PREFERENCE_FOR_KIND.get(kind)
    if field is None:
        return True  # service messages (team role / removal) always go through
    if profile is None:
        return field != "notify_reactions"  # defaults
    return bool(getattr(profile, field, True))


def notify(recipient, kind: str, *, actor=None, data: dict | None = None, profile=None) -> SocialNotification | None:
    """Store one notification; never raises (a notice must not fail the action)."""
    try:
        # Savepoint: a failure here never poisons the caller's transaction.
        with transaction.atomic():
            if profile is None:
                profile = SocialProfile.objects.filter(user=recipient).first()
            if not wants(profile, kind):
                return None
            if (
                SocialNotification.objects.filter(recipient=recipient, kind=kind, read_at__isnull=True).count()
                >= MAX_UNREAD_PER_KIND
            ):
                return None
            return SocialNotification.objects.create(
                recipient=recipient, actor=actor, kind=kind, data=data or {}
            )
    except Exception:
        logger.exception("social notify failed kind=%s recipient=%s", kind, getattr(recipient, "pk", None))
        return None
