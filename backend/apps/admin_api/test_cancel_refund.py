"""Admin cancel (single and bulk) must refund every entry through the shared service."""
from datetime import timedelta
from decimal import Decimal

from django.contrib.auth import get_user_model
from django.test import TestCase
from django.utils import timezone
from rest_framework.test import APIClient

from apps.challenges.models import Challenge, Participant
from apps.wallet.models import WalletTransaction

User = get_user_model()


class AdminCancelRefundTests(TestCase):
    def setUp(self):
        self.admin = User.objects.create_user(
            username="ops", email="ops@example.com", phone_number="254712348000",
            password="testpass123", is_staff=True, is_superuser=True,
        )
        self.walkers = [
            User.objects.create_user(
                username=f"w{i}", email=f"w{i}@example.com", phone_number=f"25471234800{i + 1}",
                password="testpass123", wallet_balance=Decimal("400.00"), locked_balance=Decimal("100.00"),
            )
            for i in range(2)
        ]
        self.client = APIClient()
        self.client.force_authenticate(self.admin)

    def _challenge(self):
        today = timezone.localdate()
        c = Challenge.objects.create(
            creator=self.walkers[0], name="Live one", entry_fee=Decimal("100.00"), milestone=50000,
            start_date=today - timedelta(days=1), end_date=today + timedelta(days=6),
            status="active", is_public=True, max_participants=10, total_pool=Decimal("200.00"),
        )
        for w in self.walkers:
            Participant.objects.create(challenge=c, user=w)
        return c

    def _assert_refunded(self, challenge):
        challenge.refresh_from_db()
        self.assertEqual(challenge.status, "cancelled")
        for w in self.walkers:
            w.refresh_from_db()
            self.assertEqual(w.wallet_balance, Decimal("500.00"))
            self.assertEqual(w.locked_balance, Decimal("0.00"))
            self.assertEqual(WalletTransaction.objects.filter(user=w, type="refund").count(), 1)

    def _url(self, suffix):
        if suffix == "bulk-cancel":
            return "/api/admin/challenges/bulk_cancel/"
        return f"/api/admin/challenges/{self._c.id}/cancel_challenge/"

    def test_cancel_refunds_all_entries_once(self):
        c = self._challenge()
        self._c = c
        first = self.client.post(self._url("cancel-challenge"), {"reason": "venue issue"}, format="json")
        self.assertEqual(first.status_code, 200, first.content)
        self._assert_refunded(c)
        second = self.client.post(self._url("cancel-challenge"), {}, format="json")
        self.assertEqual(second.status_code, 400)
        self._assert_refunded(c)  # no double refund

    def test_bulk_cancel_refunds(self):
        c = self._challenge()
        self._c = c
        response = self.client.post(self._url("bulk-cancel"), {"challenge_ids": [c.id]}, format="json")
        self.assertEqual(response.status_code, 200, response.content)
        self._assert_refunded(c)
