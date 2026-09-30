"""Activity feed: friends' milestones and a small fixed set of reactions.

Only milestones are ever recorded (daily goal reached, streak milestones, badges,
challenge milestone reached, weekly friends-ranking top spot). Never locations, routes,
step timelines, money, or anything from anti-cheat. What a user shares is checked at
READ time against their current settings, so switching a category off also hides
past items. No free-text comments in v1 (no moderation load).
"""

from __future__ import annotations

import logging
from datetime import timedelta

from django.db import IntegrityError, transaction
from django.db.models import Count
from django.utils import timezone

from .common import SocialError, hidden_user_ids, public_user, require_social_enabled
from .models import FeedEvent, FeedReaction, SocialNotification, SocialProfile
from .notify import notify

logger = logging.getLogger(__name__)

FEED_WINDOW_DAYS = 30
PAGE_SIZE = 20
STREAK_MILESTONES = (7, 14, 21, 30, 50, 75, 100, 150, 200, 365)

SHARE_FIELD = {
    FeedEvent.GOAL_HIT: "share_goal_hits",
    FeedEvent.STREAK: "share_streaks",
    FeedEvent.BADGE: "share_badges",
    FeedEvent.WEEKLY_WINNER: "share_badges",
    FeedEvent.CHALLENGE_QUALIFIED: "share_challenges",
}


def record(user_id: int, kind: str, key: str, data: dict | None = None) -> FeedEvent | None:
    """Idempotent: one event per (user, kind, key)."""
    try:
        with transaction.atomic():
            event, _ = FeedEvent.objects.get_or_create(
                user_id=user_id, kind=kind, key=str(key)[:64], defaults={"data": data or {}}
            )
            return event
    except IntegrityError:
        return FeedEvent.objects.filter(user_id=user_id, kind=kind, key=str(key)[:64]).first()
    except Exception:
        logger.exception("feed record failed user=%s kind=%s", user_id, kind)
        return None


def _shares(profile: SocialProfile | None, kind: str) -> bool:
    field = SHARE_FIELD.get(kind)
    if not field:
        return False
    return True if profile is None else bool(getattr(profile, field, True))


def list_feed(me, *, before_id: int | None = None, request=None) -> dict:
    from .friends import friend_ids

    require_social_enabled("feed")
    actors = (friend_ids(me.id) - hidden_user_ids(me.id)) | {me.id}
    since = timezone.now() - timedelta(days=FEED_WINDOW_DAYS)
    qs = FeedEvent.objects.filter(
        user_id__in=actors, created_at__gte=since, user__is_active=True, user__deleted_at__isnull=True
    ).select_related("user", "user__social_profile")
    if before_id:
        qs = qs.filter(id__lt=before_id)
    items = []
    last_id = None
    # Over-fetch a little: some rows are filtered by the actor's share settings.
    batch = list(qs.order_by("-id")[: PAGE_SIZE * 3])
    for e in batch:
        last_id = e.id
        try:
            profile = e.user.social_profile
        except SocialProfile.DoesNotExist:
            profile = None
        if not _shares(profile, e.kind):
            continue
        items.append(e)
        if len(items) >= PAGE_SIZE:
            break
    ids = [e.id for e in items]
    counts: dict[int, dict[str, int]] = {}
    for r in FeedReaction.objects.filter(event_id__in=ids).exclude(user_id__in=hidden_user_ids(me.id)).values(
        "event_id", "kind"
    ).annotate(n=Count("id")):
        counts.setdefault(r["event_id"], {})[r["kind"]] = r["n"]
    mine = dict(FeedReaction.objects.filter(event_id__in=ids, user=me).values_list("event_id", "kind"))
    has_more = len(items) >= PAGE_SIZE or len(batch) == PAGE_SIZE * 3
    return {
        "items": [
            {
                "id": e.id,
                "kind": e.kind,
                "user": public_user(e.user, request),
                "is_me": e.user_id == me.id,
                "data": e.data,
                "created_at": e.created_at.isoformat(),
                "reactions": counts.get(e.id, {}),
                "my_reaction": mine.get(e.id),
            }
            for e in items
        ],
        "next_before_id": last_id if has_more else None,
    }


def react(me, event_id: int, kind: str | None) -> dict:
    from .friends import are_friends

    require_social_enabled("feed")
    event = FeedEvent.objects.select_related("user").filter(id=event_id).first()
    if event is None or event.user_id in hidden_user_ids(me.id):
        raise SocialError("not_found", "This update isn't available.", 404)
    if event.user_id != me.id and not are_friends(me.id, event.user_id):
        raise SocialError("not_found", "This update isn't available.", 404)
    if kind in (None, ""):
        FeedReaction.objects.filter(event=event, user=me).delete()
        return {"my_reaction": None}
    if kind not in dict(FeedReaction.KIND_CHOICES):
        raise SocialError("invalid_reaction", "Unknown reaction.", 400)
    obj, created = FeedReaction.objects.update_or_create(event=event, user=me, defaults={"kind": kind})
    if created and event.user_id != me.id:
        notify(event.user, SocialNotification.REACTION, actor=me, data={"event_id": event.id, "reaction": kind, "event_kind": event.kind})
    return {"my_reaction": obj.kind}
