"""
Channel layer used by the admin realtime stream (alias ``"realtime"``).

Stock ``RedisChannelLayer.receive`` raises when Redis is unreachable, and
Channels then kills the consumer: every admin socket would drop within a
second and reconnect forever. For the admin stream Redis is only the
cross-process fan-out (same-process delivery bypasses it, see
``RealtimeHub``), so here Redis errors are logged and retried with backoff
instead of propagating.
"""

from __future__ import annotations

import asyncio
import logging
import time

from channels_redis.core import RedisChannelLayer

logger = logging.getLogger("apps.core.realtime")

try:  # redis-py's base error; ConnectionError/TimeoutError subclass it
    from redis.exceptions import RedisError
except Exception:  # pragma: no cover - redis is a dependency of channels_redis
    RedisError = Exception  # type: ignore[misc,assignment]

_TRANSIENT = (RedisError, ConnectionError, OSError, asyncio.TimeoutError)


class ResilientRedisChannelLayer(RedisChannelLayer):
    _last_warn = 0.0

    def _warn(self, op: str, exc: BaseException) -> None:
        now = time.monotonic()
        if now - ResilientRedisChannelLayer._last_warn > 30:
            ResilientRedisChannelLayer._last_warn = now
            logger.warning(
                "Realtime Redis layer %s failed (%s: %s); same-process delivery continues, retrying.",
                op,
                type(exc).__name__,
                exc,
            )

    async def receive(self, channel):
        delay = 1.0
        while True:
            try:
                return await super().receive(channel)
            except _TRANSIENT as exc:
                self._warn("receive", exc)
                await asyncio.sleep(delay)
                delay = min(delay * 2, 30.0)

    async def group_add(self, group, channel):
        try:
            await super().group_add(group, channel)
        except _TRANSIENT as exc:
            self._warn("group_add", exc)

    async def group_discard(self, group, channel):
        try:
            await super().group_discard(group, channel)
        except _TRANSIENT as exc:
            self._warn("group_discard", exc)

    async def group_send(self, group, message):
        try:
            await super().group_send(group, message)
        except _TRANSIENT as exc:
            self._warn("group_send", exc)
            raise

    async def send(self, channel, message):
        try:
            await super().send(channel, message)
        except _TRANSIENT as exc:
            self._warn("send", exc)
            raise
