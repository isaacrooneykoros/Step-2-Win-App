from rest_framework.test import APITestCase
from django.contrib.auth import get_user_model
from django.urls import reverse
from rest_framework import status
from apps.admin_api.models import SupportTicket, SupportTicketMessage

User = get_user_model()

class SupportTicketSecurityTests(APITestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            username='testuser',
            password='Password123!',
            email='testuser@example.com',
            phone_number='254700000001'
        )
        self.client.force_authenticate(user=self.user)
        self.ticket = SupportTicket.objects.create(
            user=self.user,
            subject='Test Ticket',
            message='Initial message',
            status='open'
        )

    def test_reply_support_ticket_sanitization(self):
        """Test that HTML is stripped from support ticket replies"""
        url = reverse('users:reply_support_ticket', kwargs={'ticket_id': self.ticket.id})
        payload = {
            'message': '<script>alert("xss")</script>Hello <b>World</b>'
        }
        response = self.client.post(url, payload)
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        # Check the last message for this ticket
        last_message = SupportTicketMessage.objects.filter(ticket=self.ticket).order_by('-created_at').first()
        self.assertEqual(last_message.message, 'alert("xss")Hello World')

    def test_reply_support_ticket_length_limit(self):
        """Test that reply message length is enforced"""
        url = reverse('users:reply_support_ticket', kwargs={'ticket_id': self.ticket.id})
        payload = {
            'message': 'a' * 5001
        }
        response = self.client.post(url, payload)
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('Value exceeds maximum length', response.data['error'])
