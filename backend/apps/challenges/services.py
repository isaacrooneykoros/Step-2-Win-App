from decimal import Decimal

from django.db import models, transaction
from django.utils import timezone


def cancel_challenge(challenge, reason=''):
    """
    Cancel an active challenge and release all locked balances.
    Creates refund transactions for all participants.
    
    Args:
        challenge: Challenge instance to cancel
        reason: Optional reason for cancellation
    
    Returns:
        bool: True if cancelled successfully, False if not in 'active' status
    """
    from apps.challenges.models import Participant, ChallengeResult
    from apps.users.models import User
    from apps.wallet.models import WalletTransaction
    import logging

    logger = logging.getLogger(__name__)

    with transaction.atomic():
        challenge = challenge.__class__.objects.select_for_update().get(id=challenge.id)
        if challenge.status != 'active':
            logger.warning(f'Cannot cancel challenge {challenge.id}: status is {challenge.status}')
            return False

        logger.info(f'Cancelling challenge {challenge.id}: "{challenge.name}". Reason: {reason or "admin action"}')

        # Release locked balance for all participants
        participants = Participant.objects.filter(challenge=challenge).select_related('user')
        for participant in participants:
            user = User.objects.select_for_update().get(id=participant.user_id)
            balance_before = user.wallet_balance

            # Refund entry fee
            user.wallet_balance += challenge.entry_fee
            user.locked_balance -= challenge.entry_fee
            user.save(update_fields=['wallet_balance', 'locked_balance', 'updated_at'])

            # Create refund transaction
            WalletTransaction.objects.create(
                user=user,
                type='refund',
                amount=challenge.entry_fee,
                balance_before=balance_before,
                balance_after=user.wallet_balance,
                description=(
                    f'Challenge Cancelled: {challenge.name} — {reason or "Admin cancelled challenge"}'
                ),
                metadata={'challenge_id': challenge.id, 'reason': reason},
            )

            logger.info(f'Refunded KES {challenge.entry_fee} to {user.username} for cancelled challenge')

        # Mark challenge as cancelled
        challenge.status = 'cancelled'
        challenge.save(update_fields=['status', 'updated_at'])

        logger.info(
            f'Challenge {challenge.id} cancelled. '
            f'Refunded KES {challenge.entry_fee} to {participants.count()} participants.'
        )

        return True


def finalize_challenge(challenge):
    """
    Finalize one active challenge using the tie resolution engine:
    - Resolves all tie scenarios using 7-level tiebreaker hierarchy
    - Creates ChallengeResult records for audit trail
    - Distributes payouts or issues refunds
    - Marks challenge as completed
    """
    from apps.challenges.models import ChallengeResult
    from apps.challenges.tie_resolution import resolve_challenge
    from apps.users.models import User
    from apps.wallet.models import WalletTransaction
    import logging

    logger = logging.getLogger(__name__)

    with transaction.atomic():
        challenge = challenge.__class__.objects.select_for_update().get(id=challenge.id)
        if challenge.status != 'active':
            return False

        logger.info(f'Finalizing challenge {challenge.id}: "{challenge.name}"')

        # ── Run tie resolution engine ──────────────────────────────
        resolved = resolve_challenge(challenge)

        if not resolved:
            logger.warning(f'Challenge {challenge.id} has no participants — skipping.')
            challenge.status = 'completed'
            challenge.save(update_fields=['status', 'updated_at'])
            return True

        net_pool  = challenge.total_pool * Decimal('0.95')
        is_refund = all(r.payout_method == 'refund' for r in resolved)

        # ── Process each participant ───────────────────────────────
        for r in resolved:
            user = User.objects.select_for_update().get(id=r.participant.user_id)
            balance_before = user.wallet_balance

            if r.payout_method == 'refund':
                # Nobody qualified — full refund
                user.wallet_balance  += challenge.entry_fee
                user.locked_balance  -= challenge.entry_fee
                user.save(update_fields=['wallet_balance', 'locked_balance', 'updated_at'])

                WalletTransaction.objects.create(
                    user            = user,
                    type            = 'refund',
                    amount          = challenge.entry_fee,
                    balance_before  = balance_before,
                    balance_after   = user.wallet_balance,
                    description     = (
                        f'Refund: {challenge.name} — '
                        f'no participants qualified'
                    ),
                    metadata        = {'challenge_id': challenge.id},
                )

            elif r.payout_kes > 0:
                # Winner — credit payout
                user.wallet_balance  += r.payout_kes
                user.locked_balance  -= challenge.entry_fee
                user.total_earned    += r.payout_kes
                user.save(update_fields=['wallet_balance', 'locked_balance', 'total_earned', 'updated_at'])

                # Update challenges_won if this is a winner
                if r.payout_method in ('tiebreaker', 'dead_heat') and r.final_rank == 1:
                    User.objects.filter(id=user.id).update(
                        challenges_won=models.F('challenges_won') + 1
                    )
                elif r.payout_kes > 0 and r.payout_method == 'proportional':
                    User.objects.filter(id=user.id).update(
                        challenges_won=models.F('challenges_won') + 1
                    )

                WalletTransaction.objects.create(
                    user            = user,
                    type            = 'payout',
                    amount          = r.payout_kes,
                    balance_before  = balance_before,
                    balance_after   = user.wallet_balance,
                    description     = _payout_description(challenge, r),
                    metadata        = {
                        'challenge_id': challenge.id,
                        'steps': r.participant.steps,
                        'rank': r.final_rank,
                        'payout_method': r.payout_method,
                    },
                )

            else:
                # Did not qualify — release locked balance
                user.locked_balance -= challenge.entry_fee
                user.save(update_fields=['locked_balance', 'updated_at'])

            # ── Save tiebreaker data back to Participant ───────────
            r.participant.payout    = r.payout_kes
            r.participant.qualified = r.payout_kes > 0 or r.payout_method == 'refund'
            r.participant.rank      = r.final_rank
            r.participant.save(update_fields=['payout', 'qualified', 'rank'])

            # ── Create immutable ChallengeResult record ───────────
            ChallengeResult.objects.get_or_create(
                challenge   = challenge,
                participant = r.participant,
                defaults    = {
                    'user':                 r.participant.user,
                    'final_steps':          r.participant.steps,
                    'gps_verified_pct':     r.participant.gps_step_percentage,
                    'milestone_reached_at': r.participant.milestone_reached_at,
                    'zero_step_days':       r.participant.zero_step_days,
                    'best_day_steps':       r.participant.best_day_steps,
                    'longest_streak':       r.participant.longest_streak,
                    'joined_at':            r.participant.joined_at,
                    'tied_with_count':      r.tied_with_count,
                    'tiebreaker_level':     r.tiebreaker_level,
                    'tiebreaker_label':     r.tiebreaker_label,
                    'qualified':            r.participant.qualified,
                    'final_rank':           r.final_rank,
                    'payout_kes':           r.payout_kes,
                    'payout_method':        r.payout_method,
                }
            )

        # ── Record platform fee in PlatformRevenue (not orphan transaction) ────
        if not is_refund:
            from apps.payments.models import PlatformRevenue
            platform_fee = challenge.total_pool * Decimal('0.05')
            PlatformRevenue.objects.create(
                challenge=challenge,
                amount_kes=platform_fee,
                narration=f'Platform fee from challenge: {challenge.name}',
                metadata={'total_pool': str(challenge.total_pool)},
            )

        # ── Mark challenge completed ───────────────────────────────
        challenge.status = 'completed'
        challenge.save(update_fields=['status', 'updated_at'])

        logger.info(
            f'Challenge {challenge.id} finalized. '
            f'{"Refunded all" if is_refund else f"Paid out KES {net_pool}"} '
            f'to {len(resolved)} participants.'
        )

        return True


def _payout_description(challenge, resolved_participant) -> str:
    """Builds the wallet transaction description for a payout."""
    r = resolved_participant

    if r.payout_method == 'proportional':
        base = f'Payout from "{challenge.name}"'
        if r.tied_with_count > 0:
            return (f'{base} — tied with {r.tied_with_count} other(s), '
                    f'equal payout share')
        return base

    if r.payout_method == 'dead_heat':
        return (
            f'Payout from "{challenge.name}" — '
            f'{r.tied_with_count + 1}-way tie, prize pool split equally. '
            f'{r.tiebreaker_label}'
        )

    if r.payout_method == 'tiebreaker':
        return f'Payout from "{challenge.name}" — Rank {r.final_rank}'

    return f'Payout from "{challenge.name}"'


def finalize_expired_challenges(today=None):
    """Finalize challenges that have ended but are still marked active."""
    from apps.challenges.models import Challenge

    target_date = today or timezone.now().date()
    expired = Challenge.objects.filter(status='active', end_date__lt=target_date).order_by('end_date', 'id')

    finalized = 0
    for challenge in expired:
        if finalize_challenge(challenge):
            finalized += 1

    return finalized
