"""
Step2Win Tie Resolution Engine
================================
Handles all tie scenarios for both proportional and ranked payout challenges.

Tiebreaker hierarchy (7 levels):
  Level 1 — GPS-verified step percentage (higher = better)
  Level 2 — Milestone reached earliest (earlier = better)
  Level 3 — Fewest zero-step days (fewer = better)
  Level 4 — Highest single best day (more = better)
  Level 5 — Joined the challenge earliest (earlier = better)
  Level 6 — Longest consecutive active streak (longer = better)
  Level 7 — Deterministic hash (challenge_id + user_id) — always unique, auditable

Dead Heat Rule (for ranked prizes):
  When a tie group straddles a prize boundary, merge the prize money
  for all tied positions and split it equally among the tied group.
  This is the same rule used in golf, horse racing, and sports betting.

Rounding:
  Uses the Largest Remainder Method — guarantees sum(payouts) == net_pool exactly.
  Never loses or creates a single shilling.
"""

import hashlib
import logging
from decimal import Decimal
from typing import List, Tuple, Optional
from dataclasses import dataclass

logger = logging.getLogger(__name__)


# ── Tiebreaker level labels (shown to users) ─────────────────────────────────

TIEBREAKER_LABELS = {
    1: 'GPS-verified step percentage',
    2: 'Time of milestone completion',
    3: 'Fewest zero-step days (consistency)',
    4: 'Highest single-day step count',
    5: 'Challenge join time',
    6: 'Longest consecutive active streak',
    7: 'Random draw (seeded by challenge — fully auditable)',
}


# ── Data class for resolved participant (avoids mutating DB objects) ──────────

@dataclass
class ResolvedParticipant:
    participant:          object          # Participant model instance
    final_rank:           Optional[int]
    payout_kes:           Decimal
    payout_method:        str
    tied_with_count:      int
    tiebreaker_level:     Optional[int]
    tiebreaker_label:     str


# ──Main entry point ──────────────────────────────────────────────────────────

def resolve_challenge(challenge) -> List[ResolvedParticipant]:
    """
    Master function. Resolves all participant payouts for a challenge.
    Returns a list of ResolvedParticipant for every participant (including
    those who did not qualify — they get payout_kes=0 or refund).

    Dispatches to the correct resolver based on challenge.payout_structure.
    """
    from apps.challenges.models import Participant

    all_participants = list(
        Participant.objects.filter(challenge=challenge)
        .select_related('user')
    )

    if not all_participants:
        logger.warning(f'Challenge {challenge.id} has no participants — nothing to resolve.')
        return []

    net_pool  = challenge.total_pool * Decimal('0.95')
    qualified = [p for p in all_participants if p.steps >= challenge.milestone]
    dnq       = [p for p in all_participants if p.steps < challenge.milestone]

    # ── Scenario A3/A4: Nobody qualified → full refund ────────────────────
    if not qualified:
        logger.info(
            f'Challenge {challenge.id}: no qualifiers — issuing full refunds '
            f'to {len(all_participants)} participants.'
        )
        results = []
        for p in all_participants:
            results.append(ResolvedParticipant(
                participant      = p,
                final_rank       = None,
                payout_kes       = challenge.entry_fee,  # full refund
                payout_method    = 'refund',
                tied_with_count  = 0,
                tiebreaker_level = None,
                tiebreaker_label = 'Full refund — no participants qualified',
            ))
        return results

    # ── Dispatch by payout structure ──────────────────────────────────────
    if challenge.payout_structure == 'proportional':
        resolved = _resolve_proportional(challenge, qualified, net_pool)
    elif challenge.payout_structure == 'winner_takes_all':
        resolved = _resolve_ranked(
            challenge, qualified, net_pool,
            prize_slots=[Decimal('1.00')]
        )
    elif challenge.payout_structure == 'top_3':
        resolved = _resolve_ranked(
            challenge, qualified, net_pool,
            prize_slots=[Decimal('0.50'), Decimal('0.30'), Decimal('0.20')]
        )
    else:
        # Unknown structure — fall back to proportional
        logger.error(
            f'Unknown payout_structure "{challenge.payout_structure}" '
            f'on challenge {challenge.id} — falling back to proportional.'
        )
        resolved = _resolve_proportional(challenge, qualified, net_pool)

    # ── Append DNQ participants (no payout) ───────────────────────────────
    for p in dnq:
        resolved.append(ResolvedParticipant(
            participant      = p,
            final_rank       = None,
            payout_kes       = Decimal('0.00'),
            payout_method    = 'no_payout',
            tied_with_count  = 0,
            tiebreaker_level = None,
            tiebreaker_label = 'Did not reach milestone',
        ))

    # ── Sanity check: total payouts must not exceed net_pool ─────────────
    total_paid = sum(r.payout_kes for r in resolved if r.payout_method != 'refund')
    # Allow refund scenarios to exceed net_pool (refunds come from pool + fee)
    if not all(r.payout_method == 'refund' for r in resolved):
        max_allowed = net_pool + Decimal('0.10')  # 10 cent tolerance for edge cases
        if total_paid > max_allowed:
            logger.critical(
                f'PAYOUT OVERFLOW on challenge {challenge.id}: '
                f'total_paid={total_paid} net_pool={net_pool} — ABORTING'
            )
            raise ValueError(
                f'Payout total KES {total_paid} exceeds net pool KES {net_pool}. '
                f'Challenge {challenge.id} NOT finalized.'
            )

    return resolved


# ── Proportional resolver ─────────────────────────────────────────────────────

def _resolve_proportional(challenge, qualified, net_pool) -> List[ResolvedParticipant]:
    """
    Distributes net_pool proportionally by steps.
    Ties resolve naturally — equal steps = equal payout.
    Uses Largest Remainder Method for rounding.
    """
    total_steps = sum(p.steps for p in qualified)

    if total_steps == 0:
        # Edge: all qualified but somehow 0 steps — split equally
        amounts = _split_equally(net_pool, len(qualified))
    else:
        raw_amounts = [
            net_pool * Decimal(str(p.steps)) / Decimal(str(total_steps))
            for p in qualified
        ]
        amounts = _largest_remainder(net_pool, raw_amounts)

    # Detect tied groups for audit record
    step_counts = {}
    for p in qualified:
        step_counts.setdefault(p.steps, []).append(p)

    results = []
    for i, p in enumerate(qualified):
        tied_group = step_counts[p.steps]
        tied_count = len(tied_group) - 1  # exclude self

        results.append(ResolvedParticipant(
            participant      = p,
            final_rank       = None,   # no ranking for proportional
            payout_kes       = amounts[i],
            payout_method    = 'proportional',
            tied_with_count  = tied_count,
            tiebreaker_level = None,   # proportional never needs tiebreaker
            tiebreaker_label = (
                f'Tied with {tied_count} other participant(s) — '
                f'equal steps means equal payout share.'
                if tied_count > 0 else ''
            ),
        ))

    return results


# ── Ranked resolver ───────────────────────────────────────────────────────────

def _resolve_ranked(
    challenge,
    qualified: list,
    net_pool: Decimal,
    prize_slots: List[Decimal]
) -> List[ResolvedParticipant]:
    """
    Distributes net_pool using ranked prize slots with dead heat rules.

    prize_slots: fractions of net_pool per position, e.g. [0.5, 0.3, 0.2]
    Sum of prize_slots must equal 1.0

    Dead heat rule: when a tie group straddles a prize boundary,
    the prize money for all positions occupied by the group is merged
    and split equally among the tied group members.
    """
    n_slots      = len(prize_slots)
    slot_amounts = [net_pool * slot for slot in prize_slots]

    # Step 1: Sort by steps descending
    sorted_qualified = sorted(qualified, key=lambda p: -p.steps)

    # Step 2: Group consecutive participants with the same step count
    tie_groups = _group_by_steps(sorted_qualified)

    # Step 3: Walk through groups, assign ranks, apply dead heat where needed
    results   = []
    current_rank = 1

    for group in tie_groups:
        group_size      = len(group)
        group_start_rank = current_rank
        group_end_rank   = current_rank + group_size - 1

        # Determine which prize slots this group occupies
        # A group occupies positions [group_start_rank .. group_end_rank]
        # Prize slots are 1-indexed: slot 1 = index 0, slot n_slots = index n_slots-1
        occupied_slot_indices = [
            i for i in range(n_slots)
            if group_start_rank <= (i + 1) <= group_end_rank
        ]

        if not occupied_slot_indices:
            # Group is entirely outside prize positions — no payout
            tb_level, tb_label = None, ''

            if group_size > 1:
                # Still apply tiebreaker for rank order (display purposes)
                resolved_group, tb_level = _apply_tiebreaker_hierarchy(group, challenge)
                tb_label = TIEBREAKER_LABELS.get(tb_level, '')
            else:
                resolved_group = [(group[0], '')]

            for i, (p, _) in enumerate(resolved_group):
                results.append(ResolvedParticipant(
                    participant      = p,
                    final_rank       = current_rank + i,
                    payout_kes       = Decimal('0.00'),
                    payout_method    = 'no_payout',
                    tied_with_count  = group_size - 1,
                    tiebreaker_level = tb_level,
                    tiebreaker_label = tb_label,
                ))

        else:
            # Dead heat: merge prize money for all occupied slots
            merged_prize = sum(slot_amounts[i] for i in occupied_slot_indices)

            if group_size == 1:
                # No tie — single winner takes this slot
                p = group[0]
                results.append(ResolvedParticipant(
                    participant      = p,
                    final_rank       = current_rank,
                    payout_kes       = merged_prize,
                    payout_method    = 'tiebreaker',
                    tied_with_count  = 0,
                    tiebreaker_level = None,
                    tiebreaker_label = '',
                ))
            else:
                # Multi-way tie in prize zone — dead heat applies
                # Apply tiebreaker hierarchy for rank ORDER display
                # but ALL members of the group share the merged prize equally
                resolved_group, tb_level = _apply_tiebreaker_hierarchy(group, challenge)
                tb_label  = TIEBREAKER_LABELS.get(tb_level, '')

                # Split merged prize equally using Largest Remainder Method
                equal_share = merged_prize / Decimal(str(group_size))
                raw_amounts = [equal_share for _ in group]
                split_amounts = _largest_remainder(merged_prize, raw_amounts)

                for i, (p, _) in enumerate(resolved_group):
                    results.append(ResolvedParticipant(
                        participant      = p,
                        final_rank       = current_rank + i,
                        payout_kes       = split_amounts[i],
                        payout_method    = 'dead_heat',
                        tied_with_count  = group_size - 1,
                        tiebreaker_level = tb_level,
                        tiebreaker_label = (
                            f'{group_size}-way tie for position {current_rank}–{group_end_rank}. '
                            f'KES {merged_prize:.2f} prize pool split equally. '
                            f'Display order resolved by: {tb_label}.'
                        ),
                    ))

        current_rank += group_size

    return results


# ── Tiebreaker hierarchy ──────────────────────────────────────────────────────

def _apply_tiebreaker_hierarchy(
    group: list,
    challenge
) -> Tuple[List[Tuple], Optional[int]]:
    """
    Applies the 7-level tiebreaker hierarchy to a tied group.
    Returns (list of (participant, detail), tiebreaker_level_used).

    The order of the returned list is the final display ranking
    within the tied group (1st in list = better rank).
    """

    def score_at_level(p, level: int, challenge_id: int):
        """Lower return value = better rank for levels where lower is better."""
        if level == 1:
            # Higher GPS % = better → negate for ascending sort
            return -(getattr(p, 'gps_step_percentage', 0) or 0)

        if level == 2:
            # Earlier milestone timestamp = better
            ts = getattr(p, 'milestone_reached_at', None)
            return ts.timestamp() if ts else float('inf')

        if level == 3:
            # Fewer zero-step days = better
            return getattr(p, 'zero_step_days', 0) or 0

        if level == 4:
            # Higher best day = better → negate
            return -(getattr(p, 'best_day_steps', 0) or 0)

        if level == 5:
            # Earlier join = better
            return p.joined_at.timestamp()

        if level == 6:
            # Longer streak = better → negate
            return -(getattr(p, 'longest_streak', 0) or 0)

        if level == 7:
            # Deterministic hash — always unique per (challenge, user) pair
            # Seeded so result is reproducible for audit purposes
            seed = f"{challenge_id}-{p.user_id}"
            return int(hashlib.sha256(seed.encode()).hexdigest(), 16)

        return 0

    for level in range(1, 8):
        scores = {p.id: score_at_level(p, level, challenge.id) for p in group}
        unique_scores = len(set(scores.values()))

        if unique_scores > 1:
            # This level breaks the tie
            sorted_group = sorted(group, key=lambda p: scores[p.id])
            label        = TIEBREAKER_LABELS.get(level, f'Level {level}')

            logger.info(
                f'Tie of {len(group)} participants on challenge {challenge.id} '
                f'broken at Level {level}: {label}'
            )
            return [(p, label) for p in sorted_group], level

    # Should be mathematically impossible to reach here due to Level 7 hash
    # but handle gracefully just in case
    logger.error(
        f'Tiebreaker exhausted all 7 levels on challenge {challenge.id} '
        f'— falling back to joined_at order.'
    )
    fallback = sorted(group, key=lambda p: p.joined_at)
    return [(p, 'Fallback: join time') for p in fallback], None


# ── Rounding: Largest Remainder Method ───────────────────────────────────────

def _largest_remainder(total: Decimal, raw_amounts: List[Decimal]) -> List[Decimal]:
    """
    Distributes `total` KES among recipients such that sum(result) == total exactly.
    Uses the Largest Remainder Method — the gold standard for fair rounding.

    No money is ever lost or created. Every shilling is accounted for.

    Example:
      total = KES 9,500 · 3 recipients
      raw   = [3166.666..., 3166.666..., 3166.666...]
      floor = [3166.66,     3166.66,     3166.66]    sum = 9499.98
      remainder = 0.02 → 2 cents distributed to first 2 (largest fractions)
      result = [3166.67,    3166.67,     3166.66]    sum = 9500.00 ✅
    """
    if not raw_amounts:
        return []

    n = len(raw_amounts)

    # Floor each amount to 2 decimal places
    floored = [
        (Decimal(str(int(amount * 100))) / Decimal('100'))
        for amount in raw_amounts
    ]

    remainder = total - sum(floored)
    remainder_cents = int(round(remainder * 100))

    # Fractional parts for Largest Remainder ordering
    fractional = [(raw_amounts[i] * 100) % 1 for i in range(n)]
    order = sorted(range(n), key=lambda i: fractional[i], reverse=True)

    for i in range(remainder_cents):
        floored[order[i]] += Decimal('0.01')

    # Final sanity assert
    assert sum(floored) == total, (
        f'Largest Remainder Method failed: sum={sum(floored)} != total={total}'
    )

    return floored


def _split_equally(total: Decimal, n: int) -> List[Decimal]:
    """Split total equally among n recipients using Largest Remainder Method."""
    raw = [total / Decimal(str(n)) for _ in range(n)]
    return _largest_remainder(total, raw)


# ── Grouping helper ───────────────────────────────────────────────────────────

def _group_by_steps(sorted_participants: list) -> List[List]:
    """
    Groups consecutive participants with identical step counts.
    Input must be sorted by steps descending.

    Example: [82000, 74320, 74320, 74320, 45000]
    Returns: [[82000], [74320, 74320, 74320], [45000]]
    """
    if not sorted_participants:
        return []

    groups        = []
    current_group = [sorted_participants[0]]

    for p in sorted_participants[1:]:
        if p.steps == current_group[0].steps:
            current_group.append(p)
        else:
            groups.append(current_group)
            current_group = [p]

    groups.append(current_group)
    return groups
