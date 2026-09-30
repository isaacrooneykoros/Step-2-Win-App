"""Who an announcement is for (platform + optional customer group)."""

from datetime import timedelta

from django.contrib.auth import get_user_model
from django.db.models import Q
from django.utils import timezone

from .models import Announcement

PLATFORMS = ("android", "ios", "web")
NEW_USER_DAYS = 14


def _segment_q(segment: str):
    """Q over users for a segment."""
    now = timezone.now()
    if segment == "active_challenge":
        return Q(challenge_participations__challenge__status="active")
    if segment == "paid_challenge":
        return Q(challenge_participations__challenge__status="active", challenge_participations__challenge__entry_fee__gt=0)
    if segment == "new_users":
        return Q(date_joined__gte=now - timedelta(days=NEW_USER_DAYS))
    if segment == "no_challenge_yet":
        return Q(challenges_joined=0)
    return Q(pk__in=[])


def user_in_segment(user, segment: str) -> bool:
    User = get_user_model()
    return User.objects.filter(pk=user.pk).filter(_segment_q(segment)).exists()


def matches(a: Announcement, user, platform: str | None) -> bool:
    if a.audience == Announcement.AUDIENCE_ALL:
        return True
    if a.audience in PLATFORMS:
        return platform == a.audience
    if a.audience == "segment":
        return bool(a.segment) and user_in_segment(user, a.segment)
    return False


def reach(a: Announcement) -> int | None:
    """Customers the announcement can reach (None when it depends on the device)."""
    User = get_user_model()
    base = User.objects.filter(is_active=True, is_staff=False)
    if hasattr(User, "deleted_at"):
        base = base.filter(deleted_at__isnull=True)
    if a.audience == Announcement.AUDIENCE_ALL:
        return base.count()
    if a.audience == "segment" and a.segment:
        return base.filter(_segment_q(a.segment)).distinct().count()
    return None
