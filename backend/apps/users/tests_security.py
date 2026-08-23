from django.contrib.auth import get_user_model
from rest_framework import status
from rest_framework.test import APITestCase
from apps.admin_api.models import SupportTicket, SupportTicketMessage

User = get_user_model()


class SupportTicketSecurityTests(APITestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            username='security_user',
            email='user@example.com',
            phone_number='+254712345678',
            password='TestPass123!',
        )
        self.admin = User.objects.create_user(
            username='security_admin',
            email='admin@example.com',
            phone_number='+254787654321',
            password='TestPass123!',
            is_staff=True,
        )
        self.ticket = SupportTicket.objects.create(
            user=self.user,
            subject='Security Test Ticket',
            category='account',
            priority='medium',
            message='Initial message',
            status='open',
        )

    def test_user_reply_sanitizes_html_xss(self):
        self.client.force_authenticate(user=self.user)
        malicious_message = '<script>alert("xss")</script>Hello Support <b>Team</b>'

        response = self.client.post(
            f'/api/auth/support/tickets/{self.ticket.id}/reply/',
            {'message': malicious_message},
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        reply = SupportTicketMessage.objects.filter(ticket=self.ticket, sender=self.user).last()
        self.assertIsNotNone(reply)
        self.assertNotIn('<script>', reply.message)
        self.assertNotIn('<b>', reply.message)
        self.assertIn('alert("xss")Hello Support Team', reply.message)

    def test_user_reply_rejects_exceeding_max_length(self):
        self.client.force_authenticate(user=self.user)
        overlong_message = 'A' * 5001

        response = self.client.post(
            f'/api/auth/support/tickets/{self.ticket.id}/reply/',
            {'message': overlong_message},
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('maximum length', str(response.data.get('error', '')))

    def test_admin_reply_sanitizes_html_xss(self):
        self.client.force_authenticate(user=self.admin)
        malicious_message = '<iframe src="javascript:alert(1)"></iframe>Admin Response'

        response = self.client.post(
            f'/api/admin/support/tickets/{self.ticket.id}/reply/',
            {'message': malicious_message},
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        reply = SupportTicketMessage.objects.filter(ticket=self.ticket, sender=self.admin).last()
        self.assertIsNotNone(reply)
        self.assertNotIn('<iframe', reply.message)
        self.assertEqual(reply.message, 'Admin Response')

    def test_admin_reply_rejects_exceeding_max_length(self):
        self.client.force_authenticate(user=self.admin)
        overlong_message = 'B' * 5001

        response = self.client.post(
            f'/api/admin/support/tickets/{self.ticket.id}/reply/',
            {'message': overlong_message},
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('maximum length', str(response.data.get('error', '')))
