"""
Realtime event bus for the admin console.

Customer-side changes (step syncs, sign-ups, deposits, tickets, flags...) are
published here and pushed to every connected admin over one WebSocket group.

Design (see also ``apps/core/consumers.py`` and ``apps/core/signals.py``):

* ``publish_admin_event(kind, payload)`` is the only entry point. It registers a
  ``transaction.on_commit`` callback, so nothing is announced for a rolled-back
  write, and it never raises: a realtime failure must not fail a customer request.
* The callback does O(1) work: it merges the payload into an in-process
  ``Coalescer`` under a lock. No I/O, no DB query, nothing awaited.
* A single flusher task (``RealtimeHub``) drains the coalescer on a short
  per-kind window (0.25 s for rare kinds, 0.5 s for high-frequency ones) and
  builds ONE message per flush with every kind that is due. Thousands of step syncs in a second become one message listing the
  changed users (capped); over the cap the kind collapses to
  ``<domain>.bulk_changed`` and the admin refetches instead.
* Memory is bounded: each kind keeps at most ``cap`` entities per window, after
  which only a counter grows.
* Delivery to admin sockets in THIS process is direct (each socket has a
  bounded outbox, see consumers.py), so a single server works with no channel
  layer at all and keeps working when Redis is down. The channel layer (alias
  "realtime") is only used to reach sockets held by OTHER processes when it is
  Redis; sockets ignore layer messages that came from their own process.
* The flusher runs on the ASGI server's event loop (bound on the first request
  or socket). When there is no ASGI loop in this process (management command,
  Celery) and a Redis layer is configured, it runs on a private daemon thread
  loop instead.
"""

from __future__ import annotations

import asyncio
import logging
import threading
import time
import uuid
from dataclasses import dataclass
from typing import Any

from django.conf import settings
from django.db import transaction
from django.utils import timezone

logger = logging.getLogger("apps.core.realtime")

ADMIN_EVENTS_GROUP = "admin_events"
REALTIME_LAYER_ALIAS = "realtime"
# Channels maps "admin.events" to the consumer method ``admin_events``.
ADMIN_EVENTS_TYPE = "admin.events"

# Flush windows (seconds). High-frequency kinds wait longer so a burst becomes
# one message; rare, operator-relevant kinds go out almost immediately.
FAST_WINDOW = 0.25
SLOW_WINDOW = 0.5
# Upper bound on items in one flushed message across all kinds.
MAX_ITEMS_PER_FLUSH = 500
# A group_send that takes longer than this is abandoned (Redis unreachable...).
SEND_TIMEOUT = 3.0


@dataclass(frozen=True)
class KindSpec:
    window: float
    """Seconds to gather events of this kind before they are flushed."""
    cap: int
    """Max distinct entities per window; beyond it the kind becomes bulk_changed."""
    key: str | None = "id"
    """Payload field that identifies the entity (later events for it replace earlier ones)."""


DEFAULT_SPEC = KindSpec(FAST_WINDOW, 50, "id")

KIND_SPECS: dict[str, KindSpec] = {
    # Users and sessions
    "user.registered": KindSpec(FAST_WINDOW, 50, "id"),
    "user.updated": KindSpec(SLOW_WINDOW, 100, "id"),
    "user.deleted": KindSpec(FAST_WINDOW, 50, "id"),
    "session.login": KindSpec(SLOW_WINDOW, 100, "user_id"),
    "session.updated": KindSpec(SLOW_WINDOW, 100, "user_id"),
    "device.updated": KindSpec(SLOW_WINDOW, 100, "user_id"),
    # Steps (the hot path: every phone sync lands here)
    "steps.updated": KindSpec(SLOW_WINDOW, 200, "user_id"),
    # Challenges
    "challenge.created": KindSpec(FAST_WINDOW, 50, "id"),
    "challenge.updated": KindSpec(FAST_WINDOW, 50, "id"),
    "challenge.deleted": KindSpec(FAST_WINDOW, 50, "id"),
    "challenge.joined": KindSpec(FAST_WINDOW, 100, "id"),
    "challenge.left": KindSpec(FAST_WINDOW, 100, "id"),
    "challenge.progress": KindSpec(SLOW_WINDOW, 100, "challenge_id"),
    # Money
    "wallet.transaction": KindSpec(SLOW_WINDOW, 100, "id"),
    "payment.updated": KindSpec(FAST_WINDOW, 50, "id"),
    "withdrawal.updated": KindSpec(FAST_WINDOW, 50, "id"),
    "withdrawal.legacy": KindSpec(FAST_WINDOW, 50, "id"),
    # Support
    "support.ticket": KindSpec(FAST_WINDOW, 50, "id"),
    "support.message": KindSpec(FAST_WINDOW, 50, "id"),
    # Trust and safety
    "trust.flag": KindSpec(FAST_WINDOW, 50, "id"),
    "trust.activity": KindSpec(FAST_WINDOW, 50, "id"),
    "trust.review": KindSpec(FAST_WINDOW, 50, "id"),
    "trust.score": KindSpec(SLOW_WINDOW, 100, "user_id"),
    # Staff actions
    "audit.logged": KindSpec(SLOW_WINDOW, 50, "id"),
    # Scheduled jobs (apps/admin_api/scheduler.py): one entry per finished run
    "jobs.updated": KindSpec(SLOW_WINDOW, 50, "name"),
}


def spec_for(kind: str) -> KindSpec:
    return KIND_SPECS.get(kind, DEFAULT_SPEC)


def bulk_kind(kind: str) -> str:
    return f"{kind.split('.', 1)[0]}.bulk_changed"


# ── Coalescer ────────────────────────────────────────────────────────────────


class _KindBuffer:
    __slots__ = ("items", "count", "first_at", "overflow", "_anon")

    def __init__(self, now: float):
        self.items: dict[Any, dict] = {}
        self.count = 0
        self.first_at = now
        self.overflow = False
        self._anon = 0


class Coalescer:
    """Per-kind aggregation with bounded memory. Not thread-safe on its own; the hub locks."""

    def __init__(self, specs: dict[str, KindSpec] | None = None, max_items: int = MAX_ITEMS_PER_FLUSH):
        self._specs = specs if specs is not None else KIND_SPECS
        self._max_items = max_items
        self._kinds: dict[str, _KindBuffer] = {}

    def _spec(self, kind: str) -> KindSpec:
        return self._specs.get(kind, DEFAULT_SPEC)

    def add(self, kind: str, payload: dict, now: float) -> float | None:
        """Merge one event. Returns the kind's flush deadline if this started a new window."""
        spec = self._spec(kind)
        buf = self._kinds.get(kind)
        started = buf is None
        if buf is None:
            buf = self._kinds[kind] = _KindBuffer(now)
        buf.count += 1
        if buf.overflow:
            return buf.first_at + spec.window if started else None
        key = payload.get(spec.key) if spec.key else None
        if key is None:
            buf._anon += 1
            key = ("_anon", buf._anon)
        existing = buf.items.get(key)
        if existing is not None:
            existing.update(payload)
        elif len(buf.items) >= spec.cap:
            buf.overflow = True
            buf.items.clear()
        else:
            buf.items[key] = dict(payload)
        return buf.first_at + spec.window if started else None

    def next_due(self) -> float | None:
        if not self._kinds:
            return None
        return min(b.first_at + self._spec(k).window for k, b in self._kinds.items())

    def pending_kinds(self) -> int:
        return len(self._kinds)

    def pending_items(self) -> int:
        return sum(len(b.items) for b in self._kinds.values())

    def drain(self, now: float | None = None, force: bool = False) -> list[dict]:
        """Remove and return the entries whose window has elapsed (all when ``force``)."""
        due: list[tuple[str, _KindBuffer]] = []
        for kind, buf in list(self._kinds.items()):
            if force or now is None or buf.first_at + self._spec(kind).window <= now:
                due.append((kind, self._kinds.pop(kind)))
        if not due:
            return []
        # Smallest kinds first so a single huge kind is the one that collapses.
        due.sort(key=lambda kb: len(kb[1].items))
        entries: list[dict] = []
        budget = self._max_items
        for kind, buf in due:
            if buf.overflow or len(buf.items) > budget:
                entries.append({"kind": bulk_kind(kind), "of": kind, "count": buf.count})
                continue
            budget -= len(buf.items)
            entries.append({"kind": kind, "count": buf.count, "items": list(buf.items.values())})
        return entries

    def clear(self) -> None:
        self._kinds.clear()


# ── Hub ──────────────────────────────────────────────────────────────────────


def channel_layer_name() -> str:
    layers = getattr(settings, "CHANNEL_LAYERS", {}) or {}
    backend = (layers.get(REALTIME_LAYER_ALIAS) or layers.get("default") or {}).get("BACKEND", "")
    if "redis" in backend.lower():
        return "redis"
    if "inmemory" in backend.lower():
        return "memory"
    return backend or "none"


class RealtimeHub:
    """Owns the coalescer and the flusher task. One per process."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._co = Coalescer()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._wake: asyncio.Event | None = None
        self._task: asyncio.Task | None = None
        self._private = False
        self.source = uuid.uuid4().hex[:8]
        self._n = 0
        self._last_warn = 0.0
        self._local: set = set()
        self.stats = {
            "published": 0,
            "flushes": 0,
            "entries": 0,
            "bulk": 0,
            "send_failures": 0,
            "dropped_no_loop": 0,
            "max_flush_ms": 0.0,
        }

    # -- local sockets -------------------------------------------------------

    @property
    def connections(self) -> int:
        return len(self._local)

    def register(self, consumer) -> None:
        """An authenticated admin socket in this process. It must expose ``deliver(message)``."""
        self._local.add(consumer)

    def unregister(self, consumer) -> None:
        self._local.discard(consumer)

    # -- loop binding --------------------------------------------------------

    def bind_loop(self) -> None:
        """Run the flusher on the current (ASGI server) event loop. Cheap when already bound."""
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        if loop is self._loop and self._task is not None and not self._task.done():
            return
        with self._lock:
            cur = self._loop
            if (
                cur is not None
                and cur is not loop
                and not self._private
                and not cur.is_closed()
                and cur.is_running()
                and self._task is not None
                and not self._task.done()
            ):
                # Already running on another live server loop; keep it.
                return
            old_private = cur if self._private else None
            self._loop = loop
            self._private = False
            self._wake = asyncio.Event()
            self._task = loop.create_task(self._run(), name="admin-realtime-flusher")
        if old_private is not None:
            old_private.call_soon_threadsafe(old_private.stop)

    def _ensure_private_loop(self) -> asyncio.AbstractEventLoop | None:
        """Start a daemon-thread loop for processes without an ASGI loop (Redis layer only)."""
        with self._lock:
            if self._loop is not None and not self._loop.is_closed():
                return self._loop
            loop = asyncio.new_event_loop()
            self._loop = loop
            self._private = True
            self._wake = asyncio.Event()

            def _runner() -> None:
                asyncio.set_event_loop(loop)
                self._task = loop.create_task(self._run(), name="admin-realtime-flusher")
                loop.run_forever()

            threading.Thread(target=_runner, name="admin-realtime-publisher", daemon=True).start()
            return loop

    # -- publishing ----------------------------------------------------------

    def enqueue(self, kind: str, payload: dict) -> None:
        """Merge an event (call after commit). O(1); never raises."""
        try:
            now = time.monotonic()
            with self._lock:
                started_due = self._co.add(kind, payload, now)
                self.stats["published"] += 1
                loop, wake = self._loop, self._wake
            if loop is None or loop.is_closed():
                if channel_layer_name() == "redis":
                    loop = self._ensure_private_loop()
                    wake = self._wake
                else:
                    # In-memory layer and no server loop in this process: no socket can
                    # be listening here. Keep the (bounded) buffer; it flushes once a loop binds.
                    self.stats["dropped_no_loop"] += 1
                    return
            if started_due is not None and loop is not None and wake is not None:
                loop.call_soon_threadsafe(wake.set)
        except Exception as exc:  # noqa: BLE001 - realtime is best effort
            self._warn("enqueue failed", exc)

    async def _run(self) -> None:
        while True:
            try:
                wake = self._wake
                with self._lock:
                    due = self._co.next_due()
                if due is None:
                    if wake is None:
                        await asyncio.sleep(0.5)
                    else:
                        await wake.wait()
                        wake.clear()
                    continue
                delay = due - time.monotonic()
                if delay > 0:
                    if wake is None:
                        await asyncio.sleep(delay)
                    else:
                        try:
                            await asyncio.wait_for(wake.wait(), timeout=delay)
                        except asyncio.TimeoutError:
                            pass
                        wake.clear()
                    continue
                with self._lock:
                    entries = self._co.drain(time.monotonic())
                if entries:
                    await self._send(entries)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - never let the flusher die
                self._warn("flusher error", exc)
                await asyncio.sleep(1.0)

    def build_message(self, entries: list[dict]) -> dict:
        self._n += 1
        return {
            "type": ADMIN_EVENTS_TYPE,
            "src": self.source,
            "n": self._n,
            "ts": timezone.now().isoformat(),
            "events": entries,
        }

    async def _send(self, entries: list[dict]) -> None:
        from channels.layers import get_channel_layer

        started = time.perf_counter()
        message = self.build_message(entries)
        self.stats["flushes"] += 1
        self.stats["entries"] += len(entries)
        self.stats["bulk"] += sum(1 for e in entries if e["kind"].endswith(".bulk_changed"))
        # Same-process sockets: O(1) hand-off into each socket's bounded outbox.
        for consumer in list(self._local):
            try:
                consumer.deliver(message)
            except Exception as exc:  # noqa: BLE001
                self._warn("local delivery failed", exc)
        if channel_layer_name() != "redis":
            # In-memory layer: every socket lives in this process and was served above.
            self.stats["max_flush_ms"] = max(self.stats["max_flush_ms"], round((time.perf_counter() - started) * 1000, 2))
            return
        try:
            layer = get_channel_layer(REALTIME_LAYER_ALIAS)
            if layer is None:
                return
            await asyncio.wait_for(layer.group_send(ADMIN_EVENTS_GROUP, message), timeout=SEND_TIMEOUT)
        except Exception as exc:  # noqa: BLE001
            self.stats["send_failures"] += 1
            self._warn("group_send failed", exc)
        finally:
            ms = (time.perf_counter() - started) * 1000
            if ms > self.stats["max_flush_ms"]:
                self.stats["max_flush_ms"] = round(ms, 2)

    async def flush_now(self) -> list[dict]:
        """Flush everything pending immediately (tests, shutdown)."""
        with self._lock:
            entries = self._co.drain(force=True)
        if entries:
            await self._send(entries)
        return entries

    # -- introspection / tests ----------------------------------------------

    def pending(self) -> list[dict]:
        """Drain pending entries without sending them (tests)."""
        with self._lock:
            return self._co.drain(force=True)

    def snapshot(self) -> dict:
        with self._lock:
            pending_kinds = self._co.pending_kinds()
            pending_items = self._co.pending_items()
        return {
            "layer": channel_layer_name(),
            "source": self.source,
            "connections": self.connections,
            "pending_kinds": pending_kinds,
            "pending_items": pending_items,
            "flusher_running": bool(self._task is not None and not self._task.done()),
            **self.stats,
        }

    def reset(self) -> None:
        """Forget the loop and pending events (tests)."""
        with self._lock:
            if self._task is not None and self._loop is not None and not self._loop.is_closed():
                try:
                    self._loop.call_soon_threadsafe(self._task.cancel)
                except RuntimeError:
                    pass
            if self._private and self._loop is not None and not self._loop.is_closed():
                self._loop.call_soon_threadsafe(self._loop.stop)
            self._loop = None
            self._wake = None
            self._task = None
            self._private = False
            self._co.clear()
            self._local.clear()
            for k in self.stats:
                self.stats[k] = 0

    def _warn(self, what: str, exc: Exception) -> None:
        now = time.monotonic()
        if now - self._last_warn > 30:
            self._last_warn = now
            logger.warning("Realtime %s (%s: %s); continuing without it.", what, type(exc).__name__, exc)


hub = RealtimeHub()


def realtime_enabled() -> bool:
    return bool(getattr(settings, "REALTIME_ENABLED", True))


def publish_admin_event(kind: str, payload: dict) -> None:
    """
    Announce a change to connected admins once the current transaction commits.

    ``payload`` must be small and JSON-serialisable (ids, statuses, new totals,
    timestamps). Never put secrets, emails or phone numbers in it. Safe to call
    anywhere; it never raises and never blocks the caller.
    """
    if not realtime_enabled():
        return
    try:
        transaction.on_commit(lambda: hub.enqueue(kind, payload), robust=True)
    except Exception as exc:  # noqa: BLE001
        hub._warn("publish failed", exc)
