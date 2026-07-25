from django.contrib.auth import get_user_model
from rest_framework import status
from rest_framework.test import APITestCase
from unittest.mock import patch
from apps.admin_api.models import SupportTicket, SupportTicketMessage

User = get_user_model()

class SupportTicketSecurityTests(APITestCase):
    def setUp(self):
        # Patch realtime broadcasts to avoid Redis connection errors in test environment
        self.patcher1 = patch('apps.admin_api.realtime.broadcast_support_message')
        self.patcher2 = patch('apps.admin_api.realtime.broadcast_support_ticket')
        self.mock_broadcast_msg = self.patcher1.start()
        self.mock_broadcast_tkt = self.patcher2.start()

        # Create user
        self.user = User.objects.create_user(
            username="ticket_user",
            email="user@example.com",
            password="TestPassword123!",
            phone_number="+254712345678"
        )

        # Create admin
        self.admin = User.objects.create_user(
            username="ticket_admin",
            email="admin@example.com",
            password="TestPassword123!",
            phone_number="+254712345679",
            is_staff=True
        )

        # Create support ticket
        self.ticket = SupportTicket.objects.create(
            user=self.user,
            subject="Test Subject",
            category="technical",
            priority="medium",
            message="Initial Message",
            status="open"
        )

    def tearDown(self):
        self.patcher1.stop()
        self.patcher2.stop()

    def test_user_reply_sanitization_xss(self):
        """Verify user support ticket replies are sanitized against Stored XSS."""
        self.client.force_authenticate(user=self.user)

        malicious_input = "<script>alert('xss')</script>Hello, I need help!"
        expected_output = "alert('xss')Hello, I need help!"

        response = self.client.post(
            f"/api/auth/support/tickets/{self.ticket.id}/reply/",
            {"message": malicious_input},
            format="json"
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        # Fetch last message
        last_message = SupportTicketMessage.objects.filter(ticket=self.ticket).order_by('-created_at').first()
        self.assertIsNotNone(last_message)
        self.assertEqual(last_message.message, expected_output)

    def test_user_reply_length_limit(self):
        """Verify user support ticket replies enforce the 5000-character length limit."""
        self.client.force_authenticate(user=self.user)

        excessive_input = "A" * 5001
        response = self.client.post(
            f"/api/auth/support/tickets/{self.ticket.id}/reply/",
            {"message": excessive_input},
            format="json"
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("exceeds maximum length", response.data.get("error", ""))

    def test_admin_reply_sanitization_xss(self):
        """Verify admin support ticket replies are sanitized against Stored XSS."""
        self.client.force_authenticate(user=self.admin)

        malicious_input = "<img src=x onerror=alert(1)>Admin reply content"
        expected_output = "Admin reply content"

        response = self.client.post(
            f"/api/admin/support/tickets/{self.ticket.id}/reply/",
            {"message": malicious_input},
            format="json"
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        # Fetch last message
        last_message = SupportTicketMessage.objects.filter(ticket=self.ticket).order_by('-created_at').first()
        self.assertIsNotNone(last_message)
        self.assertEqual(last_message.message, expected_output)

    def test_admin_reply_length_limit(self):
        """Verify admin support ticket replies enforce the 5000-character length limit."""
        self.client.force_authenticate(user=self.admin)

        excessive_input = "B" * 5001
        response = self.client.post(
            f"/api/admin/support/tickets/{self.ticket.id}/reply/",
            {"message": excessive_input},
            format="json"
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("exceeds maximum length", response.data.get("error", ""))
