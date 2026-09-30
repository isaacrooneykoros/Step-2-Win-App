"""In-app notices to a user from staff actions.

Same delivery as trust & safety and payout-review notices: a *resolved* support ticket
with one staff message, so it appears in the user's Support inbox in the app without
entering the open support queue (a user reply reopens it as a normal conversation).
A notice never blocks the action that sent it.
"""

import logging

from django.db import transaction
from django.utils import timezone

logger = logging.getLogger(__name__)

TEAM_BODY = {
    "payments": "Notice from the Step2Win payments team.",
    "support": "Notice from the Step2Win support team.",
}


def notice_to_user(user, admin, subject: str, message: str, *, category: str = "payment", team: str = "payments"):
    """Create the notice ticket; returns its id, or None if it could not be delivered."""
    from apps.admin_api.models import SupportTicket, SupportTicketMessage

    try:
        with transaction.atomic():
            ticket = SupportTicket.objects.create(
                user=user,
                subject=subject[:255],
                category=category,
                message=TEAM_BODY.get(team, TEAM_BODY["support"]),
                status="resolved",
                priority="medium",
                resolved_at=timezone.now(),
            )
            SupportTicketMessage.objects.create(
                ticket=ticket,
                sender=admin,
                sender_username=getattr(admin, "username", None) or "Step2Win",
                is_admin=True,
                message=message,
            )
        return ticket.id
    except Exception:
        logger.exception("Could not deliver a notice to user %s", getattr(user, "pk", None))
        return None
