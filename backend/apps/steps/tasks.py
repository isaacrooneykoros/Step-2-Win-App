from celery import shared_task
from django.utils import timezone
from django.db.models import Sum
from datetime import timedelta
import logging

logger = logging.getLogger(__name__)


@shared_task
def finalize_completed_challenges():
    """
    Run daily — check for challenges past end_date and distribute payouts.
    This task should run at 00:05 UTC daily.
    """
    from apps.challenges.services import finalize_expired_challenges

    today = timezone.now().date()
    finalized = finalize_expired_challenges(today=today)
    logger.info(f'Finalized {finalized} completed challenges')
    return f'Finalized {finalized} challenges'


@shared_task
def calculate_user_streaks():
    """
    Calculate and update current streaks for all active users
    """
    from apps.users.models import User
    from apps.steps.models import HealthRecord
    
    today = timezone.now().date()
    users = User.objects.filter(is_active=True, device_id__isnull=False)
    
    updated_count = 0
    
    for user in users:
        streak = 0
        current_date = today
        
        # Count consecutive days with steps
        while True:
            record = HealthRecord.objects.filter(
                user=user,
                date=current_date
            ).first()
            
            if not record or record.steps == 0:
                break
            
            streak += 1
            current_date -= timedelta(days=1)
            
            if streak > 365:  # Safety limit
                break
        
        if user.current_streak != streak:
            user.current_streak = streak
            user.save(update_fields=['current_streak'])
            updated_count += 1
    
    logger.info(f'Updated streaks for {updated_count} users')
    return f'Updated {updated_count} user streaks'


@shared_task
def cleanup_old_suspicious_activities():
    """
    Clean up reviewed suspicious activities older than 90 days
    """
    from apps.steps.models import SuspiciousActivity

    cutoff_date = timezone.now() - timedelta(days=90)
    deleted_count, _ = SuspiciousActivity.objects.filter(
        reviewed=True,
        created_at__lt=cutoff_date
    ).delete()

    logger.info(f'Cleaned up {deleted_count} old suspicious activity records')
    return f'Deleted {deleted_count} old records'


@shared_task
def nightly_fraud_scan():
    """2 AM nightly: catches multi-day patterns missed by real-time checks.

    Performance: replaces per-user query loops with two bulk aggregations —
    one for 14-consecutive-high-step-days and one for weekly totals.
    """
    from django.contrib.auth import get_user_model
    from django.db.models import Count, Q
    from apps.steps.models import HealthRecord, FraudFlag

    user_model = get_user_model()
    today = timezone.now().date()
    yesterday = today - timedelta(days=1)
    window_start = yesterday - timedelta(days=13)   # 14-day window
    week_start = yesterday - timedelta(days=6)      # 7-day window

    # ── Flag 1: no_rest_days — 14 consecutive days with 40k+ steps ──────
    # Count high-step days per user in one aggregation query.
    high_step_counts = (
        HealthRecord.objects
        .filter(
            date__gte=window_start,
            date__lte=yesterday,
            steps__gte=40_000,
            is_suspicious=False,
            user__is_active=True,
        )
        .values('user_id')
        .annotate(high_days=Count('id'))
        .filter(high_days__gte=14)
    )

    for row in high_step_counts:
        user = user_model.objects.get(id=row['user_id'])
        FraudFlag.objects.get_or_create(
            user=user,
            date=yesterday,
            flag_type='no_rest_days',
            defaults={
                'severity': 'medium',
                'details': {
                    'consecutive_days': row['high_days'],
                    'note': f"{row['high_days']} consecutive days of 40k+ steps",
                },
            },
        )

    # ── Flag 2: weekly_cap — > 420,000 steps in 7 days ──────────────────
    weekly_totals = (
        HealthRecord.objects
        .filter(
            date__gte=week_start,
            date__lte=yesterday,
            user__is_active=True,
        )
        .values('user_id')
        .annotate(week_total=Sum('steps'))
        .filter(week_total__gt=420_000)
    )

    for row in weekly_totals:
        user = user_model.objects.get(id=row['user_id'])
        FraudFlag.objects.get_or_create(
            user=user,
            date=yesterday,
            flag_type='weekly_cap',
            defaults={
                'severity': 'high',
                'details': {
                    'week_total': row['week_total'],
                    'note': f"Weekly {row['week_total']:,} > 420,000 maximum",
                },
            },
        )

    logger.info('Nightly fraud scan complete')
    return 'Nightly fraud scan complete'


@shared_task
def update_participant_consistency_stats():
    """
    Runs nightly at midnight.
    Updates zero_step_days and longest_streak for all active challenge participants.
    These are the Level 3 and Level 6 tiebreaker criteria.
    """
    from apps.challenges.models import Challenge, Participant
    from apps.steps.models import HealthRecord
    import datetime

    active_challenges = Challenge.objects.filter(status='active')
    total_updated = 0

    for challenge in active_challenges:
        participants = challenge.participants.select_related('user').all()

        for participant in participants:
            # Get all days in challenge window up to today
            today = timezone.now().date()
            days_so_far = (min(today, challenge.end_date) - challenge.start_date).days + 1
            all_dates   = [
                challenge.start_date + datetime.timedelta(days=i)
                for i in range(days_so_far)
            ]

            # Step counts per day
            step_records = {
                r.date: r.steps
                for r in HealthRecord.objects.filter(
                    user=participant.user,
                    date__gte=challenge.start_date,
                    date__lte=min(today, challenge.end_date),
                    is_suspicious=False,
                )
            }

            # Count zero-step days
            zero_days = sum(
                1 for d in all_dates
                if step_records.get(d, 0) == 0
            )

            # Calculate longest streak
            longest = 0
            current = 0
            for d in all_dates:
                if step_records.get(d, 0) > 0:
                    current += 1
                    longest = max(longest, current)
                else:
                    current = 0

            participant.zero_step_days = zero_days
            participant.longest_streak = longest
            participant.save(update_fields=['zero_step_days', 'longest_streak'])
            total_updated += 1

    logger.info(f'update_participant_consistency_stats: updated {total_updated} participants.')
    return f'Updated {total_updated} participants'


@shared_task
def update_user_streak_records():
    """
    Runs nightly. Updates current_streak and best_streak for all users.
    current_streak = consecutive days with steps > 0 ending today
    best_streak    = max streak ever — only ever goes up

    Performance: instead of issuing one DB query per user per day in a Python
    loop (O(users × streak_length) queries), we fetch all relevant HealthRecord
    dates in a single bulk query, then compute streaks entirely in Python.
    """
    from apps.users.models import User
    from apps.steps.models import HealthRecord
    import datetime

    today = timezone.now().date()

    # ── Step 1: fetch all non-suspicious step dates per active user ──────
    # A single query; 365-day lookback covers the max possible streak.
    lookback = today - datetime.timedelta(days=365)
    step_dates_qs = (
        HealthRecord.objects
        .filter(
            user__is_active=True,
            date__gte=lookback,
            steps__gt=0,
            is_suspicious=False,
        )
        .values_list('user_id', 'date')
        .order_by('user_id', 'date')
    )

    # Build a set of step-days per user in Python
    from collections import defaultdict
    step_days: dict[int, set] = defaultdict(set)
    for user_id, date in step_dates_qs:
        step_days[user_id].add(date)

    # ── Step 2: compute streaks and bulk-update ───────────────────────────
    users = User.objects.filter(is_active=True).only('id', 'current_streak', 'best_streak')
    updated_count = 0

    for user in users:
        days = step_days.get(user.id, set())

        streak = 0
        check_date = today
        while check_date in days and streak <= 365:
            streak += 1
            check_date -= datetime.timedelta(days=1)

        updates = {'current_streak': streak}
        if streak > user.best_streak:
            updates['best_streak'] = streak

        User.objects.filter(id=user.id).update(**updates)
        updated_count += 1

    logger.info(f'update_user_streak_records: updated {updated_count} users.')
    return f'Updated {updated_count} users'
