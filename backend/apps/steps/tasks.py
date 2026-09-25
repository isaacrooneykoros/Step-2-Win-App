import logging
from datetime import timedelta

from celery import shared_task
from django.conf import settings
from django.db.models import Sum
from django.utils import timezone

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
    logger.info(f"Finalized {finalized} completed challenges")
    return f"Finalized {finalized} challenges"


@shared_task
def calculate_user_streaks():
    """
    Calculate and update current streaks for all active users
    """
    from apps.steps.models import HealthRecord
    from apps.users.models import User

    today = timezone.now().date()
    users = User.objects.filter(is_active=True, device_id__isnull=False)

    updated_count = 0

    for user in users:
        streak = 0
        current_date = today

        # Count consecutive days with steps
        while True:
            record = HealthRecord.objects.filter(user=user, date=current_date).first()

            if not record or record.steps == 0:
                break

            streak += 1
            current_date -= timedelta(days=1)

            if streak > 365:  # Safety limit
                break

        if user.current_streak != streak:
            user.current_streak = streak
            user.save(update_fields=["current_streak"])
            updated_count += 1

    logger.info(f"Updated streaks for {updated_count} users")
    return f"Updated {updated_count} user streaks"


@shared_task
def cleanup_old_suspicious_activities():
    """
    Clean up reviewed suspicious activities older than 90 days
    """
    from apps.steps.models import SuspiciousActivity

    cutoff_date = timezone.now() - timedelta(days=90)
    deleted_count, _ = SuspiciousActivity.objects.filter(
        reviewed=True, created_at__lt=cutoff_date
    ).delete()

    logger.info(f"Cleaned up {deleted_count} old suspicious activity records")
    return f"Deleted {deleted_count} old records"


@shared_task
def nightly_fraud_scan():
    """2 AM nightly: catches multi-day patterns missed by real-time checks.

    Two aggregate queries (per-user counts/sums in the database) instead of two
    queries per active user, so the scan's memory stays flat in the shared web process.
    Idempotent: flags are get_or_create per (user, day, type).
    """
    from django.db.models import Count

    from apps.steps.models import FraudFlag, HealthRecord

    today = timezone.now().date()
    yesterday = today - timedelta(days=1)

    # 14 consecutive days (yesterday-13 .. yesterday) of 40k+ accepted steps.
    no_rest = (
        HealthRecord.objects.filter(
            date__gte=yesterday - timedelta(days=13),
            date__lte=yesterday,
            steps__gte=40_000,
            is_suspicious=False,
        )
        .values("user_id")
        .annotate(high_days=Count("id"))
        .filter(high_days__gte=14)
        .order_by()
    )
    flagged = 0
    for row in list(no_rest):  # only the flagged users come back
        high_days = row["high_days"]
        _, created = FraudFlag.objects.get_or_create(
            user_id=row["user_id"],
            date=yesterday,
            flag_type="no_rest_days",
            defaults={
                "severity": "medium",
                "details": {
                    "consecutive_days": high_days,
                    "note": f"{high_days} consecutive days of 40k+ steps",
                },
            },
        )
        flagged += int(created)

    # 7-day total (yesterday-6 .. yesterday) above the weekly maximum.
    weekly = (
        HealthRecord.objects.filter(
            date__gte=yesterday - timedelta(days=6),
            date__lte=yesterday,
        )
        .values("user_id")
        .annotate(total=Sum("steps"))
        .filter(total__gt=420_000)
        .order_by()
    )
    for row in list(weekly):
        total = row["total"]
        _, created = FraudFlag.objects.get_or_create(
            user_id=row["user_id"],
            date=yesterday,
            flag_type="weekly_cap",
            defaults={
                "severity": "high",
                "details": {
                    "week_total": total,
                    "note": f"Weekly {total:,} > 420,000 maximum",
                },
            },
        )
        flagged += int(created)

    logger.info("Nightly fraud scan complete (%s new flags)", flagged)
    return f"Nightly fraud scan complete ({flagged} new flags)"


@shared_task
def update_participant_consistency_stats():
    """
    Runs nightly at midnight.
    Updates zero_step_days and longest_streak for all active challenge participants.
    These are the Level 3 and Level 6 tiebreaker criteria.
    """
    import datetime

    from apps.challenges.models import Challenge, Participant
    from apps.steps.models import HealthRecord

    active_challenges = Challenge.objects.filter(status="active")
    total_updated = 0

    for challenge in active_challenges:
        participants = challenge.participants.select_related("user").all()

        for participant in participants:
            # Get all days in challenge window up to today
            today = timezone.now().date()
            days_so_far = (
                min(today, challenge.end_date) - challenge.start_date
            ).days + 1
            all_dates = [
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
            zero_days = sum(1 for d in all_dates if step_records.get(d, 0) == 0)

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
            participant.save(update_fields=["zero_step_days", "longest_streak"])
            total_updated += 1

    logger.info(
        f"update_participant_consistency_stats: updated {total_updated} participants."
    )
    return f"Updated {total_updated} participants"


STREAK_BATCH_SIZE = 200
STREAK_LOOKBACK_DAYS = 400


@shared_task
def update_user_streak_records():
    """
    Runs nightly (00:15 UTC). Updates current_streak and best_streak for all users.

    Same rule as the live sync (apps.steps.daily_reset.update_streak): consecutive days
    with >= MIN_STEPS_FOR_STREAK steps, ending today, or ending yesterday while today
    is not yet qualified (so the job never wipes a streak just after midnight).
    Suspicious days never count. best_streak only ever goes up.

    Memory: users are streamed in batches of STREAK_BATCH_SIZE, with one query per
    batch for their qualifying days. Only rows whose values change are written.
    Idempotent: re-running it computes the same values.
    """
    from apps.steps.daily_reset import MIN_STEPS_FOR_STREAK, streak_from_days
    from apps.steps.models import HealthRecord
    from apps.users.models import User

    today = timezone.now().date()
    since = today - timedelta(days=STREAK_LOOKBACK_DAYS)
    users = User.objects.filter(is_active=True).order_by("id")

    checked = changed = 0
    last_id = 0
    while True:
        # Keyset pagination (no server-side cursor, safe behind a pooler); one batch
        # of users and their qualifying days in memory at a time.
        rows = list(
            users.filter(id__gt=last_id).values_list(
                "id", "current_streak", "best_streak"
            )[:STREAK_BATCH_SIZE]
        )
        if not rows:
            break
        last_id = rows[-1][0]
        checked += len(rows)
        ids = [r[0] for r in rows]
        days: dict[int, set] = {i: set() for i in ids}
        for user_id, day in HealthRecord.objects.filter(
            user_id__in=ids,
            date__gte=since,
            date__lte=today,
            steps__gte=MIN_STEPS_FOR_STREAK,
            is_suspicious=False,
        ).values_list("user_id", "date"):
            days[user_id].add(day)
        for user_id, current, best in rows:
            streak = streak_from_days(days[user_id], today)
            new_best = max(best or 0, streak)
            if streak != current or new_best != best:
                User.objects.filter(id=user_id).update(
                    current_streak=streak, best_streak=new_best
                )
                changed += 1

    logger.info(f"update_user_streak_records: checked {checked}, updated {changed} users.")
    return f"Checked {checked} users, updated {changed}"


@shared_task
def monitor_anticheat_shadow_drift_task():
    """
    Runs periodic anti-cheat shadow drift checks and emits ops webhook alerts
    when v2 shadow diverges from legacy accepted totals beyond configured bounds.
    """
    from apps.steps.drift_monitor import (AntiCheatDriftThresholds,
                                          run_anticheat_shadow_drift_monitor)

    thresholds = AntiCheatDriftThresholds(
        lookback_hours=int(getattr(settings, "ANTICHEAT_DRIFT_LOOKBACK_HOURS", 24)),
        min_samples=int(getattr(settings, "ANTICHEAT_DRIFT_MIN_SAMPLES", 50)),
        per_sample_alert_pct=float(
            getattr(settings, "ANTICHEAT_DRIFT_PER_SAMPLE_ALERT_PCT", 35.0)
        ),
        max_avg_abs_delta_pct=float(
            getattr(settings, "ANTICHEAT_DRIFT_MAX_AVG_ABS_DELTA_PCT", 20.0)
        ),
        max_high_drift_ratio_pct=float(
            getattr(settings, "ANTICHEAT_DRIFT_MAX_HIGH_DRIFT_RATIO_PCT", 25.0)
        ),
        max_review_mismatch_ratio_pct=float(
            getattr(settings, "ANTICHEAT_DRIFT_MAX_REVIEW_MISMATCH_RATIO_PCT", 10.0)
        ),
    )
    return run_anticheat_shadow_drift_monitor(thresholds=thresholds, send_alerts=True)
