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
            phone_number='+254712345678',
            password='TestPassword123!',
        )
        self.admin = User.objects.create_user(
            username='admin_user',
            email='admin@example.com',
            phone_number='+254787654321',
            password='TestPassword123!',
            is_staff=True,
        )
        self.ticket = SupportTicket.objects.create(
            user=self.user,
            subject='Help Needed',
            category='general',
            priority='medium',
            message='Initial message',
            status='open',
        )

    def test_user_ticket_reply_strips_html_and_prevents_xss(self):
        self.client.force_authenticate(user=self.user)
        xss_payload = "<script>alert('XSS')</script>Hello Support <img src=x onerror=alert(1)>"

        response = self.client.post(
            f'/api/auth/support/tickets/{self.ticket.id}/reply/',
            {'message': xss_payload},
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        reply = SupportTicketMessage.objects.filter(ticket=self.ticket, sender=self.user).first()
        self.assertIsNotNone(reply)
        self.assertNotIn('<script>', reply.message)
        self.assertNotIn('<img', reply.message)
        self.assertEqual(reply.message, "alert('XSS')Hello Support")

    def test_admin_ticket_reply_strips_html_and_prevents_xss(self):
        self.client.force_authenticate(user=self.admin)
        xss_payload = "<b>Admin</b> <script>document.cookie</script>"

        response = self.client.post(
            f'/api/admin/support/tickets/{self.ticket.id}/reply/',
            {'message': xss_payload},
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        reply = SupportTicketMessage.objects.filter(ticket=self.ticket, sender=self.admin).first()
        self.assertIsNotNone(reply)
        self.assertNotIn('<script>', reply.message)
        self.assertNotIn('<b>', reply.message)
        self.assertEqual(reply.message, 'Admin document.cookie')

    def test_ticket_reply_exceeding_max_length_returns_400(self):
        self.client.force_authenticate(user=self.user)
        overlong_message = 'A' * 5001

        response = self.client.post(
            f'/api/auth/support/tickets/{self.ticket.id}/reply/',
            {'message': overlong_message},
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
