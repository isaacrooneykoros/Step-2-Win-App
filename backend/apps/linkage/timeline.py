"""
Admin evidence timeline for one account (read-only).

``build_timeline(user, start, end, categories)`` returns:
  days:   one row per local day with steps counted (phone's raw total) vs credited
          (counts toward goals and challenges) vs money-eligible (credited and the day
          not under review), unverified steps, sync/flag counts and the shadow risk score;
  events: chronological (newest first) events from syncs, devices and sessions, flags,
          trust changes, admin actions, money (wallet, payout holds), the shadow risk
          model and account linkage.

Categories: steps, syncs, devices, flags, trust, admin, money, risk, linkage.
No raw IP addresses, coordinates or full phone numbers are returned.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime, timedelta
from datetime import timezone as dt_timezone

from django.contrib.auth import get_user_model
from django.db.models import Q

from .detectors import mask_device
from .models import HouseholdMark, LinkEdge
from .store import local_today

CATEGORIES = ("steps", "syncs", "devices", "flags", "trust", "admin", "money", "risk", "linkage")
MAX_DAYS = 120
MAX_EVENTS_PER_KIND = 300
OFFSET = timedelta(hours=3)  # Kenya (EAT); the phone's local day


def _local_day(dt) -> date:
    return (dt + OFFSET).date()


def _range_utc(start: date, end: date):
    lo = datetime(start.year, start.month, start.day, tzinfo=dt_timezone.utc) - OFFSET
    hi = datetime(end.year, end.month, end.day, tzinfo=dt_timezone.utc) + timedelta(days=1) - OFFSET
    return lo, hi


def _ev(at, category, kind, title, detail="", tone="neutral", **meta):
    if isinstance(at, date) and not isinstance(at, datetime):
        at = datetime(at.year, at.month, at.day, 12, tzinfo=dt_timezone.utc) - OFFSET
    return {"at": at.isoformat(), "day": _local_day(at).isoformat(), "category": category,
            "kind": kind, "title": title, "detail": detail, "tone": tone, "meta": meta}


def parse_range(params) -> tuple[date, date]:
    def parse(v):
        try:
            return date.fromisoformat(str(v)[:10]) if v else None
        except ValueError:
            return None

    end = parse(params.get("end")) or local_today()
    start = parse(params.get("start"))
    if start is None:
        try:
            days = int(params.get("days", 30))
        except (TypeError, ValueError):
            days = 30
        days = max(1, min(MAX_DAYS, days))
        start = end - timedelta(days=days - 1)
    if start > end:
        start, end = end, start
    if (end - start).days >= MAX_DAYS:
        start = end - timedelta(days=MAX_DAYS - 1)
    return start, end


def parse_categories(raw) -> set:
    if not raw:
        return set(CATEGORIES)
    wanted = {c.strip() for c in str(raw).split(",") if c.strip()}
    return (wanted & set(CATEGORIES)) or set(CATEGORIES)


def _days(user, start, end):
    from apps.risk_ml.models import RiskScore
    from apps.steps.models import FraudFlag, HealthRecord, StepSyncEvent

    lo, hi = _range_utc(start, end)
    rows = {}
    for d, steps, raw, unverified, suspicious in (HealthRecord.objects.filter(user=user, date__range=(start, end))
                                                  .values_list("date", "steps", "last_raw_steps",
                                                               "unverified_steps", "is_suspicious")):
        credited = int(steps or 0)
        rows[d] = {"date": d.isoformat(), "counted": max(int(raw or 0), credited), "credited": credited,
                   "money_eligible": 0 if suspicious else credited, "unverified": int(unverified or 0),
                   "under_review": bool(suspicious), "syncs": 0, "rejected_syncs": 0, "flags": 0,
                   "risk_score": None}
    blank = lambda d: {"date": d.isoformat(), "counted": 0, "credited": 0, "money_eligible": 0,  # noqa: E731
                       "unverified": 0, "under_review": False, "syncs": 0, "rejected_syncs": 0,
                       "flags": 0, "risk_score": None}
    for at, accepted in StepSyncEvent.objects.filter(user=user, created_at__gte=lo, created_at__lt=hi) \
            .values_list("created_at", "accepted").iterator(chunk_size=2000):
        d = _local_day(at)
        row = rows.setdefault(d, blank(d))
        row["syncs"] += 1
        if not accepted:
            row["rejected_syncs"] += 1
    for d in FraudFlag.objects.filter(user=user, date__range=(start, end)).values_list("date", flat=True):
        rows.setdefault(d, blank(d))["flags"] += 1
    for d, score, ctx in RiskScore.objects.filter(user=user, date__range=(start, end)) \
            .values_list("date", "score", "context"):
        if (ctx or {}).get("supervised"):
            continue
        row = rows.setdefault(d, blank(d))
        row["risk_score"] = max(score, row["risk_score"] or 0.0)
    return [rows[d] for d in sorted(rows, reverse=True)]


def _step_events(user, start, end):
    from apps.steps.models import HealthRecord

    out = []
    for d, steps, suspicious, unverified in (HealthRecord.objects.filter(user=user, date__range=(start, end))
                                             .values_list("date", "steps", "is_suspicious", "unverified_steps")):
        if suspicious:
            out.append(_ev(d, "steps", "day_under_review", "Day under review",
                           f"{steps:,} credited steps don't count toward challenges while under review.",
                           "warning", date=d.isoformat()))
        elif unverified:
            out.append(_ev(d, "steps", "steps_unverified", "Some steps not counted",
                           f"{unverified:,} steps not counted toward challenges.", "info", date=d.isoformat()))
    return out


def _sync_events(user, lo, hi):
    from apps.steps.models import StepSyncEvent

    per_day = defaultdict(lambda: [0, 0, None, None])
    rejected = []
    for at, accepted, reason, replay in (StepSyncEvent.objects.filter(user=user, created_at__gte=lo, created_at__lt=hi)
                                         .values_list("created_at", "accepted", "rejection_reason", "replay_detected")
                                         .iterator(chunk_size=2000)):
        row = per_day[_local_day(at)]
        row[0] += 1
        row[2] = at if row[2] is None or at < row[2] else row[2]
        row[3] = at if row[3] is None or at > row[3] else row[3]
        if not accepted:
            row[1] += 1
            if len(rejected) < MAX_EVENTS_PER_KIND:
                rejected.append(_ev(at, "syncs", "sync_rejected", "Upload not accepted",
                                    reason or ("Replayed upload" if replay else ""), "warning"))
    out = [_ev(last, "syncs", "sync_day", f"{n} step uploads" + (f", {r} not accepted" if r else ""),
               f"First {first.isoformat()[11:16]} UTC, last {last.isoformat()[11:16]} UTC",
               "neutral", count=n, rejected=r)
           for d, (n, r, first, last) in per_day.items()]
    return out + rejected


def _device_events(user, lo, hi):
    from apps.steps.models import DeviceRegistration, StepSession
    from apps.users.models import DeviceSession

    out = []
    for dev, platform, first, active in DeviceRegistration.objects.filter(
            user=user, first_seen_at__gte=lo, first_seen_at__lt=hi).values_list(
            "device_id", "platform", "first_seen_at", "is_active"):
        out.append(_ev(first, "devices", "device_registered", f"Phone {mask_device(dev)} registered",
                       f"{platform}{'' if active else ' (no longer active)'}", "info"))
    per_day = defaultdict(lambda: [0, set(), None])
    for started, dev in (StepSession.objects.filter(user=user, started_at__gte=lo, started_at__lt=hi)
                         .values_list("started_at", "device__device_id").iterator(chunk_size=2000)):
        row = per_day[_local_day(started)]
        row[0] += 1
        if dev:
            row[1].add(mask_device(dev))
        row[2] = started if row[2] is None or started > row[2] else row[2]
    for d, (n, devs, last) in per_day.items():
        out.append(_ev(last, "devices", "step_sessions", f"{n} step session{'s' if n != 1 else ''}",
                       ("On " + ", ".join(sorted(devs))) if devs else "", "neutral",
                       devices=len(devs)))
    for created, name, dtype in (DeviceSession.objects.filter(user=user, created_at__gte=lo, created_at__lt=hi)
                                 .values_list("created_at", "device_name", "device_type")[:MAX_EVENTS_PER_KIND]):
        out.append(_ev(created, "devices", "login", "Signed in", name or dtype or "", "neutral"))
    return out


def _flag_events(user, lo, hi):
    from apps.steps.models import FraudFlag

    tone = {"critical": "danger", "high": "danger", "medium": "warning", "low": "neutral"}
    return [_ev(at, "flags", "flag", f"Flag: {ftype.replace('_', ' ')}",
                f"{severity} · step day {d.isoformat()}" + (" · reviewed" if reviewed else ""),
                tone.get(severity, "neutral"), flag_id=pk, severity=severity, reviewed=reviewed)
            for pk, at, ftype, severity, d, reviewed in
            FraudFlag.objects.filter(user=user, created_at__gte=lo, created_at__lt=hi)
            .values_list("pk", "created_at", "flag_type", "severity", "date", "reviewed")[:MAX_EVENTS_PER_KIND]]


def _trust_events(user, start, end):
    from apps.steps.models import DailyVerificationSummary

    out = []
    for d, before, after, updated in (DailyVerificationSummary.objects.filter(user=user, date__range=(start, end))
                                      .values_list("date", "trust_score_before", "trust_score_after", "updated_at")):
        if before != after:
            out.append(_ev(updated, "trust", "trust_change", f"Trust {before} → {after}",
                           f"Step day {d.isoformat()}", "warning" if after < before else "success",
                           before=before, after=after))
    return out


def _admin_events(user, lo, hi):
    from apps.admin_api.models import AuditLog

    return [_ev(at, "admin", action, desc[:160], f"by {admin}", "info", action=action)
            for at, action, desc, admin in
            AuditLog.objects.filter(resource_type="user", resource_id=user.pk, created_at__gte=lo, created_at__lt=hi)
            .values_list("created_at", "action", "description", "admin_username")[:MAX_EVENTS_PER_KIND]]


def _money_events(user, lo, hi):
    from apps.challenges.models import HeldPayout
    from apps.wallet.models import WalletTransaction

    out = []
    for at, typ, amount, desc in (WalletTransaction.objects.filter(user=user, created_at__gte=lo, created_at__lt=hi)
                                  .values_list("created_at", "type", "amount", "description")[:MAX_EVENTS_PER_KIND]):
        out.append(_ev(at, "money", typ, f"{typ.replace('_', ' ').capitalize()} KES {amount:,.2f}", desc,
                       "success" if typ == "payout" else "neutral", amount=str(amount)))
    for hold in HeldPayout.objects.filter(user=user).filter(
            Q(created_at__gte=lo, created_at__lt=hi) | Q(decided_at__gte=lo, decided_at__lt=hi)).select_related("challenge"):
        codes = ", ".join(r.get("code", "") for r in (hold.reasons or []))
        if lo <= hold.created_at < hi:
            out.append(_ev(hold.created_at, "money", "payout_held", f"Payout KES {hold.amount:,.2f} held for review",
                           f'"{hold.challenge.name}" · {codes}', "warning", hold_id=hold.pk))
        if hold.decided_at and lo <= hold.decided_at < hi:
            out.append(_ev(hold.decided_at, "money", f"payout_{hold.status}",
                           f"Held payout {hold.status}", hold.note[:160],
                           "success" if hold.status == "released" else "danger", hold_id=hold.pk))
    return out


def _risk_events(user, start, end):
    from apps.risk_ml.models import RiskScore

    out = []
    for d, score, model, ctx, expl in (RiskScore.objects.filter(user=user, date__range=(start, end), score__gte=0.4)
                                       .values_list("date", "score", "model_version", "context", "explanations")):
        if (ctx or {}).get("supervised"):
            continue
        top = (expl or [{}])[0].get("text", "") if expl else ""
        out.append(_ev(d, "risk", "risk_score", f"Shadow risk score {round(score * 100)}",
                       top, "warning" if score < 0.7 else "danger", model=model))
    return out


def _linkage_events(user, lo, hi):
    User = get_user_model()
    out = []
    edges = list(LinkEdge.objects.filter(Q(user_a=user) | Q(user_b=user), first_detected_at__gte=lo,
                                         first_detected_at__lt=hi)
                 .values_list("user_a_id", "user_b_id", "edge_type", "strength", "first_detected_at", "active"))
    others = {b if a == user.pk else a for a, b, *_ in edges}
    marks = list(HouseholdMark.objects.filter(Q(user_a=user) | Q(user_b=user))
                 .filter(Q(created_at__gte=lo, created_at__lt=hi) | Q(revoked_at__gte=lo, revoked_at__lt=hi))
                 .values_list("user_a_id", "user_b_id", "created_at", "revoked_at", "note"))
    others |= {b if a == user.pk else a for a, b, *_ in marks}
    names = dict(User.objects.filter(pk__in=others).values_list("pk", "username"))
    labels = dict(LinkEdge.TYPE_CHOICES)
    tone = {"strong": "danger", "medium": "warning", "weak": "neutral"}
    for a, b, etype, strength, at, active in edges:
        other = b if a == user.pk else a
        out.append(_ev(at, "linkage", "link_detected", f"Linked to {names.get(other, other)}: {labels.get(etype, etype)}",
                       f"{strength} evidence" + ("" if active else " (no longer seen)"), tone.get(strength, "neutral"),
                       other_user_id=other, edge_type=etype, strength=strength))
    for a, b, created, revoked, note in marks:
        other = b if a == user.pk else a
        if lo <= created < hi:
            out.append(_ev(created, "linkage", "household_marked", f"Marked known household with {names.get(other, other)}",
                           note[:160], "info", other_user_id=other))
        if revoked and lo <= revoked < hi:
            out.append(_ev(revoked, "linkage", "household_revoked",
                           f"Household mark with {names.get(other, other)} removed", "", "info", other_user_id=other))
    return out


def build_timeline(user, start: date, end: date, categories=None) -> dict:
    categories = set(categories or CATEGORIES)
    lo, hi = _range_utc(start, end)
    events = []
    if "steps" in categories:
        events += _step_events(user, start, end)
    if "syncs" in categories:
        events += _sync_events(user, lo, hi)
    if "devices" in categories:
        events += _device_events(user, lo, hi)
    if "flags" in categories:
        events += _flag_events(user, lo, hi)
    if "trust" in categories:
        events += _trust_events(user, start, end)
    if "admin" in categories:
        events += _admin_events(user, lo, hi)
    if "money" in categories:
        events += _money_events(user, lo, hi)
    if "risk" in categories:
        events += _risk_events(user, start, end)
    if "linkage" in categories:
        events += _linkage_events(user, lo, hi)
    events.sort(key=lambda e: e["at"], reverse=True)
    return {"user_id": user.pk, "start": start.isoformat(), "end": end.isoformat(),
            "categories": sorted(categories), "days": _days(user, start, end), "events": events}
