"""
Security Test Suite for Challenge Chat Endpoint
────────────────────────────────────────────────
Verifies Stored XSS input sanitization and length/empty validation
on the HTTP REST endpoint for challenge chat messages.
"""

from datetime import date, timedelta
from decimal import Decimal

from django.contrib.auth import get_user_model
from django.test import TestCase
from rest_framework.test import APIClient

from apps.challenges.models import Challenge, Participant

User = get_user_model()


class ChallengeChatSecurityTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            username="chatuser",
            email="chatuser@example.com",
            phone_number="254712349002",
            password="testpass123",
            wallet_balance=Decimal("10000.00"),
        )
        self.client = APIClient()
        self.client.force_authenticate(self.user)

        self.challenge = Challenge.objects.create(
            name="Security Test Challenge",
            creator=self.user,
            milestone=10000,
            entry_fee=0,
            is_private=True,
            is_public=False,
            status="active",
            start_date=date.today(),
            end_date=date.today() + timedelta(days=7),
        )
        Participant.objects.create(challenge=self.challenge, user=self.user)

    def test_chat_sanitizes_xss_tags(self):
        """Verify that HTML and script tags are stripped from chat messages."""
        payload = {"content": "<script>alert('XSS')</script>Hello team!"}
        response = self.client.post(
            f"/api/challenges/{self.challenge.id}/chat/",
            payload,
            format="json",
        )
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.data["content"], "alert('XSS')Hello team!")

    def test_chat_rejects_html_only_message(self):
        """Verify that a message containing only HTML tags becomes empty and is rejected."""
        payload = {"content": "<div><script></script></div>"}
        response = self.client.post(
            f"/api/challenges/{self.challenge.id}/chat/",
            payload,
            format="json",
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("error", response.data)

    def test_chat_strips_html_attributes_and_tags(self):
        """Verify that anchor tags and JS href attributes are stripped."""
        payload = {"content": '<a href="javascript:alert(1)">Click here</a>'}
        response = self.client.post(
            f"/api/challenges/{self.challenge.id}/chat/",
            payload,
            format="json",
        )
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.data["content"], "Click here")

    def test_chat_preserves_emoji_and_unicode(self):
        """Verify that valid emoji and unicode characters are preserved during sanitization."""
        payload = {"content": "Great run today! 🏆 🏃‍♂️"}
        response = self.client.post(
            f"/api/challenges/{self.challenge.id}/chat/",
            payload,
            format="json",
        )
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.data["content"], "Great run today! 🏆 🏃‍♂️")
