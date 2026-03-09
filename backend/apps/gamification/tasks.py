from celery import shared_task
from django.utils import timezone
from django.contrib.auth import get_user_model
from datetime import timedelta, date
from apps.gamification.models import XPEvent, UserBadge, Badge, DailyLoginStreak
from apps.users.models import UserXP

User = get_user_model()


@shared_task(name='gamification.award_daily_login_xp')
def award_daily_login_xp():
    """
    Award +10 XP to users who have logged in today
    Runs once daily via Celery Beat
    """
    today = timezone.now().date()
    
    # Get users who logged in today
    login_streaks = DailyLoginStreak.objects.filter(last_login_date=today)
    
    awarded_count = 0
    for streak in login_streaks:
        # Check if XP event already exists for today
        existing = XPEvent.objects.filter(
            user=streak.user,
            event_type='daily_login',
            created_at__date=today
        ).exists()
        
        if not existing:
            XPEvent.objects.create(
                user=streak.user,
                event_type='daily_login',
                amount=10,
                description='Daily login bonus',
            )
            awarded_count += 1
    
    return f'Awarded daily login XP to {awarded_count} users'


@shared_task(name='gamification.award_challenge_xp')
def award_challenge_xp(user_id, event_type='challenge_complete', amount=50, challenge_id=None):
    """
    Award XP for challenge events (completion, win, etc.)
    Called directly when challenge events occur
    """
    try:
        user = User.objects.get(id=user_id)
        
        XPEvent.objects.create(
            user=user,
            event_type=event_type,
            amount=amount,
            challenge_id=challenge_id,
            description=f'Challenge {event_type}',
        )
        
        return f'Awarded {amount} XP for {event_type}'
    except User.DoesNotExist:
        return f'User {user_id} not found'


@shared_task(name='gamification.check_step_milestones')
def check_step_milestones(user_id):
    """
    Check if user has reached step milestones (50k, 70k, 90k, 100k)
    and award appropriate XP/badges
    """
    try:
        user = User.objects.get(id=user_id)
    except User.DoesNotExist:
        return f'User {user_id} not found'

    milestone_steps = {
        50000: ('step-50k', 100),
        70000: ('step-70k', 150),
        90000: ('step-90k', 200),
        100000: ('step-100k', 250),
    }

    for steps, (badge_slug, xp_bonus) in milestone_steps.items():
        if user.total_steps >= steps:
            # Check if badge already awarded
            try:
                badge = Badge.objects.get(slug=badge_slug)
                if not UserBadge.objects.filter(user=user, badge=badge).exists():
                    UserBadge.objects.create(user=user, badge=badge)
                    
                    # Award bonus XP
                    XPEvent.objects.create(
                        user=user,
                        event_type='step_milestone',
                        amount=xp_bonus,
                        description=f'Reached {steps} steps milestone',
                    )
            except Badge.DoesNotExist:
                pass

    return f'Checked milestones for user {user_id}'


@shared_task(name='gamification.reset_weekly_xp')
def reset_weekly_xp():
    """
    Reset weekly XP counter every Monday
    Runs once weekly via Celery Beat
    """
    from django.utils import timezone
    now = timezone.now()
    
    # Only run on Mondays
    if now.weekday() != 0:
        return 'Not Monday, skipping weekly reset'

    updated = UserXP.objects.all().update(
        xp_this_week=0,
        weekly_reset=now
    )

    return f'Reset weekly XP for {updated} users'


@shared_task(name='gamification.award_streak_milestone_badges')
def award_streak_milestone_badges():
    """
    Check for streak milestones and award badges
    Runs daily via Celery Beat
    """
    streak_milestones = {
        7: 'streak-7',
        14: 'streak-14',
        30: 'streak-30',
        100: 'streak-100',
    }

    awarded = 0
    for days, badge_slug in streak_milestones.items():
        try:
            badge = Badge.objects.get(slug=badge_slug)
            
            # Find users with this streak
            streaks = DailyLoginStreak.objects.filter(current_streak=days)
            
            for streak in streaks:
                if not UserBadge.objects.filter(user=streak.user, badge=badge).exists():
                    UserBadge.objects.create(user=streak.user, badge=badge)
                    awarded += 1
        except Badge.DoesNotExist:
            pass

    return f'Awarded streak badges to {awarded} users'


@shared_task(name='gamification.process_pending_xp_events')
def process_pending_xp_events():
    """
    Process any XP events that failed to process initially
    Runs periodically via Celery Beat
    """
    pending_events = XPEvent.objects.filter(processed=False)

    processed = 0
    for event in pending_events:
        try:
            xp_profile = UserXP.objects.get(user=event.user)
            xp_profile.add_xp(event.amount, source=event.event_type)
            event.processed = True
            event.save()
            processed += 1
        except Exception:
            # Skip events that can't be processed
            pass

    return f'Processed {processed} pending XP events'


@shared_task(name='gamification.clean_old_xp_events')
def clean_old_xp_events(days=90):
    """
    Archive or delete old XP events (older than 90 days)
    Helps keep database clean
    """
    cutoff_date = timezone.now() - timedelta(days=days)
    deleted_count, _ = XPEvent.objects.filter(
        created_at__lt=cutoff_date,
        processed=True
    ).delete()

    return f'Deleted {deleted_count} old XP events'
