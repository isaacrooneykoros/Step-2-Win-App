from django.contrib.auth import get_user_model
from rest_framework import status
from rest_framework.test import APITestCase
from apps.admin_api.models import SupportTicket, SupportTicketMessage

User = get_user_model()


class AdminSupportTicketSecurityTests(APITestCase):
    def setUp(self):
        self.admin = User.objects.create_superuser(
            username='admin_sec',
            email='admin_sec@example.com',
            password='Password123!',
            phone_number='254711223344',
            is_staff=True,
        )
        self.user = User.objects.create_user(
            username='user_sec',
            email='user_sec@example.com',
            password='Password123!',
            phone_number='254722334455',
        )
        self.ticket = SupportTicket.objects.create(
            user=self.user,
            subject='Security Test Ticket',
            category='account',
            priority='medium',
            message='Need assistance.',
            status='open',
        )
        self.client.force_authenticate(user=self.admin)

    def test_reply_support_ticket_sanitizes_html_xss(self):
        xss_payload = '<script>alert("xss")</script>Hello <b>Admin</b>'
        response = self.client.post(
            f'/api/admin/support/tickets/{self.ticket.id}/reply/',
            {'message': xss_payload},
            format='json',
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        reply_msg = SupportTicketMessage.objects.filter(ticket=self.ticket, is_admin=True).last()
        self.assertIsNotNone(reply_msg)
        self.assertEqual(reply_msg.message, 'alert("xss")Hello Admin')

    def test_reply_support_ticket_exceeds_max_length(self):
        long_message = 'A' * 5001
        response = self.client.post(
            f'/api/admin/support/tickets/{self.ticket.id}/reply/',
            {'message': long_message},
            format='json',
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('error', response.data)
