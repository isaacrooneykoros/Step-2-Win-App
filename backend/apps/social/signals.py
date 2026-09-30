"""Feed hooks that are cheap and rare. Step-driven milestones (goal hits, streaks,
challenge milestones) are picked up by the scheduled refresh job instead, so the step
sync path gains no extra queries."""

from django.db.models.signals import post_save
from django.dispatch import receiver

from apps.gamification.models import UserBadge

WEEKLY_BADGE_PREFIX = "weekly-"


@receiver(post_save, sender=UserBadge, dispatch_uid="social_badge_feed_event")
def badge_to_feed(sender, instance, created, **kwargs):
    if not created:
        return
    try:
        slug = instance.badge.slug or ""
        if slug.startswith(WEEKLY_BADGE_PREFIX):
            return  # weekly wins have their own feed item
        from .feed import record
        from .models import Friendship

        if not Friendship.objects.filter(user_id=instance.user_id).exists():
            return
        record(
            instance.user_id,
            "badge",
            slug,
            {"badge_name": instance.badge.name, "badge_type": instance.badge.badge_type, "badge_slug": slug},
        )
    except Exception:  # a feed item must never break awarding a badge
        import logging

        logging.getLogger(__name__).exception("badge feed hook failed")
