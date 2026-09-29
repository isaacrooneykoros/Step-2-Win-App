"""
Payout holds: the money guard between anti-cheat and the wallet.

At settlement (services.finalize_challenge) every winner's payout is computed as
usual. ``hold_if_needed`` then decides whether it is *clear*:

  clear  -> the caller credits the wallet exactly as before (instant payout);
  held   -> the entry is released from locked_balance, a HeldPayout row records
            the amount and the reasons, and the wallet is NOT credited. The money
            is outside the balance, so it can't be withdrawn or re-entered.

Hold rules (thresholds are admin settings, see SystemSettings.payout_hold_*):

  trust_banned         TrustScore status BAN (always, even with holds switched off)
  account_closed       the account is deleted or disabled (always)
  trust_status         TrustScore at or below payout_hold_trust_score_max (60 =
                       REVIEW, RESTRICT, SUSPEND)
  open_high_flags      unreviewed HIGH / CRITICAL FraudFlags dated in the window
  suspicious_days      a HealthRecord in the window is marked suspicious
  large_win_with_flags payout >= payout_hold_large_win_kes and unreviewed
                       MEDIUM+ flags dated in the window
  linked_accounts      (Phase 2a, apps/linkage/policy.py) several linked accounts in
                       the same paid challenge (all but the first-registered are
                       held), or a strong link (same phone / payout number) to an
                       account that was already paid. Linkage settings are in
                       apps.linkage.LinkageSettings; known households are exempt.

Staff decide in the admin console (Finance > Payout reviews):

  release  -> credit the wallet with a "payout" WalletTransaction (unique
              reference, so it can never be paid twice). Not possible when the
              user is banned or the account is closed.
  forfeit  -> the amount is shared among the challenge's other clear qualifiers
              in proportion to their original payouts (largest-remainder cents,
              the shares add up to the forfeited amount exactly), one "payout"
              WalletTransaction each. Clear = paid instantly or released after
              review; qualifiers still under review, forfeited, banned or closed
              get none.
              With no clear qualifier the amount is REFUNDED to the challenge's
              other participants in proportion to their entry fees (same
              largest-remainder cents, one "refund" WalletTransaction each).
              Participants whose own payout is held or forfeited, and banned or
              closed accounts, get none. Only when nobody is eligible at all is
              it recorded as PlatformRevenue (with the audit trail).

Both decisions claim the row with a conditional UPDATE (status held -> decided)
inside a transaction, so a double click or two admins at once decide it once.
Customer wording is always neutral ("being reviewed"), never an accusation.
"""

from __future__ import annotations

import logging
from decimal import Decimal

from django.db import models, transaction
from django.utils import timezone

logger = logging.getLogger(__name__)

REVIEW_HOURS = 48
NOTE_MIN = 5
NOTE_MAX = 1000

HIGH_SEVERITIES = ("high", "critical")
MEDIUM_PLUS_SEVERITIES = ("medium", "high", "critical")

REASON_LABELS = {
    "trust_banned": "Account is banned from step sync",
    "account_closed": "Account is deleted or disabled",
    "trust_status": "Trust score in review range or lower",
    "open_high_flags": "Open high / critical anti-cheat flags in the challenge window",
    "suspicious_days": "Step days in the challenge window marked suspicious",
    "large_win_with_flags": "Large payout with open anti-cheat flags in the window",
    # Phase 2a (apps/linkage): multi-account / shared device / shared payout number.
    "linked_accounts": "Linked to other accounts (same phone, payout number or activity)",
}


class PayoutReviewError(Exception):
    """A decision that is not allowed (shown to staff as a 400)."""


def _D(value) -> Decimal:
    return Decimal(str(value or 0)).quantize(Decimal("0.01"))


def customer_review_message(amount) -> str:
    return (
        f"Your KSh {_D(amount):,.2f} payout is being reviewed. "
        f"This usually takes up to {REVIEW_HOURS} hours."
    )


# ── settlement ───────────────────────────────────────────────────────────────


def _settings():
    from apps.admin_api.platform import current_settings

    return current_settings()


def _trust(user_id):
    from apps.steps.models import TrustScore

    return TrustScore.objects.filter(user_id=user_id).first()


def hold_reasons(challenge, participant, amount, user=None) -> list[dict]:
    """Every hold rule that matches this winner. Empty list = clear, pay now."""
    from apps.steps.models import FraudFlag, HealthRecord

    user = user or participant.user
    amount = _D(amount)
    cfg = _settings()
    reasons: list[dict] = []

    def add(code, **detail):
        reasons.append({"code": code, "label": REASON_LABELS[code], "detail": detail})

    trust = _trust(user.id)
    score = trust.score if trust else 100
    status = trust.status if trust else "GOOD"

    # Safety floor: never pay a banned or closed account automatically.
    if status == "BAN":
        add("trust_banned", score=score, status=status)
    if not user.is_active or getattr(user, "deleted_at", None):
        add("account_closed", deleted=bool(getattr(user, "deleted_at", None)))

    if not getattr(cfg, "payout_holds_enabled", True):
        return reasons

    threshold = int(getattr(cfg, "payout_hold_trust_score_max", 60))
    if status != "BAN" and score <= threshold:
        add("trust_status", score=score, status=status, threshold=threshold)

    window = {"date__gte": challenge.start_date, "date__lte": challenge.end_date}
    open_flags = FraudFlag.objects.filter(user=user, reviewed=False, **window)
    high = list(
        open_flags.filter(severity__in=HIGH_SEVERITIES).values_list("id", "flag_type")
    )
    if high:
        add(
            "open_high_flags",
            count=len(high),
            flag_ids=[f[0] for f in high][:50],
            types=sorted({f[1] for f in high}),
        )

    days = list(
        HealthRecord.objects.filter(user=user, is_suspicious=True, **window)
        .order_by("date")
        .values_list("date", flat=True)
    )
    if days:
        add("suspicious_days", count=len(days), dates=[d.isoformat() for d in days])

    large = _D(getattr(cfg, "payout_hold_large_win_kes", 5000))
    if amount >= large:
        medium_plus = open_flags.filter(severity__in=MEDIUM_PLUS_SEVERITIES).count()
        if medium_plus:
            add(
                "large_win_with_flags",
                amount=str(amount),
                threshold=str(large),
                open_flags=medium_plus,
            )

    # ── Phase 2a: account linkage (apps/linkage/policy.py) ──────────────────
    # Fails open (logged): the rules above still apply if the linkage check breaks.
    try:
        from apps.linkage.policy import linked_account_reasons

        for detail in linked_account_reasons(challenge, participant, user, amount):
            add("linked_accounts", **detail)
    except Exception as exc:
        logger.exception(
            "LINKED-ACCOUNT CHECK FAILED for user %s challenge %s: paid as if not linked "
            "(other hold rules still applied)", user.id, challenge.id,
        )
        try:
            from apps.linkage.alerts import ops_alert

            ops_alert({"event": "linked_account_check_failed", "user_id": user.id,
                       "challenge_id": challenge.id, "error": type(exc).__name__})
        except Exception:
            pass
    return reasons


def _linked_to_hold(hold) -> set:
    """Phase 2a: accounts linked to the held account never receive a share of its
    forfeited payout (otherwise a farm's main account collects its alts' prizes)."""
    try:
        from apps.linkage.policy import forfeit_excluded_user_ids

        return forfeit_excluded_user_ids(hold.user_id)
    except Exception:
        logger.exception("Linked-account lookup failed for hold %s", hold.pk)
        return set()


def hold_if_needed(challenge, resolved, user) -> bool:
    """Settlement hook. Call inside finalize_challenge's transaction with `user`
    already locked (select_for_update), before crediting a winner.

    Returns False when the payout is clear (the caller pays as usual). Returns
    True when it was held: the entry fee is released from locked_balance, a
    HeldPayout is recorded and the user is told it is under review. The wallet
    is not credited.
    """
    from apps.challenges.models import HeldPayout

    amount = _D(resolved.payout_kes)
    if amount <= 0:
        return False
    reasons = hold_reasons(challenge, resolved.participant, amount, user=user)
    if not reasons:
        return False

    codes = {r["code"] for r in reasons}
    user.locked_balance -= challenge.entry_fee
    user.save(update_fields=["locked_balance", "updated_at"])
    hold, created = HeldPayout.objects.get_or_create(
        participant=resolved.participant,
        defaults={
            "challenge": challenge,
            "user": user,
            "amount": amount,
            "reasons": reasons,
            "forfeit_only": bool(codes & {"trust_banned", "account_closed"}),
        },
    )
    if created:
        logger.warning(
            "Payout held for review: hold=%s challenge=%s user=%s amount=%s reasons=%s",
            hold.pk, challenge.id, user.id, amount, sorted(codes),
        )
        _notify(
            user,
            None,
            "Your payout is being reviewed",
            f'{customer_review_message(amount)} It is from "{challenge.name}". '
            "You don't need to do anything; we'll message you here when the review is done.",
        )
    return True


# ── customer-facing state ────────────────────────────────────────────────────


def review_payload(hold) -> dict | None:
    if hold is None:
        return None
    if hold.status == hold.STATUS_HELD:
        message = customer_review_message(hold.amount)
    elif hold.status == hold.STATUS_RELEASED:
        message = f"Your KSh {_D(hold.amount):,.2f} payout was reviewed and added to your wallet."
    else:
        message = (
            "After review, this payout could not be approved. "
            "Contact support if you have questions."
        )
    return {
        "id": hold.pk,
        "status": hold.status,
        "amount": str(_D(hold.amount)),
        "created_at": hold.created_at.isoformat() if hold.created_at else None,
        "decided_at": hold.decided_at.isoformat() if hold.decided_at else None,
        "review_hours": REVIEW_HOURS,
        "message": message,
    }


def payout_review_for(user, challenge) -> dict | None:
    from apps.challenges.models import HeldPayout

    hold = HeldPayout.objects.filter(user=user, challenge=challenge).first()
    return review_payload(hold)


def open_reviews_for(user) -> list[dict]:
    from apps.challenges.models import HeldPayout

    rows = (
        HeldPayout.objects.filter(user=user, status=HeldPayout.STATUS_HELD)
        .select_related("challenge")
        .order_by("created_at")
    )
    out = []
    for h in rows:
        p = review_payload(h)
        p["challenge_id"] = h.challenge_id
        p["challenge_name"] = h.challenge.name
        out.append(p)
    return out


def paid_entry_block(user) -> str | None:
    """Why this user may not join or create a paid challenge right now (None = allowed)."""
    from apps.challenges.models import HeldPayout

    trust = _trust(user.id)
    if trust is not None and trust.status in ("SUSPEND", "BAN"):
        return (
            "Paid challenges are paused on your account. "
            "Contact support if you think this is a mistake."
        )
    if HeldPayout.objects.filter(user=user, status=HeldPayout.STATUS_HELD).exists():
        return (
            "You can join paid challenges again once the review of your recent payout "
            f"is complete. This usually takes up to {REVIEW_HOURS} hours."
        )
    return None


# ── staff decisions ──────────────────────────────────────────────────────────


def _clean_note(note) -> str:
    note = str(note or "").strip()
    if len(note) < NOTE_MIN:
        raise PayoutReviewError(f"A note of at least {NOTE_MIN} characters is required.")
    if len(note) > NOTE_MAX:
        raise PayoutReviewError(f"The note must be {NOTE_MAX} characters or fewer.")
    return note


def _claim(hold_id, new_status, admin, note) -> bool:
    """Atomic held -> decided transition. True for exactly one caller."""
    from apps.challenges.models import HeldPayout

    return bool(
        HeldPayout.objects.filter(pk=hold_id, status=HeldPayout.STATUS_HELD).update(
            status=new_status, decided_by=admin, decided_at=timezone.now(), note=note
        )
    )


def _release_blocker(hold) -> str | None:
    if hold.forfeit_only:
        return "This payout can only be forfeited (the account was banned or closed at settlement)."
    user = hold.user
    if getattr(user, "deleted_at", None):
        return "The account has been deleted; this payout can only be forfeited."
    trust = _trust(user.id)
    if trust is not None and trust.status == "BAN":
        return "The user is banned; this payout can only be forfeited."
    return None


def _credit(user_id, amount, *, reference_id, description, metadata, count_win=False,
            txn_type="payout"):
    from apps.users.models import User
    from apps.wallet.models import WalletTransaction

    user = User.objects.select_for_update().get(pk=user_id)
    before = user.wallet_balance
    user.wallet_balance += amount
    fields = ["wallet_balance", "updated_at"]
    if txn_type == "payout":
        # A refund gives back money the user paid in; it is not "earned".
        user.total_earned += amount
        fields.append("total_earned")
    user.save(update_fields=fields)
    if count_win:
        User.objects.filter(pk=user_id).update(challenges_won=models.F("challenges_won") + 1)
    return WalletTransaction.objects.create(
        user=user,
        type=txn_type,
        amount=amount,
        balance_before=before,
        balance_after=user.wallet_balance,
        description=description[:255],
        reference_id=reference_id,
        metadata=metadata,
    )


def _audit(admin, action, hold, description, changes, request):
    from apps.admin_api.models import AuditLog

    AuditLog.log_action(
        admin=admin,
        action=action,
        resource_type="transaction",
        resource_id=hold.pk,
        resource_name=f"Payout review #{hold.pk} ({hold.user.username})",
        description=description,
        changes={"kind": "payout_review", **changes},
        request=request,
    )


def _counts_as_win(hold) -> bool:
    """Mirror of finalize_challenge's challenges_won rule."""
    from apps.challenges.models import ChallengeResult

    r = ChallengeResult.objects.filter(participant_id=hold.participant_id).first()
    if r is None:
        return False
    if r.payout_method in ("tiebreaker", "dead_heat"):
        return r.final_rank == 1
    return r.payout_method == "proportional"


def release_hold(hold_id, admin, note, request=None) -> dict:
    from apps.challenges.models import HeldPayout

    note = _clean_note(note)
    with transaction.atomic():
        hold = (
            HeldPayout.objects.select_for_update()
            .select_related("user", "challenge")
            .get(pk=hold_id)
        )
        if hold.status != HeldPayout.STATUS_HELD:
            return {"id": hold.pk, "status": hold.status, "already_decided": True}
        blocker = _release_blocker(hold)
        if blocker:
            raise PayoutReviewError(blocker)
        if not _claim(hold.pk, HeldPayout.STATUS_RELEASED, admin, note):
            hold.refresh_from_db()
            return {"id": hold.pk, "status": hold.status, "already_decided": True}

        amount = _D(hold.amount)
        txn = _credit(
            hold.user_id,
            amount,
            reference_id=f"PAYOUT-HOLD-{hold.pk}-RELEASE",
            description=f'Payout from "{hold.challenge.name}" (released after review)',
            metadata={
                "challenge_id": hold.challenge_id,
                "held_payout_id": hold.pk,
                "payout_review": "released",
            },
            count_win=_counts_as_win(hold),
        )
        hold.refresh_from_db()
        hold.resolution = {"action": "released", "wallet_transaction_id": txn.pk}
        hold.save(update_fields=["resolution"])
        _audit(
            admin, "approve", hold,
            f"Released held payout KES {amount} to {hold.user.username} "
            f'(challenge "{hold.challenge.name}")',
            {"decision": "release", "amount": str(amount), "note": note,
             "user_id": hold.user_id, "challenge_id": hold.challenge_id,
             "wallet_transaction_id": txn.pk},
            request,
        )
        _notify(
            hold.user, admin, "Your payout review is complete",
            f'Your KSh {amount:,.2f} payout from "{hold.challenge.name}" was reviewed '
            "and has been added to your wallet.",
        )
    return {"id": hold.pk, "status": HeldPayout.STATUS_RELEASED, "wallet_transaction_id": txn.pk}


def _clear_recipients(hold):
    """(participant_id, user_id, original payout) of the challenge's clear qualifiers."""
    from apps.challenges.models import ChallengeResult, HeldPayout
    from apps.steps.models import TrustScore

    blocked = set(
        HeldPayout.objects.filter(challenge_id=hold.challenge_id)
        .exclude(status=HeldPayout.STATUS_RELEASED)
        .values_list("participant_id", flat=True)
    )
    rows = list(
        ChallengeResult.objects.filter(challenge_id=hold.challenge_id, payout_kes__gt=0)
        .exclude(payout_method="refund")
        .exclude(participant_id=hold.participant_id)
        .select_related("user")
        .order_by("participant_id")
    )
    banned = set(
        TrustScore.objects.filter(
            user_id__in=[r.user_id for r in rows], score__lte=0
        ).values_list("user_id", flat=True)
    )
    linked = _linked_to_hold(hold)  # Phase 2a
    out = []
    for r in rows:
        if r.participant_id in blocked or r.user_id in banned or r.user_id in linked:
            continue
        if not r.user.is_active or getattr(r.user, "deleted_at", None):
            continue
        out.append((r.participant_id, r.user_id, _D(r.payout_kes)))
    return out


def split_forfeit(amount, weights) -> list[Decimal]:
    """Split `amount` in proportion to `weights`, to the cent, summing exactly."""
    from apps.challenges.tie_resolution import _largest_remainder

    amount = _D(amount)
    total = sum(weights, Decimal("0"))
    if not weights or total <= 0:
        return []
    raw = [amount * w / total for w in weights]
    return _largest_remainder(amount, raw)


def _refund_recipients(hold):
    """(participant_id, user_id, entry fee) of the challenge's other participants
    who may receive a refund share: not the held user, no held or forfeited
    payout of their own, not banned, account not closed."""
    from apps.challenges.models import HeldPayout, Participant
    from apps.steps.models import TrustScore

    challenge = hold.challenge
    not_clear = set(
        HeldPayout.objects.filter(challenge_id=hold.challenge_id)
        .exclude(status=HeldPayout.STATUS_RELEASED)
        .values_list("participant_id", flat=True)
    )
    rows = list(
        Participant.objects.filter(challenge_id=hold.challenge_id)
        .exclude(pk=hold.participant_id)
        .select_related("user")
        .order_by("pk")
    )
    banned = set(
        TrustScore.objects.filter(
            user_id__in=[p.user_id for p in rows], score__lte=0
        ).values_list("user_id", flat=True)
    )
    fee = _D(challenge.entry_fee)
    linked = _linked_to_hold(hold)  # Phase 2a
    out = []
    for p in rows:
        if p.pk in not_clear or p.user_id in banned or p.user_id in linked:
            continue
        if not p.user.is_active or getattr(p.user, "deleted_at", None):
            continue
        out.append((p.pk, p.user_id, fee))
    return out


def forfeit_plan(hold) -> dict:
    """Where a forfeited payout goes. Used by the decision and the admin preview.

    mode "qualifiers": shared among clear qualifiers by original payout;
    mode "refund":     no clear qualifier, refunded to the other eligible
                       participants by entry fee;
    mode "platform":   nobody eligible, recorded as PlatformRevenue.
    `recipients` is a list of (participant_id, user_id, weight, share).
    """
    amount = _D(hold.amount)
    for mode, recipients in (
        ("qualifiers", _clear_recipients(hold)),
        ("refund", _refund_recipients(hold)),
    ):
        shares = split_forfeit(amount, [r[2] for r in recipients])
        rows = [
            (pid, uid, weight, share)
            for (pid, uid, weight), share in zip(recipients, shares)
            if share > 0
        ]
        if rows:
            return {"mode": mode, "recipients": rows}
    return {"mode": "platform", "recipients": []}


def forfeit_hold(hold_id, admin, note, request=None) -> dict:
    from apps.challenges.models import HeldPayout
    from apps.payments.models import PlatformRevenue

    note = _clean_note(note)
    with transaction.atomic():
        hold = (
            HeldPayout.objects.select_for_update()
            .select_related("user", "challenge")
            .get(pk=hold_id)
        )
        if hold.status != HeldPayout.STATUS_HELD:
            return {"id": hold.pk, "status": hold.status, "already_decided": True}
        if not _claim(hold.pk, HeldPayout.STATUS_FORFEITED, admin, note):
            hold.refresh_from_db()
            return {"id": hold.pk, "status": hold.status, "already_decided": True}

        amount = _D(hold.amount)
        name = hold.challenge.name
        plan = forfeit_plan(hold)
        mode = plan["mode"]
        distributed = []
        for participant_id, user_id, weight, share in plan["recipients"]:
            if mode == "qualifiers":
                txn = _credit(
                    user_id,
                    share,
                    reference_id=f"PAYOUT-HOLD-{hold.pk}-SHARE-{participant_id}",
                    description=(
                        f'Extra payout from "{name}": a prize not approved after review '
                        "was shared among qualifying finishers"
                    ),
                    metadata={
                        "challenge_id": hold.challenge_id,
                        "held_payout_id": hold.pk,
                        "payout_review": "forfeit_share",
                        "original_payout": str(weight),
                    },
                )
                distributed.append(
                    {"user_id": user_id, "participant_id": participant_id,
                     "original_payout": str(weight), "share": str(share),
                     "wallet_transaction_id": txn.pk}
                )
            else:
                txn = _credit(
                    user_id,
                    share,
                    txn_type="refund",
                    reference_id=f"PAYOUT-HOLD-{hold.pk}-REFUND-{participant_id}",
                    description=(
                        f'Partial refund from "{name}": a prize not approved after review '
                        "was returned to the other participants"
                    ),
                    metadata={
                        "challenge_id": hold.challenge_id,
                        "held_payout_id": hold.pk,
                        "payout_review": "forfeit_refund",
                        "entry_fee": str(weight),
                    },
                )
                distributed.append(
                    {"user_id": user_id, "participant_id": participant_id,
                     "entry_fee": str(weight), "share": str(share),
                     "wallet_transaction_id": txn.pk}
                )

        revenue_id = None
        if not distributed:
            revenue = PlatformRevenue.objects.create(
                challenge=hold.challenge,
                amount_kes=amount,
                narration=f"Forfeited payout (review #{hold.pk}) from challenge: {name}"[:255],
                metadata={
                    "held_payout_id": hold.pk,
                    "user_id": hold.user_id,
                    "reason": "forfeit_no_eligible_participants",
                    "decided_by": getattr(admin, "username", None),
                },
            )
            revenue_id = revenue.pk

        hold.refresh_from_db()
        hold.resolution = {
            "action": "forfeited",
            "mode": mode,
            "redistributed": distributed,
            "platform_revenue_id": revenue_id,
            "total": str(amount),
        }
        hold.save(update_fields=["resolution"])
        _audit(
            admin, "reject", hold,
            f"Forfeited held payout KES {amount} of {hold.user.username} "
            f'(challenge "{name}"): '
            + {
                "qualifiers": f"shared among {len(distributed)} qualifier(s)",
                "refund": f"refunded to {len(distributed)} other participant(s) by entry fee",
            }.get(mode, "kept by the platform (no eligible participant)"),
            {"decision": "forfeit", "amount": str(amount), "note": note,
             "user_id": hold.user_id, "challenge_id": hold.challenge_id,
             "mode": mode, "redistributed": distributed, "platform_revenue_id": revenue_id},
            request,
        )
        _notify(
            hold.user, admin, "Your payout review is complete",
            f'We reviewed the step data for "{name}". The KSh {amount:,.2f} payout '
            "could not be approved. If you think this is a mistake, contact support "
            "and we'll take another look.",
        )
    return {
        "id": hold.pk,
        "status": HeldPayout.STATUS_FORFEITED,
        "mode": mode,
        "redistributed": distributed,
        "platform_revenue_id": revenue_id,
    }


# ── notifications ────────────────────────────────────────────────────────────


def _notify(user, admin, subject, message):
    """Message in the user's Support inbox (a resolved ticket with one staff
    message), the same pattern as trust & safety notices."""
    from apps.admin_api.models import SupportTicket, SupportTicketMessage

    try:
        with transaction.atomic():
            ticket = SupportTicket.objects.create(
                user=user,
                subject=subject[:255],
                category="payment",
                message="Notice from the Step2Win payouts team.",
                status="resolved",
                priority="medium",
                resolved_at=timezone.now(),
            )
            SupportTicketMessage.objects.create(
                ticket=ticket,
                sender=admin,
                sender_username=getattr(admin, "username", None) or "Step2Win",
                is_admin=True,
                message=message,
            )
    except Exception:  # a notice must never block settlement or a decision
        logger.exception("Could not deliver payout review notice to user %s", user.pk)
