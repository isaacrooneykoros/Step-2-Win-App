"""
Daily reset and streak calculation utilities for Step2Win.

Handles:
- Daily step counter reset at midnight
- Streak calculation based on consecutive days with steps
- Step threshold configuration for streak eligibility
"""

from datetime import timedelta
from django.utils import timezone
from apps.steps.models import HealthRecord

# Minimum steps required on a day to count towards streak
MIN_STEPS_FOR_STREAK = 1000


def get_today_date():
    """Get today's date in the user's timezone (currently UTC)."""
    return timezone.now().date()


def get_yesterday_date():
    """Get yesterday's date."""
    return get_today_date() - timedelta(days=1)


def get_today_health_record(user):
    """
    Get or create today's health record for a user.
    Ensures we always have a record for today.
    """
    today = get_today_date()
    record, created = HealthRecord.objects.get_or_create(
        user=user,
        date=today,
        defaults={'steps': 0}
    )
    return record, created


def reset_daily_stats_if_needed(user):
    """
    Check if it's a new day and reset today's stats if necessary.
    This is called on every app sync to ensure consistent state.
    
    Returns:
        reset: bool - True if reset occurred, False if still same day
    """
    # Get today and yesterday
    today = get_today_date()
    yesterday = get_yesterday_date()
    
    # Ensure we have today's record
    today_record, created = get_today_health_record(user)
    
    if created:
        # We just created today's record, so it's a new day
        # Check streak
        update_streak(user)
        return True
    
    return False


def update_streak(user):
    """
    Calculate and update user's current_streak and best_streak.
    
    Logic:
    - Current streak: Count consecutive days ending today with >= MIN_STEPS_FOR_STREAK
    - Best streak: Track the longest streak ever achieved
    - If today has no steps yet, streak is maintained but not extended
    - If a day is skipped, streak is broken
    """
    today = get_today_date()
    
    # Pull recent records and map by date for direct day lookups.
    records = HealthRecord.objects.filter(user=user, date__lte=today).values('date', 'steps')
    records_by_date = {row['date']: row['steps'] for row in records}

    current_streak = 0
    today_steps = records_by_date.get(today, 0)

    # If today is not yet qualified, we still allow streak continuity from yesterday.
    checking_date = today if today_steps >= MIN_STEPS_FOR_STREAK else today - timedelta(days=1)

    while True:
        steps = records_by_date.get(checking_date)
        if steps is None or steps < MIN_STEPS_FOR_STREAK:
            break
        current_streak += 1
        checking_date -= timedelta(days=1)
    
    # Update best_streak if current exceeds it
    new_best_streak = max(user.best_streak, current_streak)
    
    # Update user
    user.current_streak = current_streak
    user.best_streak = new_best_streak
    user.save(update_fields=['current_streak', 'best_streak', 'updated_at'])
    
    return current_streak


def should_extend_streak(user, new_steps: int) -> bool:
    """
    Determine if the given step count should extend/maintain the streak.
    """
    return new_steps >= MIN_STEPS_FOR_STREAK


def get_streak_status(user):
    """
    Get detailed streak information for a user.
    
    Returns:
        dict with:
        - current: Current streak in days
        - best: Best streak ever achieved
        - today_steps: Steps recorded for today
        - status: 'active', 'at_risk', or 'broken'
        - days_since_last_activity: Days since last day with steps
    """
    today = get_today_date()
    
    try:
        today_record = HealthRecord.objects.get(user=user, date=today)
        today_steps = today_record.steps
    except HealthRecord.DoesNotExist:
        today_record = None
        today_steps = 0
    
    # Determine streak status
    if today_steps >= MIN_STEPS_FOR_STREAK:
        status = 'active'
    elif user.current_streak > 0:
        status = 'at_risk'
    else:
        status = 'broken'
    
    # Calculate days since last activity
    last_active = HealthRecord.objects.filter(
        user=user,
        date__lt=today,
        steps__gte=MIN_STEPS_FOR_STREAK
    ).order_by('-date').first()
    
    days_since_last = (today - last_active.date).days if last_active else None
    
    return {
        'current': user.current_streak,
        'best': user.best_streak,
        'today_steps': today_steps,
        'status': status,
        'days_since_last_activity': days_since_last,
        'min_steps_for_streak': MIN_STEPS_FOR_STREAK,
    }


def reset_streak_if_broken(user):
    """
    Check if streak should be reset due to missed days.
    Called during daily sync/check.
    
    Returns:
        reset: bool - True if streak was reset
    """
    today = get_today_date()
    yesterday = get_yesterday_date()
    
    # Get yesterday's record
    try:
        yesterday_record = HealthRecord.objects.get(user=user, date=yesterday)
        yesterday_steps = yesterday_record.steps
    except HealthRecord.DoesNotExist:
        yesterday_steps = 0
    
    # If yesterday had insufficient steps and streak was active, break it
    if user.current_streak > 0 and yesterday_steps < MIN_STEPS_FOR_STREAK:
        user.current_streak = 0
        user.save(update_fields=['current_streak', 'updated_at'])
        return True
    
    return False
