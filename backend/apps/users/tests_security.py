from django.contrib.auth import get_user_model
from rest_framework import status
from rest_framework.test import APITestCase

from apps.admin_api.models import SupportTicket, SupportTicketMessage


User = get_user_model()


class SupportTicketReplySecurityTests(APITestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            username='ticket_user',
            email='user@example.com',
            phone_number='+254712345678',
            password='TestPass123!',
        )
        self.admin = User.objects.create_user(
            username='admin_user',
            email='admin@example.com',
            phone_number='+254787654321',
            password='TestPass123!',
            is_staff=True,
        )
        self.ticket = SupportTicket.objects.create(
            user=self.user,
            subject='Help needed',
            category='account',
            priority='medium',
            message='Initial ticket message',
            status='open',
        )

    def test_user_support_ticket_reply_sanitizes_html(self):
        self.client.force_authenticate(user=self.user)
        payload = {'message': "<script>alert('xss')</script>Need assistance"}
        response = self.client.post(
            f'/api/auth/support/tickets/{self.ticket.id}/reply/',
            payload,
            format='json',
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        reply = SupportTicketMessage.objects.filter(ticket=self.ticket, is_admin=False).last()
        self.assertIsNotNone(reply)
        self.assertNotIn('<script>', reply.message)
        self.assertIn("alert('xss')Need assistance", reply.message)

    def test_admin_support_ticket_reply_sanitizes_html(self):
        self.client.force_authenticate(user=self.admin)
        payload = {'message': "<b>Hello</b> <iframe src='http://evil.com'></iframe>"}
        response = self.client.post(
            f'/api/admin/support/tickets/{self.ticket.id}/reply/',
            payload,
            format='json',
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        reply = SupportTicketMessage.objects.filter(ticket=self.ticket, is_admin=True).last()
        self.assertIsNotNone(reply)
        self.assertNotIn('<b>', reply.message)
        self.assertNotIn('<iframe', reply.message)
        self.assertIn('Hello', reply.message)

    def test_support_ticket_reply_exceeding_max_length_rejected(self):
        self.client.force_authenticate(user=self.user)
        payload = {'message': 'A' * 5001}
        response = self.client.post(
            f'/api/auth/support/tickets/{self.ticket.id}/reply/',
            payload,
            format='json',
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
