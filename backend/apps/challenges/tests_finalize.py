"""
Integration tests for apps.challenges.services.finalize_challenge.

Uses an in-memory SQLite database (TestCase) to verify that wallet balances,
WalletTransaction records, and ChallengeResult records are correct after
challenge finalization.
"""
from decimal import Decimal

from django.test import TestCase
from django.utils import timezone

from apps.challenges.models import Challenge, Participant, ChallengeResult
from apps.challenges.services import finalize_challenge
from apps.users.models import User
from apps.wallet.models import WalletTransaction


def _make_user(username: str, balance: Decimal = Decimal('0'), locked: Decimal = Decimal('0')):
    u = User.objects.create_user(username=username, password='pass')
    u.wallet_balance = balance
    u.locked_balance = locked
    u.save()
    return u


def _make_challenge(
    name='Test',
    entry_fee=Decimal('100'),
    milestone=50_000,
    payout_structure='proportional',
    status='active',
):
    from datetime import date, timedelta
    return Challenge.objects.create(
        name             = name,
        entry_fee        = entry_fee,
        total_pool       = Decimal('0'),   # will be updated manually
        milestone        = milestone,
        payout_structure = payout_structure,
        status           = status,
        start_date       = date.today() - timedelta(days=7),
        end_date         = date.today() - timedelta(days=1),
        win_condition    = 'proportional',
    )


def _add_participant(challenge, user, steps: int):
    return Participant.objects.create(
        challenge  = challenge,
        user       = user,
        steps      = steps,
        joined_at  = timezone.now(),
    )


class FinalizeChallengeNoQualifiersTest(TestCase):
    """Scenario A3: no one reaches the milestone → full refund."""

    def setUp(self):
        entry_fee = Decimal('100')
        self.challenge = _make_challenge(entry_fee=entry_fee, milestone=50_000)
        self.users = [_make_user(f'u{i}', balance=Decimal('0'), locked=entry_fee) for i in range(3)]
        for u in self.users:
            _add_participant(self.challenge, u, steps=10_000)  # under milestone
        # Set pool manually after adding participants
        self.challenge.total_pool = entry_fee * 3
        self.challenge.save()

    def test_all_users_refunded(self):
        finalize_challenge(self.challenge)
        for u in self.users:
            u.refresh_from_db()
            self.assertEqual(u.wallet_balance, Decimal('100'))
            self.assertEqual(u.locked_balance, Decimal('0'))

    def test_challenge_marked_completed(self):
        finalize_challenge(self.challenge)
        self.challenge.refresh_from_db()
        self.assertEqual(self.challenge.status, 'completed')

    def test_idempotent_second_call(self):
        finalize_challenge(self.challenge)
        result = finalize_challenge(self.challenge)
        self.assertFalse(result)  # already completed → returns False

    def test_wallet_transactions_created(self):
        finalize_challenge(self.challenge)
        for u in self.users:
            txns = WalletTransaction.objects.filter(user=u, type='refund')
            self.assertEqual(txns.count(), 1)
            self.assertEqual(txns.first().amount, Decimal('100'))


class FinalizeChallengeProportionalTest(TestCase):
    """Standard proportional payout: 3 qualifiers with different step counts."""

    def setUp(self):
        entry_fee = Decimal('100')
        self.challenge = _make_challenge(
            entry_fee=entry_fee, milestone=1, payout_structure='proportional'
        )
        self.user1 = _make_user('p1', locked=entry_fee)
        self.user2 = _make_user('p2', locked=entry_fee)
        self.user3 = _make_user('p3', locked=entry_fee)
        self.p1 = _add_participant(self.challenge, self.user1, steps=60_000)
        self.p2 = _add_participant(self.challenge, self.user2, steps=30_000)
        self.p3 = _add_participant(self.challenge, self.user3, steps=10_000)
        self.challenge.total_pool = entry_fee * 3  # KES 300
        self.challenge.save()

    def test_payout_sums_to_net_pool(self):
        finalize_challenge(self.challenge)
        txns = WalletTransaction.objects.filter(type='payout')
        total_paid = sum(t.amount for t in txns)
        net_pool = self.challenge.total_pool * Decimal('0.95')
        self.assertEqual(total_paid, net_pool)

    def test_top_stepper_gets_highest_payout(self):
        finalize_challenge(self.challenge)
        self.user1.refresh_from_db()
        self.user2.refresh_from_db()
        self.user3.refresh_from_db()
        self.assertGreater(self.user1.wallet_balance, self.user2.wallet_balance)
        self.assertGreater(self.user2.wallet_balance, self.user3.wallet_balance)

    def test_platform_fee_transaction_created(self):
        finalize_challenge(self.challenge)
        fees = WalletTransaction.objects.filter(type='fee')
        self.assertEqual(fees.count(), 1)
        expected_fee = self.challenge.total_pool * Decimal('0.05')
        self.assertEqual(fees.first().amount, expected_fee)

    def test_challenge_results_created(self):
        finalize_challenge(self.challenge)
        results = ChallengeResult.objects.filter(challenge=self.challenge)
        self.assertEqual(results.count(), 3)

    def test_locked_balance_released(self):
        finalize_challenge(self.challenge)
        for u in [self.user1, self.user2, self.user3]:
            u.refresh_from_db()
            self.assertEqual(u.locked_balance, Decimal('0'))


class FinalizeChallengeWinnerTakesAllTest(TestCase):
    """winner_takes_all: single winner collects the full net pool."""

    def setUp(self):
        entry_fee = Decimal('200')
        self.challenge = _make_challenge(
            entry_fee=entry_fee, milestone=1, payout_structure='winner_takes_all'
        )
        self.winner = _make_user('winner', locked=entry_fee)
        self.loser  = _make_user('loser',  locked=entry_fee)
        _add_participant(self.challenge, self.winner, steps=80_000)
        _add_participant(self.challenge, self.loser,  steps=40_000)
        self.challenge.total_pool = entry_fee * 2
        self.challenge.save()

    def test_winner_receives_net_pool(self):
        finalize_challenge(self.challenge)
        self.winner.refresh_from_db()
        net_pool = self.challenge.total_pool * Decimal('0.95')
        self.assertEqual(self.winner.wallet_balance, net_pool)

    def test_loser_receives_nothing(self):
        finalize_challenge(self.challenge)
        self.loser.refresh_from_db()
        self.assertEqual(self.loser.wallet_balance, Decimal('0'))


class FinalizeChallengeTwoWayTieTest(TestCase):
    """Dead-heat: two users with equal steps share the prize equally."""

    def setUp(self):
        entry_fee = Decimal('100')
        self.challenge = _make_challenge(
            entry_fee=entry_fee, milestone=1, payout_structure='winner_takes_all'
        )
        self.u1 = _make_user('tied1', locked=entry_fee)
        self.u2 = _make_user('tied2', locked=entry_fee)
        _add_participant(self.challenge, self.u1, steps=70_000)
        _add_participant(self.challenge, self.u2, steps=70_000)
        self.challenge.total_pool = entry_fee * 2
        self.challenge.save()

    def test_equal_payout_both_users(self):
        finalize_challenge(self.challenge)
        self.u1.refresh_from_db()
        self.u2.refresh_from_db()
        net_pool = self.challenge.total_pool * Decimal('0.95')
        self.assertEqual(self.u1.wallet_balance + self.u2.wallet_balance, net_pool)
        self.assertEqual(self.u1.wallet_balance, self.u2.wallet_balance)
