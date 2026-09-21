from django.contrib.auth import get_user_model
from rest_framework import status
from rest_framework.test import APITestCase
from apps.admin_api.models import SupportTicket, SupportTicketMessage

User = get_user_model()


class SupportTicketReplySecurityTestCase(APITestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            username='support_user',
            email='user@example.com',
            password='TestPassword123!',
            phone_number='254712345678',
        )
        self.ticket = SupportTicket.objects.create(
            user=self.user,
            subject='Test Ticket',
            category='general',
            priority='medium',
            message='Initial problem description',
            status='open',
        )
        self.url = f'/api/auth/support/tickets/{self.ticket.id}/reply/'

    def test_reply_strips_html_tags_stored_xss(self):
        self.client.force_authenticate(user=self.user)
        malicious_html = "<script>alert('xss')</script>Hello <b>world</b>"

        response = self.client.post(self.url, {'message': malicious_html}, format='json')
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        reply = SupportTicketMessage.objects.filter(ticket=self.ticket, is_admin=False).last()
        self.assertIsNotNone(reply)
        self.assertNotIn('<script>', reply.message)
        self.assertNotIn('<b>', reply.message)
        self.assertIn("alert('xss')Hello world", reply.message)

    def test_reply_rejects_exceeding_max_length(self):
        self.client.force_authenticate(user=self.user)
        long_message = 'a' * 5001

        response = self.client.post(self.url, {'message': long_message}, format='json')
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('exceeds maximum length', str(response.data.get('error', '')))
