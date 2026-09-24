"""
Trust & safety endpoints for the admin console (anti-cheat triage, moderation,
ops history).

Scope rules:
- Nothing here changes anti-cheat scoring or verification. Cases are READ from
  the models the step pipeline writes (FraudFlag, SuspiciousSessionReview,
  StepSession, StepSyncEvent, IntervalVerificationResult,
  DailyVerificationSummary, TrustScore, UserTrustProfile).
- Admin decisions reuse the enforcement semantics of the existing
  ``views.action_flag`` endpoint (trust score set/deducted/recovered; the step
  sync endpoint enforces SUSPEND and BAN). ``TRUST_ACTIONS`` below mirrors that
  mapping exactly; ``test_trust.py`` asserts both endpoints stay in step.
- Every decision writes an ``AuditLog`` row (who, what, why) and can deliver a
  plain-language message to the user's Support inbox.
- Secrets never leave the server: session token hashes, server nonces, payload
  hashes, raw payloads and device public keys are not serialised.
"""

from collections import defaultdict
from datetime import datetime, timedelta

from django.contrib.auth import get_user_model
from django.db import transaction as db_transaction
from django.db.models import Count, Max, Q
from django.db.models.functions import TruncDate
from django.shortcuts import get_object_or_404
from django.utils import timezone
from drf_spectacular.utils import OpenApiTypes, extend_schema
from rest_framework import permissions
from rest_framework.decorators import api_view, permission_classes
from rest_framework.response import Response

from apps.admin_api.models import AuditLog, SupportTicket, SupportTicketMessage
from apps.admin_api.views import IsAdminUser
from apps.steps.models import (DailyVerificationSummary, DeviceRegistration,
                               FraudFlag, HealthRecord,
                               IntervalVerificationResult, StepSession,
                               StepSyncEvent, SuspiciousSessionReview,
                               TrustScore, UserTrustProfile)

User = get_user_model()
ADMIN = [permissions.IsAuthenticated, IsAdminUser]

SEVERITIES = ["critical", "high", "medium", "low"]
SEVERITY_RANK = {s: i for i, s in enumerate(SEVERITIES)}
OPEN_SESSION_STATUSES = ("pending", "escalated")
SESSION_DECISIONS = ("approved", "rejected", "escalated")
FLAG_ACTIONS = ("dismiss", "warn", "restrict", "suspend", "ban")
MODERATION_ACTIONS = ("warn", "restrict", "suspend", "ban", "unrestrict", "unsuspend", "unban")
# Audit actions shown in the moderation history (users page ban/unban included).
HISTORY_ACTIONS = (
    "warn", "restrict", "suspend", "ban", "unrestrict", "unsuspend", "unban",
    "dismiss_flag", "session_review",
)
REASON_MIN, REASON_MAX, MESSAGE_MAX = 5, 500, 1000
SECRET_KEY_FRAGMENTS = ("hash", "signature", "secret", "token", "nonce", "public_key", "private", "key_id")


# ── helpers ────────────────────────────────────────────────────────────────


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


def _age_hours(dt, now):
    return round(max(0.0, (now - dt).total_seconds() / 3600.0), 2)


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


def _related(obj, attr):
    try:
        return getattr(obj, attr)
    except Exception:  # RelatedObjectDoesNotExist
        return None


def _scrub(value, depth=0):
    """Drop secret-looking keys from free-form JSON evidence."""
    if depth > 4:
        return None
    if isinstance(value, dict):
        return {
            k: _scrub(v, depth + 1)
            for k, v in value.items()
            if not any(f in str(k).lower() for f in SECRET_KEY_FRAGMENTS)
        }
    if isinstance(value, list):
        return [_scrub(v, depth + 1) for v in value[:50]]
    return value


def _session_severity(risk_score):
    """Severity for a session review, from its risk score (reviews open at >= 60)."""
    if risk_score >= 80:
        return "critical"
    if risk_score >= 70:
        return "high"
    return "medium"


def _user_brief(user):
    ts = _related(user, "trust_score")
    score = ts.score if ts else 100
    return {
        "id": user.id,
        "username": user.username,
        "email": user.email,
        "is_active": user.is_active,
        "trust_score": score,
        "trust_status": _trust_status(score),
        "has_trust_record": ts is not None,
    }


def _flag_status(flag):
    if not flag.reviewed:
        return "open"
    return "actioned" if flag.actioned else "dismissed"


def _flag_summary(details):
    if not isinstance(details, dict):
        return ""
    for key in ("message", "note", "reason"):
        v = details.get(key)
        if isinstance(v, str) and v.strip():
            return v.strip()
    return ""


def _flag_row(flag, now):
    details = flag.details if isinstance(flag.details, dict) else {}
    return {
        "key": f"flag:{flag.id}",
        "kind": "flag",
        "id": str(flag.id),
        "user": _user_brief(flag.user),
        "type": flag.flag_type,
        "severity": flag.severity if flag.severity in SEVERITY_RANK else "low",
        "status": _flag_status(flag),
        "event_date": flag.date.isoformat() if flag.date else None,
        "created_at": flag.created_at.isoformat(),
        "age_hours": _age_hours(flag.created_at, now),
        "summary": _flag_summary(details),
        "rule_codes": [flag.flag_type],
        "risk_score": None,
        "last_action": details.get("admin_action"),
        "reviewed_at": details.get("reviewed_at"),
        "reviewed_by": details.get("reviewed_by"),
        "admin_note": details.get("admin_note"),
    }


def _session_row(review, now):
    hits = review.risk_hits if isinstance(review.risk_hits, list) else []
    codes = [h.get("rule") or h.get("rule_code") for h in hits if isinstance(h, dict)]
    return {
        "key": f"session:{review.id}",
        "kind": "session",
        "id": str(review.id),
        "user": _user_brief(review.user),
        "type": "session_risk",
        "severity": _session_severity(review.risk_score),
        "status": "open" if review.status in OPEN_SESSION_STATUSES else review.status,
        "review_status": review.status,
        "event_date": review.session.started_at.date().isoformat() if review.session_id else None,
        "created_at": review.created_at.isoformat(),
        "age_hours": _age_hours(review.created_at, now),
        "summary": review.reason_summary,
        "rule_codes": [c for c in codes if c],
        "risk_score": round(review.risk_score, 1),
        "last_action": None if review.status == "pending" else review.status,
        "reviewed_at": review.reviewed_at.isoformat() if review.reviewed_at else None,
        "reviewed_by": review.reviewer.username if review.reviewer_id else None,
        "admin_note": None,
    }


def _filter_users(qs, q, prefix="user__"):
    if not q:
        return qs
    cond = Q(**{f"{prefix}username__icontains": q}) | Q(**{f"{prefix}email__icontains": q})
    if q.isdigit():
        cond |= Q(**{f"{prefix}id": int(q)})
    return qs.filter(cond)


def _notice_to_user(user, admin, subject, message):
    """Deliver an admin notice to the user's Support inbox (a resolved ticket
    with one staff message) so it is visible in the app without entering the
    open support queue."""
    ticket = SupportTicket.objects.create(
        user=user,
        subject=subject[:255],
        category="account",
        message="Notice from the Step2Win trust & safety team.",
        status="resolved",
        priority="medium",
        resolved_at=timezone.now(),
    )
    SupportTicketMessage.objects.create(
        ticket=ticket, sender=admin, sender_username=admin.username, is_admin=True, message=message,
    )
    return ticket.id


# Mirrors views.action_flag exactly (see module docstring).
def _apply_trust_action(trust, action):
    if action == "dismiss":
        trust.recover(10)
    elif action == "warn":
        trust.deduct(5)
    elif action == "restrict":
        trust.score = 35
        trust.save(update_fields=["score", "updated_at"])
    elif action == "suspend":
        trust.score = 10
        trust.save(update_fields=["score", "updated_at"])
    elif action == "ban":
        trust.score = 0
        trust.save(update_fields=["score", "updated_at"])
    elif action == "unrestrict":
        trust.score = max(trust.score, 65)
        trust.save(update_fields=["score", "updated_at"])
    elif action == "unsuspend":
        trust.score = max(trust.score, 45)
        trust.save(update_fields=["score", "updated_at"])
    elif action == "unban":
        trust.score = max(trust.score, 35)
        trust.save(update_fields=["score", "updated_at"])


def _read_decision_payload(request):
    reason = str(request.data.get("reason") or "").strip()
    message = str(request.data.get("message_to_user") or "").strip()
    if len(reason) < REASON_MIN:
        return None, None, Response({"error": f"A reason of at least {REASON_MIN} characters is required."}, status=400)
    if len(reason) > REASON_MAX:
        return None, None, Response({"error": f"Reason must be {REASON_MAX} characters or fewer."}, status=400)
    if len(message) > MESSAGE_MAX:
        return None, None, Response({"error": f"Message must be {MESSAGE_MAX} characters or fewer."}, status=400)
    return reason, message, None


ACTION_LABEL = {
    "warn": "Warned", "restrict": "Restricted", "suspend": "Suspended", "ban": "Banned from step sync",
    "unrestrict": "Lifted restriction for", "unsuspend": "Lifted suspension for", "unban": "Lifted ban for",
    "dismiss": "Dismissed flag for",
}


def _moderate(request, user, action, reason, message, flag=None):
    """Apply a trust action + audit + optional notice. Returns response payload."""
    trust, _ = TrustScore.objects.select_for_update().get_or_create(user=user)
    before_score, before_status = trust.score, trust.status
    _apply_trust_action(trust, action)
    trust.refresh_from_db()

    notice_id = None
    if message:
        notice_id = _notice_to_user(user, request.user, "Account notice", message)

    changes = {
        "trust_score": {"old": before_score, "new": trust.score},
        "trust_status": {"old": before_status, "new": trust.status},
        "reason": reason,
    }
    if flag is not None:
        changes["flag_id"] = flag.id
        changes["flag_type"] = flag.flag_type
    if message:
        changes["message_to_user"] = message
        changes["notice_ticket_id"] = notice_id
    AuditLog.log_action(
        admin=request.user,
        action="dismiss_flag" if action == "dismiss" else action,
        resource_type="user",
        resource_id=user.id,
        resource_name=user.username,
        description=f"{ACTION_LABEL.get(action, action)} {user.username}"
        + (f" (flag #{flag.id} {flag.flag_type})" if flag is not None else ""),
        changes=changes,
        request=request,
    )
    return {
        "status": "ok",
        "action": action,
        "user_id": user.id,
        "trust_score": {"before": before_score, "after": trust.score},
        "trust_status": {"before": before_status, "after": trust.status},
        "notice_ticket_id": notice_id,
    }


# ── anti-cheat triage ─────────────────────────────────────────────────────


@extend_schema(responses={200: OpenApiTypes.OBJECT})
@api_view(["GET"])
@permission_classes(ADMIN)
def trust_summary(request):
    """Queue sizes, enforcement counts and flags per day by severity."""
    now = timezone.now()
    days = _int(request.query_params.get("days"), 30, 7, 90)
    start = timezone.localdate() - timedelta(days=days - 1)

    open_flags = FraudFlag.objects.filter(reviewed=False)
    open_sessions = SuspiciousSessionReview.objects.filter(status__in=OPEN_SESSION_STATUSES)
    by_sev = {s: 0 for s in SEVERITIES}
    for row in open_flags.values("severity").annotate(c=Count("id")):
        if row["severity"] in by_sev:
            by_sev[row["severity"]] += row["c"]
    for rs in open_sessions.values_list("risk_score", flat=True):
        by_sev[_session_severity(rs)] += 1

    oldest = [
        x for x in (
            open_flags.order_by("created_at").values_list("created_at", flat=True).first(),
            open_sessions.order_by("created_at").values_list("created_at", flat=True).first(),
        ) if x
    ]

    series = defaultdict(lambda: {s: 0 for s in SEVERITIES})
    for row in (
        FraudFlag.objects.filter(created_at__date__gte=start)
        .annotate(d=TruncDate("created_at"))
        .values("d", "severity")
        .annotate(c=Count("id"))
    ):
        if row["severity"] in SEVERITIES:
            series[row["d"]][row["severity"]] += row["c"]
    daily = []
    for i in range(days):
        d = start + timedelta(days=i)
        daily.append({"date": d.isoformat(), **series[d]})

    week = now - timedelta(days=7)
    decided = {"actioned": 0, "dismissed": 0}
    # reviewed_at lives in the flag's JSON details (written by both action endpoints).
    for actioned, details in FraudFlag.objects.filter(
        reviewed=True, created_at__gte=now - timedelta(days=120)
    ).values_list("actioned", "details"):
        ts = details.get("reviewed_at") if isinstance(details, dict) else None
        try:
            when = datetime.fromisoformat(ts) if ts else None
        except (TypeError, ValueError):
            when = None
        if when and timezone.is_naive(when):
            when = timezone.make_aware(when)
        if when and when >= week:
            decided["actioned" if actioned else "dismissed"] += 1

    return Response(
        {
            "open_total": sum(by_sev.values()),
            "open_flags": open_flags.count(),
            "open_sessions": open_sessions.count(),
            "open_by_severity": by_sev,
            "oldest_open_age_hours": _age_hours(min(oldest), now) if oldest else None,
            "flags_today": FraudFlag.objects.filter(created_at__date=timezone.localdate()).count(),
            "decided_7d": {
                **decided,
                "sessions": SuspiciousSessionReview.objects.filter(reviewed_at__gte=week).count(),
            },
            "enforcement": {
                "restricted": TrustScore.objects.filter(score__lte=40, score__gt=20).count(),
                "suspended": TrustScore.objects.filter(score__lte=20, score__gt=0).count(),
                "banned": TrustScore.objects.filter(score=0).count(),
                "disabled_accounts": User.objects.filter(is_active=False, is_staff=False).count(),
            },
            "daily": daily,
            "days": days,
        }
    )


@extend_schema(responses={200: OpenApiTypes.OBJECT})
@api_view(["GET"])
@permission_classes(ADMIN)
def trust_cases(request):
    """Unified triage list: fraud flags + suspicious session reviews.

    Filters: kind (flag|session), status (open|closed|all), severity, type, q
    (user), from/to (event date), user_id. Sorted by severity, then oldest first.
    """
    now = timezone.now()
    p = request.query_params
    kind = p.get("kind") or "all"
    status_f = p.get("status") or "open"
    severity = p.get("severity") or ""
    type_f = p.get("type") or ""
    q = (p.get("q") or "").strip()
    d_from, d_to = _parse_date(p.get("from")), _parse_date(p.get("to"))
    user_id = p.get("user_id")
    limit = _int(p.get("limit"), 50, 1, 200)
    offset = _int(p.get("offset"), 0, 0, 100000)

    rows = []
    type_counts = defaultdict(int)

    if kind in ("all", "flag") and (not type_f or type_f != "session_risk"):
        flags = FraudFlag.objects.select_related("user", "user__trust_score")
        if status_f == "open":
            flags = flags.filter(reviewed=False)
        elif status_f == "closed":
            flags = flags.filter(reviewed=True)
        flags = _filter_users(flags, q)
        if user_id and str(user_id).isdigit():
            flags = flags.filter(user_id=int(user_id))
        if d_from:
            flags = flags.filter(date__gte=d_from)
        if d_to:
            flags = flags.filter(date__lte=d_to)
        for row in flags.values("flag_type").annotate(c=Count("id")):
            type_counts[row["flag_type"]] += row["c"]
        if type_f:
            flags = flags.filter(flag_type=type_f)
        if severity in SEVERITY_RANK:
            flags = flags.filter(severity=severity)
        rows.extend(_flag_row(f, now) for f in flags[:2000])

    if kind in ("all", "session") and (not type_f or type_f == "session_risk"):
        reviews = SuspiciousSessionReview.objects.select_related(
            "user", "user__trust_score", "session", "reviewer"
        )
        if status_f == "open":
            reviews = reviews.filter(status__in=OPEN_SESSION_STATUSES)
        elif status_f == "closed":
            reviews = reviews.exclude(status__in=OPEN_SESSION_STATUSES)
        reviews = _filter_users(reviews, q)
        if user_id and str(user_id).isdigit():
            reviews = reviews.filter(user_id=int(user_id))
        if d_from:
            reviews = reviews.filter(session__started_at__date__gte=d_from)
        if d_to:
            reviews = reviews.filter(session__started_at__date__lte=d_to)
        session_rows = [_session_row(r, now) for r in reviews[:2000]]
        type_counts["session_risk"] += len(session_rows)
        if severity in SEVERITY_RANK:
            session_rows = [r for r in session_rows if r["severity"] == severity]
        rows.extend(session_rows)

    by_severity = {s: 0 for s in SEVERITIES}
    for r in rows:
        by_severity[r["severity"]] += 1

    if status_f == "open":
        rows.sort(key=lambda r: (SEVERITY_RANK[r["severity"]], r["created_at"]))
    else:
        rows.sort(key=lambda r: r["created_at"], reverse=True)

    return Response(
        {
            "count": len(rows),
            "results": rows[offset: offset + limit],
            "by_severity": by_severity,
            "types": sorted(({"type": t, "count": c} for t, c in type_counts.items()), key=lambda x: -x["count"]),
        }
    )


def _session_payload(session, with_events=True):
    if session is None:
        return None
    device = session.device
    data = {
        "id": str(session.id),
        "status": session.status,
        "started_at": session.started_at.isoformat(),
        "ended_at": session.ended_at.isoformat() if session.ended_at else None,
        "duration_minutes": round(((session.ended_at or session.updated_at) - session.started_at).total_seconds() / 60.0, 1),
        "total_steps": session.total_steps,
        "accepted_steps": session.accepted_steps,
        "rejected_steps": session.rejected_steps,
        "avg_walk_probability": session.avg_walk_probability,
        "avg_shake_probability": session.avg_shake_probability,
        "session_risk_score": round(session.session_risk_score or 0.0, 1),
        "trust_adjustment": session.trust_adjustment,
        "policy_version": session.policy_version,
        "ml_model_version": session.ml_model_version,
        "last_sequence_number": session.last_sequence_number,
        "device": _device_payload(device) if device else None,
    }
    if with_events:
        events = list(
            StepSyncEvent.objects.filter(session=session).order_by("sequence_number", "timestamp_server")[:300]
        )
        data["events"] = [
            {
                "sequence": e.sequence_number,
                "client_time": e.timestamp_client.isoformat() if e.timestamp_client else None,
                "server_time": e.timestamp_server.isoformat(),
                "steps_delta": e.steps_delta,
                "walk_probability": e.ml_walk_probability,
                "shake_probability": e.ml_shake_probability,
                "motion_label": e.ml_motion_label,
                "interval_risk_score": round(e.interval_risk_score or 0.0, 1),
                "accepted": e.accepted,
                "rejection_reason": e.rejection_reason,
                "signature_valid": e.signature_valid,
                "replay_detected": e.replay_detected,
            }
            for e in events
        ]
        data["events_total"] = StepSyncEvent.objects.filter(session=session).count()
    return data


def _device_payload(d):
    device_id = d.device_id or ""
    return {
        "platform": d.platform,
        "app_version": d.app_version,
        "trust_level": d.trust_level,
        "is_active": d.is_active,
        "device_ref": ("…" + device_id[-6:]) if len(device_id) > 6 else device_id,
        "first_seen_at": d.first_seen_at.isoformat(),
        "last_seen_at": d.last_seen_at.isoformat(),
        "sessions": d.sessions.count(),
    }


def _account_payload(user):
    ts = _related(user, "trust_score")
    tp = _related(user, "trust_profile")
    score = ts.score if ts else 100
    return {
        "user": {
            **_user_brief(user),
            "date_joined": user.date_joined.isoformat() if user.date_joined else None,
            "device_platform": getattr(user, "device_platform", None),
            "is_staff": user.is_staff,
        },
        "trust": {
            "score": score,
            "status": _trust_status(score),
            "flags_total": ts.flags_total if ts else 0,
            "updated_at": ts.updated_at.isoformat() if ts else None,
            "has_record": ts is not None,
        },
        "trust_profile": (
            {
                "trust_score": round(tp.trust_score, 1),
                "tier": tp.trust_tier,
                "verified_sessions": tp.verified_sessions_count,
                "suspicious_sessions": tp.suspicious_sessions_count,
                "replay_attempts": tp.replay_attempts_count,
                "accepted_steps": tp.total_accepted_steps,
                "rejected_steps": tp.total_rejected_steps,
                "last_suspicious_at": tp.last_suspicious_at.isoformat() if tp.last_suspicious_at else None,
                "last_verified_at": tp.last_verified_at.isoformat() if tp.last_verified_at else None,
            }
            if tp
            else None
        ),
    }


def _history_for(user, now):
    since = timezone.localdate() - timedelta(days=29)
    summaries = DailyVerificationSummary.objects.filter(user=user, date__gte=since, mode="active").order_by("date")
    trust_history = [
        {
            "date": s.date.isoformat(),
            "trust_before": s.trust_score_before,
            "trust_after": s.trust_score_after,
            "risk_score": round(s.risk_score, 1),
            "raw_steps": s.raw_steps_total,
            "verified_steps": s.verified_steps_total,
            "suspicious_steps": s.suspicious_steps_total,
            "review_state": s.review_state,
            "payout_state": s.payout_state,
        }
        for s in summaries
    ]
    flags = FraudFlag.objects.filter(user=user).order_by("-created_at")[:25]
    other_flags = [_flag_row(f, now) for f in flags]
    actions = AuditLog.objects.filter(resource_type="user", resource_id=user.id).filter(
        Q(action__in=HISTORY_ACTIONS) | Q(action__in=("ban", "unban"))
    )[:25]
    return trust_history, other_flags, [_audit_row(a) for a in actions]


def _audit_row(a):
    changes = a.changes if isinstance(a.changes, dict) else {}
    return {
        "id": a.id,
        "action": a.action,
        "admin": a.admin_username,
        "user_id": a.resource_id,
        "username": a.resource_name,
        "description": a.description,
        "reason": changes.get("reason"),
        "message_to_user": changes.get("message_to_user"),
        "trust_score": changes.get("trust_score"),
        "trust_status": changes.get("trust_status"),
        "flag_id": changes.get("flag_id"),
        "decision": changes.get("decision"),
        "created_at": a.created_at.isoformat(),
    }


def _intervals_for(user, day):
    rows = IntervalVerificationResult.objects.filter(user=user, date=day, mode="active").order_by("interval_start")[:96]
    return [
        {
            "start": r.interval_start.isoformat(),
            "end": r.interval_end.isoformat(),
            "source_platform": r.source_platform,
            "source_app": r.source_app,
            "raw_steps": r.raw_steps,
            "verified_steps": r.verified_steps,
            "risk_score": round(r.risk_score, 1),
            "confidence_score": round(r.confidence_score, 2),
            "status": r.verification_status,
            "review_state": r.review_state,
            "payout_state": r.payout_state,
            "rule_hits": [
                {
                    "rule_code": h.get("rule_code"),
                    "severity": h.get("severity"),
                    "message": h.get("message"),
                    "evidence": _scrub(h.get("evidence") or {}),
                }
                for h in (r.rule_hits_json or [])
                if isinstance(h, dict)
            ],
        }
        for r in rows
    ]


def _day_payload(user, day):
    if not day:
        return None
    rec = HealthRecord.objects.filter(user=user, date=day).first()
    summary = DailyVerificationSummary.objects.filter(user=user, date=day, mode="active").first()
    return {
        "date": day.isoformat(),
        "health_record": (
            {"steps": rec.steps, "source": rec.source, "is_suspicious": rec.is_suspicious,
             "distance_km": rec.distance_km, "synced_at": rec.synced_at.isoformat()}
            if rec else None
        ),
        "verification": (
            {"raw_steps": summary.raw_steps_total, "verified_steps": summary.verified_steps_total,
             "suspicious_steps": summary.suspicious_steps_total, "interval_count": summary.interval_count,
             "accepted": summary.accepted_count, "review": summary.review_count, "rejected": summary.rejected_count,
             "risk_score": round(summary.risk_score, 1), "review_state": summary.review_state,
             "payout_state": summary.payout_state, "trust_before": summary.trust_score_before,
             "trust_after": summary.trust_score_after}
            if summary else None
        ),
        "intervals": _intervals_for(user, day),
    }


@extend_schema(responses={200: OpenApiTypes.OBJECT, 404: OpenApiTypes.OBJECT})
@api_view(["GET"])
@permission_classes(ADMIN)
def trust_case_detail(request, kind, case_id):
    now = timezone.now()
    if kind == "flag":
        if not str(case_id).isdigit():
            return Response({"error": "Case not found"}, status=404)
        flag = get_object_or_404(FraudFlag.objects.select_related("user"), id=int(case_id))
        user = flag.user
        case = _flag_row(flag, now)
        evidence = _scrub(flag.details if isinstance(flag.details, dict) else {})
        rule_hits = [
            {"rule_code": flag.flag_type, "severity": flag.severity, "message": _flag_summary(flag.details),
             "evidence": {k: v for k, v in (evidence or {}).items()
                          if k not in ("admin_action", "admin_note", "reviewed_at", "reviewed_by", "message", "note")}}
        ]
        day = flag.date
        sessions = StepSession.objects.filter(user=user, started_at__date=day).select_related("device").order_by("started_at")[:10]
        primary = None
        related_sessions = [_session_payload(s, with_events=False) for s in sessions]
    elif kind == "session":
        review = get_object_or_404(
            SuspiciousSessionReview.objects.select_related("user", "session", "session__device", "reviewer"),
            id=case_id,
        )
        user = review.user
        case = _session_row(review, now)
        rule_hits = [
            {"rule_code": h.get("rule") or h.get("rule_code"), "severity": h.get("severity"),
             "message": h.get("details") if isinstance(h.get("details"), str) else h.get("message"),
             "penalty": h.get("penalty"), "evidence": {}}
            for h in (review.risk_hits or []) if isinstance(h, dict)
        ]
        evidence = None
        day = review.session.started_at.date()
        primary = _session_payload(review.session, with_events=True)
        related_sessions = [
            _session_payload(s, with_events=False)
            for s in StepSession.objects.filter(user=user, started_at__date=day).exclude(id=review.session_id)
            .select_related("device").order_by("started_at")[:10]
        ]
    else:
        return Response({"error": "Case not found"}, status=404)

    trust_history, other_flags, actions = _history_for(user, now)
    devices = [_device_payload(d) for d in DeviceRegistration.objects.filter(user=user).order_by("-last_seen_at")[:10]]
    return Response(
        {
            "case": case,
            "rule_hits": rule_hits,
            "evidence": evidence,
            **_account_payload(user),
            "day": _day_payload(user, day),
            "session": primary,
            "related_sessions": related_sessions,
            "devices": devices,
            "trust_history": trust_history,
            "user_flags": [f for f in other_flags if f["key"] != case["key"]],
            "actions": actions,
            "open_cases_for_user": FraudFlag.objects.filter(user=user, reviewed=False).count()
            + SuspiciousSessionReview.objects.filter(user=user, status__in=OPEN_SESSION_STATUSES).count(),
        }
    )


@extend_schema(request=OpenApiTypes.OBJECT, responses={200: OpenApiTypes.OBJECT, 400: OpenApiTypes.OBJECT})
@api_view(["POST"])
@permission_classes(ADMIN)
def trust_flag_action(request, flag_id):
    """Decide a fraud flag: dismiss, or confirm with warn/restrict/suspend/ban.

    Same flag + trust effects as ``views.action_flag`` plus a required reason,
    reviewer attribution, an audit row and an optional message to the user.
    """
    action = request.data.get("action")
    if action not in FLAG_ACTIONS:
        return Response({"error": "Invalid action"}, status=400)
    reason, message, err = _read_decision_payload(request)
    if err:
        return err
    with db_transaction.atomic():
        flag = get_object_or_404(FraudFlag.objects.select_for_update().select_related("user"), id=flag_id)
        if flag.reviewed:
            return Response({"error": "This flag was already decided by another reviewer. Refresh the queue."}, status=409)
        if flag.user_id == request.user.id:
            return Response({"error": "You cannot decide a flag on your own account."}, status=400)
        details = flag.details if isinstance(flag.details, dict) else {}
        details.update(
            {
                "admin_action": action,
                "admin_note": reason,
                "reviewed_at": timezone.now().isoformat(),
                "reviewed_by": request.user.username,
            }
        )
        flag.reviewed = True
        flag.actioned = action != "dismiss"
        flag.details = details
        flag.save(update_fields=["reviewed", "actioned", "details"])
        payload = _moderate(request, flag.user, action, reason, message, flag=flag)
    return Response({**payload, "flag_id": flag.id})


@extend_schema(request=OpenApiTypes.OBJECT, responses={200: OpenApiTypes.OBJECT, 400: OpenApiTypes.OBJECT})
@api_view(["POST"])
@permission_classes(ADMIN)
def trust_session_decision(request, review_id):
    """Record a decision on a suspicious session review.

    approved = session looks legitimate; rejected = confirmed suspicious;
    escalated = needs a second reviewer (stays in the open queue).
    This records the decision only: it does not change steps, rewards or the
    trust score (use a moderation action for enforcement).
    """
    decision = request.data.get("decision")
    if decision not in SESSION_DECISIONS:
        return Response({"error": "Invalid decision"}, status=400)
    reason, message, err = _read_decision_payload(request)
    if err:
        return err
    with db_transaction.atomic():
        review = get_object_or_404(
            SuspiciousSessionReview.objects.select_for_update().select_related("user"), id=review_id
        )
        if review.status not in OPEN_SESSION_STATUSES:
            return Response({"error": "This session was already decided. Refresh the queue."}, status=409)
        if review.user_id == request.user.id:
            return Response({"error": "You cannot decide a review on your own account."}, status=400)
        before = review.status
        review.status = decision
        review.reviewer = request.user
        review.reviewed_at = timezone.now()
        review.save(update_fields=["status", "reviewer", "reviewed_at"])
        notice_id = _notice_to_user(review.user, request.user, "Step session review", message) if message else None
        changes = {"decision": {"old": before, "new": decision}, "reason": reason, "review_id": str(review.id),
                   "risk_score": round(review.risk_score, 1)}
        if message:
            changes["message_to_user"] = message
            changes["notice_ticket_id"] = notice_id
        AuditLog.log_action(
            admin=request.user,
            action="session_review",
            resource_type="user",
            resource_id=review.user_id,
            resource_name=review.user.username,
            description=f"Marked suspicious session {decision} for {review.user.username}",
            changes=changes,
            request=request,
        )
    return Response({"status": "ok", "decision": decision, "review_id": str(review.id), "notice_ticket_id": notice_id})


# ── moderation ─────────────────────────────────────────────────────────────


@extend_schema(responses={200: OpenApiTypes.OBJECT})
@api_view(["GET"])
@permission_classes(ADMIN)
def moderation_users(request):
    """Accounts that need a moderation decision (view=queue) or are under an
    enforcement (view=enforced)."""
    view = request.query_params.get("view") or "queue"
    q = (request.query_params.get("q") or "").strip()
    limit = _int(request.query_params.get("limit"), 50, 1, 200)
    offset = _int(request.query_params.get("offset"), 0, 0, 100000)

    users = User.objects.filter(is_staff=False).select_related("trust_score")
    users = _filter_users(users, q, prefix="")
    users = users.annotate(
        open_flags=Count("fraud_flags", filter=Q(fraud_flags__reviewed=False), distinct=True),
        open_sessions=Count(
            "suspicious_session_reviews",
            filter=Q(suspicious_session_reviews__status__in=OPEN_SESSION_STATUSES),
            distinct=True,
        ),
        last_flag_at=Max("fraud_flags__created_at"),
    )
    if view == "enforced":
        users = users.filter(Q(trust_score__score__lte=40) | Q(is_active=False))
    else:
        users = users.filter(
            Q(open_flags__gt=0) | Q(open_sessions__gt=0)
            | Q(trust_score__score__lte=60, trust_score__score__gt=40)
        ).exclude(trust_score__score__lte=40)

    ids = list(users.values_list("id", flat=True)[:1000])
    sev_by_user = {}
    for row in FraudFlag.objects.filter(user_id__in=ids, reviewed=False).values("user_id", "severity"):
        cur = sev_by_user.get(row["user_id"])
        if row["severity"] in SEVERITY_RANK and (cur is None or SEVERITY_RANK[row["severity"]] < SEVERITY_RANK[cur]):
            sev_by_user[row["user_id"]] = row["severity"]
    for uid, rs in SuspiciousSessionReview.objects.filter(
        user_id__in=ids, status__in=OPEN_SESSION_STATUSES
    ).values_list("user_id", "risk_score"):
        sev = _session_severity(rs)
        cur = sev_by_user.get(uid)
        if cur is None or SEVERITY_RANK[sev] < SEVERITY_RANK[cur]:
            sev_by_user[uid] = sev

    last_action = {}
    for a in AuditLog.objects.filter(resource_type="user", resource_id__in=ids, action__in=HISTORY_ACTIONS + ("ban", "unban")).order_by("-created_at"):
        last_action.setdefault(a.resource_id, a)

    rows = []
    for u in users.filter(id__in=ids):
        brief = _user_brief(u)
        la = last_action.get(u.id)
        rows.append(
            {
                **brief,
                "open_flags": u.open_flags,
                "open_sessions": u.open_sessions,
                "top_severity": sev_by_user.get(u.id),
                "last_flag_at": u.last_flag_at.isoformat() if u.last_flag_at else None,
                "date_joined": u.date_joined.isoformat() if u.date_joined else None,
                "last_action": _audit_row(la) if la else None,
            }
        )

    def sort_key(r):
        return (SEVERITY_RANK.get(r["top_severity"], 9), r["trust_score"], -(r["open_flags"] + r["open_sessions"]))

    rows.sort(key=sort_key if view != "enforced" else (lambda r: (r["trust_score"], r["username"])))
    return Response({"count": len(rows), "results": rows[offset: offset + limit]})


@extend_schema(responses={200: OpenApiTypes.OBJECT})
@api_view(["GET"])
@permission_classes(ADMIN)
def moderation_history(request):
    """Audit trail of trust & safety decisions (newest first)."""
    p = request.query_params
    limit = _int(p.get("limit"), 25, 1, 100)
    offset = _int(p.get("offset"), 0, 0, 100000)
    qs = AuditLog.objects.filter(resource_type="user", action__in=HISTORY_ACTIONS + ("ban", "unban"))
    action = p.get("action")
    if action:
        qs = qs.filter(action=action)
    q = (p.get("q") or "").strip()
    if q:
        qs = qs.filter(Q(resource_name__icontains=q) | Q(admin_username__icontains=q))
    if p.get("user_id") and str(p.get("user_id")).isdigit():
        qs = qs.filter(resource_id=int(p["user_id"]))
    d_from, d_to = _parse_date(p.get("from")), _parse_date(p.get("to"))
    if d_from:
        qs = qs.filter(created_at__date__gte=d_from)
    if d_to:
        qs = qs.filter(created_at__date__lte=d_to)
    total = qs.count()
    return Response({"count": total, "results": [_audit_row(a) for a in qs[offset: offset + limit]]})


@extend_schema(request=OpenApiTypes.OBJECT, responses={200: OpenApiTypes.OBJECT, 400: OpenApiTypes.OBJECT})
@api_view(["POST"])
@permission_classes(ADMIN)
def moderate_user(request, user_id):
    """Apply a trust enforcement to a user outside a specific flag."""
    action = request.data.get("action")
    if action not in MODERATION_ACTIONS:
        return Response({"error": "Invalid action"}, status=400)
    reason, message, err = _read_decision_payload(request)
    if err:
        return err
    user = get_object_or_404(User, id=user_id)
    if user.id == request.user.id:
        return Response({"error": "You cannot moderate your own account."}, status=400)
    if user.is_staff and not request.user.is_superuser:
        return Response({"error": "Only superusers can moderate staff accounts."}, status=403)
    with db_transaction.atomic():
        payload = _moderate(request, user, action, reason, message)
    return Response(payload)


# ── ops history ────────────────────────────────────────────────────────────


@extend_schema(responses={200: OpenApiTypes.OBJECT})
@api_view(["GET"])
@permission_classes(ADMIN)
def ops_history(request):
    """Daily counts behind the ops checks (from stored records, not samples)."""
    from apps.payments.models import CallbackLog, PaymentTransaction, WithdrawalRequest

    days = _int(request.query_params.get("days"), 14, 7, 60)
    start = timezone.localdate() - timedelta(days=days - 1)

    def daily(qs, field="created_at"):
        out = defaultdict(int)
        for row in qs.filter(**{f"{field}__date__gte": start}).annotate(d=TruncDate(field)).values("d").annotate(c=Count("id")):
            out[row["d"]] = row["c"]
        return out

    cb_total = daily(CallbackLog.objects.all())
    cb_unprocessed = daily(CallbackLog.objects.filter(processed=False))
    wd_requested = daily(WithdrawalRequest.objects.all())
    wd_failed = daily(WithdrawalRequest.objects.filter(status="failed"), "updated_at")
    pay_failed = daily(PaymentTransaction.objects.filter(status="failed"), "updated_at")
    flags = daily(FraudFlag.objects.all())
    rows = []
    for i in range(days):
        d = start + timedelta(days=i)
        rows.append(
            {
                "date": d.isoformat(),
                "callbacks": cb_total[d],
                "callbacks_unprocessed": cb_unprocessed[d],
                "withdrawals_requested": wd_requested[d],
                "withdrawals_failed": wd_failed[d],
                "payments_failed": pay_failed[d],
                "fraud_flags": flags[d],
            }
        )
    return Response({"days": days, "daily": rows})
