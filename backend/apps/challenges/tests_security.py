from datetime import date, timedelta
from decimal import Decimal
from rest_framework import status
from rest_framework.test import APITestCase
from django.contrib.auth import get_user_model
from apps.challenges.models import Challenge, ChallengeMessage

User = get_user_model()


class ChallengeSecurityTests(APITestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            username='chatuser',
            email='chat@example.com',
            password='TestPass123!',
        )
        self.challenge = Challenge.objects.create(
            name='Private Challenge',
            creator=self.user,
            milestone=50000,
            entry_fee=Decimal('0.00'),
            start_date=date.today(),
            end_date=date.today() + timedelta(days=7),
            is_private=True,
            is_public=False,
            status='active',
        )
        self.challenge.participants.create(user=self.user)

    def test_challenge_chat_sanitizes_xss(self):
        self.client.force_authenticate(user=self.user)
        payload = {
            'content': '<script>alert("XSS")</script>Hello challenge chat!'
        }
        response = self.client.post(
            f'/api/challenges/{self.challenge.id}/chat/',
            payload,
            format='json'
        )
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        # Bleach strips <script> tags but retains text content
        self.assertEqual(response.data['content'], 'alert("XSS")Hello challenge chat!')

        msg = ChallengeMessage.objects.get(id=response.data['id'])
        self.assertEqual(msg.message, 'alert("XSS")Hello challenge chat!')
