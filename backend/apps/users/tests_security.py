from django.contrib.auth import get_user_model
from rest_framework import status
from rest_framework.test import APITestCase

from apps.admin_api.models import SupportTicket, SupportTicketMessage

User = get_user_model()


class SupportTicketSecurityTestCase(APITestCase):
    """
    Security test suite for user and admin support ticket endpoints.
    Verifies input sanitization against Stored XSS, length validation,
    and safe exception handling for invalid/malformed ticket IDs.
    """

    def setUp(self):
        self.user = User.objects.create_user(
            username="testuser",
            email="user@test.com",
            password="Password123!",
            phone_number="254712345678",
        )
        self.admin = User.objects.create_superuser(
            username="adminuser",
            email="admin@test.com",
            password="Password123!",
            phone_number="254700000000",
            is_staff=True,
        )
        self.ticket = SupportTicket.objects.create(
            user=self.user,
            subject="Help needed",
            category="general",
            priority="medium",
            message="Initial question",
            status="open",
        )

    def test_user_ticket_detail_nonexistent_id_returns_404(self):
        """Non-existent ticket ID should return 404 Not Found."""
        self.client.force_authenticate(user=self.user)
        response = self.client.get("/api/auth/support/tickets/999999999/")
        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)
        self.assertEqual(response.json(), {"error": "Support ticket not found"})

    def test_user_ticket_reply_nonexistent_id_returns_404(self):
        """Replying to non-existent ticket ID should return 404 Not Found."""
        self.client.force_authenticate(user=self.user)
        response = self.client.post(
            "/api/auth/support/tickets/999999999/reply/",
            {"message": "Hello"},
            format="json",
        )
        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)

    def test_user_ticket_status_nonexistent_id_returns_404(self):
        """Updating status of non-existent ticket ID should return 404 Not Found."""
        self.client.force_authenticate(user=self.user)
        response = self.client.patch(
            "/api/auth/support/tickets/999999999/status/",
            {"status": "resolved"},
            format="json",
        )
        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)

    def test_user_ticket_reply_sanitizes_xss(self):
        """User reply messages with script/HTML tags must be sanitized to prevent Stored XSS."""
        self.client.force_authenticate(user=self.user)
        xss_payload = "<script>alert('xss')</script>Hello <b>world</b>"
        response = self.client.post(
            f"/api/auth/support/tickets/{self.ticket.id}/reply/",
            {"message": xss_payload},
            format="json",
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        reply = SupportTicketMessage.objects.filter(
            ticket=self.ticket, sender=self.user
        ).last()
        self.assertIsNotNone(reply)
        self.assertNotIn("<script>", reply.message)
        self.assertNotIn("<b>", reply.message)
        self.assertIn("Hello world", reply.message)

    def test_user_ticket_reply_exceeding_max_length(self):
        """User reply messages exceeding 5000 characters must return 400 Bad Request."""
        self.client.force_authenticate(user=self.user)
        long_message = "a" * 5001
        response = self.client.post(
            f"/api/auth/support/tickets/{self.ticket.id}/reply/",
            {"message": long_message},
            format="json",
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

    def test_admin_ticket_detail_nonexistent_id_returns_404(self):
        """Admin endpoint with non-existent ticket ID should return 404 Not Found."""
        self.client.force_authenticate(user=self.admin)
        response = self.client.get("/api/admin/support/tickets/999999999/")
        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)

    def test_admin_ticket_reply_sanitizes_xss(self):
        """Admin reply messages with script/HTML tags must be sanitized to prevent Stored XSS."""
        self.client.force_authenticate(user=self.admin)
        xss_payload = "<iframe src='evil.com'></iframe>Admin response <script>steal()</script>"
        response = self.client.post(
            f"/api/admin/support/tickets/{self.ticket.id}/reply/",
            {"message": xss_payload},
            format="json",
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        reply = SupportTicketMessage.objects.filter(
            ticket=self.ticket, sender=self.admin
        ).last()
        self.assertIsNotNone(reply)
        self.assertNotIn("<iframe", reply.message)
        self.assertNotIn("<script", reply.message)
        self.assertIn("Admin response", reply.message)
