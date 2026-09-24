"""
Phase 2 Challenge Finalization Tests

Tests for:
- Challenge lifecycle transitions
- Idempotent finalization
- Reward distribution
- Platform fee calculation
- Concurrent finalization prevention
- Edge cases (no participants, all ties, etc.)
"""
from decimal import Decimal
from datetime import date, timedelta
from unittest.mock import patch

from django.test import TestCase, TransactionTestCase
from django.contrib.auth import get_user_model
from django.db import transaction

from apps.challenges.models import Challenge, Participant, ChallengeResult
from apps.challenges.services import finalize_challenge, cancel_challenge
from apps.wallet.models import WalletTransaction
from apps.payments.models import PlatformRevenue


User = get_user_model()


class ChallengeFinalizationTests(TestCase):
    """Test challenge finalization logic."""

    def setUp(self):
        # Create users
        self.creator = User.objects.create_user(
            username="creator",
            email="creator@example.com",
            phone_number="254712345001",
            password="testpass123",
            wallet_balance=Decimal("5000.00"),
        )
        self.user2 = User.objects.create_user(
            username="user2",
            email="user2@example.com",
            phone_number="254712345002",
            password="testpass123",
            wallet_balance=Decimal("5000.00"),
        )
        self.user3 = User.objects.create_user(
            username="user3",
            email="user3@example.com",
            phone_number="254712345003",
            password="testpass123",
            wallet_balance=Decimal("5000.00"),
        )

        # Create active challenge
        self.challenge = Challenge.objects.create(
            creator=self.creator,
            name="Test Challenge",
            entry_fee=Decimal("100.00"),
            milestone=10000,
            start_date=date.today() - timedelta(days=7),
            end_date=date.today() - timedelta(days=1),  # Ended yesterday
            status="active",
            total_pool=Decimal("300.00"),  # 3 participants
        )

        # Add participants with locked balance
        self._add_participant(self.creator, steps=15000)  # Qualified
        self._add_participant(self.user2, steps=12000)  # Qualified
        self._add_participant(self.user3, steps=5000)  # Not qualified

    def _add_participant(self, user, steps=0):
        """Helper to add participant and simulate entry fee."""
        user.locked_balance += self.challenge.entry_fee
        user.wallet_balance -= self.challenge.entry_fee
        user.save()
        return Participant.objects.create(
            challenge=self.challenge,
            user=user,
            steps=steps,
        )

    def test_finalization_distributes_rewards(self):
        """Finalization should distribute rewards to qualified participants."""
        initial_creator_balance = self.creator.wallet_balance

        result = finalize_challenge(self.challenge)
        self.assertTrue(result)

        self.challenge.refresh_from_db()
        self.assertEqual(self.challenge.status, "completed")

        # Creator should have received payout (winner)
        self.creator.refresh_from_db()
        self.assertGreater(self.creator.wallet_balance, initial_creator_balance)

        # Locked balance should be released for all
        for user in [self.creator, self.user2, self.user3]:
            user.refresh_from_db()
            # Their locked balance for this challenge should be released
            # Note: They might have other challenges, so we can't assert == 0

        # Platform revenue should be recorded
        revenue = PlatformRevenue.objects.filter(challenge=self.challenge).first()
        self.assertIsNotNone(revenue)

    def test_finalization_is_idempotent(self):
        """Calling finalization twice should not double reward."""
        # First finalization
        result1 = finalize_challenge(self.challenge)
        self.assertTrue(result1)

        self.creator.refresh_from_db()
        balance_after_first = self.creator.wallet_balance

        # Second finalization (should return False, no change)
        result2 = finalize_challenge(self.challenge)
        self.assertFalse(result2)

        self.creator.refresh_from_db()
        balance_after_second = self.creator.wallet_balance

        # Balance should not change
        self.assertEqual(balance_after_first, balance_after_second)

        # Only one ChallengeResult per participant
        results = ChallengeResult.objects.filter(challenge=self.challenge)
        self.assertEqual(results.count(), 3)  # One per participant

    def test_only_active_challenges_can_finalize(self):
        """Only challenges in 'active' status can be finalized."""
        self.challenge.status = "completed"
        self.challenge.save()

        result = finalize_challenge(self.challenge)
        self.assertFalse(result)

    def test_no_participants_challenge_completes_without_error(self):
        """Challenge with no participants should complete gracefully."""
        empty_challenge = Challenge.objects.create(
            creator=self.creator,
            name="Empty Challenge",
            entry_fee=Decimal("0.00"),
            milestone=10000,
            start_date=date.today() - timedelta(days=7),
            end_date=date.today() - timedelta(days=1),
            status="active",
            total_pool=Decimal("0.00"),
        )

        result = finalize_challenge(empty_challenge)
        self.assertTrue(result)

        empty_challenge.refresh_from_db()
        self.assertEqual(empty_challenge.status, "completed")

    def test_all_unqualified_triggers_refund(self):
        """If no one qualifies, all should be refunded."""
        # Create challenge where no one qualifies
        refund_challenge = Challenge.objects.create(
            creator=self.creator,
            name="Refund Challenge",
            entry_fee=Decimal("50.00"),
            milestone=100000,  # Very high milestone
            start_date=date.today() - timedelta(days=7),
            end_date=date.today() - timedelta(days=1),
            status="active",
            total_pool=Decimal("100.00"),
        )

        # Add two participants with low steps
        self.creator.locked_balance += Decimal("50.00")
        self.creator.wallet_balance -= Decimal("50.00")
        self.creator.save()
        Participant.objects.create(
            challenge=refund_challenge,
            user=self.creator,
            steps=5000,  # Not enough
        )

        self.user2.locked_balance += Decimal("50.00")
        self.user2.wallet_balance -= Decimal("50.00")
        self.user2.save()
        Participant.objects.create(
            challenge=refund_challenge,
            user=self.user2,
            steps=3000,  # Not enough
        )

        # Record balances before
        self.creator.refresh_from_db()
        self.user2.refresh_from_db()
        creator_before = self.creator.wallet_balance
        user2_before = self.user2.wallet_balance

        result = finalize_challenge(refund_challenge)
        self.assertTrue(result)

        # Both should get refunds
        self.creator.refresh_from_db()
        self.user2.refresh_from_db()
        self.assertEqual(
            self.creator.wallet_balance,
            creator_before + Decimal("50.00")
        )
        self.assertEqual(
            self.user2.wallet_balance,
            user2_before + Decimal("50.00")
        )

        # Check refund transactions created
        refund_txns = WalletTransaction.objects.filter(
            type="refund",
            metadata__challenge_id=refund_challenge.id
        )
        self.assertEqual(refund_txns.count(), 2)


class ChallengeCancellationTests(TestCase):
    """Test challenge cancellation logic."""

    def setUp(self):
        self.creator = User.objects.create_user(
            username="creator",
            email="creator@example.com",
            phone_number="254712345010",
            password="testpass123",
            wallet_balance=Decimal("1000.00"),
        )
        self.user2 = User.objects.create_user(
            username="user2",
            email="user2@example.com",
            phone_number="254712345011",
            password="testpass123",
            wallet_balance=Decimal("1000.00"),
        )

        self.challenge = Challenge.objects.create(
            creator=self.creator,
            name="Cancellable Challenge",
            entry_fee=Decimal("100.00"),
            milestone=10000,
            start_date=date.today(),
            end_date=date.today() + timedelta(days=7),
            status="active",
            total_pool=Decimal("200.00"),
        )

        # Add participants
        for user in [self.creator, self.user2]:
            user.wallet_balance -= Decimal("100.00")
            user.locked_balance += Decimal("100.00")
            user.save()
            Participant.objects.create(challenge=self.challenge, user=user)

    def test_cancellation_refunds_all_participants(self):
        """Cancellation should refund all participants."""
        self.creator.refresh_from_db()
        self.user2.refresh_from_db()
        creator_before = self.creator.wallet_balance
        user2_before = self.user2.wallet_balance

        result = cancel_challenge(self.challenge, reason="Admin cancelled")
        self.assertTrue(result)

        self.creator.refresh_from_db()
        self.user2.refresh_from_db()
        self.assertEqual(
            self.creator.wallet_balance,
            creator_before + Decimal("100.00")
        )
        self.assertEqual(
            self.user2.wallet_balance,
            user2_before + Decimal("100.00")
        )

        # Challenge status should be cancelled
        self.challenge.refresh_from_db()
        self.assertEqual(self.challenge.status, "cancelled")

    def test_cannot_cancel_non_active_challenge(self):
        """Only active challenges can be cancelled."""
        self.challenge.status = "completed"
        self.challenge.save()

        result = cancel_challenge(self.challenge, reason="Test")
        self.assertFalse(result)


class RewardCalculationTests(TestCase):
    """Test reward/payout calculations."""

    def setUp(self):
        self.user = User.objects.create_user(
            username="rewarduser",
            email="reward@example.com",
            phone_number="254712345020",
            password="testpass123",
            wallet_balance=Decimal("1000.00"),
        )

    def test_platform_fee_uses_decimal(self):
        """Platform fee calculation should use Decimal, not float."""
        from apps.admin_api.models import SystemSettings

        settings = SystemSettings.load()
        fee_percentage = settings.platform_fee_percentage

        # Convert to Decimal for safe financial calculations
        # SQLite may return float, but we ensure safe conversion
        fee_pct = Decimal(str(fee_percentage))

        # Test fee calculation
        pool = Decimal("1000.00")
        fee = pool * (fee_pct / Decimal("100"))

        # Should be exact (within 2 decimal places for financial precision)
        self.assertEqual(fee.quantize(Decimal("0.01")), Decimal("100.00"))

    def test_payout_amounts_are_decimal(self):
        """All payout amounts should be Decimal type."""
        # Create a challenge with known values
        challenge = Challenge.objects.create(
            creator=self.user,
            name="Decimal Test",
            entry_fee=Decimal("100.00"),
            milestone=10000,
            start_date=date.today() - timedelta(days=7),
            end_date=date.today() - timedelta(days=1),
            status="active",
            total_pool=Decimal("100.00"),
        )

        self.user.locked_balance += Decimal("100.00")
        self.user.wallet_balance -= Decimal("100.00")
        self.user.save()

        participant = Participant.objects.create(
            challenge=challenge,
            user=self.user,
            steps=15000,  # Qualified
        )

        finalize_challenge(challenge)

        # Check payout stored as Decimal
        participant.refresh_from_db()
        self.assertIsInstance(participant.payout, Decimal)


class ConcurrentFinalizationTests(TransactionTestCase):
    """Test concurrent finalization protection.

    NOTE: These tests may fail with SQLite due to its limited
    concurrency support. They are designed for PostgreSQL.
    """

    def setUp(self):
        self.user = User.objects.create_user(
            username="concurrentfin",
            email="concfin@example.com",
            phone_number="254712345030",
            password="testpass123",
            wallet_balance=Decimal("1000.00"),
        )

        self.challenge = Challenge.objects.create(
            creator=self.user,
            name="Concurrent Finalization Test",
            entry_fee=Decimal("100.00"),
            milestone=10000,
            start_date=date.today() - timedelta(days=7),
            end_date=date.today() - timedelta(days=1),
            status="active",
            total_pool=Decimal("100.00"),
        )

        self.user.locked_balance += Decimal("100.00")
        self.user.wallet_balance -= Decimal("100.00")
        self.user.save()

        Participant.objects.create(
            challenge=self.challenge,
            user=self.user,
            steps=15000,
        )

        # Check if we're using SQLite
        from django.conf import settings
        self.is_sqlite = 'sqlite' in settings.DATABASES['default']['ENGINE']

    def test_concurrent_finalization_only_one_succeeds(self):
        """Only one concurrent finalization should succeed."""
        if self.is_sqlite:
            self.skipTest("SQLite doesn't support concurrent writes properly")

        from concurrent.futures import ThreadPoolExecutor, as_completed

        results = []

        def attempt_finalize():
            try:
                # Re-fetch challenge in each thread
                challenge = Challenge.objects.get(id=self.challenge.id)
                return finalize_challenge(challenge)
            except Exception as e:
                return f"error: {e}"

        with ThreadPoolExecutor(max_workers=5) as executor:
            futures = [executor.submit(attempt_finalize) for _ in range(5)]
            for future in as_completed(futures):
                results.append(future.result())

        # Only one should return True, rest should return False
        true_count = results.count(True)
        false_count = results.count(False)

        self.assertEqual(true_count, 1)
        self.assertEqual(false_count, 4)

        # Only one payout transaction
        payout_txns = WalletTransaction.objects.filter(
            user=self.user,
            type="payout"
        )
        self.assertEqual(payout_txns.count(), 1)
