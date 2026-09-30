"""Finance console: wallet corrections, deposits and stuck withdrawals.

POST /api/admin/finance/adjustments/                {user_id, amount (+/-), reason, reference?, idempotency_key}
POST /api/admin/finance/transactions/<id>/reverse/  {reason, idempotency_key}
GET  /api/admin/finance/corrections/?status=&user_id=
POST /api/admin/finance/corrections/<id>/approve/   second approver (not the requester)
POST /api/admin/finance/corrections/<id>/reject/    {note}
GET  /api/admin/finance/deposits/?q=&status=&page=
GET  /api/admin/finance/deposits/<uuid>/            detail + callback logs (read-only)
POST /api/admin/finance/deposits/<uuid>/verify/     ask IntaSend, then resolve (credits at most once)
POST /api/admin/finance/withdrawals/<uuid>/resolve/ {outcome: paid|failed, reason, mpesa_reference?}
GET  /api/admin/finance/withdrawals/<uuid>/history/ django-auditlog changes + admin actions

Rules: apps/admin_api/money.py (corrections) and apps/payments/services.py (deposits,
refunds). Everything is audited.
"""

import logging
from datetime import timedelta

from django.contrib.auth import get_user_model
from django.db import transaction as db_transaction
from django.db.models import Q
from django.shortcuts import get_object_or_404
from django.utils import timezone
from drf_spectacular.utils import OpenApiTypes, extend_schema
from rest_framework.decorators import api_view, permission_classes
from rest_framework.response import Response

from apps.admin_api.models import AuditLog, WalletCorrection
from apps.admin_api.money import (CorrectionError, approval_threshold, approve_correction,
                                  correction_row, parse_amount, reject_correction,
                                  request_correction)
from apps.admin_api.roles import staff
from apps.core.locks import acquire_lock, release_lock
from apps.payments.models import CallbackLog, PaymentTransaction, WithdrawalRequest
from apps.wallet.models import WalletTransaction

logger = logging.getLogger(__name__)
User = get_user_model()


def _err(exc: CorrectionError):
    return Response({"error": exc.message, "code": exc.code}, status=exc.status_code)


def _key(request):
    return request.data.get("idempotency_key") or request.headers.get("X-Idempotency-Key") or ""


# ── wallet corrections ──────────────────────────────────────────────────────


@extend_schema(request=OpenApiTypes.OBJECT, responses={200: OpenApiTypes.OBJECT, 201: OpenApiTypes.OBJECT})
@api_view(["POST"])
@permission_classes(staff("finance.adjust"))
def create_adjustment(request):
    try:
        user_id = int(request.data.get("user_id"))
    except (TypeError, ValueError):
        return Response({"error": "user_id is required"}, status=400)
    user = get_object_or_404(User, id=user_id)
    try:
        amount = parse_amount(request.data.get("amount"))
        correction, created = request_correction(
            admin=request.user,
            kind=WalletCorrection.KIND_ADJUSTMENT,
            user=user,
            amount=amount,
            reason=request.data.get("reason"),
            reference=request.data.get("reference") or "",
            idempotency_key=_key(request),
            request=request,
        )
    except CorrectionError as exc:
        return _err(exc)
    user.refresh_from_db()
    return Response(
        {"correction": correction_row(correction), "created": created, "wallet_balance": str(user.wallet_balance)},
        status=201 if created else 200,
    )


@extend_schema(request=OpenApiTypes.OBJECT, responses={200: OpenApiTypes.OBJECT, 201: OpenApiTypes.OBJECT})
@api_view(["POST"])
@permission_classes(staff("finance.adjust"))
def create_reversal(request, txn_id):
    target = get_object_or_404(WalletTransaction.objects.select_related("user"), id=txn_id)
    if target.user is None:
        return Response({"error": "This transaction has no wallet owner."}, status=409)
    try:
        correction, created = request_correction(
            admin=request.user,
            kind=WalletCorrection.KIND_REVERSAL,
            user=target.user,
            amount=-target.amount,
            reason=request.data.get("reason"),
            reference=request.data.get("reference") or "",
            idempotency_key=_key(request),
            target=target,
            request=request,
        )
    except CorrectionError as exc:
        return _err(exc)
    return Response({"correction": correction_row(correction), "created": created}, status=201 if created else 200)


@extend_schema(responses={200: OpenApiTypes.OBJECT})
@api_view(["GET"])
@permission_classes(staff("finance.view"))
def corrections(request):
    qs = WalletCorrection.objects.select_related("user", "requested_by", "decided_by")
    status_param = request.query_params.get("status")
    if status_param in {s for s, _ in WalletCorrection.STATUS_CHOICES}:
        qs = qs.filter(status=status_param)
    user_id = request.query_params.get("user_id")
    if user_id and user_id.isdigit():
        qs = qs.filter(user_id=int(user_id))
    return Response(
        {
            "results": [correction_row(c) for c in qs[:200]],
            "pending_count": WalletCorrection.objects.filter(status=WalletCorrection.STATUS_PENDING).count(),
            "threshold_kes": str(approval_threshold()),
        }
    )


@extend_schema(request=OpenApiTypes.OBJECT, responses={200: OpenApiTypes.OBJECT})
@api_view(["POST"])
@permission_classes(staff("finance.approve_adjustment"))
def approve_correction_view(request, correction_id):
    get_object_or_404(WalletCorrection, id=correction_id)
    try:
        c = approve_correction(correction_id, approver=request.user, note=request.data.get("note") or "", request=request)
    except CorrectionError as exc:
        return _err(exc)
    c.refresh_from_db()
    return Response({"correction": correction_row(c)})


@extend_schema(request=OpenApiTypes.OBJECT, responses={200: OpenApiTypes.OBJECT})
@api_view(["POST"])
@permission_classes(staff("finance.approve_adjustment"))
def reject_correction_view(request, correction_id):
    get_object_or_404(WalletCorrection, id=correction_id)
    try:
        c = reject_correction(correction_id, approver=request.user, note=request.data.get("note"), request=request)
    except CorrectionError as exc:
        return _err(exc)
    return Response({"correction": correction_row(c)})


# ── deposits ────────────────────────────────────────────────────────────────


def _deposit_row(t: PaymentTransaction) -> dict:
    return {
        "id": str(t.id),
        "user_id": t.user_id,
        "username": t.user.username,
        "amount_kes": str(t.amount_kes),
        "status": t.status,
        "phone_number": t.phone_number,
        "order_id": t.order_id,
        "collection_id": t.collection_id,
        "mpesa_reference": t.mpesa_reference,
        "fail_reason": t.fail_reason,
        "created_at": t.created_at.isoformat(),
        "updated_at": t.updated_at.isoformat(),
        "callback_received_at": t.callback_received_at.isoformat() if t.callback_received_at else None,
        "age_hours": round((timezone.now() - t.created_at).total_seconds() / 3600, 1),
    }


@extend_schema(responses={200: OpenApiTypes.OBJECT})
@api_view(["GET"])
@permission_classes(staff("finance.view"))
def deposits(request):
    qs = PaymentTransaction.objects.filter(type="deposit").select_related("user")
    q = (request.query_params.get("q") or "").strip()
    if q:
        cond = (
            Q(mpesa_reference__icontains=q)
            | Q(order_id__icontains=q)
            | Q(collection_id__icontains=q)
            | Q(phone_number__icontains=q)
            | Q(user__username__icontains=q)
            | Q(user__email__icontains=q)
        )
        qs = qs.filter(cond)
    status_param = request.query_params.get("status")
    if status_param == "stuck":
        qs = qs.filter(status__in=["initiated", "pending"], created_at__lt=timezone.now() - timedelta(minutes=15))
    elif status_param in {s for s, _ in PaymentTransaction.STATUS_CHOICES}:
        qs = qs.filter(status=status_param)
    try:
        page = max(1, int(request.query_params.get("page", 1)))
        page_size = max(1, min(200, int(request.query_params.get("page_size", 25))))
    except ValueError:
        return Response({"error": "Invalid pagination parameters"}, status=400)
    total = qs.count()
    rows = qs.order_by("-created_at")[(page - 1) * page_size : page * page_size]
    base = PaymentTransaction.objects.filter(type="deposit")
    return Response(
        {
            "count": total,
            "results": [_deposit_row(t) for t in rows],
            "counts": {
                "pending": base.filter(status__in=["initiated", "pending"]).count(),
                "stuck": base.filter(
                    status__in=["initiated", "pending"], created_at__lt=timezone.now() - timedelta(minutes=15)
                ).count(),
                "failed": base.filter(status__in=["failed", "cancelled"]).count(),
                "completed": base.filter(status="completed").count(),
            },
        }
    )


def _auditlog_entries(model, pk) -> list:
    from auditlog.models import LogEntry
    from django.contrib.contenttypes.models import ContentType

    ct = ContentType.objects.get_for_model(model)
    rows = LogEntry.objects.filter(content_type=ct, object_pk=str(pk)).select_related("actor").order_by("-timestamp")[:50]
    return [
        {
            "id": e.id,
            "action": {0: "create", 1: "update", 2: "delete", 3: "access"}.get(e.action, str(e.action)),
            "changes": e.changes_dict if hasattr(e, "changes_dict") else e.changes,
            "actor": e.actor.username if e.actor_id else None,
            "timestamp": e.timestamp.isoformat(),
        }
        for e in rows
    ]


@extend_schema(responses={200: OpenApiTypes.OBJECT})
@api_view(["GET"])
@permission_classes(staff("finance.view"))
def deposit_detail(request, txn_id):
    t = get_object_or_404(PaymentTransaction.objects.select_related("user"), id=txn_id, type="deposit")
    callbacks = CallbackLog.objects.filter(order_id=t.order_id).order_by("-created_at")[:20]
    credit = WalletTransaction.objects.filter(reference_id=t.order_id).first()
    audit = AuditLog.objects.filter(resource_type="deposit", changes__deposit_id=str(t.id))[:20]
    return Response(
        {
            "deposit": _deposit_row(t),
            "callbacks": [
                {
                    "id": c.id,
                    "type": c.type,
                    "processed": c.processed,
                    "created_at": c.created_at.isoformat(),
                    "payload": c.raw_payload,
                }
                for c in callbacks
            ],
            "wallet_transaction": (
                {"id": credit.id, "amount": str(credit.amount), "balance_after": str(credit.balance_after),
                 "created_at": credit.created_at.isoformat()}
                if credit else None
            ),
            "history": _auditlog_entries(PaymentTransaction, t.id),
            "audit": [
                {"id": a.id, "admin_username": a.admin_username, "action": a.action, "description": a.description,
                 "created_at": a.created_at.isoformat()}
                for a in audit
            ],
        }
    )


@extend_schema(request=None, responses={200: OpenApiTypes.OBJECT, 502: OpenApiTypes.OBJECT})
@api_view(["POST"])
@permission_classes(staff("finance.deposits"))
def deposit_verify(request, txn_id):
    """Ask IntaSend for the deposit's real state and resolve it (credit at most once)."""
    from apps.payments import intasend
    from apps.payments.services import settle_deposit_from_gateway
    from apps.payments.views import _notify_user

    t = get_object_or_404(PaymentTransaction.objects.select_related("user"), id=txn_id, type="deposit")
    if t.status == "completed":
        return Response({"outcome": "already_completed", "deposit": _deposit_row(t)})
    if not t.collection_id:
        return Response(
            {"error": "This deposit never reached IntaSend (no invoice id), so there is nothing to verify."},
            status=409,
        )
    lock_key = f"admin:verify_deposit:{t.id}"
    if not acquire_lock(lock_key, ttl_seconds=30):
        return Response({"error": "Another check of this deposit is in progress."}, status=429)
    try:
        try:
            invoice = intasend.query_collection(t.collection_id) or {}
        except Exception as exc:
            logger.warning("Deposit verify failed | txn=%s: %s", t.id, exc)
            return Response({"error": "Could not reach IntaSend. Try again in a minute."}, status=502)
        before = t.status
        outcome = settle_deposit_from_gateway(t.id, invoice)
    finally:
        release_lock(lock_key)
    t.refresh_from_db()
    if outcome == "credited":
        _notify_user(t.user, "deposit_credited", admin=request.user, amount=t.amount_kes)
    AuditLog.log_action(
        admin=request.user, action="resolve", resource_type="deposit", resource_name=t.user.username,
        description=f"Verified deposit of KES {t.amount_kes} with IntaSend: {outcome.replace('_', ' ')}",
        changes={"deposit_id": str(t.id), "order_id": t.order_id, "gateway_state": invoice.get("state"),
                 "status": {"old": before, "new": t.status}, "outcome": outcome},
        request=request,
    )
    return Response({"outcome": outcome, "gateway_state": invoice.get("state"), "deposit": _deposit_row(t)})


# ── stuck withdrawals ───────────────────────────────────────────────────────


@extend_schema(request=OpenApiTypes.OBJECT, responses={200: OpenApiTypes.OBJECT})
@api_view(["POST"])
@permission_classes(staff("finance.withdrawals"))
def withdrawal_resolve(request, withdrawal_id):
    """Resolve a withdrawal stuck in approved / processing (the gateway's answer never
    arrived). paid: mark completed. failed: mark failed and refund the full amount to
    the wallet through the existing payout-failure refund path."""
    from apps.payments.services import _refund_linked_withdrawal
    from apps.payments.views import _notify_user

    outcome = request.data.get("outcome")
    reason = str(request.data.get("reason") or "").strip()
    mpesa_ref = str(request.data.get("mpesa_reference") or "").strip()[:100]
    if outcome not in ("paid", "failed"):
        return Response({"error": "outcome must be 'paid' or 'failed'"}, status=400)
    if len(reason) < 5:
        return Response({"error": "A reason of at least 5 characters is required."}, status=400)

    with db_transaction.atomic():
        w = get_object_or_404(WithdrawalRequest.objects.select_for_update().select_related("user"), id=withdrawal_id)
        before = w.status
        if w.status not in ("approved", "processing"):
            return Response({"error": f"Only approved or processing withdrawals can be resolved (this one is {w.status})."}, status=409)
        payout = PaymentTransaction.objects.select_for_update().filter(order_id=str(w.id), type="payout").first()
        if outcome == "paid":
            w.status = "completed"
            if mpesa_ref:
                w.mpesa_reference = mpesa_ref
            w.callback_received_at = timezone.now()
            w.save(update_fields=["status", "mpesa_reference", "callback_received_at", "updated_at"])
            if payout and payout.status not in ("completed", "failed"):
                payout.status = "completed"
                if mpesa_ref:
                    payout.mpesa_reference = mpesa_ref
                payout.callback_received_at = timezone.now()
                payout.save(update_fields=["status", "mpesa_reference", "callback_received_at", "updated_at"])
        else:
            fail_reason = f"Resolved by staff: {reason}"[:500]
            if payout is None:
                # Approved but never sent to the gateway: a stand-in record lets the shared
                # refund path run (it refunds the withdrawal it points at).
                payout = PaymentTransaction.objects.create(
                    user=w.user, type="payout", status="failed", amount_kes=w.amount_kes,
                    order_id=str(w.id), tracking_reference=f"RES-{w.id}", phone_number=w.phone_number or "",
                    narration="Withdrawal resolved as failed by staff", fail_reason=fail_reason,
                )
            elif payout.status != "failed":
                payout.status = "failed"
                payout.fail_reason = fail_reason
                payout.save(update_fields=["status", "fail_reason", "updated_at"])
            _refund_linked_withdrawal(payout, fail_reason)
    w.refresh_from_db()
    _notify_user(
        w.user, "withdrawal_completed" if outcome == "paid" else "withdrawal_failed",
        admin=request.user, amount=w.amount_kes, reason="",
    )
    AuditLog.log_action(
        admin=request.user, action="resolve", resource_type="withdrawal", resource_name=w.user.username,
        description=f"Resolved stuck withdrawal of KES {w.amount_kes} as {outcome}"
        + (" (refunded)" if outcome == "failed" else ""),
        changes={"withdrawal_id": str(w.id), "status": {"old": before, "new": w.status}, "outcome": outcome,
                 "reason": reason, "mpesa_reference": mpesa_ref or None},
        request=request,
    )
    return Response({"status": w.status, "withdrawal_id": str(w.id)})


@extend_schema(responses={200: OpenApiTypes.OBJECT})
@api_view(["GET"])
@permission_classes(staff("finance.view"))
def withdrawal_history(request, withdrawal_id):
    w = get_object_or_404(WithdrawalRequest, id=withdrawal_id)
    audit = AuditLog.objects.filter(resource_type="withdrawal", changes__withdrawal_id=str(w.id))[:30]
    return Response(
        {
            "history": _auditlog_entries(WithdrawalRequest, w.id),
            "audit": [
                {"id": a.id, "admin_username": a.admin_username, "action": a.action, "description": a.description,
                 "changes": a.changes, "created_at": a.created_at.isoformat()}
                for a in audit
            ],
        }
    )
