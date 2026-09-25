"""Rank-based payouts are paused, and the chosen rule is the rule that's paid."""
from datetime import date, timedelta
from decimal import Decimal
from unittest import mock

from django.contrib.auth import get_user_model
from django.test import TestCase
from rest_framework.test import APIClient

from apps.challenges.models import Challenge

User = get_user_model()


class PayoutPolicyTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            username="policy_owner", email="policy@example.com", password="TestPass123!",
            wallet_balance=Decimal("1000.00"), challenges_joined=3,
        )
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def _create_private(self, win_condition):
        return self.client.post(
            "/api/challenges/create/",
            {
                "name": "Office walkers",
                "milestone": 50000,
                "entry_fee": "100",
                "max_participants": 10,
                "duration_days": 7,
                "is_public": False,
                "win_condition": win_condition,
                "theme_emoji": "🔥",
            },
            format="json",
        )

    def test_winner_takes_all_is_refused_while_paused(self):
        response = self._create_private("winner_takes_all")
        self.assertEqual(response.status_code, 400, response.content)
        self.assertIn("win_condition", response.json()["errors"])
        self.assertFalse(Challenge.objects.filter(name="Office walkers").exists())

    def test_qualification_only_is_refused_while_it_pays_proportionally(self):
        self.assertEqual(self._create_private("qualification_only").status_code, 400)

    def test_proportional_private_challenge_pays_proportionally(self):
        response = self._create_private("proportional")
        self.assertIn(response.status_code, (200, 201), response.content)
        challenge = Challenge.objects.get(name="Office walkers")
        self.assertEqual(challenge.payout_structure, "proportional")

    @mock.patch.dict("os.environ", {"RANK_PAYOUTS_ENABLED": "true"})
    def test_when_enabled_winner_takes_all_is_actually_paid_that_way(self):
        response = self._create_private("winner_takes_all")
        self.assertIn(response.status_code, (200, 201), response.content)
        challenge = Challenge.objects.get(name="Office walkers")
        self.assertEqual(challenge.payout_structure, "winner_takes_all")

    def test_config_lists_only_available_rules(self):
        data = self.client.get("/api/challenges/config/").json()
        self.assertEqual(data["allowed_win_conditions"], ["proportional"])


class AdminPayoutPolicyTests(TestCase):
    def setUp(self):
        self.admin = User.objects.create_user(
            username="policy_admin", email="padmin@example.com", password="TestPass123!",
            is_staff=True, is_superuser=True,
        )
        self.client = APIClient()
        self.client.force_authenticate(self.admin)
        self.challenge = Challenge.objects.create(
            name="Legacy rank", creator=self.admin, milestone=50000, entry_fee=Decimal("100.00"),
            total_pool=Decimal("0.00"), max_participants=10, status="active",
            start_date=date.today(), end_date=date.today() + timedelta(days=7),
            is_private=True, is_public=False, payout_structure="top_3",
        )

    def _patch(self, payload):
        return self.client.patch(f"/api/admin/challenges/{self.challenge.id}/", payload, format="json")

    def test_admin_cannot_switch_to_a_rank_payout(self):
        self.challenge.payout_structure = "proportional"
        self.challenge.save(update_fields=["payout_structure"])
        response = self._patch({"payout_structure": "winner_takes_all"})
        self.assertEqual(response.status_code, 400, response.content)
        self.challenge.refresh_from_db()
        self.assertEqual(self.challenge.payout_structure, "proportional")

    def test_existing_rank_challenge_can_still_be_edited(self):
        response = self._patch({"payout_structure": "top_3", "name": "Legacy rank renamed"})
        self.assertEqual(response.status_code, 200, response.content)
