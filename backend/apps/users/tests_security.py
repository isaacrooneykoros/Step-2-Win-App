from django.contrib.auth import get_user_model
from rest_framework import status
from rest_framework.test import APITestCase
from apps.admin_api.models import SupportTicket, SupportTicketMessage

User = get_user_model()


class SupportTicketReplySecurityTests(APITestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            username='security_user',
            email='sec_user@example.com',
            phone_number='254711223344',
            password='TestPassword123!',
        )
        self.admin = User.objects.create_user(
            username='security_admin',
            email='sec_admin@example.com',
            phone_number='254711223345',
            password='AdminPassword123!',
            is_staff=True,
        )
        self.ticket = SupportTicket.objects.create(
            user=self.user,
            subject='Security Test Ticket',
            category='account',
            priority='medium',
            message='Need help with security.',
            status='open',
        )

    def test_user_reply_sanitizes_html_tags(self):
        self.client.force_authenticate(user=self.user)
        xss_payload = "<script>alert('xss')</script>Hello <b>Admin</b>"

        response = self.client.post(
            f'/api/auth/support/tickets/{self.ticket.id}/reply/',
            data={'message': xss_payload},
            format='json',
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        reply_msg = SupportTicketMessage.objects.filter(ticket=self.ticket, is_admin=False).last()
        self.assertIsNotNone(reply_msg)
        self.assertNotIn('<script>', reply_msg.message)
        self.assertEqual(reply_msg.message, "alert('xss')Hello Admin")

    def test_admin_reply_sanitizes_html_tags(self):
        self.client.force_authenticate(user=self.admin)
        xss_payload = "<iframe src='javascript:alert(1)'></iframe>Thank you <style>body{color:red}</style>"

        response = self.client.post(
            f'/api/admin/support/tickets/{self.ticket.id}/reply/',
            data={'message': xss_payload},
            format='json',
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        reply_msg = SupportTicketMessage.objects.filter(ticket=self.ticket, is_admin=True).last()
        self.assertIsNotNone(reply_msg)
        self.assertNotIn('<iframe', reply_msg.message)
        self.assertEqual(reply_msg.message, "Thank you body{color:red}")

    def test_user_reply_exceeding_max_length_rejected(self):
        self.client.force_authenticate(user=self.user)
        oversized_message = 'A' * 5001

        response = self.client.post(
            f'/api/auth/support/tickets/{self.ticket.id}/reply/',
            data={'message': oversized_message},
            format='json',
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('maximum length', response.data.get('error', ''))
