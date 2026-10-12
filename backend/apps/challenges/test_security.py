from datetime import date, timedelta
from decimal import Decimal

from django.contrib.auth import get_user_model
from rest_framework import status
from rest_framework.test import APITestCase

from apps.challenges.models import Challenge, ChallengeMessage, Participant

User = get_user_model()


class ChallengeChatSecurityTests(APITestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            username="chatuser",
            email="chatuser@example.com",
            phone_number="254712345688",
            password="Password123!",
        )
        self.client.force_authenticate(user=self.user)

        self.challenge = Challenge.objects.create(
            name="Private Secret Challenge",
            description="Testing chat security",
            creator=self.user,
            milestone=50000,
            entry_fee=Decimal("0.00"),
            max_participants=10,
            status="active",
            start_date=date.today(),
            end_date=date.today() + timedelta(days=7),
            is_public=False,
            is_private=True,
        )
        Participant.objects.create(challenge=self.challenge, user=self.user)

    def test_post_chat_message_sanitizes_html_xss(self):
        url = f"/api/challenges/{self.challenge.id}/chat/"
        payload = {"content": "<b>Hello World!</b> <script>alert('xss')</script>"}
        response = self.client.post(url, payload, format="json")

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(response.data["content"], "Hello World! alert('xss')")

        # Verify saved message in database is sanitized
        msg = ChallengeMessage.objects.get(id=response.data["id"])
        self.assertEqual(msg.message, "Hello World! alert('xss')")

    def test_post_chat_message_empty_string_rejected(self):
        url = f"/api/challenges/{self.challenge.id}/chat/"
        payload = {"content": "   "}
        response = self.client.post(url, payload, format="json")

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("error", response.data)

    def test_post_chat_message_exceeding_max_length_rejected(self):
        url = f"/api/challenges/{self.challenge.id}/chat/"
        payload = {"content": "A" * 1001}
        response = self.client.post(url, payload, format="json")

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("error", response.data)
