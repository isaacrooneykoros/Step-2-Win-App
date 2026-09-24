"""Read-side helpers for the admin console (users, steps, challenges, audit).

Kept out of views.py so the viewsets only gain thin, testable entry points.
Nothing here moves money or changes anti-cheat decisions: these helpers filter,
aggregate and serialise existing records for staff.
"""

from datetime import date as date_cls
from datetime import timedelta
from decimal import Decimal

from django.contrib.auth import get_user_model
from django.db.models import Count, Max, Q, Sum, Value
from django.db.models.functions import Coalesce
from django.utils import timezone
from rest_framework.pagination import PageNumberPagination

User = get_user_model()


class AdminPageNumberPagination(PageNumberPagination):
    """Page-number pagination that lets the console pick its page size."""

    page_size = 25
    page_size_query_param = "page_size"
    max_page_size = 200


# ── Users ────────────────────────────────────────────────────────────────────

# TrustScore.status thresholds (score > 80 GOOD, > 60 WARN, > 40 REVIEW,
# > 20 RESTRICT, > 0 SUSPEND, else BAN). Users without a row are treated as 100.
TRUST_RANGES = {
    "good": Q(trust_value__gt=80),
    "warn": Q(trust_value__gt=60, trust_value__lte=80),
    "review": Q(trust_value__gt=40, trust_value__lte=60),
    "restrict": Q(trust_value__gt=20, trust_value__lte=40),
    "suspend": Q(trust_value__gt=0, trust_value__lte=20),
    "ban": Q(trust_value__lte=0),
}

USER_ORDERING = {
    "username",
    "date_joined",
    "last_login",
    "wallet_balance",
    "locked_balance",
    "total_steps",
    "trust_value",
    "last_seen_at",
    "open_flags",
}


def annotate_users(qs):
    return qs.select_related("trust_score").annotate(
        trust_value=Coalesce("trust_score__score", Value(100)),
        open_flags=Count(
            "fraud_flags", filter=Q(fraud_flags__reviewed=False), distinct=True
        ),
        last_seen_at=Max("device_sessions__last_active_at"),
    )


def filter_users(qs, params):
    """Apply console list filters: search, status, trust, ordering."""
    qs = annotate_users(qs)

    search = (params.get("search") or "").strip()
    if search:
        cond = (
            Q(username__icontains=search)
            | Q(email__icontains=search)
            | Q(phone_number__icontains=search)
        )
        if search.isdigit():
            cond |= Q(id=int(search))
        qs = qs.filter(cond)

    status = params.get("status")
    if status == "active":
        qs = qs.filter(is_active=True)
    elif status == "banned":
        qs = qs.filter(is_active=False, deleted_at__isnull=True)
    elif status == "deleted":
        qs = qs.filter(deleted_at__isnull=False)
    elif status == "staff":
        qs = qs.filter(is_staff=True)

    trust = params.get("trust")
    if trust == "flagged":
        qs = qs.filter(open_flags__gt=0)
    elif trust in TRUST_RANGES:
        qs = qs.filter(TRUST_RANGES[trust])

    ordering = params.get("ordering") or "-date_joined"
    field = ordering.lstrip("-")
    if field not in USER_ORDERING:
        ordering, field = "-date_joined", "date_joined"
    if field in {"last_login", "last_seen_at"}:
        # Never-seen users go last whichever direction is chosen.
        from django.db.models import F

        expr = F(field).desc(nulls_last=True) if ordering.startswith("-") else F(field).asc(nulls_last=True)
        return qs.order_by(expr, "-id")
    return qs.order_by(ordering, "-id")


def trust_fields(user):
    """Trust score + status for a user; users without a TrustScore row score 100."""
    trust = getattr(user, "trust_score", None) if _has_trust(user) else None
    score = trust.score if trust else 100
    return score, _trust_status(score)


def _has_trust(user):
    from apps.steps.models import TrustScore

    try:
        return user.trust_score is not None
    except TrustScore.DoesNotExist:
        return False


def _trust_status(score):
    if score > 80:
        return "GOOD"
    if score > 60:
        return "WARN"
    if score > 40:
        return "REVIEW"
    if score > 20:
        return "RESTRICT"
    if score > 0:
        return "SUSPEND"
    return "BAN"


def _money(value):
    return str((value or Decimal("0")).quantize(Decimal("0.01")))


def user_overview(user):
    """Everything the console's user drawer shows, in one payload."""
    from apps.admin_api.models import AuditLog, SupportTicket
    from apps.challenges.models import Participant
    from apps.payments.models import WithdrawalRequest
    from apps.steps.models import (DeviceRegistration, FraudFlag, HealthRecord,
                                   StepSyncEvent, UserTrustProfile)
    from apps.users.models import DeviceSession
    from apps.wallet.models import WalletTransaction

    today = timezone.localdate()
    since = today - timedelta(days=29)

    txns = WalletTransaction.objects.filter(user=user)
    deposited = txns.filter(type="deposit").aggregate(t=Sum("amount"))["t"]
    withdrawn = txns.filter(type="withdrawal").aggregate(t=Sum("amount"))["t"]

    score, status = trust_fields(user)
    trust_row = user.trust_score if _has_trust(user) else None
    profile = UserTrustProfile.objects.filter(user=user).first()

    records = {
        r.date: r
        for r in HealthRecord.objects.filter(user=user, date__gte=since, date__lte=today)
    }
    steps_days = []
    for i in range(30):
        d = since + timedelta(days=i)
        r = records.get(d)
        steps_days.append(
            {
                "date": d.isoformat(),
                "steps": r.steps if r else 0,
                "source": r.source if r else None,
                "is_suspicious": bool(r and r.is_suspicious),
                "synced_at": r.synced_at if r else None,
            }
        )

    participations = (
        Participant.objects.filter(user=user)
        .select_related("challenge")
        .order_by("-joined_at")[:50]
    )

    return {
        "wallet": {
            "wallet_balance": _money(user.wallet_balance),
            "available_balance": _money(user.available_balance),
            "locked_balance": _money(user.locked_balance),
            "total_deposited": _money(deposited),
            "total_withdrawn": _money(abs(withdrawn or Decimal("0"))),
            "total_earned": _money(user.total_earned),
        },
        "trust": {
            "score": score,
            "status": status,
            "flags_total": trust_row.flags_total if trust_row else 0,
            "updated_at": trust_row.updated_at if trust_row else None,
            "profile": (
                {
                    "trust_score": round(profile.trust_score, 1),
                    "trust_tier": profile.trust_tier,
                    "verified_sessions_count": profile.verified_sessions_count,
                    "suspicious_sessions_count": profile.suspicious_sessions_count,
                    "replay_attempts_count": profile.replay_attempts_count,
                    "total_accepted_steps": profile.total_accepted_steps,
                    "total_rejected_steps": profile.total_rejected_steps,
                    "last_suspicious_at": profile.last_suspicious_at,
                }
                if profile
                else None
            ),
        },
        "activity": {
            "daily_goal": user.daily_goal,
            "best_day_steps": user.best_day_steps,
            "current_streak": user.current_streak,
            "best_streak": user.best_streak,
            "days": steps_days,
            "syncs": [
                {
                    "id": str(e.id),
                    "created_at": e.created_at,
                    "steps_delta": e.steps_delta,
                    "accepted": e.accepted,
                    "replay_detected": e.replay_detected,
                    "signature_valid": e.signature_valid,
                    "interval_risk_score": round(e.interval_risk_score or 0, 3),
                    "rejection_reason": e.rejection_reason,
                }
                for e in StepSyncEvent.objects.filter(user=user).order_by("-created_at")[:20]
            ],
        },
        "devices": [
            {
                "id": str(d.id),
                "platform": d.platform,
                "app_version": d.app_version,
                "trust_level": d.trust_level,
                "is_active": d.is_active,
                "first_seen_at": d.first_seen_at,
                "last_seen_at": d.last_seen_at,
            }
            for d in DeviceRegistration.objects.filter(user=user).order_by("-last_seen_at")[:10]
        ],
        "sessions": [
            {
                "id": str(s.id),
                "device_type": s.device_type,
                "device_name": s.device_name,
                "os_version": s.os_version,
                "app_version": s.app_version,
                "ip_address": s.ip_address,
                "country": s.country,
                "is_active": s.is_active,
                "last_active_at": s.last_active_at,
                "created_at": s.created_at,
            }
            for s in DeviceSession.objects.filter(user=user).order_by("-last_active_at")[:10]
        ],
        "challenges": [
            {
                "challenge_id": p.challenge_id,
                "name": p.challenge.name,
                "status": p.challenge.status,
                "entry_fee": _money(p.challenge.entry_fee),
                "milestone": p.challenge.milestone,
                "start_date": p.challenge.start_date,
                "end_date": p.challenge.end_date,
                "steps": p.steps,
                "qualified": p.qualified,
                "rank": p.rank,
                "payout": _money(p.payout),
                "joined_at": p.joined_at,
            }
            for p in participations
        ],
        "transactions": [
            {
                "id": t.id,
                "type": t.type,
                "amount": _money(t.amount),
                "balance_after": _money(t.balance_after),
                "description": t.description,
                "reference_id": t.reference_id,
                "created_at": t.created_at,
            }
            for t in txns.order_by("-created_at")[:25]
        ],
        "withdrawals": [
            {
                "id": str(w.id),
                "status": w.status,
                "amount_kes": _money(w.amount_kes),
                "method": w.method,
                "destination": w.phone_number or w.account_number or w.short_code,
                "rejection_reason": w.rejection_reason or w.fail_reason,
                "created_at": w.created_at,
                "reviewed_at": w.reviewed_at,
            }
            for w in WithdrawalRequest.objects.filter(user=user).order_by("-created_at")[:15]
        ],
        "flags": [
            {
                "id": f.id,
                "flag_type": f.flag_type,
                "severity": f.severity,
                "date": f.date,
                "reviewed": f.reviewed,
                "actioned": f.actioned,
                "admin_action": (f.details or {}).get("admin_action") if isinstance(f.details, dict) else None,
                "admin_note": (f.details or {}).get("admin_note") if isinstance(f.details, dict) else None,
                "details": f.details if isinstance(f.details, dict) else {},
                "created_at": f.created_at,
            }
            for f in FraudFlag.objects.filter(user=user).order_by("-created_at")[:30]
        ],
        "tickets": [
            {
                "id": t.id,
                "subject": t.subject,
                "category": t.category,
                "status": t.status,
                "priority": t.priority,
                "assigned_to_username": t.assigned_to.username if t.assigned_to else None,
                "created_at": t.created_at,
                "updated_at": t.updated_at,
            }
            for t in SupportTicket.objects.filter(user=user)
            .select_related("assigned_to")
            .order_by("-created_at")[:20]
        ],
        "audit": [
            {
                "id": a.id,
                "admin_username": a.admin_username,
                "action": a.action,
                "description": a.description,
                "changes": a.changes,
                "created_at": a.created_at,
            }
            for a in AuditLog.objects.filter(resource_type="user", resource_id=user.id)[:50]
        ],
    }


# ── Step logs ────────────────────────────────────────────────────────────────

STEP_BUCKETS = [
    (0, 2000, "0–2K"),
    (2000, 5000, "2K–5K"),
    (5000, 10000, "5K–10K"),
    (10000, 15000, "10K–15K"),
    (15000, 20000, "15K–20K"),
    (20000, 30000, "20K–30K"),
    (30000, None, "30K+"),
]


def step_distribution(logs):
    out = []
    for low, high, label in STEP_BUCKETS:
        cond = Q(steps__gte=low) if high is None else Q(steps__gte=low, steps__lt=high)
        agg = logs.aggregate(
            n=Count("id", filter=cond),
            s=Count("id", filter=cond & Q(is_suspicious=True)),
        )
        out.append({"label": label, "min": low, "max": high, "count": agg["n"], "suspicious": agg["s"]})
    return out


def step_daily_totals(logs, max_days=120):
    rows = (
        logs.order_by()
        .values("date")
        .annotate(
            steps=Sum("steps"),
            logs=Count("id"),
            users=Count("user_id", distinct=True),
            suspicious=Count("id", filter=Q(is_suspicious=True)),
        )
        .order_by("-date")[:max_days]
    )
    return [
        {
            "date": r["date"].isoformat() if isinstance(r["date"], date_cls) else r["date"],
            "steps": int(r["steps"] or 0),
            "logs": r["logs"],
            "users": r["users"],
            "suspicious": r["suspicious"],
        }
        for r in reversed(list(rows))
    ]


def step_flag_reasons(rows):
    """Fraud flags + suspicious-activity reasons for the (user, date) pairs on a page."""
    from apps.steps.models import FraudFlag, SuspiciousActivity

    pairs = {(r.user_id, r.date) for r in rows if r.is_suspicious}
    if not pairs:
        return {}
    users = {p[0] for p in pairs}
    dates = {p[1] for p in pairs}
    reasons = {}
    for f in FraudFlag.objects.filter(user_id__in=users, date__in=dates).order_by("-created_at"):
        if (f.user_id, f.date) in pairs:
            reasons.setdefault((f.user_id, f.date), []).append(
                {
                    "kind": "flag",
                    "id": f.id,
                    "type": f.flag_type,
                    "severity": f.severity,
                    "reviewed": f.reviewed,
                }
            )
    for s in SuspiciousActivity.objects.filter(user_id__in=users, date__in=dates):
        if (s.user_id, s.date) in pairs:
            reasons.setdefault((s.user_id, s.date), []).append(
                {"kind": "activity", "id": s.id, "type": s.reason, "severity": None, "reviewed": s.reviewed}
            )
    return reasons
