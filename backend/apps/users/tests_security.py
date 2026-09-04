from django.contrib.auth import get_user_model
from rest_framework import status
from rest_framework.test import APITestCase
from apps.admin_api.models import SupportTicket, SupportTicketMessage

User = get_user_model()


class SupportTicketSanitizerTests(APITestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            username='ticket_user',
            email='ticket_user@example.com',
            password='TestPass123!',
            phone_number='254711223344',
        )
        self.admin = User.objects.create_user(
            username='ticket_admin',
            email='ticket_admin@example.com',
            password='TestPass123!',
            phone_number='254755667788',
            is_staff=True,
        )
        self.ticket = SupportTicket.objects.create(
            user=self.user,
            subject='Help Needed',
            message='Initial issue message',
            status='open',
        )

    def test_user_reply_sanitizes_xss_and_strips_html(self):
        self.client.force_authenticate(user=self.user)
        payload = {'message': '<script>alert("xss")</script>Hello Support!'}

        response = self.client.post(
            f'/api/auth/support/tickets/{self.ticket.id}/reply/',
            payload,
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        reply = SupportTicketMessage.objects.filter(ticket=self.ticket, sender=self.user).last()
        self.assertIsNotNone(reply)
        self.assertEqual(reply.message, 'alert("xss")Hello Support!')

    def test_user_reply_rejects_exceeding_max_length(self):
        self.client.force_authenticate(user=self.user)
        payload = {'message': 'a' * 5001}

        response = self.client.post(
            f'/api/auth/support/tickets/{self.ticket.id}/reply/',
            payload,
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

    def test_admin_reply_sanitizes_xss_and_strips_html(self):
        self.client.force_authenticate(user=self.admin)
        payload = {'message': '<b>Admin Notice:</b> <script>steal()</script>Issue received.'}

        response = self.client.post(
            f'/api/admin/support/tickets/{self.ticket.id}/reply/',
            payload,
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        reply = SupportTicketMessage.objects.filter(ticket=self.ticket, sender=self.admin).last()
        self.assertIsNotNone(reply)
        self.assertEqual(reply.message, 'Admin Notice: steal()Issue received.')
