"""Security test suite for user support ticket sanitization and input limits."""

from django.contrib.auth import get_user_model
from django.test import TestCase
from rest_framework.test import APIClient

from apps.admin_api.models import SupportTicket

User = get_user_model()


class SupportTicketSecurityTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.user = User.objects.create_user(
            username="sec_user",
            email="sec@example.com",
            phone_number="254711111111",
            password="pass12345!",
        )
        self.admin = User.objects.create_user(
            username="sec_admin",
            email="admin_sec@example.com",
            phone_number="254722222222",
            password="pass12345!",
            is_staff=True,
        )
        self.ticket = SupportTicket.objects.create(
            user=self.user,
            subject="Test Ticket",
            category="general",
            priority="medium",
            message="Initial question",
            status="open",
        )

    def test_user_reply_sanitizes_html_script_tags(self):
        self.client.force_authenticate(self.user)
        payload = {"message": "<script>alert('xss')</script>Hello Support!"}
        res = self.client.post(
            f"/api/auth/support/tickets/{self.ticket.id}/reply/",
            payload,
            format="json",
        )
        self.assertEqual(res.status_code, 200)
        last_msg = self.ticket.messages.order_by("-created_at").first()
        self.assertNotIn("<script>", last_msg.message)
        self.assertIn("alert('xss')Hello Support!", last_msg.message)

    def test_user_reply_enforces_max_length(self):
        self.client.force_authenticate(self.user)
        payload = {"message": "A" * 5001}
        res = self.client.post(
            f"/api/auth/support/tickets/{self.ticket.id}/reply/",
            payload,
            format="json",
        )
        self.assertEqual(res.status_code, 400)

    def test_admin_reply_sanitizes_html_script_tags(self):
        self.client.force_authenticate(self.admin)
        payload = {"message": "<b>Hello</b> <script>alert(1)</script>User"}
        res = self.client.post(
            f"/api/admin/support/tickets/{self.ticket.id}/reply/",
            payload,
            format="json",
        )
        self.assertEqual(res.status_code, 200)
        last_msg = self.ticket.messages.order_by("-created_at").first()
        self.assertNotIn("<script>", last_msg.message)
        self.assertNotIn("<b>", last_msg.message)
        self.assertIn("Hello alert(1)User", last_msg.message)

    def test_admin_reply_enforces_max_length(self):
        self.client.force_authenticate(self.admin)
        payload = {"message": "B" * 5001}
        res = self.client.post(
            f"/api/admin/support/tickets/{self.ticket.id}/reply/",
            payload,
            format="json",
        )
        self.assertEqual(res.status_code, 400)
