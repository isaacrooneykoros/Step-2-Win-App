"""Scheduled jobs (CELERY_BEAT_SCHEDULE, run by apps/admin_api/scheduler.py)."""

from celery import shared_task


@shared_task
def run_privacy_retention_task():
    """Hourly at :50 UTC: privacy retention rules (apps/privacy/retention.py)."""
    from .retention import run_retention

    return run_retention()


@shared_task
def process_data_exports_task():
    """Every 5 minutes: build waiting "download my data" archives (apps/privacy/export.py)."""
    from .export import process_pending_exports

    return process_pending_exports()
