"""Wallet corrections by staff: adjustments (+/-) and reversals of ledger rows.

Rules (non-negotiable, see the admin audit):
- The ledger (wallet.WalletTransaction) is never edited or deleted. A correction writes
  one NEW row of type "adjustment" or "reversal" with balance_before / balance_after,
  under select_for_update on the user.
- A wallet balance never goes below zero: a debit larger than the balance fails.
- Every request carries an idempotency key (unique): repeating it returns the first
  request instead of creating a second one.
- Requests whose absolute amount is ABOVE ConsoleControls.adjustment_approval_threshold_kes
  (default KES 5,000) are created "pending" and applied only when a DIFFERENT staff
  member with finance.approve_adjustment approves them. Smaller ones apply at once.
- A reversal creates the opposite row once: WalletTransaction.reversal_of is a
  one-to-one, so a row can be reversed at most once, and reversal rows themselves
  cannot be reversed.
- Only ledger rows whose money is settled inside the wallet can be reversed: deposits,
  payouts, refunds and adjustments. Withdrawals and challenge entries have their own
  lifecycles (withdrawal resolve / participant removal) and cannot be reversed here.
- Everything is written to the admin AuditLog (resource "wallet", id = user id).
"""

from __future__ import annotations

from decimal import Decimal, InvalidOperation

from django.contrib.auth import get_user_model
from django.db import IntegrityError
from django.db import transaction as db_transaction
from django.utils import timezone

from apps.admin_api.models import AuditLog, ConsoleControls, WalletCorrection
from apps.core.sanitizers import sanitize_text
from apps.wallet.models import WalletTransaction

User = get_user_model()

REVERSIBLE_TYPES = frozenset({"deposit", "payout", "refund", "adjustment"})
MAX_ABS_AMOUNT = Decimal("1000000")
REASON_MIN = 5


class CorrectionError(Exception):
    def __init__(self, message: str, status_code: int = 400, code: str = "invalid"):
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.code = code


def approval_threshold() -> Decimal:
    return ConsoleControls.load().adjustment_approval_threshold_kes


def parse_amount(raw) -> Decimal:
    try:
        value = Decimal(str(raw)).quantize(Decimal("0.01"))
    except (InvalidOperation, TypeError, ValueError):
        raise CorrectionError("Enter the amount in KES, e.g. 250 or -250.")
    if value == 0:
        raise CorrectionError("The amount can't be zero.")
    if abs(value) > MAX_ABS_AMOUNT:
        raise CorrectionError("The amount is too large.")
    return value


def _clean_reason(reason) -> str:
    cleaned = sanitize_text(reason or "")
    if len(cleaned) < REASON_MIN:
        raise CorrectionError(f"A reason of at least {REASON_MIN} characters is required.")
    return cleaned[:1000]


def _audit(admin, correction: WalletCorrection, action: str, description: str, request=None, extra=None):
    changes = {
        "correction_id": correction.id,
        "kind": correction.kind,
        "amount": str(correction.amount),
        "status": correction.status,
        "reason": correction.reason,
    }
    if correction.reference:
        changes["reference"] = correction.reference
    if correction.target_transaction_id:
        changes["target_transaction_id"] = correction.target_transaction_id
    if correction.applied_transaction_id:
        changes["transaction_id"] = correction.applied_transaction_id
    if extra:
        changes.update(extra)
    AuditLog.log_action(
        admin=admin,
        action=action,
        resource_type="wallet",
        resource_id=correction.user_id,
        resource_name=correction.user.username,
        description=description,
        changes=changes,
        request=request,
    )


def _existing_for_key(key: str, *, admin, kind, user_id, amount, target_id):
    existing = WalletCorrection.objects.filter(idempotency_key=key).first()
    if existing is None:
        return None
    same = (
        existing.kind == kind
        and existing.user_id == user_id
        and existing.amount == amount
        and existing.target_transaction_id == target_id
        and existing.requested_by_id == getattr(admin, "id", None)
    )
    if not same:
        raise CorrectionError(
            "This idempotency key was already used for a different request.", 409, "idempotency_conflict"
        )
    return existing


def request_correction(
    *,
    admin,
    kind: str,
    user,
    amount: Decimal,
    reason: str,
    reference: str = "",
    idempotency_key: str,
    target: WalletTransaction | None = None,
    request=None,
) -> tuple[WalletCorrection, bool]:
    """Create (and, below the threshold, apply) a correction. Returns (correction, created)."""
    key = str(idempotency_key or "").strip()[:100]
    if len(key) < 8:
        raise CorrectionError("An idempotency_key (at least 8 characters) is required.")
    reason = _clean_reason(reason)
    reference = sanitize_text(reference or "")[:100]
    existing = _existing_for_key(
        key, admin=admin, kind=kind, user_id=user.id, amount=amount, target_id=target.id if target else None
    )
    if existing is not None:
        return existing, False

    if getattr(user, "deleted_at", None):
        raise CorrectionError("This account was deleted; its wallet can't be corrected.", 409, "account_deleted")
    if kind == WalletCorrection.KIND_REVERSAL:
        _check_reversible(target)
        if WalletCorrection.objects.filter(
            target_transaction=target, status=WalletCorrection.STATUS_PENDING
        ).exists():
            raise CorrectionError("A reversal of this transaction is already waiting for approval.", 409, "pending_exists")
    if amount < 0 and user.wallet_balance + amount < 0:
        raise CorrectionError(
            f"This would take the balance below zero (available KES {user.wallet_balance}).", 400, "negative_balance"
        )

    needs_approval = abs(amount) > approval_threshold()
    try:
        with db_transaction.atomic():
            correction = WalletCorrection.objects.create(
                kind=kind,
                user=user,
                amount=amount,
                reason=reason,
                reference=reference,
                idempotency_key=key,
                target_transaction=target,
                requested_by=admin,
                needs_second_approval=needs_approval,
            )
    except IntegrityError:
        existing = _existing_for_key(
            key, admin=admin, kind=kind, user_id=user.id, amount=amount, target_id=target.id if target else None
        )
        if existing is None:
            raise
        return existing, False

    label = "Adjustment" if kind == WalletCorrection.KIND_ADJUSTMENT else "Reversal"
    if needs_approval:
        _audit(
            admin, correction, "adjust" if kind == "adjustment" else "reverse",
            f"{label} of KES {amount} for {user.username} requested (waits for a second approver)", request,
        )
        return correction, True
    _audit(
        admin, correction, "adjust" if kind == "adjustment" else "reverse",
        f"{label} of KES {amount} for {user.username} requested (below the approval threshold)", request,
    )
    apply_correction(correction.id, decided_by=admin, request=request)
    correction.refresh_from_db()
    return correction, True


def _check_reversible(target: WalletTransaction | None):
    if target is None:
        raise CorrectionError("Transaction not found.", 404, "not_found")
    if target.type == "reversal":
        raise CorrectionError("A reversal can't itself be reversed.", 409, "is_reversal")
    if WalletTransaction.objects.filter(reversal_of=target).exists():
        raise CorrectionError("This transaction was already reversed.", 409, "already_reversed")
    if target.type not in REVERSIBLE_TYPES:
        raise CorrectionError(
            f"{target.get_type_display()} rows can't be reversed here "  # type: ignore[attr-defined]
            "(use the withdrawal or challenge tools instead).",
            409,
            "not_reversible",
        )
    if target.user_id is None:
        raise CorrectionError("This transaction has no wallet owner.", 409, "no_user")


def apply_correction(correction_id: int, *, decided_by, request=None) -> WalletCorrection:
    """Write the ledger row for a pending correction (exactly once)."""
    with db_transaction.atomic():
        c = WalletCorrection.objects.select_for_update().select_related("user").get(id=correction_id)
        if c.status != WalletCorrection.STATUS_PENDING:
            raise CorrectionError(f"This correction is already {c.status}.", 409, "not_pending")
        user = User.objects.select_for_update().get(id=c.user_id)
        target = None
        if c.kind == WalletCorrection.KIND_REVERSAL:
            target = WalletTransaction.objects.select_for_update().get(id=c.target_transaction_id)
            _check_reversible(target)
        before = user.wallet_balance
        after = before + c.amount
        if after >= 0:
            _write_correction(c, user, target, before, after, decided_by, request)
            return c
    # Balance too low: nothing was written; record the failure outside the rolled-back block.
    WalletCorrection.objects.filter(id=c.id, status=WalletCorrection.STATUS_PENDING).update(
        status=WalletCorrection.STATUS_FAILED,
        error=f"Balance too low: KES {before} available",
        decided_by=decided_by,
        decided_at=timezone.now(),
    )
    c.refresh_from_db()
    _audit(decided_by, c, "adjust" if c.kind == "adjustment" else "reverse",
           f"Correction for {c.user.username} failed: balance would go below zero", request)
    raise CorrectionError(
        f"This would take the balance below zero (available KES {before}).", 400, "negative_balance"
    )


def _write_correction(c, user, target, before, after, decided_by, request):
    if True:
        user.wallet_balance = after
        user.save(update_fields=["wallet_balance", "updated_at"])
        prefix = "ADJ" if c.kind == WalletCorrection.KIND_ADJUSTMENT else "REV"
        description = (
            f"Adjustment by Step2Win: {c.reason}"[:255]
            if c.kind == WalletCorrection.KIND_ADJUSTMENT
            else f"Reversal of transaction #{target.id}: {c.reason}"[:255]
        )
        txn = WalletTransaction.objects.create(
            user=user,
            type=c.kind,
            amount=c.amount,
            balance_before=before,
            balance_after=after,
            description=description,
            reference_id=f"{prefix}-{c.id}",
            reversal_of=target,
            metadata={
                "source": "admin_correction",
                "correction_id": c.id,
                "reason": c.reason,
                "reference": c.reference,
                "requested_by": c.requested_by.username if c.requested_by_id else None,
                "approved_by": getattr(decided_by, "username", None),
            },
        )
        c.status = WalletCorrection.STATUS_APPLIED
        c.applied_transaction = txn
        c.decided_by = decided_by
        c.decided_at = timezone.now()
        c.save(update_fields=["status", "applied_transaction", "decided_by", "decided_at"])
        _audit(
            decided_by, c, "adjust" if c.kind == "adjustment" else "reverse",
            f"Applied {c.kind} of KES {c.amount} for {user.username}", request,
            extra={"balance": {"old": str(before), "new": str(after)}},
        )
    return c


def approve_correction(correction_id: int, *, approver, note: str = "", request=None) -> WalletCorrection:
    c = WalletCorrection.objects.get(id=correction_id)
    if c.requested_by_id == approver.id:
        raise CorrectionError(
            "A different staff member must approve this: you requested it.", 403, "same_person"
        )
    if c.status != WalletCorrection.STATUS_PENDING:
        raise CorrectionError(f"This correction is already {c.status}.", 409, "not_pending")
    if note:
        WalletCorrection.objects.filter(id=c.id).update(decision_note=sanitize_text(note)[:1000])
    return apply_correction(c.id, decided_by=approver, request=request)


def reject_correction(correction_id: int, *, approver, note: str, request=None) -> WalletCorrection:
    note = _clean_reason(note)
    with db_transaction.atomic():
        c = WalletCorrection.objects.select_for_update().select_related("user").get(id=correction_id)
        if c.status != WalletCorrection.STATUS_PENDING:
            raise CorrectionError(f"This correction is already {c.status}.", 409, "not_pending")
        c.status = WalletCorrection.STATUS_REJECTED
        c.decided_by = approver
        c.decided_at = timezone.now()
        c.decision_note = note
        c.save(update_fields=["status", "decided_by", "decided_at", "decision_note"])
        _audit(approver, c, "reject", f"Rejected a {c.kind} of KES {c.amount} for {c.user.username}", request,
               extra={"note": note})
    return c


def correction_row(c: WalletCorrection) -> dict:
    return {
        "id": c.id,
        "kind": c.kind,
        "status": c.status,
        "user_id": c.user_id,
        "username": c.user.username,
        "amount": str(c.amount),
        "reason": c.reason,
        "reference": c.reference,
        "target_transaction_id": c.target_transaction_id,
        "needs_second_approval": c.needs_second_approval,
        "requested_by": c.requested_by.username if c.requested_by_id else None,
        "requested_by_id": c.requested_by_id,
        "requested_at": c.requested_at.isoformat(),
        "decided_by": c.decided_by.username if c.decided_by_id else None,
        "decided_at": c.decided_at.isoformat() if c.decided_at else None,
        "decision_note": c.decision_note,
        "transaction_id": c.applied_transaction_id,
        "error": c.error,
    }
