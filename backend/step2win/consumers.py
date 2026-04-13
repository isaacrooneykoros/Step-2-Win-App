import json

from channels.generic.websocket import AsyncWebsocketConsumer


class HealthCheckConsumer(AsyncWebsocketConsumer):
    """Minimal websocket endpoint used by mobile preflight checks."""

    async def connect(self):
        await self.accept()
        await self.send(text_data=json.dumps({'type': 'ws.health', 'status': 'ok'}))

    async def receive(self, text_data=None, bytes_data=None):
        return
