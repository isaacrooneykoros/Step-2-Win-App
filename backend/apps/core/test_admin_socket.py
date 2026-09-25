"""Admin realtime socket: auth, origin, delivery, coalescing, backpressure, revocation."""

import asyncio
import time
from datetime import date
from unittest import mock

from channels.db import database_sync_to_async
from channels.layers import get_channel_layer
from channels.testing import WebsocketCommunicator
from django.contrib.auth import get_user_model
from django.test import TransactionTestCase, override_settings
from rest_framework_simplejwt.tokens import AccessToken

from apps.core.consumers import AdminEventsConsumer
from apps.core.realtime import hub
from step2win.asgi import application

User = get_user_model()
ORIGIN = b"https://step-2-win-app.vercel.app"
MEMORY_LAYER = {
    "default": {"BACKEND": "channels.layers.InMemoryChannelLayer"},
    "realtime": {"BACKEND": "channels.layers.InMemoryChannelLayer"},
}


def _comm(origin=ORIGIN):
    headers = [(b"origin", origin)] if origin else []
    return WebsocketCommunicator(application, "/ws/admin/events/", headers=headers)


@override_settings(CHANNEL_LAYERS=MEMORY_LAYER)
class AdminSocketTests(TransactionTestCase):
    def setUp(self):
        hub.reset()
        self.staff = User.objects.create_user(
            username="ops_rt", password="x" * 12, email="ops@example.com", is_staff=True
        )
        self.customer = User.objects.create_user(username="amani_rt", password="x" * 12, email="am@example.com")

    def tearDown(self):
        hub.reset()

    async def _authed(self, user=None):
        comm = _comm()
        connected, _ = await comm.connect()
        self.assertTrue(connected)
        await comm.send_json_to({"type": "auth", "token": str(AccessToken.for_user(user or self.staff))})
        hello = await comm.receive_json_from(timeout=3)
        self.assertEqual(hello["type"], "hello")
        return comm

    async def _closed_with(self, comm, code, timeout=3):
        """Skip data frames (e.g. repeated expiry warnings) until the socket closes."""
        deadline = time.monotonic() + timeout
        while True:
            out = await comm.receive_output(timeout=max(0.1, deadline - time.monotonic()))
            if out["type"] == "websocket.close":
                break
        self.assertEqual(out.get("code"), code)

    # -- auth / origin ----------------------------------------------------------

    async def test_staff_is_accepted(self):
        comm = await self._authed()
        await comm.send_json_to({"type": "ping", "t": 1})
        self.assertEqual(await comm.receive_json_from(timeout=2), {"type": "pong", "t": 1})
        self.assertEqual(hub.connections, 1)
        await comm.disconnect()
        self.assertEqual(hub.connections, 0)

    async def test_non_staff_is_rejected(self):
        comm = _comm()
        await comm.connect()
        await comm.send_json_to({"type": "auth", "token": str(AccessToken.for_user(self.customer))})
        await self._closed_with(comm, 4403)

    async def test_bad_token_is_rejected(self):
        comm = _comm()
        await comm.connect()
        await comm.send_json_to({"type": "auth", "token": "not-a-jwt"})
        await self._closed_with(comm, 4401)

    async def test_anonymous_messages_are_rejected(self):
        comm = _comm()
        await comm.connect()
        await comm.send_json_to({"type": "ping"})
        await self._closed_with(comm, 4401)

    async def test_no_auth_frame_times_out(self):
        with mock.patch.object(AdminEventsConsumer, "AUTH_TIMEOUT", 0.3), mock.patch.object(
            AdminEventsConsumer, "WATCHDOG_TICK", 0.1
        ):
            comm = _comm()
            await comm.connect()
            await self._closed_with(comm, 4401)

    async def test_bad_origin_is_rejected_before_accept(self):
        for origin in (b"https://evil.example.com", None, b"http://localhost:5181"):
            comm = _comm(origin)
            connected, code = await comm.connect()
            self.assertFalse(connected, origin)
            self.assertEqual(code, 4403)

    @override_settings(DEBUG=True)
    async def test_localhost_origin_allowed_in_debug(self):
        comm = _comm(b"http://localhost:5181")
        connected, _ = await comm.connect()
        self.assertTrue(connected)
        await comm.disconnect()

    async def test_token_is_not_accepted_from_query_string(self):
        comm = WebsocketCommunicator(
            application,
            f"/ws/admin/events/?token={AccessToken.for_user(self.staff)}",
            headers=[(b"origin", ORIGIN)],
        )
        await comm.connect()
        await comm.send_json_to({"type": "ping"})
        await self._closed_with(comm, 4401)

    async def test_revoked_staff_is_disconnected(self):
        with mock.patch.object(AdminEventsConsumer, "RECHECK_INTERVAL", 0.2), mock.patch.object(
            AdminEventsConsumer, "WATCHDOG_TICK", 0.1
        ):
            comm = await self._authed()
            await database_sync_to_async(User.objects.filter(id=self.staff.id).update)(is_staff=False)
            await self._closed_with(comm, 4403)

    async def test_silent_client_is_dropped(self):
        with mock.patch.object(AdminEventsConsumer, "IDLE_TIMEOUT", 0.3), mock.patch.object(
            AdminEventsConsumer, "WATCHDOG_TICK", 0.1
        ):
            comm = await self._authed()
            await self._closed_with(comm, 4408)

    async def test_expiring_token_asks_for_renewal_and_accepts_it(self):
        with mock.patch.object(AdminEventsConsumer, "EXPIRY_WARNING", 10**6), mock.patch.object(
            AdminEventsConsumer, "WATCHDOG_TICK", 0.1
        ):
            comm = await self._authed()
            msg = await comm.receive_json_from(timeout=2)
            self.assertEqual(msg["type"], "auth.expiring")
            await comm.send_json_to({"type": "auth", "token": str(AccessToken.for_user(self.staff))})
            msg = await comm.receive_json_from(timeout=2)
            while msg["type"] == "auth.expiring":
                msg = await comm.receive_json_from(timeout=2)
            self.assertEqual(msg["type"], "auth.ok")
            # A token for someone else cannot take over the socket.
            other = await database_sync_to_async(User.objects.create_user)(
                username="ops2", password="x" * 12, email="o2@example.com", is_staff=True
            )
            await comm.send_json_to({"type": "auth", "token": str(AccessToken.for_user(other))})
            await self._closed_with(comm, 4401)

    # -- delivery / coalescing ----------------------------------------------------

    async def test_signal_to_socket_end_to_end(self):
        """A committed step sync reaches every connected admin, coalesced."""
        from apps.steps.models import HealthRecord

        a = await self._authed()
        b = await self._authed()  # a second tab / admin

        def sync_many():
            users = [
                User.objects.create_user(username=f"w{i}", password="x" * 12, email=f"w{i}@example.com")
                for i in range(20)
            ]
            for u in users:
                for steps in (100, 200, 300):  # three syncs each
                    HealthRecord.objects.update_or_create(user=u, date=date(2026, 9, 24), defaults={"steps": steps})
            return [u.id for u in users]

        ids = await database_sync_to_async(sync_many)()
        for comm in (a, b):
            got = {}
            deadline = time.monotonic() + 4
            while "steps.updated" not in got and time.monotonic() < deadline:
                msg = await comm.receive_json_from(timeout=3)
                self.assertEqual(msg["type"], "events")
                for e in msg["events"]:
                    got[e["kind"]] = e
            steps = got["steps.updated"]
            self.assertEqual(steps["count"], 60)  # 60 syncs...
            self.assertEqual(len(steps["items"]), 20)  # ...one item per user
            self.assertEqual({i["user_id"] for i in steps["items"]}, set(ids))
            self.assertTrue(all(i["steps"] == 300 for i in steps["items"]))

    async def test_burst_over_cap_becomes_one_bulk_changed_message(self):
        comm = await self._authed()
        for uid in range(2000):
            hub.enqueue("steps.updated", {"user_id": uid, "steps": uid})
        msg = await comm.receive_json_from(timeout=3)
        self.assertEqual(msg["events"], [{"kind": "steps.bulk_changed", "of": "steps.updated", "count": 2000}])
        self.assertTrue(await comm.receive_nothing(timeout=1.5))

    async def test_sequence_numbers_are_contiguous(self):
        comm = await self._authed()
        for i in range(3):
            hub.enqueue("support.ticket", {"id": i})
            await hub.flush_now()
        seqs = [(await comm.receive_json_from(timeout=2))["seq"] for _ in range(3)]
        self.assertEqual(seqs, [1, 2, 3])

    # -- backpressure ---------------------------------------------------------------

    async def test_slow_client_gets_resync_instead_of_unbounded_backlog(self):
        with mock.patch.object(AdminEventsConsumer, "WINDOW", 3), mock.patch.object(AdminEventsConsumer, "OUTBOX_MAX", 2):
            comm = await self._authed()
            for i in range(10):
                hub.enqueue("support.ticket", {"id": i})
                await hub.flush_now()
                await asyncio.sleep(0.05)  # real flushes are >= 250 ms apart
            frames = [await comm.receive_json_from(timeout=2) for _ in range(3)]
            self.assertEqual([f["seq"] for f in frames], [1, 2, 3])
            self.assertTrue(await comm.receive_nothing(timeout=0.5))  # 2 queued, then overflow: all 7 dropped
            await comm.send_json_to({"type": "ack", "seq": 3})
            resync = await comm.receive_json_from(timeout=2)
            self.assertEqual(resync, {"type": "resync", "reason": "backpressure", "dropped": 7})
            # Flow resumes after the resync.
            hub.enqueue("support.ticket", {"id": 99})
            await hub.flush_now()
            self.assertEqual((await comm.receive_json_from(timeout=2))["seq"], 4)

    async def test_redis_failure_never_breaks_same_process_delivery(self):
        """Redis down: group_send fails (logged), but sockets in this process still get events."""
        comm = await self._authed()

        class Broken:
            async def group_send(self, group, message):
                raise ConnectionError("redis down")

        with mock.patch("apps.core.realtime.channel_layer_name", return_value="redis"), mock.patch(
            "channels.layers.get_channel_layer", return_value=Broken()
        ):
            hub.enqueue("support.ticket", {"id": 1})
            await hub.flush_now()  # logged, not raised
        self.assertEqual(hub.stats["send_failures"], 1)
        msg = await comm.receive_json_from(timeout=2)
        self.assertEqual(msg["events"][0]["kind"], "support.ticket")
        await comm.disconnect()

    async def test_cross_process_group_messages(self):
        """With a Redis layer, events from other processes arrive via the group; our own are not doubled."""
        with mock.patch("apps.core.consumers.channel_layer_name", return_value="redis"):
            comm = await self._authed()
        layer = get_channel_layer("realtime")
        base = {"type": "admin.events", "ts": "t", "events": [{"kind": "support.ticket", "count": 1, "items": [{"id": 5}]}]}
        await layer.group_send("admin_events", {**base, "src": hub.source, "n": 1})
        self.assertTrue(await comm.receive_nothing(timeout=0.5))
        await layer.group_send("admin_events", {**base, "src": "otherproc", "n": 1})
        msg = await comm.receive_json_from(timeout=2)
        self.assertEqual((msg["src"], msg["events"][0]["items"]), ("otherproc", [{"id": 5}]))
        await comm.disconnect()


class ResilientLayerTests(TransactionTestCase):
    async def test_receive_retries_instead_of_raising(self):
        from channels_redis.core import RedisChannelLayer

        from apps.core.layers import ResilientRedisChannelLayer

        layer = ResilientRedisChannelLayer(hosts=["redis://127.0.0.1:1/0"])
        with mock.patch.object(
            RedisChannelLayer, "receive", side_effect=[ConnectionError("down"), {"type": "ok"}]
        ), mock.patch("apps.core.layers.asyncio.sleep", new=mock.AsyncMock()):
            self.assertEqual(await layer.receive("specific.x!y"), {"type": "ok"})
        with mock.patch.object(RedisChannelLayer, "group_add", side_effect=ConnectionError("down")):
            await layer.group_add("g", "specific.x!y")  # swallowed
