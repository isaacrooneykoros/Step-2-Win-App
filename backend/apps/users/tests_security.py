from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase
from rest_framework import status
from apps.admin_api.models import SupportTicket, SupportTicketMessage

User = get_user_model()

class SupportTicketReplySecurityTests(APITestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            username="testuser",
            email="testuser@example.com",
            phone_number="254700000001",
            password="Password123!",
        )
        self.admin = User.objects.create_superuser(
            username="adminuser",
            email="adminuser@example.com",
            phone_number="254700000002",
            password="Password123!",
        )
        self.ticket = SupportTicket.objects.create(
            user=self.user,
            subject="Test Ticket",
            category="general",
            priority="medium",
            message="Initial question",
            status="open",
        )

    def test_user_reply_sanitizes_html(self):
        self.client.force_authenticate(user=self.user)
        url = f"/api/auth/support/tickets/{self.ticket.id}/reply/"
        payload = {"message": "Hello <script>alert('xss')</script> world!"}
        response = self.client.post(url, payload, format="json")
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        reply = SupportTicketMessage.objects.filter(ticket=self.ticket, sender=self.user).last()
        self.assertIsNotNone(reply)
        self.assertNotIn("<script>", reply.message)
        self.assertIn("Hello alert('xss') world!", reply.message)

    def test_user_reply_length_limit(self):
        self.client.force_authenticate(user=self.user)
        url = f"/api/auth/support/tickets/{self.ticket.id}/reply/"
        payload = {"message": "a" * 5001}
        response = self.client.post(url, payload, format="json")
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

    def test_admin_reply_sanitizes_html(self):
        self.client.force_authenticate(user=self.admin)
        url = f"/api/admin/support/tickets/{self.ticket.id}/reply/"
        payload = {"message": "Admin <img src=x onerror=alert(1)> response"}
        response = self.client.post(url, payload, format="json")
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        reply = SupportTicketMessage.objects.filter(ticket=self.ticket, sender=self.admin).last()
        self.assertIsNotNone(reply)
        self.assertNotIn("<img", reply.message)
        self.assertIn("Admin response", reply.message)

    def test_admin_reply_length_limit(self):
        self.client.force_authenticate(user=self.admin)
        url = f"/api/admin/support/tickets/{self.ticket.id}/reply/"
        payload = {"message": "b" * 5001}
        response = self.client.post(url, payload, format="json")
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
