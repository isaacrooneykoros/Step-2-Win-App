"""Admin realtime: coalescer, publish-on-commit, signal wiring, pulse endpoint."""

from datetime import date
from decimal import Decimal
from unittest import mock

from django.contrib.auth import get_user_model
from django.db import transaction
from django.test import TestCase, override_settings
from rest_framework.test import APIClient

from apps.core import realtime
from apps.core.realtime import Coalescer, KindSpec, hub, publish_admin_event

User = get_user_model()


def _kinds(entries):
    return {e["kind"]: e for e in entries}


class CoalescerTests(TestCase):
    def test_many_step_syncs_in_one_window_become_one_entry(self):
        co = Coalescer()
        for uid in range(150):
            co.add("steps.updated", {"user_id": uid, "steps": uid * 10}, now=0.0)
        entries = co.drain(now=5.0)
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["kind"], "steps.updated")
        self.assertEqual(entries[0]["count"], 150)
        self.assertEqual(len(entries[0]["items"]), 150)

    def test_same_entity_is_merged_latest_wins(self):
        co = Coalescer()
        for n in range(1000):
            co.add("steps.updated", {"user_id": 7, "steps": n}, now=0.0)
        (entry,) = co.drain(now=5.0)
        self.assertEqual(entry["count"], 1000)
        self.assertEqual(entry["items"], [{"user_id": 7, "steps": 999}])

    def test_over_cap_collapses_to_bulk_changed_and_memory_stays_bounded(self):
        co = Coalescer(specs={"steps.updated": KindSpec(1.0, 10, "user_id")})
        for uid in range(5000):
            co.add("steps.updated", {"user_id": uid}, now=0.0)
        self.assertEqual(co.pending_items(), 0)  # items dropped once over cap; only a counter grows
        (entry,) = co.drain(now=5.0)
        self.assertEqual(entry, {"kind": "steps.bulk_changed", "of": "steps.updated", "count": 5000})

    def test_windows_are_per_kind(self):
        co = Coalescer(
            specs={"steps.updated": KindSpec(1.0, 10, "user_id"), "support.ticket": KindSpec(0.25, 10, "id")}
        )
        self.assertEqual(co.add("steps.updated", {"user_id": 1}, now=0.0), 1.0)
        self.assertEqual(co.add("support.ticket", {"id": 1}, now=0.1), 0.35)
        self.assertIsNone(co.add("steps.updated", {"user_id": 2}, now=0.2))  # window already open
        self.assertEqual(co.next_due(), 0.35)
        self.assertEqual([e["kind"] for e in co.drain(now=0.4)], ["support.ticket"])
        self.assertEqual([e["kind"] for e in co.drain(now=1.1)], ["steps.updated"])

    def test_total_items_per_flush_is_capped(self):
        co = Coalescer(specs={"a.x": KindSpec(1.0, 100, "id"), "b.x": KindSpec(1.0, 100, "id")}, max_items=120)
        for i in range(60):
            co.add("a.x", {"id": i}, now=0.0)
        for i in range(90):
            co.add("b.x", {"id": i}, now=0.0)
        entries = _kinds(co.drain(now=2.0))
        self.assertEqual(len(entries["a.x"]["items"]), 60)
        self.assertEqual(entries["b.bulk_changed"]["count"], 90)


class PublishOnCommitTests(TestCase):
    def setUp(self):
        hub.reset()
        self.user = User.objects.create_user(username="walker", password="x" * 12, email="w@example.com")
        hub.pending()  # discard the registration event

    def tearDown(self):
        hub.reset()

    def test_event_is_published_after_commit(self):
        with self.captureOnCommitCallbacks(execute=True):
            with transaction.atomic():
                publish_admin_event("support.ticket", {"id": 1})
                self.assertEqual(hub.pending(), [])  # nothing before commit
        entries = hub.pending()
        self.assertEqual(entries[0]["kind"], "support.ticket")

    def test_nothing_is_published_on_rollback(self):
        with self.captureOnCommitCallbacks(execute=True) as callbacks:
            try:
                with transaction.atomic():
                    publish_admin_event("support.ticket", {"id": 1})
                    raise RuntimeError("boom")
            except RuntimeError:
                pass
        self.assertEqual(callbacks, [])
        self.assertEqual(hub.pending(), [])

    def test_publish_never_raises_even_if_enqueue_breaks(self):
        with mock.patch.object(hub._co, "add", side_effect=RuntimeError("broken")):
            with self.captureOnCommitCallbacks(execute=True):
                publish_admin_event("support.ticket", {"id": 1})  # must not raise

    @override_settings(REALTIME_ENABLED=False)
    def test_disabled_publishes_nothing(self):
        with self.captureOnCommitCallbacks(execute=True):
            publish_admin_event("support.ticket", {"id": 1})
        self.assertEqual(hub.pending(), [])


class SignalWiringTests(TestCase):
    def setUp(self):
        hub.reset()

    def tearDown(self):
        hub.reset()

    def _events(self):
        return _kinds(hub.pending())

    def test_registration_and_step_sync_and_ticket(self):
        from apps.admin_api.models import SupportTicket, SupportTicketMessage
        from apps.steps.models import HealthRecord

        with self.captureOnCommitCallbacks(execute=True):
            user = User.objects.create_user(username="amani2", password="x" * 12, email="a2@example.com")
        ev = self._events()
        self.assertEqual(ev["user.registered"]["items"][0]["id"], user.id)
        self.assertNotIn("email", ev["user.registered"]["items"][0])

        with self.captureOnCommitCallbacks(execute=True):
            HealthRecord.objects.update_or_create(user=user, date=date(2026, 9, 24), defaults={"steps": 4321})
        ev = self._events()
        item = ev["steps.updated"]["items"][0]
        self.assertEqual((item["user_id"], item["steps"]), (user.id, 4321))

        with self.captureOnCommitCallbacks(execute=True):
            ticket = SupportTicket.objects.create(user=user, subject="Help", message="Steps missing")
            SupportTicketMessage.objects.create(ticket=ticket, sender=user, sender_username="amani2", message="hi")
        ev = self._events()
        self.assertEqual(ev["support.ticket"]["items"][0]["id"], ticket.id)
        self.assertEqual(ev["support.message"]["items"][0]["ticket_id"], ticket.id)

    def test_wallet_update_sends_new_balance_but_no_contact_data(self):
        user = User.objects.create_user(username="payer", password="x" * 12, email="p@example.com")
        hub.pending()
        user.wallet_balance = Decimal("250.00")
        with self.captureOnCommitCallbacks(execute=True):
            user.save(update_fields=["wallet_balance", "updated_at"])
        item = self._events()["user.updated"]["items"][0]
        self.assertEqual(item["wallet_balance"], "250.00")
        self.assertEqual(item["fields"], ["updated_at", "wallet_balance"])
        for secret in ("email", "phone_number", "password"):
            self.assertNotIn(secret, item)


class PulseEndpointTests(TestCase):
    def test_staff_only(self):
        client = APIClient()
        self.assertIn(client.get("/api/admin/realtime/pulse/").status_code, (401, 403))
        user = User.objects.create_user(username="cust", password="x" * 12, email="c@example.com")
        client.force_authenticate(user)
        self.assertEqual(client.get("/api/admin/realtime/pulse/").status_code, 403)
        staff = User.objects.create_user(username="ops", password="x" * 12, email="o@example.com", is_staff=True)
        client.force_authenticate(staff)
        res = client.get("/api/admin/realtime/pulse/")
        self.assertEqual(res.status_code, 200)
        for key in ("step_syncs_last_hour", "users_synced_last_hour", "signups_last_24h", "logins_last_hour"):
            self.assertIn(key, res.data)
        self.assertEqual(res.data["signups_last_24h"], 2)


class LayerSelectionTests(TestCase):
    def test_layer_name(self):
        with override_settings(CHANNEL_LAYERS={"default": {"BACKEND": "channels.layers.InMemoryChannelLayer"}}):
            self.assertEqual(realtime.channel_layer_name(), "memory")
        with override_settings(
            CHANNEL_LAYERS={"default": {"BACKEND": "channels_redis.core.RedisChannelLayer", "CONFIG": {}}}
        ):
            self.assertEqual(realtime.channel_layer_name(), "redis")
