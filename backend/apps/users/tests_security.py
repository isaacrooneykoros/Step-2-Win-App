from django.contrib.auth import get_user_model
from rest_framework import status
from rest_framework.test import APITestCase
from apps.admin_api.models import SupportTicket, SupportTicketMessage

User = get_user_model()


class SupportTicketSecurityTests(APITestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            username='ticket_user',
            email='user@example.com',
            password='TestPass123!',
            phone_number='+254712345678',
        )
        self.admin = User.objects.create_user(
            username='ticket_admin',
            email='admin@example.com',
            password='TestPass123!',
            phone_number='+254787654321',
            is_staff=True,
        )
        self.ticket = SupportTicket.objects.create(
            user=self.user,
            subject='Security Test Ticket',
            category='general',
            priority='medium',
            message='Initial message',
            status='open',
        )

    def test_user_reply_sanitizes_xss(self):
        self.client.force_authenticate(user=self.user)
        xss_payload = "<script>alert('xss')</script>User reply text"

        response = self.client.post(
            f'/api/auth/support/tickets/{self.ticket.id}/reply/',
            {'message': xss_payload},
            format='json',
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        reply = SupportTicketMessage.objects.filter(ticket=self.ticket, is_admin=False).last()
        self.assertIsNotNone(reply)
        self.assertNotIn('<script>', reply.message)
        self.assertEqual(reply.message, "alert('xss')User reply text")

    def test_user_reply_enforces_length_limit(self):
        self.client.force_authenticate(user=self.user)
        oversized_message = 'A' * 5001

        response = self.client.post(
            f'/api/auth/support/tickets/{self.ticket.id}/reply/',
            {'message': oversized_message},
            format='json',
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

    def test_admin_reply_sanitizes_xss(self):
        self.client.force_authenticate(user=self.admin)
        xss_payload = "<img src=x onerror=alert('admin_xss')>Admin reply text"

        response = self.client.post(
            f'/api/admin/support/tickets/{self.ticket.id}/reply/',
            {'message': xss_payload},
            format='json',
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        reply = SupportTicketMessage.objects.filter(ticket=self.ticket, is_admin=True).last()
        self.assertIsNotNone(reply)
        self.assertNotIn('<img', reply.message)
        self.assertEqual(reply.message, 'Admin reply text')

    def test_admin_reply_enforces_length_limit(self):
        self.client.force_authenticate(user=self.admin)
        oversized_message = 'B' * 5001

        response = self.client.post(
            f'/api/admin/support/tickets/{self.ticket.id}/reply/',
            {'message': oversized_message},
            format='json',
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
