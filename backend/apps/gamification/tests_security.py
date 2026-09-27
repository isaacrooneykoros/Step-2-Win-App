"""
Security Tests for Gamification App
────────────────────────────────────
Verifies input validation, sanitization, and authorization for gamification endpoints.
"""

from django.contrib.auth import get_user_model
from django.test import TestCase
from rest_framework import status
from rest_framework.test import APIClient

from apps.gamification.models import XPEvent
from apps.users.models import UserXP

User = get_user_model()


class GamificationAwardXPSecurityTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.admin = User.objects.create_user(
            username="xp_admin",
            email="admin@example.com",
            phone_number="254700000088",
            password="pass12345!",
            is_staff=True,
        )
        self.normal_user = User.objects.create_user(
            username="normal_user",
            email="normal@example.com",
            phone_number="254700000089",
            password="pass12345!",
            is_staff=False,
        )
        self.target_user = User.objects.create_user(
            username="target_user",
            email="target@example.com",
            phone_number="254700000090",
            password="pass12345!",
            is_staff=False,
        )
        self.xp_profile, _ = UserXP.objects.get_or_create(user=self.target_user)

    def test_award_xp_requires_admin_permissions(self):
        self.client.force_authenticate(self.normal_user)
        res = self.client.post(
            "/api/gamification/xp/award_xp/",
            {"user_id": self.target_user.id, "amount": 100, "reason": "Bonus"},
            format="json",
        )
        self.assertEqual(res.status_code, status.HTTP_403_FORBIDDEN)

    def test_award_xp_sanitizes_xss_in_reason(self):
        self.client.force_authenticate(self.admin)
        res = self.client.post(
            "/api/gamification/xp/award_xp/",
            {
                "user_id": self.target_user.id,
                "amount": 100,
                "reason": "<script>alert('xss')</script>Great Job",
            },
            format="json",
        )
        self.assertEqual(res.status_code, status.HTTP_200_OK)
        xp_event = XPEvent.objects.filter(user=self.target_user).first()
        self.assertIsNotNone(xp_event)
        self.assertNotIn("<script>", xp_event.description)
        self.assertIn("alert('xss')Great Job", xp_event.description)

    def test_award_xp_validates_amount_bounds(self):
        self.client.force_authenticate(self.admin)

        # Test negative amount
        res = self.client.post(
            "/api/gamification/xp/award_xp/",
            {"user_id": self.target_user.id, "amount": -50, "reason": "Invalid"},
            format="json",
        )
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)

        # Test zero amount
        res = self.client.post(
            "/api/gamification/xp/award_xp/",
            {"user_id": self.target_user.id, "amount": 0, "reason": "Invalid"},
            format="json",
        )
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)

        # Test amount above max bound
        res = self.client.post(
            "/api/gamification/xp/award_xp/",
            {"user_id": self.target_user.id, "amount": 100001, "reason": "Too high"},
            format="json",
        )
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)

    def test_award_xp_handles_non_integer_amount(self):
        self.client.force_authenticate(self.admin)
        res = self.client.post(
            "/api/gamification/xp/award_xp/",
            {"user_id": self.target_user.id, "amount": "invalid_number", "reason": "Bonus"},
            format="json",
        )
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)
