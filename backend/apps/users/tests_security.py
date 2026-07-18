from decimal import Decimal
from django.contrib.auth import get_user_model
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APITestCase
from apps.admin_api.models import SupportTicket, SupportTicketMessage

User = get_user_model()


class SupportTicketSecurityTests(APITestCase):
    def setUp(self):
        # Create standard user
        self.user = User.objects.create_user(
            username='regular_user',
            email='user@example.com',
            phone_number='0712345678',
            password='TestPass123!',
            wallet_balance=Decimal('100.00'),
        )
        # Create admin user
        self.admin_user = User.objects.create_user(
            username='admin_user',
            email='admin@example.com',
            phone_number='0787654321',
            password='TestPass123!',
            is_staff=True,
            is_active=True,
        )
        # Create a support ticket
        self.ticket = SupportTicket.objects.create(
            user=self.user,
            subject='Payment Issue',
            category='billing',
            priority='high',
            message='My deposit failed.',
            status='open',
        )

    def test_user_reply_strips_html_xss(self):
        self.client.force_authenticate(user=self.user)
        url = reverse('users:reply_support_ticket', kwargs={'ticket_id': self.ticket.id})

        unsafe_payload = "<script>alert('XSS')</script>Hello World!"
        response = self.client.post(url, {'message': unsafe_payload}, format='json')

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        # Check that the saved message in database does not contain HTML tags
        latest_reply = SupportTicketMessage.objects.filter(ticket=self.ticket).order_by('-created_at').first()
        self.assertIsNotNone(latest_reply)
        self.assertEqual(latest_reply.message, "alert('XSS')Hello World!")

    def test_user_reply_rejects_empty_after_sanitize(self):
        self.client.force_authenticate(user=self.user)
        url = reverse('users:reply_support_ticket', kwargs={'ticket_id': self.ticket.id})

        unsafe_payload = "<script></script>  "
        response = self.client.post(url, {'message': unsafe_payload}, format='json')

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('message is required', response.data.get('error', ''))

    def test_user_reply_rejects_exceeding_max_length(self):
        self.client.force_authenticate(user=self.user)
        url = reverse('users:reply_support_ticket', kwargs={'ticket_id': self.ticket.id})

        long_payload = "A" * 5001
        response = self.client.post(url, {'message': long_payload}, format='json')

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('exceeds maximum length', response.data.get('error', ''))

    def test_admin_reply_strips_html_xss(self):
        self.client.force_authenticate(user=self.admin_user)
        url = reverse('admin_api:support-ticket-reply', kwargs={'ticket_id': self.ticket.id})

        unsafe_payload = "<img src=x onerror=alert(1)>Admin Help!"
        response = self.client.post(url, {'message': unsafe_payload}, format='json')

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        latest_reply = SupportTicketMessage.objects.filter(ticket=self.ticket).order_by('-created_at').first()
        self.assertIsNotNone(latest_reply)
        self.assertEqual(latest_reply.message, "Admin Help!")

    def test_admin_reply_rejects_empty_after_sanitize(self):
        self.client.force_authenticate(user=self.admin_user)
        url = reverse('admin_api:support-ticket-reply', kwargs={'ticket_id': self.ticket.id})

        unsafe_payload = "<html><body></body></html>"
        response = self.client.post(url, {'message': unsafe_payload}, format='json')

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('message is required', response.data.get('error', ''))

    def test_admin_reply_rejects_exceeding_max_length(self):
        self.client.force_authenticate(user=self.admin_user)
        url = reverse('admin_api:support-ticket-reply', kwargs={'ticket_id': self.ticket.id})

        long_payload = "B" * 5001
        response = self.client.post(url, {'message': long_payload}, format='json')

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('exceeds maximum length', response.data.get('error', ''))
