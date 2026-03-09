import json
from urllib.parse import parse_qs

from channels.generic.websocket import AsyncWebsocketConsumer
from django.contrib.auth import get_user_model
from rest_framework_simplejwt.exceptions import TokenError
from rest_framework_simplejwt.tokens import AccessToken

User = get_user_model()


class StepsSyncConsumer(AsyncWebsocketConsumer):
    """
    User-scoped websocket for live step updates.
    Client must pass JWT access token as query param: ?token=<access_token>
    """

    async def connect(self):
        query_string = self.scope.get('query_string', b'').decode()
        params = parse_qs(query_string)
        token = (params.get('token') or [None])[0]

        if not token:
            await self.close(code=4401)
            return

        user = await self._get_user_from_token(token)
        if not user:
            await self.close(code=4401)
            return

        self.user = user
        self.group_name = f'user_steps_{self.user.id}'

        await self.channel_layer.group_add(self.group_name, self.channel_name)
        await self.accept()
        await self.send(text_data=json.dumps({'type': 'steps.connected'}))

    async def disconnect(self, close_code):
        if hasattr(self, 'group_name'):
            await self.channel_layer.group_discard(self.group_name, self.channel_name)

    async def receive(self, text_data=None, bytes_data=None):
        return

    async def steps_update(self, event):
        await self.send(text_data=json.dumps({
            'type': 'steps.update',
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
