import logging

from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer

logger = logging.getLogger(__name__)


def _group_name(ticket_id: int) -> str:
    return f"support_ticket_{ticket_id}"


def _safe_group_send(group: str, event: dict) -> bool:
    """Best-effort realtime fan-out.

    Callers invoke this *after* the database write has succeeded, so a missing
    or unreachable channel layer (e.g. Redis down) must not turn a saved ticket
    or reply into a 500. Failures are logged as warnings; clients still get the
    change on their next fetch. Returns True when the event was handed off.
    """
    try:
        channel_layer = get_channel_layer()
        if not channel_layer:
            return False
        async_to_sync(channel_layer.group_send)(group, event)
        return True
    except Exception as exc:  # noqa: BLE001 - any transport error is non-fatal here
        logger.warning(
            "Realtime broadcast to %s failed (%s: %s); continuing without it.",
            group,
            type(exc).__name__,
            exc,
        )
        return False


def broadcast_support_message(ticket_id: int, message_payload: dict):
    return _safe_group_send(
        _group_name(ticket_id),
        {
            "type": "support.message",
            "message": message_payload,
        },
    )


def broadcast_support_ticket(ticket_id: int, ticket_payload: dict):
    return _safe_group_send(
        _group_name(ticket_id),
        {
            "type": "support.ticket",
            "ticket": ticket_payload,
        },
    )


def _admin_steps_group_name() -> str:
    return "admin_steps_live"


def broadcast_admin_steps_update(step_payload: dict):
    return _safe_group_send(
        _admin_steps_group_name(),
        {
            "type": "admin.steps.update",
            "payload": step_payload,
        },
    )
