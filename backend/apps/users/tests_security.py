from django.contrib.auth import get_user_model
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APITestCase

from apps.admin_api.models import SupportTicket, SupportTicketMessage

User = get_user_model()


class SupportTicketReplySecurityTests(APITestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            username="testuser",
            email="testuser@example.com",
            phone_number="0712345678",
            password="Password123!",
        )
        self.admin = User.objects.create_superuser(
            username="adminuser",
            email="admin@example.com",
            phone_number="0722345678",
            password="AdminPassword123!",
        )
        self.ticket = SupportTicket.objects.create(
            user=self.user,
            subject="Test Ticket",
            category="general",
            priority="medium",
            message="Initial support request",
            status="open",
        )
        self.user_reply_url = f"/api/auth/support/tickets/{self.ticket.id}/reply/"
        self.admin_reply_url = f"/api/admin/support/tickets/{self.ticket.id}/reply/"

    def test_user_reply_sanitizes_xss_and_html(self):
        self.client.force_authenticate(user=self.user)
        payload = {
            "message": "<script>alert('xss')</script>Hello <b>World</b> <iframe src='http://evil.com'></iframe>"
        }
        response = self.client.post(self.user_reply_url, payload, format="json")
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        last_msg = SupportTicketMessage.objects.filter(ticket=self.ticket).order_by("-id").first()
        self.assertIsNotNone(last_msg)
        self.assertNotIn("<script>", last_msg.message)
        self.assertNotIn("<b>", last_msg.message)
        self.assertNotIn("<iframe>", last_msg.message)
        self.assertIn("Hello World", last_msg.message)

    def test_admin_reply_sanitizes_xss_and_html(self):
        self.client.force_authenticate(user=self.admin)
        payload = {
            "message": "<img src=x onerror=alert(1)>Admin response <script>evil()</script>"
        }
        response = self.client.post(self.admin_reply_url, payload, format="json")
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        last_msg = SupportTicketMessage.objects.filter(ticket=self.ticket).order_by("-id").first()
        self.assertIsNotNone(last_msg)
        self.assertNotIn("<script>", last_msg.message)
        self.assertNotIn("<img", last_msg.message)
        self.assertIn("Admin response", last_msg.message)

    def test_user_reply_enforces_length_limit(self):
        self.client.force_authenticate(user=self.user)
        payload = {"message": "A" * 5001}
        response = self.client.post(self.user_reply_url, payload, format="json")
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

    def test_admin_reply_enforces_length_limit(self):
        self.client.force_authenticate(user=self.admin)
        payload = {"message": "B" * 5001}
        response = self.client.post(self.admin_reply_url, payload, format="json")
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
