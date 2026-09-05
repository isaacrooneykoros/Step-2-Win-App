from django.contrib.auth import get_user_model
from rest_framework import status
from rest_framework.test import APITestCase
from apps.admin_api.models import SupportTicket, SupportTicketMessage

User = get_user_model()


class SupportTicketSecurityTests(APITestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            username='security_user',
            email='security_user@example.com',
            password='TestPass123!',
            phone_number='+254712345678',
        )
        self.admin = User.objects.create_user(
            username='security_admin',
            email='security_admin@example.com',
            password='TestPass123!',
            phone_number='+254787654321',
            is_staff=True,
        )
        self.ticket = SupportTicket.objects.create(
            user=self.user,
            subject='Security Test Ticket',
            category='general',
            priority='medium',
            message='Initial test ticket message',
            status='open',
        )

    def test_user_ticket_reply_sanitizes_xss(self):
        self.client.force_authenticate(user=self.user)
        xss_payload = '<script>alert("xss")</script>Thank you for helping.'

        response = self.client.post(
            f'/api/auth/support/tickets/{self.ticket.id}/reply/',
            {'message': xss_payload},
            format='json',
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        reply = SupportTicketMessage.objects.filter(ticket=self.ticket, is_admin=False).last()
        self.assertIsNotNone(reply)
        self.assertNotIn('<script>', reply.message)
        self.assertEqual(reply.message, 'alert("xss")Thank you for helping.')

    def test_user_ticket_reply_length_limit(self):
        self.client.force_authenticate(user=self.user)
        overly_long_payload = 'A' * 5001

        response = self.client.post(
            f'/api/auth/support/tickets/{self.ticket.id}/reply/',
            {'message': overly_long_payload},
            format='json',
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

    def test_admin_ticket_reply_sanitizes_xss(self):
        self.client.force_authenticate(user=self.admin)
        xss_payload = '<b>Hello</b> <img src=x onerror=alert(1)>'

        response = self.client.post(
            f'/api/admin/support/tickets/{self.ticket.id}/reply/',
            {'message': xss_payload},
            format='json',
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        reply = SupportTicketMessage.objects.filter(ticket=self.ticket, is_admin=True).last()
        self.assertIsNotNone(reply)
        self.assertNotIn('<img', reply.message)
        self.assertEqual(reply.message, 'Hello')
