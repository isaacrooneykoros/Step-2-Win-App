"""Typed challenge entry amounts: any whole KES amount in the shared range, public or private."""
from decimal import Decimal

from django.contrib.auth import get_user_model
from django.test import TestCase
from rest_framework.test import APIClient

from apps.challenges.models import get_configured_milestones
from apps.challenges.serializers import ENTRY_FEE_MAX, ENTRY_FEE_MIN

User = get_user_model()


class TypedEntryFeeTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            username="creator",
            email="creator@example.com",
            phone_number="254712349001",
            password="testpass123",
            wallet_balance=Decimal("50000.00"),
            challenges_joined=3,  # creator eligibility rule for paid challenges
        )
        self.client = APIClient()
        self.client.force_authenticate(self.user)
        self.milestone = get_configured_milestones()[0]

    def _create(self, fee, is_public=True):
        return self.client.post(
            "/api/challenges/create/",
            {
                "name": "Typed entry",
                "milestone": self.milestone,
                "entry_fee": fee,
                "max_participants": 10,
                "is_public": is_public,
                "duration_days": 7,
            },
            format="json",
        )

    def test_public_accepts_typed_amount(self):
        response = self._create(375)
        self.assertEqual(response.status_code, 201, response.content)
        self.user.refresh_from_db()
        self.assertEqual(self.user.wallet_balance, Decimal("49625.00"))

    def test_private_accepts_typed_amount(self):
        self.assertEqual(self._create(1200, is_public=False).status_code, 201)

    def test_rejects_out_of_range(self):
        self.assertEqual(self._create(ENTRY_FEE_MIN - 1).status_code, 400)
        self.assertEqual(self._create(ENTRY_FEE_MAX + 1).status_code, 400)

    def test_rejects_fractional_shillings(self):
        response = self._create("150.50")
        self.assertEqual(response.status_code, 400)
        self.assertIn("whole number", str(response.content))

    def test_config_exposes_range_and_suggestions(self):
        data = self.client.get("/api/challenges/config/").json()
        self.assertEqual(data["entry_fee_min"], ENTRY_FEE_MIN)
        self.assertEqual(data["entry_fee_max"], ENTRY_FEE_MAX)
        self.assertTrue(all(ENTRY_FEE_MIN <= s <= ENTRY_FEE_MAX for s in data["entry_fee_suggestions"]))
