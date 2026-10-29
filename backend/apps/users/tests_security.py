from django.contrib.auth import get_user_model
from rest_framework import status
from rest_framework.test import APITestCase

from apps.admin_api.models import SupportTicket, SupportTicketMessage

User = get_user_model()


class SupportTicketReplySecurityTests(APITestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            username="testuser_sec",
            email="testuser_sec@example.com",
            password="Password123!",
            phone_number="254711223344",
        )
        self.admin = User.objects.create_superuser(
            username="admin_sec",
            email="admin_sec@example.com",
            password="Password123!",
            phone_number="254711223345",
            is_staff=True,
        )
        self.ticket = SupportTicket.objects.create(
            user=self.user,
            subject="Need Help",
            category="general",
            priority="medium",
            message="Initial support issue",
            status="open",
        )

    def test_user_reply_sanitizes_html_xss(self):
        self.client.force_authenticate(user=self.user)
        url = f"/api/auth/support/tickets/{self.ticket.id}/reply/"
        payload = {"message": "<script>alert('xss')</script>Hello Support"}

        response = self.client.post(url, payload, format="json")
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        reply = SupportTicketMessage.objects.filter(
            ticket=self.ticket, is_admin=False
        ).last()
        self.assertIsNotNone(reply)
        self.assertNotIn("<script>", reply.message)
        self.assertEqual(reply.message, "alert('xss')Hello Support")

    def test_admin_reply_sanitizes_html_xss(self):
        self.client.force_authenticate(user=self.admin)
        url = f"/api/admin/support/tickets/{self.ticket.id}/reply/"
        payload = {"message": "<b>Hello</b> <img src=x onerror=alert(1)>User"}

        response = self.client.post(url, payload, format="json")
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        reply = SupportTicketMessage.objects.filter(
            ticket=self.ticket, is_admin=True
        ).last()
        self.assertIsNotNone(reply)
        self.assertNotIn("<img", reply.message)
        self.assertNotIn("<b>", reply.message)
        self.assertEqual(reply.message, "Hello User")

    def test_user_reply_exceeds_max_length_returns_bad_request(self):
        self.client.force_authenticate(user=self.user)
        url = f"/api/auth/support/tickets/{self.ticket.id}/reply/"
        payload = {"message": "A" * 5001}

        response = self.client.post(url, payload, format="json")
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

    def test_admin_reply_exceeds_max_length_returns_bad_request(self):
        self.client.force_authenticate(user=self.admin)
        url = f"/api/admin/support/tickets/{self.ticket.id}/reply/"
        payload = {"message": "B" * 5001}

        response = self.client.post(url, payload, format="json")
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
