import uuid
from django.contrib.auth import get_user_model
from rest_framework import status
from rest_framework.test import APITestCase

from apps.admin_api.models import SupportTicket, SupportTicketMessage
from apps.admin_api.roles import OWNER

User = get_user_model()


class SupportTicketReplySecurityTests(APITestCase):
    def setUp(self):
        unique_suffix = uuid.uuid4().hex[:8]
        self.user = User.objects.create_user(
            username=f"user_{unique_suffix}",
            email=f"user_{unique_suffix}@example.com",
            phone_number=f"25471{unique_suffix[:7]}",
            password="TestPassword123!",
        )
        self.admin = User.objects.create_user(
            username=f"admin_{unique_suffix}",
            email=f"admin_{unique_suffix}@example.com",
            phone_number=f"25470{unique_suffix[:7]}",
            password="AdminPassword123!",
            is_staff=True,
        )
        from apps.admin_api.models import StaffProfile

        StaffProfile.objects.create(
            user=self.admin,
            roles=["support"],
            updated_by=self.admin,
        )

        self.ticket = SupportTicket.objects.create(
            user=self.user,
            subject="Security test ticket",
            category="general",
            priority="medium",
            status="open",
            message="Initial question",
        )

    def test_user_support_ticket_reply_sanitizes_xss(self):
        self.client.force_authenticate(user=self.user)
        xss_payload = "<script>alert('xss')</script>Hello <img src=x onerror=alert(1)>World"
        response = self.client.post(
            f"/api/auth/support/tickets/{self.ticket.id}/reply/",
            {"message": xss_payload},
            format="json",
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        reply_message = SupportTicketMessage.objects.filter(
            ticket=self.ticket, sender=self.user
        ).latest("created_at")

        self.assertNotIn("<script>", reply_message.message)
        self.assertNotIn("<img", reply_message.message)
        self.assertNotIn("onerror", reply_message.message)
        self.assertEqual(reply_message.message, "alert('xss')Hello World")

    def test_user_support_ticket_reply_enforces_max_length(self):
        self.client.force_authenticate(user=self.user)
        oversized_message = "A" * 5001
        response = self.client.post(
            f"/api/auth/support/tickets/{self.ticket.id}/reply/",
            {"message": oversized_message},
            format="json",
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("maximum length", response.data.get("error", ""))

    def test_admin_support_ticket_reply_sanitizes_xss(self):
        self.client.force_authenticate(user=self.admin)
        xss_payload = "<b>Staff reply</b><script>alert(2)</script><iframe src='javascript:alert(3)'></iframe>"
        response = self.client.post(
            f"/api/admin/support/tickets/{self.ticket.id}/reply/",
            {"message": xss_payload},
            format="json",
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        reply_message = SupportTicketMessage.objects.filter(
            ticket=self.ticket, sender=self.admin
        ).latest("created_at")

        self.assertNotIn("<b>", reply_message.message)
        self.assertNotIn("<script>", reply_message.message)
        self.assertNotIn("<iframe", reply_message.message)
        self.assertEqual(reply_message.message, "Staff replyalert(2)")

    def test_admin_support_ticket_reply_enforces_max_length(self):
        self.client.force_authenticate(user=self.admin)
        oversized_message = "B" * 5001
        response = self.client.post(
            f"/api/admin/support/tickets/{self.ticket.id}/reply/",
            {"message": oversized_message},
            format="json",
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("maximum length", response.data.get("error", ""))
