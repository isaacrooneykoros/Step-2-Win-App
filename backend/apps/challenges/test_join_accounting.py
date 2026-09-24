"""
Join accounting regression tests.

- A challenge entry must reduce the user's available balance exactly once.
- Pending (not yet started) challenges listed in the lobby can be joined.
- Ended challenges cannot be joined.
"""
from datetime import timedelta
from decimal import Decimal

from django.contrib.auth import get_user_model
from django.test import TestCase
from django.utils import timezone
from rest_framework.test import APIClient

from apps.challenges.models import Challenge, Participant

User = get_user_model()


class JoinAccountingTests(TestCase):
    def setUp(self):
        self.creator = User.objects.create_user(
            username="host",
            email="host@example.com",
            phone_number="254712340001",
            password="testpass123",
            wallet_balance=Decimal("5000.00"),
        )
        self.walker = User.objects.create_user(
            username="walker",
            email="walker@example.com",
            phone_number="254712340002",
            password="testpass123",
            wallet_balance=Decimal("1000.00"),
        )
        self.client = APIClient()
        self.client.force_authenticate(self.walker)

    def _challenge(self, status="active", start_offset=-1, end_offset=6, fee="100.00"):
        return Challenge.objects.create(
            creator=self.creator,
            name=f"{status} challenge",
            entry_fee=Decimal(fee),
            milestone=50000,
            start_date=timezone.localdate() + timedelta(days=start_offset),
            end_date=timezone.localdate() + timedelta(days=end_offset),
            status=status,
            is_public=True,
            max_participants=10,
        )

    def _join(self, challenge):
        return self.client.post("/api/challenges/join/", {"invite_code": challenge.invite_code}, format="json")

    def test_entry_reduces_available_balance_once(self):
        challenge = self._challenge(fee="500.00")
        response = self._join(challenge)
        self.assertEqual(response.status_code, 200, response.content)

        self.walker.refresh_from_db()
        self.assertEqual(self.walker.wallet_balance, Decimal("500.00"))
        self.assertEqual(self.walker.locked_balance, Decimal("500.00"))
        # Previously wallet - locked = 0.00 (entry counted twice).
        self.assertEqual(self.walker.available_balance, Decimal("500.00"))

    def test_second_entry_allowed_when_funds_remain(self):
        """The 80% lock cap is measured against total funds, not the post-entry wallet."""
        self.assertEqual(self._join(self._challenge(fee="400.00")).status_code, 200)
        second = self._join(self._challenge(fee="100.00"))
        self.assertEqual(second.status_code, 200, second.content)

        self.walker.refresh_from_db()
        self.assertEqual(self.walker.available_balance, Decimal("500.00"))
        self.assertEqual(self.walker.locked_balance, Decimal("500.00"))

    def test_can_join_pending_challenge(self):
        challenge = self._challenge(status="pending", start_offset=2, end_offset=9)
        response = self._join(challenge)
        self.assertEqual(response.status_code, 200, response.content)
        self.assertTrue(Participant.objects.filter(challenge=challenge, user=self.walker).exists())

    def test_cannot_join_ended_challenge(self):
        challenge = self._challenge(status="active", start_offset=-8, end_offset=-1)
        response = self._join(challenge)
        self.assertEqual(response.status_code, 400)
        self.walker.refresh_from_db()
        self.assertEqual(self.walker.wallet_balance, Decimal("1000.00"))

    def test_cannot_join_completed_challenge(self):
        challenge = self._challenge(status="completed", start_offset=-8, end_offset=-1)
        self.assertEqual(self._join(challenge).status_code, 400)
