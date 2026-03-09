import json
import logging
from urllib.parse import parse_qs

from channels.db import database_sync_to_async
from channels.generic.websocket import AsyncWebsocketConsumer
from django.contrib.auth import get_user_model
from rest_framework_simplejwt.exceptions import TokenError
from rest_framework_simplejwt.tokens import AccessToken

from .models import Challenge, Participant

User = get_user_model()
logger = logging.getLogger(__name__)


class ChallengeChatConsumer(AsyncWebsocketConsumer):
    """
    WebSocket consumer for private challenge group chat with real-time messaging
    """
    
    async def connect(self):
        self.user = await self._authenticate_user()
        if not self.user:
            await self.close(code=4001)
            return

        self.challenge_id = self.scope['url_route']['kwargs']['challenge_id']
        self.challenge = await self._get_challenge(self.challenge_id)
        
        if not self.challenge:
            await self.close(code=4404)
            return
        
        # Private challenges only
        if not self.challenge.is_private:
            await self.close(code=4403)
            return
        
        # Check if user is a participant
        is_participant = await self._is_participant(self.user.id, self.challenge_id)
        if not is_participant:
            await self.close(code=4403)
            return

        self.group_name = f"challenge_{self.challenge_id}_chat"
        await self.channel_layer.group_add(self.group_name, self.channel_name)
        await self.accept()

        # Send chat history on connect
        history = await self._get_history()
        await self.send(text_data=json.dumps({
            'type': 'history',
            'messages': history,
        }))

    async def disconnect(self, close_code):
        if hasattr(self, 'group_name'):
            await self.channel_layer.group_discard(self.group_name, self.channel_name)

    async def receive(self, text_data=None, bytes_data=None):
        try:
            data = json.loads(text_data)
        except json.JSONDecodeError:
            return

        msg_type = data.get('type', 'message')

        if msg_type == 'message':
            content = (data.get('content') or '').strip()
            if not content or len(content) > 1000:
                return

            saved = await self._save_message(content)

            # Broadcast to all participants in the group
            await self.channel_layer.group_send(self.group_name, {
                'type': 'chat_message',
                'id': saved['id'],
                'sender': self.user.username,
                'initials': self.user.username[:2].upper(),
                'content': content,
                'created_at': saved['created_at'],
                'is_system': False,
            })

        elif msg_type == 'typing':
            # Broadcast typing indicator to others
            await self.channel_layer.group_send(self.group_name, {
                'type': 'typing_indicator',
                'username': self.user.username,
                'is_typing': bool(data.get('is_typing', True)),
            })

    # ── Channel layer handlers ────────────────────────────────────────────

    async def chat_message(self, event):
        """Handler for chat_message events from group_send"""
        await self.send(text_data=json.dumps({
            'type': 'message',
            'id': event['id'],
            'sender': event['sender'],
            'initials': event['initials'],
            'content': event['content'],
            'created_at': event['created_at'],
            'is_system': event.get('is_system', False),
            'is_mine': event['sender'] == self.user.username,
        }))

    async def typing_indicator(self, event):
        """Handler for typing indicator events"""
        # Don't send own typing indicator back to self
        if event['username'] == self.user.username:
            return
        await self.send(text_data=json.dumps({
            'type': 'typing',
            'username': event['username'],
            'is_typing': event['is_typing'],
        }))

    async def system_message(self, event):
        """Handler for system messages (e.g., milestone alerts)"""
        await self.send(text_data=json.dumps({
            'type': 'message',
            'id': event.get('id', 0),
            'sender': 'Step2Win',
            'initials': '🏆',
            'content': event['content'],
            'created_at': event['created_at'],
            'is_system': True,
            'is_mine': False,
        }))

    # ── Database helpers ──────────────────────────────────────────────────

    async def _authenticate_user(self):
        query_string = self.scope.get('query_string', b'').decode('utf-8')
        token = parse_qs(query_string).get('token', [None])[0]
        if not token:
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
    def _get_challenge(self, challenge_id):
        try:
            return Challenge.objects.get(id=challenge_id)
        except Challenge.DoesNotExist:
            return None

    @database_sync_to_async
    def _is_participant(self, user_id, challenge_id):
        return Participant.objects.filter(
            user_id=user_id,
            challenge_id=challenge_id
        ).exists()

    @database_sync_to_async
    def _get_history(self):
        """Get last 100 chat messages"""
        from .models import ChallengeMessage
        msgs = (
            ChallengeMessage.objects
            .filter(challenge_id=self.challenge_id)
            .select_related('user')
            .order_by('-created_at')[:100]
        )
        return [
            {
                'id': m.id,
                'sender': m.user.username if m.user else 'Step2Win',
                'initials': m.user.username[:2].upper() if m.user else '🏆',
                'content': m.message,
                'created_at': m.created_at.isoformat(),
                'is_system': m.is_system,
                'is_mine': m.user_id == self.user.id if m.user else False,
            }
            for m in reversed(list(msgs))
        ]

    @database_sync_to_async
    def _save_message(self, content):
        """Save message to database"""
        from .models import ChallengeMessage
        msg = ChallengeMessage.objects.create(
            challenge_id=self.challenge_id,
            user=self.user,
            message=content,
        )
        return {
            'id': msg.id,
            'created_at': msg.created_at.isoformat(),
        }


async def push_system_message(challenge_id: int, content: str):
    """
    Push a system message to a challenge chat from outside the consumer.
    Call from Celery tasks or views when milestone events happen.

    Usage:
        from asgiref.sync import async_to_sync
        from apps.challenges.consumers import push_system_message
        async_to_sync(push_system_message)(challenge.id, "🎉 Rooney hit 70K steps!")
    """
    from channels.layers import get_channel_layer
    from .models import ChallengeMessage, Challenge

    channel_layer = get_channel_layer()
    group_name = f'challenge_{challenge_id}_chat'

    # Save to DB so it appears in history
    try:
        challenge = await Challenge.objects.aget(id=challenge_id)
        msg = await ChallengeMessage.objects.acreate(
            challenge=challenge,
            user=None,  # System message has no user
            message=content,
            is_system=True,
        )
        await channel_layer.group_send(group_name, {
            'type': 'system_message',
            'id': msg.id,
            'content': content,
            'created_at': msg.created_at.isoformat(),
        })
    except Exception as e:
        logger.warning(f'push_system_message failed for challenge {challenge_id}: {e}')
