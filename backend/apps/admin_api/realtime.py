from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer


def _group_name(ticket_id: int) -> str:
    return f"support_ticket_{ticket_id}"


def broadcast_support_message(ticket_id: int, message_payload: dict):
    channel_layer = get_channel_layer()
    if not channel_layer:
        return
    async_to_sync(channel_layer.group_send)(
        _group_name(ticket_id),
        {
            'type': 'support.message',
            'message': message_payload,
        },
    )


def broadcast_support_ticket(ticket_id: int, ticket_payload: dict):
    channel_layer = get_channel_layer()
    if not channel_layer:
        return
    async_to_sync(channel_layer.group_send)(
        _group_name(ticket_id),
        {
            'type': 'support.ticket',
            'ticket': ticket_payload,
        },
    )
