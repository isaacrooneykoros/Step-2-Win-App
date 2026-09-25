"""
Admin "Payout reviews" queue: challenge payouts held at settlement.

The money logic lives in apps/challenges/payout_holds.py; these endpoints list
the holds, show the evidence staff need, and call release / forfeit.

GET  /api/admin/payout-reviews/?status=held|released|forfeited|all&q=
GET  /api/admin/payout-reviews/<id>/
POST /api/admin/payout-reviews/<id>/release/   {"note": "..."}
POST /api/admin/payout-reviews/<id>/forfeit/   {"note": "..."}
"""

from __future__ import annotations

from datetime import timedelta
from decimal import Decimal

from django.db.models import Avg, Count, Q, Sum
from django.shortcuts import get_object_or_404
from django.utils import timezone
from drf_spectacular.utils import OpenApiTypes, extend_schema
from rest_framework import permissions
from rest_framework.decorators import api_view, permission_classes
from rest_framework.response import Response

from apps.admin_api.models import AuditLog
from apps.admin_api.trust_views import (HISTORY_ACTIONS, _age_hours, _related,
                                        _audit_row, _user_brief)
from apps.admin_api.views import IsAdminUser
from apps.challenges.models import ChallengeResult, HeldPayout
from apps.challenges.payout_holds import (PayoutReviewError, _release_blocker,
                                          forfeit_hold, forfeit_plan,
                                          release_hold)
from apps.steps.models import FraudFlag, HealthRecord
from apps.users.models import User

ADMIN = [permissions.IsAuthenticated, IsAdminUser]
STATUSES = [s for s, _ in HeldPayout.STATUS_CHOICES]
BASELINE_DAYS = 28


def _challenge_brief(c):
    return {
        "id": c.id,
        "name": c.name,
        "status": c.status,
        "start_date": c.start_date.isoformat(),
        "end_date": c.end_date.isoformat(),
        "entry_fee": str(c.entry_fee),
        "total_pool": str(c.total_pool),
        "payout_structure": c.payout_structure,
        "milestone": c.milestone,
    }


def _row(h, now):
    return {
        "id": h.id,
        "status": h.status,
        "amount": str(h.amount),
        "created_at": h.created_at.isoformat(),
        "age_hours": _age_hours(h.created_at, now),
        "user": _user_brief(h.user),
        "user_deleted": bool(getattr(h.user, "deleted_at", None)),
        "challenge": _challenge_brief(h.challenge),
        "reasons": h.reasons if isinstance(h.reasons, list) else [],
        "forfeit_only": h.forfeit_only,
        "decided_by": h.decided_by.username if h.decided_by_id else None,
        "decided_at": h.decided_at.isoformat() if h.decided_at else None,
        "note": h.note or None,
        "resolution": h.resolution or None,
    }


def _counts():
    by = {s: 0 for s in STATUSES}
    for r in HeldPayout.objects.values("status").annotate(c=Count("id")):
        by[r["status"]] = r["c"]
    held_total = HeldPayout.objects.filter(status=HeldPayout.STATUS_HELD).aggregate(
        t=Sum("amount")
    )["t"] or Decimal("0.00")
    return by, str(held_total)


@extend_schema(responses={200: OpenApiTypes.OBJECT})
@api_view(["GET"])
@permission_classes(ADMIN)
def payout_reviews(request):
    now = timezone.now()
    status_f = request.query_params.get("status") or HeldPayout.STATUS_HELD
    q = (request.query_params.get("q") or "").strip()
    qs = HeldPayout.objects.select_related("user", "user__trust_score", "challenge", "decided_by")
    if status_f in STATUSES:
        qs = qs.filter(status=status_f)
    if q:
        cond = Q(user__username__icontains=q) | Q(user__email__icontains=q) | Q(challenge__name__icontains=q)
        if q.isdigit():
            cond |= Q(user_id=int(q)) | Q(challenge_id=int(q)) | Q(id=int(q))
        qs = qs.filter(cond)
    # Oldest open first (queue); decided ones newest first.
    qs = qs.order_by("created_at") if status_f == HeldPayout.STATUS_HELD else qs.order_by("-decided_at", "-created_at")
    counts, held_total = _counts()
    return Response(
        {
            "results": [_row(h, now) for h in qs[:200]],
            "counts": counts,
            "held_total": held_total,
            "status": status_f,
        }
    )


def _daily_steps(h):
    c = h.challenge
    records = {
        r.date: r
        for r in HealthRecord.objects.filter(
            user=h.user, date__gte=c.start_date, date__lte=c.end_date
        )
    }
    base_start = c.start_date - timedelta(days=BASELINE_DAYS)
    baseline = HealthRecord.objects.filter(
        user=h.user, date__gte=base_start, date__lt=c.start_date, is_suspicious=False
    ).aggregate(avg=Avg("steps"), n=Count("id"))
    avg = baseline["avg"]
    days = []
    d = c.start_date
    while d <= c.end_date:
        r = records.get(d)
        steps = r.steps if r else 0
        days.append(
            {
                "date": d.isoformat(),
                "steps": steps,
                "recorded": r is not None,
                "suspicious": bool(r and r.is_suspicious),
                "vs_baseline": round(steps / avg, 2) if avg else None,
            }
        )
        d += timedelta(days=1)
    return {
        "days": days,
        "baseline_avg": round(avg) if avg else None,
        "baseline_days": baseline["n"],
        "baseline_window": f"{BASELINE_DAYS} days before the challenge (days not marked suspicious)",
    }


def _forfeit_preview(h):
    """Where the amount would go if forfeited now (same plan forfeit_hold uses)."""
    if h.status != HeldPayout.STATUS_HELD:
        return None
    plan = forfeit_plan(h)
    names = dict(
        User.objects.filter(
            pk__in=[r[1] for r in plan["recipients"]]
        ).values_list("pk", "username")
    )
    rows = []
    for pid, uid, weight, share in plan["recipients"]:
        row = {"username": names.get(uid), "user_id": uid, "share": str(share)}
        if plan["mode"] == "qualifiers":
            row["original_payout"] = str(weight)
        else:
            row["entry_fee"] = str(weight)
        rows.append(row)
    return {
        "mode": plan["mode"],
        "to_platform": plan["mode"] == "platform",
        "recipients": rows,
    }


@extend_schema(responses={200: OpenApiTypes.OBJECT})
@api_view(["GET"])
@permission_classes(ADMIN)
def payout_review_detail(request, hold_id):
    now = timezone.now()
    h = get_object_or_404(
        HeldPayout.objects.select_related("user", "user__trust_score", "challenge", "decided_by", "participant"),
        pk=hold_id,
    )
    c = h.challenge
    user = h.user
    ts = _related(user, "trust_score")
    flags = FraudFlag.objects.filter(
        user=user, date__gte=c.start_date, date__lte=c.end_date
    ).order_by("date", "created_at")
    result = ChallengeResult.objects.filter(participant_id=h.participant_id).first()
    actions = AuditLog.objects.filter(resource_type="user", resource_id=user.id).filter(
        Q(action__in=HISTORY_ACTIONS) | Q(action__in=("ban", "unban"))
    )[:15]
    blocker = _release_blocker(h) if h.status == HeldPayout.STATUS_HELD else None
    return Response(
        {
            **_row(h, now),
            "can_release": h.status == HeldPayout.STATUS_HELD and blocker is None,
            "release_blocked_reason": blocker,
            "result": (
                {
                    "final_steps": result.final_steps,
                    "final_rank": result.final_rank,
                    "payout_method": result.payout_method,
                    "qualified": result.qualified,
                }
                if result
                else None
            ),
            "evidence": {
                "trust": {
                    "score": ts.score if ts else 100,
                    "status": ts.status if ts else "GOOD",
                    "flags_total": ts.flags_total if ts else 0,
                    "admin_lock": (
                        {
                            "status": ts.admin_status,
                            "ceiling": ts.admin_ceiling,
                            "until": ts.admin_locked_until.isoformat() if ts.admin_locked_until else None,
                        }
                        if ts and ts.admin_lock_active()
                        else None
                    ),
                    "actions": [_audit_row(a) for a in actions],
                },
                "flags_in_window": [
                    {
                        "id": f.id,
                        "type": f.flag_type,
                        "severity": f.severity,
                        "date": f.date.isoformat(),
                        "reviewed": f.reviewed,
                        "actioned": f.actioned,
                        "created_at": f.created_at.isoformat(),
                    }
                    for f in flags[:100]
                ],
                "flags_open_in_window": flags.filter(reviewed=False).count(),
                "daily_steps": _daily_steps(h),
            },
            "forfeit_preview": _forfeit_preview(h),
        }
    )


def _decide(request, hold_id, fn):
    get_object_or_404(HeldPayout, pk=hold_id)
    try:
        out = fn(hold_id, request.user, request.data.get("note"), request=request)
    except PayoutReviewError as exc:
        return Response({"error": str(exc)}, status=400)
    return Response(out)


@extend_schema(request=OpenApiTypes.OBJECT, responses={200: OpenApiTypes.OBJECT})
@api_view(["POST"])
@permission_classes(ADMIN)
def payout_review_release(request, hold_id):
    return _decide(request, hold_id, release_hold)


@extend_schema(request=OpenApiTypes.OBJECT, responses={200: OpenApiTypes.OBJECT})
@api_view(["POST"])
@permission_classes(ADMIN)
def payout_review_forfeit(request, hold_id):
    return _decide(request, hold_id, forfeit_hold)
