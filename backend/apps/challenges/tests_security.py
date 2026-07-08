from django.contrib.auth import get_user_model
from rest_framework import status
from rest_framework.test import APITestCase
from apps.challenges.models import Challenge, Participant, ChallengeMessage
from datetime import date, timedelta
from decimal import Decimal

User = get_user_model()

class ChallengeChatSecurityTests(APITestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            username='chat_user',
            email='chat_user@example.com',
            password='TestPass123!',
            challenges_joined=1
        )
        self.challenge = Challenge.objects.create(
            name='Private Challenge',
            creator=self.user,
            milestone=10000,
            entry_fee=Decimal('0.00'),
            status='active',
            start_date=date.today(),
            end_date=date.today() + timedelta(days=7),
            is_private=True,
            is_public=False,
        )
        Participant.objects.create(challenge=self.challenge, user=self.user)
        self.client.force_authenticate(user=self.user)

    def test_challenge_chat_sanitization(self):
        """Test that HTML tags are stripped from challenge chat messages."""
        xss_payload = "Hello <b>World</b><img src=x onerror=alert(1)>"
        expected_cleaned = "Hello World"

        response = self.client.post(
            f'/api/challenges/{self.challenge.id}/chat/',
            {'content': xss_payload},
            format='json'
        )

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(response.data['content'], expected_cleaned)

        # Verify in database
        message = ChallengeMessage.objects.get(id=response.data['id'])
        self.assertEqual(message.message, expected_cleaned)

    def test_challenge_chat_empty_message(self):
        """Test that empty or whitespace-only messages are rejected."""
        response = self.client.post(
            f'/api/challenges/{self.challenge.id}/chat/',
            {'content': '   '},
            format='json'
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

    def test_challenge_chat_too_long_message(self):
        """Test that overly long messages are rejected."""
        long_message = "A" * 1001
        response = self.client.post(
            f'/api/challenges/{self.challenge.id}/chat/',
            {'content': long_message},
            format='json'
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
