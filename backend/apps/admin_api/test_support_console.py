"""Tests for the helpdesk queue, settings context and best-effort realtime."""

from unittest import mock

from django.contrib.auth import get_user_model
from django.test import TestCase
from rest_framework.test import APIClient

from apps.admin_api.models import (AuditLog, SupportTicket,
                                   SupportTicketMessage)
from apps.admin_api.support_views import NOTICE_MESSAGE

User = get_user_model()


class _BrokenLayer:
    async def group_send(self, group, event):
        raise ConnectionError("Connect call failed ('127.0.0.1', 6379)")


class SupportConsoleTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.admin = User.objects.create_user(
            username="desk_admin", email="desk@example.com", phone_number="254700000021",
            password="pass12345!", is_staff=True,
        )
        self.other_admin = User.objects.create_user(
            username="desk_two", email="desk2@example.com", phone_number="254700000022",
            password="pass12345!", is_staff=True,
        )
        self.user = User.objects.create_user(
            username="walker", email="w@example.com", phone_number="254712345681", password="pass12345!",
        )
        self.open = SupportTicket.objects.create(
            user=self.user, subject="Deposit missing", category="payment", message="Paid but no credit",
            priority="urgent",
        )
        SupportTicketMessage.objects.create(ticket=self.open, sender=self.user, sender_username="walker",
                                            is_admin=False, message="Paid but no credit")
        self.replied = SupportTicket.objects.create(
            user=self.user, subject="Steps not syncing", category="technical", message="Sync stuck",
            status="in_progress", priority="low", assigned_to=self.admin,
        )
        SupportTicketMessage.objects.create(ticket=self.replied, sender=self.user, sender_username="walker",
                                            is_admin=False, message="Sync stuck")
        SupportTicketMessage.objects.create(ticket=self.replied, sender=self.admin, sender_username="desk_admin",
                                            is_admin=True, message="Please update the app")
        self.done = SupportTicket.objects.create(
            user=self.user, subject="Old question", category="general", message="Thanks", status="resolved",
        )
        self.notice = SupportTicket.objects.create(
            user=self.user, subject="Account notice", category="account", message=NOTICE_MESSAGE, status="resolved",
        )
        self.client.force_authenticate(self.admin)

    def _queue(self, **params):
        res = self.client.get("/api/admin/support/queue/", params)
        self.assertEqual(res.status_code, 200, res.content)
        return res.json()

    def test_queue_requires_staff(self):
        self.client.force_authenticate(self.user)
        self.assertEqual(self.client.get("/api/admin/support/queue/").status_code, 403)

    def test_active_view_orders_by_priority_and_reports_waiting(self):
        data = self._queue()
        ids = [r["id"] for r in data["results"]]
        self.assertEqual(ids, [self.open.id, self.replied.id])
        first, second = data["results"]
        self.assertEqual(first["waiting_on"], "staff")
        self.assertIsNotNone(first["waiting_hours"])
        self.assertEqual(second["waiting_on"], "user")
        self.assertEqual(second["message_count"], 2)
        self.assertEqual(data["counts"]["active"], 2)
        self.assertEqual(data["counts"]["awaiting"], 1)
        self.assertEqual(data["counts"]["unassigned"], 1)
        self.assertEqual(data["counts"]["mine"], 1)
        self.assertEqual(data["urgent_active"], 1)

    def test_notices_are_kept_out_of_the_working_views(self):
        all_ids = [r["id"] for r in self._queue(view="all")["results"]]
        self.assertNotIn(self.notice.id, all_ids)
        self.assertIn(self.done.id, all_ids)
        resolved_ids = [r["id"] for r in self._queue(view="resolved")["results"]]
        self.assertEqual(resolved_ids, [self.done.id])
        notices = self._queue(view="notices")["results"]
        self.assertEqual([r["id"] for r in notices], [self.notice.id])
        self.assertTrue(notices[0]["is_notice"])

    def test_filters_and_search(self):
        self.assertEqual([r["id"] for r in self._queue(view="all", category="technical")["results"]], [self.replied.id])
        self.assertEqual([r["id"] for r in self._queue(view="all", q=f"#{self.open.id}")["results"]], [self.open.id])
        self.assertEqual(self.client.get("/api/admin/support/queue/", {"category": "nope"}).status_code, 400)
        self.assertEqual(self.client.get("/api/admin/support/queue/", {"view": "nope"}).status_code, 400)

    def test_conversation_includes_messages_and_staff_events(self):
        self.client.post(f"/api/admin/support/tickets/{self.open.id}/update/", {"priority": "high"}, format="json")
        res = self.client.get(f"/api/admin/support/tickets/{self.open.id}/conversation/")
        self.assertEqual(res.status_code, 200)
        body = res.json()
        self.assertEqual(body["ticket"]["priority"], "high")
        self.assertEqual(len(body["messages"]), 1)
        self.assertEqual(body["events"][-1]["changes"]["priority"], {"old": "urgent", "new": "high"})

    def test_reply_succeeds_when_realtime_layer_is_down(self):
        with mock.patch("apps.admin_api.realtime.get_channel_layer", return_value=_BrokenLayer()):
            with self.assertLogs("apps.admin_api.realtime", level="WARNING"):
                res = self.client.post(
                    f"/api/admin/support/tickets/{self.open.id}/reply/", {"message": "Looking into it"}, format="json",
                )
        self.assertEqual(res.status_code, 200, res.content)
        self.assertTrue(self.open.messages.filter(is_admin=True, message="Looking into it").exists())

    def test_user_ticket_creation_succeeds_when_realtime_layer_is_down(self):
        self.client.force_authenticate(self.user)
        with mock.patch("apps.admin_api.realtime.get_channel_layer", return_value=_BrokenLayer()):
            res = self.client.post(
                "/api/auth/support/tickets/create/",
                {"subject": "Help", "category": "general", "priority": "medium", "message": "Question"},
                format="json",
            )
        self.assertIn(res.status_code, (200, 201), res.content)
        self.assertTrue(SupportTicket.objects.filter(subject="Help").exists())

    def test_staff_note_is_not_exposed_to_the_user(self):
        self.open.admin_notes = "Suspect chargeback"
        self.open.save()
        self.client.force_authenticate(self.user)
        res = self.client.get("/api/auth/support/tickets/")
        self.assertEqual(res.status_code, 200)
        self.assertNotIn("Suspect chargeback", res.content.decode())
        self.assertNotIn("admin_notes", res.content.decode())


class SettingsContextTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.admin = User.objects.create_user(
            username="cfg_admin", email="cfg@example.com", phone_number="254700000031",
            password="pass12345!", is_staff=True,
        )
        self.client.force_authenticate(self.admin)

    def test_context_reports_limits_history_and_staff(self):
        self.client.post("/api/admin/settings/update/", {"platform_fee_percentage": "12.50"}, format="json")
        res = self.client.get("/api/admin/settings/context/")
        self.assertEqual(res.status_code, 200)
        body = res.json()
        self.assertIn("platform_fee_percentage", body["enforced_by"])
        self.assertIn("min_withdrawal_kes", body["server_limits"]["payments"])
        self.assertEqual(body["history"][0]["admin_username"], "cfg_admin")
        self.assertEqual(body["history"][0]["changes"]["platform_fee_percentage"]["new"], "12.50")
        self.assertEqual([s["username"] for s in body["staff"]], ["cfg_admin"])
        self.assertTrue(AuditLog.objects.filter(resource_type="settings").exists())

    def test_context_requires_staff(self):
        user = User.objects.create_user(username="plain", email="p@example.com", phone_number="254700000032",
                                        password="pass12345!")
        self.client.force_authenticate(user)
        self.assertEqual(self.client.get("/api/admin/settings/context/").status_code, 403)
