"""Security tests for Support Ticket Replies (Stored XSS sanitization and length validation)."""

from django.contrib.auth import get_user_model
from django.test import TestCase
from rest_framework.test import APIClient

from apps.admin_api.models import SupportTicket, SupportTicketMessage

User = get_user_model()


class SupportTicketReplySecurityTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.user = User.objects.create_user(
            username="testuser",
            email="testuser@example.com",
            phone_number="254712345678",
            password="pass12345!",
        )
        self.admin = User.objects.create_user(
            username="testadmin",
            email="testadmin@example.com",
            phone_number="254700000000",
            password="pass12345!",
            is_staff=True,
        )
        self.ticket = SupportTicket.objects.create(
            user=self.user,
            subject="Help needed",
            category="general",
            message="I need help",
            status="open",
        )

    def test_user_reply_sanitizes_xss_and_enforces_max_length(self):
        self.client.force_authenticate(self.user)

        # 1. Test XSS sanitization in user reply
        xss_payload = "<script>alert('xss')</script>Hello <b>World</b>"
        res = self.client.post(
            f"/api/auth/support/tickets/{self.ticket.id}/reply/",
            {"message": xss_payload},
            format="json",
        )
        self.assertEqual(res.status_code, 200, res.content)

        msg = SupportTicketMessage.objects.filter(ticket=self.ticket, sender=self.user).last()
        self.assertIsNotNone(msg)
        self.assertNotIn("<script>", msg.message)
        self.assertNotIn("<b>", msg.message)
        self.assertEqual(msg.message, "alert('xss')Hello World")

        # 2. Test max length enforcement (max 5000 chars)
        long_payload = "A" * 5001
        res_long = self.client.post(
            f"/api/auth/support/tickets/{self.ticket.id}/reply/",
            {"message": long_payload},
            format="json",
        )
        self.assertEqual(res_long.status_code, 400)
        self.assertIn("exceeds maximum length", res_long.data["error"])

    def test_admin_reply_sanitizes_xss_and_enforces_max_length(self):
        self.client.force_authenticate(self.admin)

        # 1. Test XSS sanitization in admin reply
        xss_payload = "<iframe src='javascript:alert(1)'></iframe>Admin reply <img src=x onerror=alert(1)>"
        res = self.client.post(
            f"/api/admin/support/tickets/{self.ticket.id}/reply/",
            {"message": xss_payload},
            format="json",
        )
        self.assertEqual(res.status_code, 200, res.content)

        msg = SupportTicketMessage.objects.filter(ticket=self.ticket, sender=self.admin).last()
        self.assertIsNotNone(msg)
        self.assertNotIn("<iframe", msg.message)
        self.assertNotIn("<img", msg.message)
        self.assertEqual(msg.message, "Admin reply")

        # 2. Test max length enforcement (max 5000 chars)
        long_payload = "B" * 5001
        res_long = self.client.post(
            f"/api/admin/support/tickets/{self.ticket.id}/reply/",
            {"message": long_payload},
            format="json",
        )
        self.assertEqual(res_long.status_code, 400)
        self.assertIn("exceeds maximum length", res_long.data["error"])
