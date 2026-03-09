from django.db.models.signals import post_save
from django.dispatch import receiver
from django.contrib.auth import get_user_model
from apps.gamification.models import UserBadge, XPEvent, DailyLoginStreak
from apps.users.models import UserXP

User = get_user_model()


@receiver(post_save, sender=User)
def create_user_xp_profile(sender, instance, created, **kwargs):
    """
    Create UserXP profile when a new user is created
    """
    if created:
        UserXP.objects.get_or_create(user=instance)
        DailyLoginStreak.objects.get_or_create(user=instance)


@receiver(post_save, sender=UserXP)
def check_level_up_badges(sender, instance, **kwargs):
    """
    Check for level-up related badges when XP changes
    """
    # Award level-specific badges
    level_badges = {
        10: 'level-10',
        25: 'level-25',
        50: 'level-50',
    }

    for level, badge_slug in level_badges.items():
        if instance.level >= level:
            try:
                from apps.gamification.models import Badge
                badge = Badge.objects.get(slug=badge_slug)
                UserBadge.objects.get_or_create(user=instance.user, badge=badge)
            except Badge.DoesNotExist:
                pass


@receiver(post_save, sender=XPEvent)
def process_xp_event(sender, instance, created, **kwargs):
    """
    Process XP events and award XP when event is created
    """
    if created and not instance.processed:
        try:
            xp_profile = UserXP.objects.get(user=instance.user)
            xp_profile.add_xp(instance.amount, source=instance.event_type)
            
            # Mark event as processed
            instance.processed = True
            instance.save(update_fields=['processed'])

            # Check for milestone badges
            check_milestone_badges(xp_profile)
            
        except UserXP.DoesNotExist:
            # Create if doesn't exist
            xp_profile = UserXP.objects.create(user=instance.user)
            xp_profile.add_xp(instance.amount, source=instance.event_type)
            instance.processed = True
            instance.save(update_fields=['processed'])


def check_milestone_badges(xp_profile):
    """
    Check and award milestone badges based on XP
    """
    milestone_badges = {
        100: 'first-steps',
        1000: 'thousand-xp',
        5000: 'five-thousand-xp',
        10000: 'ten-thousand-xp',
    }

    from apps.gamification.models import Badge
    
    for xp_threshold, badge_slug in milestone_badges.items():
        if xp_profile.total_xp >= xp_threshold:
            try:
                badge = Badge.objects.get(slug=badge_slug)
                UserBadge.objects.get_or_create(user=xp_profile.user, badge=badge)
            except Badge.DoesNotExist:
                pass
