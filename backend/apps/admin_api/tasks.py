import logging

from celery import shared_task

logger = logging.getLogger(__name__)


@shared_task
def escalate_overdue_support_tickets():
    """Beat task (every 15 min): escalate tickets waiting past their response target."""
    from apps.admin_api.support_rules import escalate_overdue

    count = escalate_overdue()
    if count:
        logger.info("Escalated %s overdue support ticket(s)", count)
    return count
