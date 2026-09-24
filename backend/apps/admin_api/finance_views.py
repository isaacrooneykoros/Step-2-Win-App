"""
Read-only finance, reporting and analytics endpoints for the admin console.

Everything here only READS money data. Approval / rejection / payout logic lives
in apps.payments.services and is reached through the existing withdrawal
endpoints in views.py.

Live data model (verified): withdrawals are `payments.WithdrawalRequest`
(created by /api/payments/withdrawal/request/ and /api/wallet/withdraw/).
`wallet.Withdrawal` is a legacy table that nothing writes to any more.
Platform fee revenue is recorded in `payments.PlatformRevenue` when a challenge
is finalised (not as WalletTransaction type="fee").
"""

import csv
from collections import defaultdict
from datetime import date, datetime, timedelta
from decimal import Decimal

from django.contrib.auth import get_user_model
from django.db.models import Count, F, Q, Sum
from django.db.models.functions import TruncDate
from django.http import HttpResponse
from django.shortcuts import get_object_or_404
from django.utils import timezone
from drf_spectacular.utils import OpenApiTypes, extend_schema
from rest_framework import permissions
from rest_framework.decorators import api_view, permission_classes
from rest_framework.response import Response

from apps.admin_api.views import IsAdminUser
from apps.challenges.models import Challenge, Participant
from apps.payments.models import (PaymentTransaction, PlatformRevenue,
                                  WithdrawalRequest)
from apps.steps.models import HealthRecord
from apps.wallet.models import WalletTransaction

User = get_user_model()

ADMIN = [permissions.IsAuthenticated, IsAdminUser]
ZERO = Decimal("0.00")
LEDGER_TYPES = [t for t, _ in WalletTransaction.TYPE_CHOICES]
WITHDRAWAL_STATUSES = [s for s, _ in WithdrawalRequest.STATUS_CHOICES]
MAX_PERIOD_DAYS = 366


# ── helpers ────────────────────────────────────────────────────────────────


def _dec(value) -> str:
    return str((value or ZERO).quantize(Decimal("0.01")))


def _parse_date(value):
    if not value:
        return None
    try:
        return datetime.strptime(value, "%Y-%m-%d").date()
    except (TypeError, ValueError):
        return None


def _int(value, default, lo, hi):
    try:
        n = int(value)
    except (TypeError, ValueError):
        return default
    return max(lo, min(hi, n))


def _period(request, default_days=30):
    """Inclusive local-date period from ?from=&to= or ?days=."""
    today = timezone.localdate()
    date_to = _parse_date(request.query_params.get("to")) or today
    date_from = _parse_date(request.query_params.get("from"))
    if date_from is None:
        days = _int(request.query_params.get("days"), default_days, 1, MAX_PERIOD_DAYS)
        date_from = date_to - timedelta(days=days - 1)
    if date_from > date_to:
        date_from, date_to = date_to, date_from
    if (date_to - date_from).days + 1 > MAX_PERIOD_DAYS:
        date_from = date_to - timedelta(days=MAX_PERIOD_DAYS - 1)
    return date_from, date_to


def _day_range(date_from: date, date_to: date):
    d = date_from
    while d <= date_to:
        yield d
        d += timedelta(days=1)


def _daily(qs, field, amount=None):
    """{date: value} grouped by local date of `field`."""
    rows = (
        qs.annotate(d=TruncDate(field))
        .values("d")
        .annotate(v=Sum(amount) if amount else Count("pk"))
    )
    return {r["d"]: r["v"] or 0 for r in rows}


def _period_meta(date_from, date_to):
    return {
        "from": date_from.isoformat(),
        "to": date_to.isoformat(),
        "days": (date_to - date_from).days + 1,
        "timezone": timezone.get_current_timezone_name(),
    }


def _trust(user):
    ts = _safe_related(user, "trust_score")
    tp = _safe_related(user, "trust_profile")
    return {
        "score": ts.score if ts else None,
        "status": ts.status if ts else None,
        "flags_total": ts.flags_total if ts else None,
        "tier": tp.trust_tier if tp else None,
        "suspicious_sessions": tp.suspicious_sessions_count if tp else None,
        "replay_attempts": tp.replay_attempts_count if tp else None,
    }


def _safe_related(user, attr):
    try:
        return getattr(user, attr)
    except Exception:
        return None


def _withdrawal_row(w):
    return {
        "id": str(w.id),
        "user_id": w.user_id,
        "username": w.user.username,
        "email": w.user.email,
        "phone": w.user.phone_number,
        "amount_kes": _dec(w.amount_kes),
        "method": w.method,
        "destination": w.destination_display,
        "phone_number": w.phone_number,
        "bank_name": w.bank_name,
        "account_number": w.account_number,
        "short_code": w.short_code,
        "status": w.status,
        "tracking_reference": w.tracking_reference or "",
        "mpesa_reference": w.mpesa_reference or "",
        "fail_reason": w.fail_reason or "",
        "rejection_reason": w.rejection_reason or "",
        "reviewed_by": w.reviewed_by.username if w.reviewed_by_id else None,
        "reviewed_at": w.reviewed_at.isoformat() if w.reviewed_at else None,
        "callback_received_at": (
            w.callback_received_at.isoformat() if w.callback_received_at else None
        ),
        "created_at": w.created_at.isoformat(),
        "updated_at": w.updated_at.isoformat(),
        "age_hours": round((timezone.now() - w.created_at).total_seconds() / 3600, 1),
    }


# ── withdrawals ────────────────────────────────────────────────────────────


@extend_schema(responses={200: OpenApiTypes.OBJECT})
@api_view(["GET"])
@permission_classes(ADMIN)
def finance_withdrawals(request):
    """
    Withdrawal requests with filters, for the review queue and history.

    ?status=pending_review | failed,rejected | all   (default pending_review)
    ?q= username / email / phone / destination / id prefix
    ?method=mpesa|bank|paybill  ?from=YYYY-MM-DD ?to=YYYY-MM-DD (created date)
    ?limit= (1-200, default 50) ?offset=
    Pending review is ordered oldest first; everything else newest first.
    """
    p = request.query_params
    qs = WithdrawalRequest.objects.select_related("user", "reviewed_by")

    raw_status = (p.get("status") or "pending_review").strip()
    statuses = [s for s in raw_status.split(",") if s in WITHDRAWAL_STATUSES]
    if raw_status != "all":
        qs = qs.filter(status__in=statuses or ["pending_review"])

    method = p.get("method")
    if method in ("mpesa", "bank", "paybill"):
        qs = qs.filter(method=method)

    q = (p.get("q") or "").strip()
    if q:
        cond = (
            Q(user__username__icontains=q)
            | Q(user__email__icontains=q)
            | Q(phone_number__icontains=q)
            | Q(account_number__icontains=q)
            | Q(short_code__icontains=q)
            | Q(tracking_reference__icontains=q)
            | Q(mpesa_reference__icontains=q)
        )
        compact = q.replace("-", "").lower()
        if len(compact) >= 6 and all(c in "0123456789abcdef" for c in compact):
            cond |= Q(id__startswith=compact)
        qs = qs.filter(cond)

    date_from = _parse_date(p.get("from"))
    date_to = _parse_date(p.get("to"))
    if date_from:
        qs = qs.filter(created_at__date__gte=date_from)
    if date_to:
        qs = qs.filter(created_at__date__lte=date_to)

    only_pending = raw_status == "pending_review"
    qs = qs.order_by("created_at" if only_pending else "-created_at")

    totals = qs.aggregate(count=Count("id"), amount=Sum("amount_kes"))
    limit = _int(p.get("limit"), 50, 1, 200)
    offset = _int(p.get("offset"), 0, 0, 10**9)
    rows = [_withdrawal_row(w) for w in qs[offset : offset + limit]]

    return Response(
        {
            "count": totals["count"] or 0,
            "total_amount_kes": _dec(totals["amount"]),
            "limit": limit,
            "offset": offset,
            "results": rows,
        }
    )


@extend_schema(responses={200: OpenApiTypes.OBJECT, 404: OpenApiTypes.OBJECT})
@api_view(["GET"])
@permission_classes(ADMIN)
def finance_withdrawal_detail(request, withdrawal_id):
    """One withdrawal plus the context an operator needs to decide on it."""
    from apps.steps.models import FraudFlag

    w = get_object_or_404(
        WithdrawalRequest.objects.select_related("user", "reviewed_by"),
        id=withdrawal_id,
    )
    user = w.user

    previous = (
        WithdrawalRequest.objects.filter(user=user)
        .exclude(id=w.id)
        .select_related("user", "reviewed_by")
        .order_by("-created_at")[:10]
    )
    by_status = {
        r["status"]: {"count": r["c"], "amount_kes": _dec(r["t"])}
        for r in WithdrawalRequest.objects.filter(user=user)
        .values("status")
        .annotate(c=Count("id"), t=Sum("amount_kes"))
    }

    ledger = WalletTransaction.objects.filter(user=user)
    ledger_totals = {
        r["type"]: {"count": r["c"], "amount_kes": _dec(r["t"])}
        for r in ledger.values("type").annotate(c=Count("id"), t=Sum("amount"))
    }
    last_tx = ledger.order_by("-created_at", "-id").first()
    first_deposit = ledger.filter(type="deposit").order_by("created_at").first()

    flags = FraudFlag.objects.filter(user=user)
    open_flags = flags.filter(reviewed=False)
    recent_flags = [
        {
            "id": f.id,
            "flag_type": f.flag_type,
            "severity": f.severity,
            "reviewed": f.reviewed,
            "created_at": f.created_at.isoformat(),
        }
        for f in flags.order_by("-created_at")[:5]
    ]

    payout = (
        PaymentTransaction.objects.filter(type="payout", order_id=str(w.id))
        .order_by("-created_at")
        .first()
    )

    return Response(
        {
            "withdrawal": _withdrawal_row(w),
            "user": {
                "id": user.id,
                "username": user.username,
                "email": user.email,
                "phone_number": user.phone_number,
                "is_active": user.is_active,
                "joined_at": (user.created_at or user.date_joined).isoformat(),
                "wallet_balance": _dec(user.wallet_balance),
                "locked_balance": _dec(user.locked_balance),
                "total_earned": _dec(user.total_earned),
                "challenges_joined": user.challenges_joined,
                "challenges_won": user.challenges_won,
            },
            "trust": {
                **_trust(user),
                "open_flags": open_flags.count(),
                "open_high_or_critical": open_flags.filter(
                    severity__in=["high", "critical"]
                ).count(),
                "recent_flags": recent_flags,
            },
            "history": {
                "by_status": by_status,
                "previous": [_withdrawal_row(p) for p in previous],
            },
            "ledger": {
                "totals_by_type": ledger_totals,
                "entries": ledger.count(),
                "last_balance_after": _dec(last_tx.balance_after) if last_tx else None,
                "last_entry_at": last_tx.created_at.isoformat() if last_tx else None,
                "first_deposit_at": (
                    first_deposit.created_at.isoformat() if first_deposit else None
                ),
            },
            "payout_transaction": (
                {
                    "id": str(payout.id),
                    "status": payout.status,
                    "tracking_reference": payout.tracking_reference or "",
                    "mpesa_reference": payout.mpesa_reference or "",
                    "fail_reason": payout.fail_reason or "",
                    "created_at": payout.created_at.isoformat(),
                    "updated_at": payout.updated_at.isoformat(),
                }
                if payout
                else None
            ),
        }
    )


# ── ledger ─────────────────────────────────────────────────────────────────


def _ledger_queryset(request):
    p = request.query_params
    qs = WalletTransaction.objects.select_related("user")

    types = [t for t in (p.get("type") or "").split(",") if t in LEDGER_TYPES]
    if types:
        qs = qs.filter(type__in=types)

    direction = p.get("direction")
    if direction == "credit":
        qs = qs.filter(amount__gt=0)
    elif direction == "debit":
        qs = qs.filter(amount__lt=0)

    user_id = p.get("user_id")
    if user_id and str(user_id).isdigit():
        qs = qs.filter(user_id=int(user_id))
    user_q = (p.get("user") or "").strip()
    if user_q:
        qs = qs.filter(
            Q(user__username__icontains=user_q)
            | Q(user__email__icontains=user_q)
            | Q(user__phone_number__icontains=user_q)
        )

    ref = (p.get("q") or "").strip()
    if ref:
        qs = qs.filter(Q(reference_id__icontains=ref) | Q(description__icontains=ref))

    date_from = _parse_date(p.get("from"))
    date_to = _parse_date(p.get("to"))
    if date_from:
        qs = qs.filter(created_at__date__gte=date_from)
    if date_to:
        qs = qs.filter(created_at__date__lte=date_to)

    ordering = p.get("ordering")
    allowed = {
        "created_at": ("created_at", "id"),
        "-created_at": ("-created_at", "-id"),
        "amount": ("amount", "id"),
        "-amount": ("-amount", "-id"),
    }
    return qs.order_by(*allowed.get(ordering, ("-created_at", "-id")))


def _ledger_row(t):
    return {
        "id": t.id,
        "user": t.user_id,
        "user_username": t.user.username if t.user_id else None,
        "type": t.type,
        "amount": _dec(t.amount),
        "balance_before": _dec(t.balance_before),
        "balance_after": _dec(t.balance_after),
        "description": t.description,
        "reference_id": t.reference_id,
        "metadata": t.metadata,
        "created_at": t.created_at.isoformat(),
        "arithmetic_ok": (t.balance_before or ZERO) + (t.amount or ZERO)
        == (t.balance_after or ZERO),
    }


@extend_schema(responses={200: OpenApiTypes.OBJECT})
@api_view(["GET"])
@permission_classes(ADMIN)
def finance_ledger(request):
    """
    Wallet ledger (WalletTransaction) with server-side filters and totals for
    the whole filtered set. ?type=a,b ?direction=credit|debit ?user= ?user_id=
    ?q= (reference/description) ?from= ?to= ?ordering= ?limit= ?offset=
    """
    qs = _ledger_queryset(request)
    agg = qs.aggregate(
        count=Count("id"),
        credits=Sum("amount", filter=Q(amount__gt=0)),
        debits=Sum("amount", filter=Q(amount__lt=0)),
        net=Sum("amount"),
        users=Count("user", distinct=True),
    )
    by_type = {
        r["type"]: {"count": r["c"], "amount": _dec(r["t"])}
        for r in qs.order_by().values("type").annotate(c=Count("id"), t=Sum("amount"))
    }
    limit = _int(request.query_params.get("limit"), 50, 1, 200)
    offset = _int(request.query_params.get("offset"), 0, 0, 10**9)
    return Response(
        {
            "count": agg["count"] or 0,
            "limit": limit,
            "offset": offset,
            "totals": {
                "credits": _dec(agg["credits"]),
                "debits": _dec(agg["debits"]),
                "net": _dec(agg["net"]),
                "users": agg["users"] or 0,
                "by_type": by_type,
            },
            "results": [_ledger_row(t) for t in qs[offset : offset + limit]],
        }
    )


@extend_schema(responses={(200, "text/csv"): OpenApiTypes.STR})
@api_view(["GET"])
@permission_classes(ADMIN)
def finance_ledger_export(request):
    """CSV of the filtered ledger (max 50,000 rows)."""
    qs = _ledger_queryset(request)[:50000]
    stamp = timezone.localtime().strftime("%Y%m%d-%H%M")
    response = HttpResponse(content_type="text/csv; charset=utf-8")
    response["Content-Disposition"] = f'attachment; filename="step2win-ledger-{stamp}.csv"'
    writer = csv.writer(response)
    writer.writerow(
        [
            "id",
            "created_at",
            "user_id",
            "username",
            "type",
            "amount_kes",
            "balance_before_kes",
            "balance_after_kes",
            "reference_id",
            "description",
        ]
    )
    for t in qs.iterator(chunk_size=2000):
        writer.writerow(
            [
                t.id,
                timezone.localtime(t.created_at).isoformat(),
                t.user_id or "",
                t.user.username if t.user_id else "",
                t.type,
                _dec(t.amount),
                _dec(t.balance_before),
                _dec(t.balance_after),
                t.reference_id or "",
                # Neutralise spreadsheet formulas in free text.
                ("'" + t.description) if t.description[:1] in "=+-@" else t.description,
            ]
        )
    return response


# ── financial report ───────────────────────────────────────────────────────


def _reconciliation():
    """Point-in-time integrity checks. Each check states what it compares."""
    checks = []

    broken_chain = WalletTransaction.objects.exclude(
        balance_after=F("balance_before") + F("amount")
    )
    checks.append(
        {
            "key": "ledger_arithmetic",
            "label": "Ledger rows where before + amount = after",
            "description": "Every wallet ledger row should balance on its own.",
            "ok": not broken_chain.exists(),
            "value": broken_chain.count(),
            "unit": "rows failing",
        }
    )

    # Wallet balance vs the last ledger balance_after, per user with ledger rows.
    mismatches = []
    latest = {}
    for row in (
        WalletTransaction.objects.filter(user__isnull=False)
        .order_by("user_id", "-created_at", "-id")
        .values("user_id", "balance_after")
    ):
        latest.setdefault(row["user_id"], row["balance_after"])
    in_flight = {
        r["user_id"]: r["t"] or ZERO
        for r in WithdrawalRequest.objects.filter(
            status__in=["pending_review", "approved", "processing", "completed"]
        )
        .values("user_id")
        .annotate(t=Sum("amount_kes"))
    }
    for u in User.objects.filter(id__in=latest.keys()).only(
        "id", "username", "wallet_balance"
    ):
        ledger_bal = latest[u.id] or ZERO
        if (u.wallet_balance or ZERO) != ledger_bal:
            mismatches.append(
                {
                    "user_id": u.id,
                    "username": u.username,
                    "wallet_balance": _dec(u.wallet_balance),
                    "ledger_balance": _dec(ledger_bal),
                    "difference": _dec((u.wallet_balance or ZERO) - ledger_bal),
                    "withdrawal_requests_kes": _dec(in_flight.get(u.id)),
                }
            )
    mismatches.sort(key=lambda m: abs(Decimal(m["difference"])), reverse=True)
    checks.append(
        {
            "key": "wallet_vs_ledger",
            "label": "Wallet balance matches last ledger entry",
            "description": (
                "Compares each user's wallet balance with the balance_after of their "
                "latest ledger row. Withdrawal requests and their rejection refunds "
                "change the wallet without a ledger row, so a difference equal to "
                "withdrawal amounts is explained by that."
            ),
            "ok": not mismatches,
            "value": len(mismatches),
            "unit": "users differ",
            "rows": mismatches[:25],
        }
    )

    negative = User.objects.filter(wallet_balance__lt=0).count()
    checks.append(
        {
            "key": "negative_balances",
            "label": "No negative wallet balances",
            "description": "Users whose wallet balance is below zero.",
            "ok": negative == 0,
            "value": negative,
            "unit": "users",
        }
    )

    # Pools of open challenges vs entry fee × participants (+ platform bonus).
    pool_mismatch = []
    for c in Challenge.objects.filter(status__in=["pending", "active"]).annotate(
        n=Count("participants")
    ):
        expected = (c.entry_fee or ZERO) * c.n
        if c.total_pool not in (expected, expected + (c.platform_bonus_kes or ZERO)):
            pool_mismatch.append(
                {
                    "challenge_id": c.id,
                    "name": c.name,
                    "participants": c.n,
                    "entry_fee": _dec(c.entry_fee),
                    "total_pool": _dec(c.total_pool),
                    "expected_pool": _dec(expected),
                }
            )
    checks.append(
        {
            "key": "pool_integrity",
            "label": "Open challenge pools = entry fee × participants",
            "description": "Pending and active challenges; a platform bonus is allowed on top.",
            "ok": not pool_mismatch,
            "value": len(pool_mismatch),
            "unit": "challenges differ",
            "rows": pool_mismatch[:25],
        }
    )

    locked_total = User.objects.aggregate(t=Sum("locked_balance"))["t"] or ZERO
    open_entries = Participant.objects.filter(
        challenge__status__in=["pending", "active"]
    ).aggregate(t=Sum("challenge__entry_fee"))["t"] or ZERO
    checks.append(
        {
            "key": "locked_vs_entries",
            "label": "Locked balances = open challenge entries",
            "description": (
                "Sum of users' locked balance vs sum of entry fees in pending and "
                "active challenges."
            ),
            "ok": locked_total == open_entries,
            "value": _dec(locked_total - open_entries),
            "unit": "KSh difference",
            "detail": {
                "locked_total": _dec(locked_total),
                "open_entries_total": _dec(open_entries),
            },
        }
    )

    stale = timezone.now() - timedelta(hours=1)
    stuck = PaymentTransaction.objects.filter(
        status__in=["initiated", "pending"], created_at__lt=stale
    )
    checks.append(
        {
            "key": "stuck_payments",
            "label": "No gateway payments pending over 1 hour",
            "description": "Deposits or payouts still initiated/pending after an hour.",
            "ok": not stuck.exists(),
            "value": stuck.count(),
            "unit": "payments",
        }
    )

    stuck_w = WithdrawalRequest.objects.filter(
        status__in=["approved", "processing"], updated_at__lt=stale
    )
    checks.append(
        {
            "key": "stuck_withdrawals",
            "label": "No approved withdrawals stuck over 1 hour",
            "description": "Approved or processing withdrawals with no gateway result after an hour.",
            "ok": not stuck_w.exists(),
            "value": stuck_w.count(),
            "unit": "withdrawals",
        }
    )
    return checks


@extend_schema(responses={200: OpenApiTypes.OBJECT})
@api_view(["GET"])
@permission_classes(ADMIN)
def finance_report(request):
    """Financial report for a period: revenue, flows, withdrawals, pools, checks."""
    date_from, date_to = _period(request, 30)
    in_period = {"created_at__date__gte": date_from, "created_at__date__lte": date_to}

    ledger = WalletTransaction.objects.filter(**in_period)
    ledger_by_type = {
        r["type"]: {"count": r["c"], "amount": r["t"] or ZERO}
        for r in ledger.values("type").annotate(c=Count("id"), t=Sum("amount"))
    }

    def lt(kind):
        row = ledger_by_type.get(kind, {"count": 0, "amount": ZERO})
        return {"count": row["count"], "amount_kes": _dec(abs(row["amount"]))}

    revenue_qs = PlatformRevenue.objects.filter(
        collected_at__date__gte=date_from, collected_at__date__lte=date_to
    )
    revenue = revenue_qs.aggregate(t=Sum("amount_kes"), c=Count("id"))
    top_fees = [
        {
            "challenge_id": r.challenge_id,
            "challenge": r.challenge.name,
            "amount_kes": _dec(r.amount_kes),
            "total_pool": (r.metadata or {}).get("total_pool"),
            "collected_at": r.collected_at.isoformat(),
        }
        for r in revenue_qs.select_related("challenge").order_by("-amount_kes")[:10]
    ]

    gateway = {
        f'{r["type"]}:{r["status"]}': {"count": r["c"], "amount_kes": _dec(r["t"])}
        for r in PaymentTransaction.objects.filter(**in_period)
        .values("type", "status")
        .annotate(c=Count("id"), t=Sum("amount_kes"))
    }

    wr = WithdrawalRequest.objects.filter(**in_period)
    withdrawals_by_status = {
        s: {"count": 0, "amount_kes": "0.00"} for s in WITHDRAWAL_STATUSES
    }
    for r in wr.values("status").annotate(c=Count("id"), t=Sum("amount_kes")):
        withdrawals_by_status[r["status"]] = {"count": r["c"], "amount_kes": _dec(r["t"])}
    paid_qs = WithdrawalRequest.objects.filter(
        status="completed",
        updated_at__date__gte=date_from,
        updated_at__date__lte=date_to,
    )
    paid = paid_qs.aggregate(t=Sum("amount_kes"), c=Count("id"))

    finalised = Challenge.objects.filter(
        status="completed", updated_at__date__gte=date_from, updated_at__date__lte=date_to
    ).aggregate(t=Sum("total_pool"), c=Count("id"))
    open_pools = Challenge.objects.filter(status__in=["pending", "active"]).aggregate(
        t=Sum("total_pool"), c=Count("id")
    )
    cancelled = Challenge.objects.filter(
        status="cancelled", updated_at__date__gte=date_from, updated_at__date__lte=date_to
    ).aggregate(t=Sum("total_pool"), c=Count("id"))

    deposits_d = _daily(ledger.filter(type="deposit"), "created_at", "amount")
    entries_d = _daily(ledger.filter(type="challenge_entry"), "created_at", "amount")
    payouts_d = _daily(ledger.filter(type="payout"), "created_at", "amount")
    refunds_d = _daily(ledger.filter(type="refund"), "created_at", "amount")
    requested_d = _daily(wr, "created_at", "amount_kes")
    paid_d = _daily(paid_qs, "updated_at", "amount_kes")
    fees_d = _daily(revenue_qs, "collected_at", "amount_kes")

    daily = [
        {
            "date": d.isoformat(),
            "deposits": float(abs(deposits_d.get(d, 0))),
            "withdrawals_requested": float(requested_d.get(d, 0)),
            "withdrawals_paid": float(paid_d.get(d, 0)),
            "entries": float(abs(entries_d.get(d, 0))),
            "payouts": float(abs(payouts_d.get(d, 0))),
            "refunds": float(abs(refunds_d.get(d, 0))),
            "fees": float(fees_d.get(d, 0)),
        }
        for d in _day_range(date_from, date_to)
    ]

    deposits_total = abs(ledger_by_type.get("deposit", {}).get("amount", ZERO))
    return Response(
        {
            "period": _period_meta(date_from, date_to),
            "revenue": {
                "platform_fees_kes": _dec(revenue["t"]),
                "fee_records": revenue["c"] or 0,
                "top_challenges": top_fees,
            },
            "ledger": {kind: lt(kind) for kind in LEDGER_TYPES},
            "gateway": gateway,
            "withdrawals": {
                "requested_by_status": withdrawals_by_status,
                "paid_kes": _dec(paid["t"]),
                "paid_count": paid["c"] or 0,
            },
            "net_cash_kes": _dec(deposits_total - (paid["t"] or ZERO)),
            "pools": {
                "finalised_kes": _dec(finalised["t"]),
                "finalised_count": finalised["c"] or 0,
                "cancelled_kes": _dec(cancelled["t"]),
                "cancelled_count": cancelled["c"] or 0,
                "open_kes": _dec(open_pools["t"]),
                "open_count": open_pools["c"] or 0,
            },
            "daily": daily,
            "reconciliation": _reconciliation(),
            "generated_at": timezone.now().isoformat(),
        }
    )


# ── product analytics ──────────────────────────────────────────────────────

STEP_BUCKETS = [
    (0, 2000, "Under 2k"),
    (2000, 5000, "2k–5k"),
    (5000, 8000, "5k–8k"),
    (8000, 10000, "8k–10k"),
    (10000, 15000, "10k–15k"),
    (15000, None, "15k+"),
]


@extend_schema(responses={200: OpenApiTypes.OBJECT})
@api_view(["GET"])
@permission_classes(ADMIN)
def finance_analytics(request):
    """
    Product analytics for a period: users, walking activity, retention cohorts,
    steps, challenges and paying users. "Active" = synced at least 1 step that day.
    """
    date_from, date_to = _period(request, 30)
    days = (date_to - date_from).days + 1

    # Per user-day steps (sources summed).
    user_days = (
        HealthRecord.objects.filter(date__gte=date_from - timedelta(days=29), date__lte=date_to)
        .values("user_id", "date")
        .annotate(s=Sum("steps"))
        .filter(s__gt=0)
    )
    active_by_day = defaultdict(set)
    steps_by_day = defaultdict(int)
    buckets = [0] * len(STEP_BUCKETS)
    for r in user_days:
        active_by_day[r["date"]].add(r["user_id"])
        if date_from <= r["date"] <= date_to:
            steps_by_day[r["date"]] += r["s"]
            for i, (lo, hi, _) in enumerate(STEP_BUCKETS):
                if r["s"] >= lo and (hi is None or r["s"] < hi):
                    buckets[i] += 1
                    break

    signups = _daily(
        User.objects.filter(created_at__date__gte=date_from, created_at__date__lte=date_to),
        "created_at",
    )
    joins = _daily(
        Participant.objects.filter(
            joined_at__date__gte=date_from, joined_at__date__lte=date_to
        ),
        "joined_at",
    )
    created = _daily(
        Challenge.objects.filter(
            created_at__date__gte=date_from, created_at__date__lte=date_to
        ),
        "created_at",
    )

    daily = []
    for d in _day_range(date_from, date_to):
        dau = len(active_by_day.get(d, ()))
        mau_set = set()
        for k in range(30):
            mau_set |= active_by_day.get(d - timedelta(days=k), set())
        daily.append(
            {
                "date": d.isoformat(),
                "signups": signups.get(d, 0),
                "active_users": dau,
                "active_30d": len(mau_set),
                "steps": steps_by_day.get(d, 0),
                "avg_steps_per_active": round(steps_by_day.get(d, 0) / dau) if dau else 0,
                "challenge_joins": joins.get(d, 0),
                "challenges_created": created.get(d, 0),
            }
        )

    period_active = set()
    for d in _day_range(date_from, date_to):
        period_active |= active_by_day.get(d, set())
    last7 = set()
    for k in range(7):
        last7 |= active_by_day.get(date_to - timedelta(days=k), set())
    last30 = set()
    for k in range(30):
        last30 |= active_by_day.get(date_to - timedelta(days=k), set())
    dau_values = [row["active_users"] for row in daily]

    # Weekly signup cohorts: % of cohort active (≥1 step) in each week after signup.
    cohort_start = date_to - timedelta(days=7 * 8 - 1)
    cohort_users = defaultdict(list)
    for u in User.objects.filter(
        created_at__date__gte=cohort_start, created_at__date__lte=date_to
    ).values("id", "created_at"):
        signup_day = timezone.localtime(u["created_at"]).date()
        week_idx = (signup_day - cohort_start).days // 7
        cohort_users[week_idx].append((u["id"], signup_day))
    activity = defaultdict(set)
    for r in (
        HealthRecord.objects.filter(date__gte=cohort_start, date__lte=date_to, steps__gt=0)
        .values("user_id", "date")
        .distinct()
    ):
        activity[r["user_id"]].add(r["date"])
    cohorts = []
    for week_idx in range(8):
        week_start = cohort_start + timedelta(days=7 * week_idx)
        members = cohort_users.get(week_idx, [])
        weeks_available = (date_to - week_start).days // 7 + 1
        retention = []
        for w in range(weeks_available):
            if not members:
                retention.append(None)
                continue
            retained = 0
            for uid, signup_day in members:
                lo = signup_day + timedelta(days=7 * w)
                hi = lo + timedelta(days=6)
                if any(lo <= d <= hi for d in activity.get(uid, ())):
                    retained += 1
            retention.append(round(retained / len(members) * 100, 1))
        cohorts.append(
            {
                "week_start": week_start.isoformat(),
                "size": len(members),
                "retention_pct": retention,
            }
        )

    ch_period = Challenge.objects.filter(
        created_at__date__gte=date_from, created_at__date__lte=date_to
    )
    status_counts = {s: 0 for s, _ in Challenge.STATUS_CHOICES}
    for r in ch_period.values("status").annotate(c=Count("id")):
        status_counts[r["status"]] = r["c"]
    finished = Participant.objects.filter(
        challenge__status="completed",
        challenge__updated_at__date__gte=date_from,
        challenge__updated_at__date__lte=date_to,
    ).aggregate(n=Count("id"), q=Count("id", filter=Q(qualified=True)))
    joiners = (
        Participant.objects.filter(joined_at__date__gte=date_from, joined_at__date__lte=date_to)
        .values("user_id")
        .distinct()
        .count()
    )
    new_users = User.objects.filter(
        created_at__date__gte=date_from, created_at__date__lte=date_to
    )
    new_count = new_users.count()
    new_joined = (
        Participant.objects.filter(user__in=new_users).values("user_id").distinct().count()
    )
    depositors = (
        WalletTransaction.objects.filter(
            type="deposit", created_at__date__gte=date_from, created_at__date__lte=date_to
        )
        .values("user_id")
        .distinct()
        .count()
    )
    fee_stats = ch_period.aggregate(
        avg_fee=Sum("entry_fee"), n=Count("id"), pool=Sum("total_pool")
    )
    participants_in_period = Participant.objects.filter(challenge__in=ch_period).count()

    return Response(
        {
            "period": _period_meta(date_from, date_to),
            "users": {
                "total": User.objects.count(),
                "new": new_count,
                "active_in_period": len(period_active),
                "active_last_7d": len(last7),
                "active_last_30d": len(last30),
                "avg_daily_active": round(sum(dau_values) / days, 1) if days else 0,
                "stickiness_pct": (
                    round((sum(dau_values) / days) / len(last30) * 100, 1)
                    if last30 and days
                    else None
                ),
            },
            "steps": {
                "total": sum(steps_by_day.values()),
                "user_days": sum(buckets),
                "avg_per_active_day": (
                    round(sum(steps_by_day.values()) / sum(buckets)) if sum(buckets) else 0
                ),
                "distribution": [
                    {"label": label, "user_days": buckets[i]}
                    for i, (_, _, label) in enumerate(STEP_BUCKETS)
                ],
            },
            "challenges": {
                "created": fee_stats["n"] or 0,
                "status": status_counts,
                "joins": sum(joins.values()),
                "unique_joiners": joiners,
                "avg_participants": (
                    round(participants_in_period / fee_stats["n"], 1) if fee_stats["n"] else 0
                ),
                "avg_entry_fee_kes": (
                    _dec(fee_stats["avg_fee"] / fee_stats["n"]) if fee_stats["n"] else None
                ),
                "finished_participants": finished["n"] or 0,
                "qualified_participants": finished["q"] or 0,
                "qualification_rate_pct": (
                    round(finished["q"] / finished["n"] * 100, 1) if finished["n"] else None
                ),
            },
            "money": {
                "depositors": depositors,
                "new_users_joined_challenge": new_joined,
                "new_user_join_rate_pct": (
                    round(new_joined / new_count * 100, 1) if new_count else None
                ),
            },
            "daily": daily,
            "cohorts": cohorts,
            "generated_at": timezone.now().isoformat(),
        }
    )
