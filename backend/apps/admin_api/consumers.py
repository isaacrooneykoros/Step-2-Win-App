import json
from urllib.parse import parse_qs

from channels.db import database_sync_to_async
from channels.generic.websocket import AsyncWebsocketConsumer
from django.contrib.auth import get_user_model
from rest_framework_simplejwt.exceptions import TokenError
from rest_framework_simplejwt.tokens import AccessToken

from apps.admin_api.models import SupportTicket

User = get_user_model()


class SupportChatConsumer(AsyncWebsocketConsumer):
    async def connect(self):
        self.user = await self._authenticate_user()
        if not self.user:
            await self.close(code=4001)
            return

        self.ticket_id = self.scope['url_route']['kwargs']['ticket_id']
        self.ticket = await self._get_ticket(self.ticket_id)
        if not self.ticket:
            await self.close(code=4404)
            return

        is_allowed = await self._can_access_ticket(self.user.id, self.ticket.user_id)
        if not is_allowed:
            await self.close(code=4403)
            return

        self.group_name = f"support_ticket_{self.ticket_id}"
        await self.channel_layer.group_add(self.group_name, self.channel_name)
        await self.accept()

        await self.send(text_data=json.dumps({
            'type': 'support.connected',
            'ticket_id': self.ticket_id,
        }))

    async def disconnect(self, _close_code):
        if hasattr(self, 'group_name'):
            await self.channel_layer.group_discard(self.group_name, self.channel_name)

    async def receive(self, text_data=None, _bytes_data=None):
        # Messaging is persisted via existing HTTP endpoints.
        # WebSocket is used for real-time push updates only.
        return

    async def support_message(self, event):
        await self.send(text_data=json.dumps({
            'type': 'support.message',
            'message': event['message'],
        }))

    async def support_ticket(self, event):
        await self.send(text_data=json.dumps({
            'type': 'support.ticket',
            'ticket': event['ticket'],
        }))

    async def _authenticate_user(self):
        query_string = self.scope.get('query_string', b'').decode('utf-8')
        token = parse_qs(query_string).get('token', [None])[0]
        if not token:
            return None

class AdminStepsLiveConsumer(AsyncWebsocketConsumer):
    async def connect(self):
        query_string = self.scope.get('query_string', b'').decode()
        params = parse_qs(query_string)
        token = (params.get('token') or [None])[0]

        if not token:
            await self.close(code=4401)
            return

        user = await self._get_user_from_token(token)
        if not user or not user.is_staff:
            await self.close(code=4403)
            return

        self.group_name = 'admin_steps_live'
        await self.channel_layer.group_add(self.group_name, self.channel_name)
        await self.accept()
        await self.send(text_data=json.dumps({'type': 'admin.steps.connected'}))

    async def disconnect(self, _close_code):
        if hasattr(self, 'group_name'):
            await self.channel_layer.group_discard(self.group_name, self.channel_name)

    async def receive(self, text_data=None, _bytes_data=None):
        return

    async def admin_steps_update(self, event):
        await self.send(text_data=json.dumps({
            'type': 'admin.steps.update',
            'payload': event.get('payload', {}),
        }))

    async def _get_user_from_token(self, token):
        try:
            access = AccessToken(token)
            user_id = access.get('user_id')
            if not user_id:
                return None
            return await User.objects.filter(id=user_id).afirst()
        except (TokenError, Exception):
            return None
        try:
            access = AccessToken(token)
            user_id = access.get('user_id')
            if not user_id:
                return None
        except TokenError:
            return None

        return await self._get_user(user_id)

    @database_sync_to_async
    def _get_user(self, user_id):
        try:
            return User.objects.get(id=user_id, is_active=True)
        except User.DoesNotExist:
            return None

    @database_sync_to_async
    def _get_ticket(self, ticket_id):
        try:
            return SupportTicket.objects.get(id=ticket_id)
        except SupportTicket.DoesNotExist:
            return None

    @database_sync_to_async
    def _can_access_ticket(self, user_id, ticket_user_id):
        if ticket_user_id == user_id:
            return True

        return User.objects.filter(id=user_id, is_staff=True, is_active=True).exists()
