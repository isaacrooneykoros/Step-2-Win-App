from django.contrib.auth import get_user_model
from rest_framework import status
from rest_framework.test import APITestCase
from apps.admin_api.models import SupportTicket

User = get_user_model()


class AdminSupportTicketSecurityTestCase(APITestCase):
    def setUp(self):
        self.admin = User.objects.create_superuser(
            username='adminuser',
            email='admin@example.com',
            password='Password123!',
            phone_number='254700000000',
        )
        self.user = User.objects.create_user(
            username='regularuser',
            email='user@example.com',
            password='Password123!',
            phone_number='254711111111',
        )
        self.ticket = SupportTicket.objects.create(
            user=self.user,
            subject='Test Ticket',
            category='account',
            priority='medium',
            message='Need help with my account',
            status='open',
        )
        self.client.force_authenticate(user=self.admin)

    def test_update_support_ticket_sanitizes_admin_notes(self):
        url = f'/api/admin/support/tickets/{self.ticket.id}/update/'
        payload = {
            'admin_notes': '<script>alert("xss")</script><b>Admin note content</b>',
        }
        response = self.client.post(url, payload, format='json')
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.ticket.refresh_from_db()
        self.assertEqual(self.ticket.admin_notes, 'alert("xss")Admin note content')

    def test_update_support_ticket_admin_notes_max_length(self):
        url = f'/api/admin/support/tickets/{self.ticket.id}/update/'
        payload = {
            'admin_notes': 'a' * 5001,
        }
        response = self.client.post(url, payload, format='json')
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('Value exceeds maximum length', response.data.get('error', ''))
