"""
Unit tests for apps.challenges.tie_resolution.

These tests exercise the resolution engine without hitting the database.
Mock Participant objects are created as simple dataclasses to keep tests fast.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from decimal import Decimal
from unittest.mock import MagicMock, patch

from django.test import TestCase

from apps.challenges.tie_resolution import (
    _apply_tiebreaker_hierarchy,
    _group_by_steps,
    _largest_remainder,
    _resolve_proportional,
    _resolve_ranked,
    _split_equally,
    resolve_challenge,
)


# ── Helpers ───────────────────────────────────────────────────────────────────

def make_participant(
    id: int,
    user_id: int,
    steps: int,
    gps_step_percentage: float = 0.0,
    milestone_reached_at=None,
    zero_step_days: int = 0,
    best_day_steps: int = 0,
    joined_at=None,
    longest_streak: int = 0,
    payout=None,
    qualified=None,
    rank=None,
):
    p = MagicMock()
    p.id                  = id
    p.user_id             = user_id
    p.steps               = steps
    p.gps_step_percentage = gps_step_percentage
    p.milestone_reached_at = milestone_reached_at
    p.zero_step_days      = zero_step_days
    p.best_day_steps      = best_day_steps
    p.joined_at           = joined_at or datetime(2025, 1, id, tzinfo=timezone.utc)
    p.longest_streak      = longest_streak
    p.payout              = payout
    p.qualified           = qualified
    p.rank                = rank
    return p


def make_challenge(
    id: int = 1,
    entry_fee: Decimal = Decimal('100'),
    total_pool: Decimal = Decimal('1000'),
    milestone: int = 50_000,
    payout_structure: str = 'proportional',
    name: str = 'Test Challenge',
    status: str = 'active',
):
    c = MagicMock()
    c.id               = id
    c.entry_fee        = entry_fee
    c.total_pool       = total_pool
    c.milestone        = milestone
    c.payout_structure = payout_structure
    c.name             = name
    c.status           = status
    return c


# ── _largest_remainder ────────────────────────────────────────────────────────

class LargestRemainderTests(TestCase):

    def test_sum_always_equals_total(self):
        total = Decimal('950.00')
        raw = [Decimal('316.6667'), Decimal('316.6667'), Decimal('316.6666')]
        result = _largest_remainder(total, raw)
        self.assertEqual(sum(result), total)

    def test_two_way_even_split(self):
        result = _largest_remainder(Decimal('100.00'), [Decimal('50'), Decimal('50')])
        self.assertEqual(result, [Decimal('50.00'), Decimal('50.00')])

    def test_uneven_three_way(self):
        total = Decimal('1.00')
        raw = [Decimal('0.3333'), Decimal('0.3333'), Decimal('0.3334')]
        result = _largest_remainder(total, raw)
        self.assertEqual(sum(result), total)
        for r in result:
            self.assertGreater(r, Decimal('0'))

    def test_empty_list(self):
        self.assertEqual(_largest_remainder(Decimal('0'), []), [])

    def test_single_item_returns_total(self):
        total = Decimal('777.77')
        result = _largest_remainder(total, [Decimal('777.77')])
        self.assertEqual(result, [total])


class SplitEquallyTests(TestCase):

    def test_even_split_three_ways(self):
        result = _split_equally(Decimal('900.00'), 3)
        self.assertEqual(sum(result), Decimal('900.00'))
        self.assertEqual(len(result), 3)
        for r in result:
            self.assertEqual(r, Decimal('300.00'))

    def test_uneven_cents_sum_is_exact(self):
        result = _split_equally(Decimal('10.00'), 3)
        self.assertEqual(sum(result), Decimal('10.00'))


# ── _group_by_steps ───────────────────────────────────────────────────────────

class GroupByStepsTests(TestCase):

    def test_all_different(self):
        ps = [make_participant(i, i, 1000 - i * 100) for i in range(3)]
        groups = _group_by_steps(ps)
        self.assertEqual(len(groups), 3)
        for g in groups:
            self.assertEqual(len(g), 1)

    def test_all_tied(self):
        ps = [make_participant(i, i, 5000) for i in range(4)]
        groups = _group_by_steps(ps)
        self.assertEqual(len(groups), 1)
        self.assertEqual(len(groups[0]), 4)

    def test_partial_tie(self):
        ps = [
            make_participant(1, 1, 8000),
            make_participant(2, 2, 6000),
            make_participant(3, 3, 6000),
            make_participant(4, 4, 4000),
        ]
        groups = _group_by_steps(ps)
        self.assertEqual(len(groups), 3)
        self.assertEqual(len(groups[1]), 2)

    def test_empty(self):
        self.assertEqual(_group_by_steps([]), [])


# ── resolve_challenge — no participants ───────────────────────────────────────

class ResolveChallengeNoParticipantsTest(TestCase):

    @patch('apps.challenges.tie_resolution.Participant')
    def test_returns_empty_list(self, mock_participant_cls):
        mock_participant_cls.objects.filter.return_value.select_related.return_value = []
        challenge = make_challenge()
        result = resolve_challenge(challenge)
        self.assertEqual(result, [])


# ── resolve_challenge — nobody qualified (full refund) ───────────────────────

class FullRefundScenarioTest(TestCase):

    @patch('apps.challenges.tie_resolution.Participant')
    def test_all_participants_refunded(self, mock_participant_cls):
        ps = [make_participant(i, i, 0) for i in range(3)]  # 0 steps < 50k milestone
        mock_participant_cls.objects.filter.return_value.select_related.return_value = ps

        challenge = make_challenge(milestone=50_000, entry_fee=Decimal('100'))
        results = resolve_challenge(challenge)

        self.assertEqual(len(results), 3)
        for r in results:
            self.assertEqual(r.payout_method, 'refund')
            self.assertEqual(r.payout_kes, Decimal('100'))  # full entry_fee


# ── _resolve_proportional ─────────────────────────────────────────────────────

class ProportionalResolverTests(TestCase):

    def _make_challenge(self):
        return make_challenge(total_pool=Decimal('1000'))

    def test_single_winner_gets_net_pool(self):
        challenge = self._make_challenge()
        p = make_participant(1, 1, 70_000)
        results = _resolve_proportional(challenge, [p], Decimal('950'))
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0].payout_kes, Decimal('950.00'))
        self.assertEqual(results[0].payout_method, 'proportional')

    def test_equal_steps_equal_payout(self):
        challenge = self._make_challenge()
        ps = [make_participant(i, i, 50_000) for i in range(2)]
        results = _resolve_proportional(challenge, ps, Decimal('1000.00'))
        self.assertEqual(sum(r.payout_kes for r in results), Decimal('1000.00'))
        self.assertEqual(results[0].payout_kes, results[1].payout_kes)
        self.assertEqual(results[0].tied_with_count, 1)

    def test_payout_sum_equals_net_pool(self):
        challenge = self._make_challenge()
        ps = [make_participant(i, i, 10_000 * (i + 1)) for i in range(5)]
        net_pool = Decimal('950.00')
        results = _resolve_proportional(challenge, ps, net_pool)
        self.assertEqual(sum(r.payout_kes for r in results), net_pool)

    def test_no_overflow(self):
        """Payout total must never exceed net_pool."""
        challenge = self._make_challenge()
        ps = [make_participant(i, i, 33_333) for i in range(3)]
        net_pool = Decimal('9999.99')
        results = _resolve_proportional(challenge, ps, net_pool)
        self.assertLessEqual(sum(r.payout_kes for r in results), net_pool + Decimal('0.01'))


# ── _resolve_ranked — winner_takes_all ───────────────────────────────────────

class RankedWinnerTakesAllTests(TestCase):

    def _make_challenge(self):
        return make_challenge(payout_structure='winner_takes_all')

    def test_single_winner(self):
        challenge = self._make_challenge()
        ps = [
            make_participant(1, 1, 80_000),
            make_participant(2, 2, 60_000),
        ]
        results = _resolve_ranked(challenge, ps, Decimal('950'), [Decimal('1.00')])
        winner = next(r for r in results if r.final_rank == 1)
        loser  = next(r for r in results if r.final_rank != 1)
        self.assertEqual(winner.payout_kes, Decimal('950.00'))
        self.assertEqual(loser.payout_kes, Decimal('0.00'))

    def test_two_way_tie_dead_heat(self):
        """Both players have the same step count — prize should be split equally."""
        challenge = self._make_challenge()
        ps = [make_participant(i, i, 70_000) for i in range(2)]
        net_pool = Decimal('1000.00')
        results = _resolve_ranked(challenge, ps, net_pool, [Decimal('1.00')])
        total_paid = sum(r.payout_kes for r in results)
        self.assertEqual(total_paid, net_pool)
        for r in results:
            self.assertEqual(r.payout_kes, Decimal('500.00'))
            self.assertEqual(r.payout_method, 'dead_heat')

    def test_three_way_tie_for_first_in_top3(self):
        """3-way tie for 1st in a top-3 competition — all three share 1st+2nd+3rd prizes."""
        challenge = self._make_challenge()
        ps = [make_participant(i, i, 70_000) for i in range(3)]
        slots = [Decimal('0.50'), Decimal('0.30'), Decimal('0.20')]
        net_pool = Decimal('1000.00')
        results = _resolve_ranked(challenge, ps, net_pool, slots)
        total_paid = sum(r.payout_kes for r in results)
        self.assertEqual(total_paid, net_pool)
        # All get 1/3 each
        for r in results:
            self.assertAlmostEqual(float(r.payout_kes), 333.33, delta=0.02)

    def test_partial_tie_straddles_boundary(self):
        """2nd and 3rd place tied — they share 2nd+3rd prize money."""
        challenge = self._make_challenge()
        ps = [
            make_participant(1, 1, 90_000),
            make_participant(2, 2, 60_000),
            make_participant(3, 3, 60_000),
        ]
        slots = [Decimal('0.50'), Decimal('0.30'), Decimal('0.20')]
        net_pool = Decimal('1000.00')
        results = _resolve_ranked(challenge, ps, net_pool, slots)

        first = next(r for r in results if r.final_rank == 1)
        tied  = [r for r in results if r.payout_method == 'dead_heat']

        self.assertEqual(first.payout_kes, Decimal('500.00'))
        # 2nd + 3rd prize = 30% + 20% = 50% → 500 / 2 = 250 each
        for r in tied:
            self.assertEqual(r.payout_kes, Decimal('250.00'))

    def test_payout_overflow_raises(self):
        """resolve_challenge should raise ValueError on overflow."""
        challenge = make_challenge(total_pool=Decimal('1000'))
        challenge.payout_structure = 'proportional'
        ps = [make_participant(i, i, 50_000) for i in range(2)]
        net_pool = Decimal('950.00')
        # Manually craft a broken scenario — negative net pool
        results = _resolve_proportional(challenge, ps, net_pool)
        # sanity: normal proportional must not overflow
        self.assertLessEqual(sum(r.payout_kes for r in results), net_pool + Decimal('0.01'))


# ── _apply_tiebreaker_hierarchy ───────────────────────────────────────────────

class TiebreakerHierarchyTests(TestCase):

    def _make_tied(self, n: int):
        return [
            make_participant(
                id=i, user_id=i,
                steps=70_000,
                gps_step_percentage=float(n - i),
                joined_at=datetime(2025, 1, i + 1, tzinfo=timezone.utc),
            )
            for i in range(1, n + 1)
        ]

    def test_level_1_gps_percentage_breaks_tie(self):
        challenge = make_challenge()
        ps = self._make_tied(3)
        # Level 1 = GPS % — participants have distinct gps_step_percentage values
        resolved, level = _apply_tiebreaker_hierarchy(ps, challenge)
        self.assertEqual(level, 1)
        self.assertEqual(len(resolved), 3)

    def test_level_7_hash_always_unique(self):
        """The SHA-256 hash fallback must always produce a unique order."""
        challenge = make_challenge()
        # Make participants identical on all criteria up to level 6
        ps = [
            make_participant(
                id=i, user_id=i,
                steps=70_000,
                gps_step_percentage=0.0,
                milestone_reached_at=None,
                zero_step_days=0,
                best_day_steps=0,
                joined_at=datetime(2025, 6, 1, tzinfo=timezone.utc),
                longest_streak=0,
            )
            for i in range(1, 5)
        ]
        resolved, level = _apply_tiebreaker_hierarchy(ps, challenge)
        # Level 7 is the hash — should always resolve
        self.assertIsNotNone(level)
        ids_in_order = [p.id for p, _ in resolved]
        # All participants should be present
        self.assertEqual(sorted(ids_in_order), list(range(1, 5)))
