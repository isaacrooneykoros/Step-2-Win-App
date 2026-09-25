"""
Admin realtime socket: ``/ws/admin/events/``.

Protocol (JSON text frames):

client -> server
  {"type": "auth", "token": "<access JWT>"}   first frame, within AUTH_TIMEOUT; repeat to renew
  {"type": "ping", "t": <any>}                  heartbeat; answered with pong
  {"type": "ack", "seq": <int>}                 highest events seq processed (flow control)

server -> client
  {"type": "hello", ...}                        authenticated and subscribed
  {"type": "events", "seq", "src", "n", "ts", "events": [...]}
  {"type": "resync", "reason", "dropped"}       events were dropped; refetch what is on screen
  {"type": "auth.expiring", "in": <seconds>}    send a fresh token
  {"type": "auth.ok", "exp": <epoch>}
  {"type": "pong", "t": <echo>}

Close codes: 4400 bad frame, 4401 unauthenticated/expired, 4403 forbidden (origin,
not staff, revoked), 4408 idle (no heartbeat), 1011 server error.

Flow control: at most WINDOW events frames may be unacknowledged, and at most
OUTBOX_MAX more wait in this socket's outbox. Beyond that the outbox is dropped
and the client gets one "resync" once it catches up, so a slow or stalled admin
costs bounded memory and never slows the publisher or other admins.

The token is never read from the URL (query strings end up in access logs).
The only DB queries are the staff check at auth and a periodic re-check.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from collections import deque

from channels.db import database_sync_to_async
from channels.generic.websocket import AsyncWebsocketConsumer
from django.conf import settings
from django.contrib.auth import get_user_model
from rest_framework_simplejwt.exceptions import TokenError
from rest_framework_simplejwt.tokens import AccessToken

from apps.core.realtime import (ADMIN_EVENTS_GROUP, REALTIME_LAYER_ALIAS,
                                channel_layer_name, hub)

logger = logging.getLogger("apps.core.realtime")

_LOCAL_ORIGIN = re.compile(r"^https?://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$")


def admin_origin_allowed(origin: str | None) -> bool:
    if not origin:
        return False
    origin = origin.strip().rstrip("/")
    allowed = getattr(settings, "ADMIN_WS_ALLOWED_ORIGINS", [])
    if origin in allowed:
        return True
    return bool(settings.DEBUG and _LOCAL_ORIGIN.match(origin))


def _decode_access_token(token: str) -> tuple[int, int] | None:
    """(user_id, exp) for a valid, unexpired access token; None otherwise. No DB access."""
    if not isinstance(token, str) or not token or len(token) > 4096:
        return None
    try:
        access = AccessToken(token)
        user_id = access.get(settings.SIMPLE_JWT.get("USER_ID_CLAIM", "user_id"))
        exp = int(access.get("exp"))
        return (int(user_id), exp) if user_id is not None else None
    except (TokenError, TypeError, ValueError):
        return None
    except Exception:  # noqa: BLE001 - malformed input of any kind is a rejection
        return None


@database_sync_to_async
def _is_active_staff(user_id: int) -> bool:
    return get_user_model().objects.filter(id=user_id, is_active=True, is_staff=True).exists()


class AdminEventsConsumer(AsyncWebsocketConsumer):
    channel_layer_alias = REALTIME_LAYER_ALIAS

    AUTH_TIMEOUT = 5.0
    IDLE_TIMEOUT = 75.0  # client pings every 20 s
    RECHECK_INTERVAL = 60.0  # staff/active re-check; also refreshes group membership
    EXPIRY_WARNING = 120.0  # ask for a new token this long before the current one expires
    EXPIRY_GRACE = 30.0
    WATCHDOG_TICK = 1.0
    WINDOW = 32  # max unacknowledged events frames per connection
    OUTBOX_MAX = 16  # max frames waiting behind the window
    MAX_FRAME = 8192

    async def connect(self):
        hub.bind_loop()
        headers = dict(self.scope.get("headers") or [])
        origin = headers.get(b"origin", b"").decode("latin-1")
        self.authed = False
        self.user_id: int | None = None
        self.token_exp: int | None = None
        self.expiry_warned = False
        self.sent_seq = 0
        self.acked_seq = 0
        self.overflow = False
        self.dropped = 0
        self._outbox: deque = deque()
        self._wake = asyncio.Event()
        self._tasks: list[asyncio.Task] = []
        if not admin_origin_allowed(origin):
            logger.info("Admin socket rejected: origin %r not allowed", origin[:200])
            await self.close(code=4403)
            return
        now = time.monotonic()
        self.connected_at = now
        self.last_rx = now
        self.next_recheck = now + self.RECHECK_INTERVAL
        await self.accept()
        self._tasks.append(asyncio.create_task(self._watch()))

    async def disconnect(self, code):
        hub.unregister(self)
        current = asyncio.current_task()
        for task in self._tasks:
            if task is not current:
                task.cancel()
        self._outbox.clear()
        if self.authed:
            self.authed = False
            if self.channel_layer is not None:
                try:
                    await self.channel_layer.group_discard(ADMIN_EVENTS_GROUP, self.channel_name)
                except Exception:  # noqa: BLE001
                    pass

    # -- inbound -------------------------------------------------------------

    async def receive(self, text_data=None, bytes_data=None):
        self.last_rx = time.monotonic()
        if text_data is None or len(text_data) > self.MAX_FRAME:
            await self.close(code=4400)
            return
        try:
            msg = json.loads(text_data)
            kind = msg.get("type") if isinstance(msg, dict) else None
        except (ValueError, AttributeError):
            await self.close(code=4400)
            return

        if kind == "auth":
            await self._authenticate(msg.get("token"))
        elif not self.authed:
            await self.close(code=4401)
        elif kind == "ping":
            await self._send_json({"type": "pong", "t": msg.get("t")})
        elif kind == "ack":
            try:
                seq = int(msg.get("seq"))
            except (TypeError, ValueError):
                return
            if seq > self.acked_seq:
                self.acked_seq = min(seq, self.sent_seq)
                self._wake.set()

    async def _authenticate(self, token):
        decoded = _decode_access_token(token)
        if decoded is None:
            await self.close(code=4401)
            return
        user_id, exp = decoded
        if self.authed and user_id != self.user_id:
            await self.close(code=4401)
            return
        if not await _is_active_staff(user_id):
            await self.close(code=4403)
            return
        self.token_exp = exp
        self.expiry_warned = False
        if self.authed:
            await self._send_json({"type": "auth.ok", "exp": exp})
            return
        self.authed = True
        self.user_id = user_id
        self.next_recheck = time.monotonic() + self.RECHECK_INTERVAL
        await self._join_group()
        hub.register(self)
        self._tasks.append(asyncio.create_task(self._pump()))
        await self._send_json(
            {
                "type": "hello",
                "server_time": int(time.time()),
                "exp": exp,
                "layer": channel_layer_name(),
                "src": hub.source,
                "window": self.WINDOW,
                "heartbeat": 20,
            }
        )

    async def _join_group(self):
        """Cross-process fan-out (Redis). Failure is not fatal: same-process delivery still works."""
        if self.channel_layer is None or channel_layer_name() != "redis":
            return
        try:
            await self.channel_layer.group_add(ADMIN_EVENTS_GROUP, self.channel_name)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Admin socket could not join the Redis group (%s: %s)", type(exc).__name__, exc)

    # -- outbound ------------------------------------------------------------------

    def deliver(self, message: dict) -> None:
        """Called by the hub (same process). Non-blocking, bounded."""
        if not self.authed:
            return
        if self.overflow:
            self.dropped += 1
            return
        if len(self._outbox) >= self.OUTBOX_MAX:
            # Slow or stalled client: stop queueing and resync it later instead.
            self.overflow = True
            self.dropped += len(self._outbox) + 1
            self._outbox.clear()
            return
        self._outbox.append(message)
        self._wake.set()

    async def admin_events(self, event):
        """Group message from another process (Redis layer)."""
        if event.get("src") == hub.source:
            return  # already delivered directly by this process's hub
        self.deliver(event)

    async def _pump(self):
        try:
            while True:
                await self._wake.wait()
                self._wake.clear()
                while self.authed:
                    inflight = self.sent_seq - self.acked_seq
                    if self.overflow:
                        if inflight > self.WINDOW // 2:
                            break  # wait for acks
                        self.overflow = False
                        dropped, self.dropped = self.dropped, 0
                        await self._send_json({"type": "resync", "reason": "backpressure", "dropped": dropped})
                        continue
                    if not self._outbox or inflight >= self.WINDOW:
                        break
                    message = self._outbox.popleft()
                    self.sent_seq += 1
                    await self._send_json(
                        {
                            "type": "events",
                            "seq": self.sent_seq,
                            "src": message.get("src"),
                            "n": message.get("n"),
                            "ts": message.get("ts"),
                            "events": message.get("events", []),
                        }
                    )
        except asyncio.CancelledError:
            pass
        except Exception as exc:  # noqa: BLE001
            logger.warning("Admin socket pump error (%s: %s)", type(exc).__name__, exc)

    async def _send_json(self, data: dict):
        await self.send(text_data=json.dumps(data, separators=(",", ":"), default=str))

    # -- watchdog --------------------------------------------------------------

    async def _watch(self):
        try:
            while True:
                await asyncio.sleep(self.WATCHDOG_TICK)
                now = time.monotonic()
                if not self.authed:
                    if now - self.connected_at > self.AUTH_TIMEOUT:
                        await self.close(code=4401)
                        return
                    continue
                if now - self.last_rx > self.IDLE_TIMEOUT:
                    await self.close(code=4408)
                    return
                if self.token_exp is not None:
                    remaining = self.token_exp - time.time()
                    if remaining < -self.EXPIRY_GRACE:
                        await self.close(code=4401)
                        return
                    if remaining < self.EXPIRY_WARNING and not self.expiry_warned:
                        self.expiry_warned = True
                        await self._send_json({"type": "auth.expiring", "in": max(0, int(remaining))})
                if now >= self.next_recheck:
                    self.next_recheck = now + self.RECHECK_INTERVAL
                    if not await _is_active_staff(self.user_id):
                        await self.close(code=4403)
                        return
                    # Keeps membership alive past the Redis layer's group_expiry.
                    await self._join_group()
        except asyncio.CancelledError:
            pass
        except Exception as exc:  # noqa: BLE001
            logger.warning("Admin socket watchdog error (%s: %s)", type(exc).__name__, exc)
            try:
                await self.close(code=1011)
            except Exception:  # noqa: BLE001
                pass
