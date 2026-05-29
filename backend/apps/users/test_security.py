import random
from django.contrib.auth import get_user_model
from rest_framework import status
from rest_framework.test import APITestCase
from apps.admin_api.models import SupportTicket, SupportTicketMessage
from django.core.exceptions import ValidationError as DjangoValidationError

User = get_user_model()

class SecurityTests(APITestCase):
    def setUp(self):
        self.username = f"testuser_{random.randint(100000, 999999)}"
        self.password = 'TestPass123!'
        self.user = User.objects.create_user(
            username=self.username,
            email=f'{self.username}@example.com',
            password=self.password,
            phone_number=f'254{random.randint(700000000, 799999999)}'
        )
        login_response = self.client.post(
            '/api/auth/login/',
            {'username': self.username, 'password': self.password},
            format='json'
        )
        self.access = login_response.data.get('access')
        self.client.credentials(HTTP_AUTHORIZATION=f'Bearer {self.access}')

        # Create a ticket to reply to
        self.ticket = SupportTicket.objects.create(
            user=self.user,
            subject="Test Ticket",
            message="Initial message"
        )

    def test_support_ticket_reply_sanitization(self):
        """
        Test that HTML tags in support ticket replies ARE sanitized.
        """
        xss_payload = "<b>Hello</b><script>alert('xss')</script>"
        # bleach.clean with strip=True removes tags but keeps content of some tags like <script> depending on version/config
        # but the point is that <b> is gone and <script> tag itself is gone.
        response = self.client.post(
            f'/api/auth/support/tickets/{self.ticket.id}/reply/',
            {'message': xss_payload},
            format='json'
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        # Check if the message in the database is sanitized
        reply = SupportTicketMessage.objects.filter(ticket=self.ticket).latest('created_at')
        self.assertNotIn("<b>", reply.message)
        self.assertNotIn("<script>", reply.message)
