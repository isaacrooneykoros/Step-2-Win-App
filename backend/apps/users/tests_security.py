from django.contrib.auth import get_user_model
from django.test import TestCase
from rest_framework import status
from rest_framework.test import APIClient

from apps.admin_api.models import SupportTicket, SupportTicketMessage

User = get_user_model()


class SupportTicketReplySecurityTests(TestCase):
    """
    Security test suite verifying Stored XSS sanitization and length validation
    for user and admin support ticket replies.
    """

    def setUp(self):
        self.user = User.objects.create_user(
            username="regular_user",
            email="user@example.com",
            password="userpassword123",
            phone_number="254712345678",
        )
        self.admin = User.objects.create_superuser(
            username="admin_user",
            email="admin@example.com",
            password="adminpassword123",
            phone_number="254700000000",
            is_staff=True,
            is_superuser=True,
        )
        self.ticket = SupportTicket.objects.create(
            user=self.user,
            subject="Billing issue",
            category="billing",
            priority="medium",
            message="Initial question",
            status="open",
        )
        self.client_user = APIClient()
        self.client_user.force_authenticate(user=self.user)

        self.client_admin = APIClient()
        self.client_admin.force_authenticate(user=self.admin)

    def test_user_reply_sanitizes_xss(self):
        url = f"/api/auth/support/tickets/{self.ticket.id}/reply/"
        payload = {
            "message": "<script>alert('pwned')</script><b>Hello</b> <img src=x onerror=alert(1)>world"
        }
        res = self.client_user.post(url, payload, format="json")
        self.assertEqual(res.status_code, status.HTTP_200_OK)

        last_message = (
            SupportTicketMessage.objects.filter(ticket=self.ticket).order_by("-id").first()
        )
        self.assertIsNotNone(last_message)
        self.assertNotIn("<script>", last_message.message)
        self.assertNotIn("</script>", last_message.message)
        self.assertNotIn("<b>", last_message.message)
        self.assertNotIn("<img", last_message.message)
        self.assertEqual(last_message.message, "alert('pwned')Hello world")

    def test_user_reply_enforces_max_length(self):
        url = f"/api/auth/support/tickets/{self.ticket.id}/reply/"
        long_message = "A" * 5001
        res = self.client_user.post(url, {"message": long_message}, format="json")
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("maximum length", res.data.get("error", ""))

    def test_admin_reply_sanitizes_xss(self):
        url = f"/api/admin/support/tickets/{self.ticket.id}/reply/"
        payload = {
            "message": "<script>alert('admin-xss')</script>Thank you for <iframe src='malicious'></iframe>contacting us."
        }
        res = self.client_admin.post(url, payload, format="json")
        self.assertEqual(res.status_code, status.HTTP_200_OK)

        last_message = (
            SupportTicketMessage.objects.filter(ticket=self.ticket).order_by("-id").first()
        )
        self.assertIsNotNone(last_message)
        self.assertNotIn("<script>", last_message.message)
        self.assertNotIn("</script>", last_message.message)
        self.assertNotIn("<iframe", last_message.message)
        self.assertEqual(last_message.message, "alert('admin-xss')Thank you for contacting us.")

    def test_admin_reply_enforces_max_length(self):
        url = f"/api/admin/support/tickets/{self.ticket.id}/reply/"
        long_message = "B" * 5001
        res = self.client_admin.post(url, {"message": long_message}, format="json")
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("maximum length", res.data.get("error", ""))
