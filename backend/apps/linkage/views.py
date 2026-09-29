"""
Staff-only account-linkage endpoints (mounted at /api/admin/linkage/).

- GET   users/<id>/linked/      the account's cluster, members, edge evidence, households
- GET   users/<id>/timeline/    evidence timeline (?days=30 | ?start=&end=, ?types=a,b)
- GET   clusters/               clusters, largest first (?min_size=2&limit=100)
- POST  households/             mark accounts as a known household (audited)
- POST  households/<id>/revoke/ remove a household mark (audited)
- GET   settings/  PATCH settings/   linkage policy switches (PATCH audited)
"""

from __future__ import annotations

from django.contrib.auth import get_user_model
from django.db import transaction
from django.db.models import Q
from django.shortcuts import get_object_or_404
from django.utils import timezone
from drf_spectacular.utils import OpenApiTypes, extend_schema
from rest_framework import permissions, status
from rest_framework.decorators import api_view, permission_classes
from rest_framework.response import Response

from apps.admin_api.models import AuditLog
from apps.admin_api.views import IsAdminUser

from .graph import summarize_pair
from .models import (HouseholdMark, LinkageRun, LinkageSettings, LinkCluster,
                     LinkClusterMember, LinkEdge)
from .store import rebuild_clusters
from .timeline import build_timeline, parse_categories, parse_range

User = get_user_model()
ADMIN = [permissions.IsAuthenticated, IsAdminUser]
NOTE_MIN, NOTE_MAX = 5, 1000
MAX_HOUSEHOLD = 12
MAX_MEMBERS = 50

POLICY_NOTE = ("Links only hold payouts for review. They never ban or change steps. Weak links "
               "(similar phone numbers, same home network) are shown as context only. Families "
               "often share a phone or an M-Pesa number: mark them as a known household.")


def explain(edge_type: str, ev: dict) -> str:
    ev = ev or {}
    if edge_type == LinkEdge.TYPE_SHARED_DEVICE:
        n = ev.get("accounts_on_device", 2)
        return (f"Both accounts registered phone {ev.get('device', '')} ({ev.get('platform') or 'unknown'})."
                + (f" {n} accounts used this phone." if n > 2 else ""))
    if edge_type in (LinkEdge.TYPE_SHARED_PAYOUT_ACCOUNT, LinkEdge.TYPE_SHARED_DEPOSIT_NUMBER):
        kind = {"mpesa": "M-Pesa number", "bank": "bank account", "paybill": "paybill account"}.get(
            ev.get("kind"), "account")
        roles = ev.get("roles") or {}
        a = ", ".join(roles.get("a") or []) or "-"
        b = ", ".join(roles.get("b") or []) or "-"
        n = ev.get("accounts_sharing", 2)
        return (f"Same {kind} {ev.get('account', '')}: used as {a} by one account and {b} by the other."
                + (f" {n} accounts share it." if n > 2 else ""))
    if edge_type == LinkEdge.TYPE_PHONE_SEQUENCE:
        return (f"Phone numbers {ev.get('number_gap')} apart, registered "
                f"{ev.get('joined_days_apart')} days apart.")
    if edge_type == LinkEdge.TYPE_SHARED_NETWORK:
        return f"Signed in from the same home-sized network ({ev.get('accounts_on_network')} accounts on it)."
    if edge_type == LinkEdge.TYPE_CO_LOCATION:
        return (f"Walked within about 100 m of each other at the same time for "
                f"{ev.get('minutes_together')} minutes over {ev.get('days_together')} day(s).")
    if edge_type == LinkEdge.TYPE_TWIN_CURVES:
        return f"Near-identical hour-by-hour steps on {ev.get('twin_days')} day(s)."
    if edge_type == LinkEdge.TYPE_JOINT_CHALLENGES:
        return (f"Joined {ev.get('challenges_together')} small challenges together and both qualified in "
                f"{ev.get('both_qualified')} ({ev.get('joined_within_30_min')} joined within 30 minutes).")
    if edge_type == LinkEdge.TYPE_HANDOVER:
        parts = []
        if ev.get("handover_days"):
            parts.append(f"steps alternate between the accounts hour by hour on {ev['handover_days']} day(s)")
        if ev.get("daily_correlation") is not None:
            parts.append(f"daily totals move in opposite directions (correlation {ev['daily_correlation']})")
        return ("One account walks exactly when the other stops: " + "; ".join(parts) + ".") if parts else ""
    return ""


def _person(u, trust=None, cluster=None) -> dict:
    return {"user_id": u.pk, "username": u.username,
            "joined": u.date_joined.isoformat() if u.date_joined else None,
            "is_active": bool(u.is_active and not getattr(u, "deleted_at", None)),
            "trust_status": getattr(trust, "status", None) if trust else None,
            "cluster": cluster}


def _edge_row(e: LinkEdge, households) -> dict:
    return {
        "id": e.pk, "user_a": e.user_a_id, "user_b": e.user_b_id, "edge_type": e.edge_type,
        "label": e.get_edge_type_display(), "strength": e.strength, "weight": e.weight,
        "evidence": e.evidence, "explanation": explain(e.edge_type, e.evidence),
        "evidence_first_at": e.evidence_first_at.isoformat() if e.evidence_first_at else None,
        "evidence_last_at": e.evidence_last_at.isoformat() if e.evidence_last_at else None,
        "first_detected_at": e.first_detected_at.isoformat(), "active": e.active,
        "household": (e.user_a_id, e.user_b_id) in households,
    }


def _mark_row(m: HouseholdMark, names) -> dict:
    return {"id": m.pk, "user_a": m.user_a_id, "user_b": m.user_b_id,
            "usernames": [names.get(m.user_a_id), names.get(m.user_b_id)], "note": m.note,
            "created_by": m.created_by.username if m.created_by_id else None,
            "created_at": m.created_at.isoformat(), "active": m.revoked_at is None,
            "revoked_at": m.revoked_at.isoformat() if m.revoked_at else None,
            "revoked_by": m.revoked_by.username if m.revoked_by_id else None,
            "revoke_note": m.revoke_note}


@extend_schema(responses={200: OpenApiTypes.OBJECT})
@api_view(["GET"])
@permission_classes(ADMIN)
def user_linked_accounts(request, user_id: int):
    from apps.challenges.models import HeldPayout
    from apps.steps.models import TrustScore

    user = get_object_or_404(User, pk=user_id)
    cfg = LinkageSettings.load()
    membership = LinkClusterMember.objects.filter(user=user).select_related("cluster").first()
    cluster = membership.cluster if membership else None
    member_ids = set(cluster.members.values_list("user_id", flat=True)[:MAX_MEMBERS]) if cluster else set()

    edges = list(LinkEdge.objects.filter(
        Q(user_a=user) | Q(user_b=user) | (Q(user_a_id__in=member_ids) & Q(user_b_id__in=member_ids)))
        .order_by("-active", "user_a_id", "user_b_id", "edge_type")[:500])
    ids = member_ids | {user.pk} | {e.user_a_id for e in edges} | {e.user_b_id for e in edges}
    marks = list(HouseholdMark.objects.filter(Q(user_a_id__in=ids) & Q(user_b_id__in=ids))
                 .select_related("created_by", "revoked_by"))
    active_marks = {(m.user_a_id, m.user_b_id) for m in marks if m.revoked_at is None}
    users = {u.pk: u for u in User.objects.filter(pk__in=ids)}
    trust = {t.user_id: t for t in TrustScore.objects.filter(user_id__in=ids)}
    clusters_of = dict(LinkClusterMember.objects.filter(user_id__in=ids).values_list("user_id", "cluster__key"))
    names = {pk: u.username for pk, u in users.items()}

    pairs = {}
    for e in edges:
        if e.active:
            pairs.setdefault((e.user_a_id, e.user_b_id), []).append((e.edge_type, e.strength, e.weight))
    pair_rows = []
    for (a, b), pe in pairs.items():
        s = summarize_pair(pe, float(cfg.medium_link_threshold))
        pair_rows.append({"user_a": a, "user_b": b, **s, "household": (a, b) in active_marks})
    pair_rows.sort(key=lambda p: (-int(p["linked"]), -p["score"]))

    holds = [
        {"id": h.pk, "user_id": h.user_id, "username": names.get(h.user_id), "challenge_id": h.challenge_id,
         "challenge_name": h.challenge.name, "amount": str(h.amount), "status": h.status,
         "created_at": h.created_at.isoformat(),
         "linked_reason": next((r.get("detail") for r in (h.reasons or []) if r.get("code") == "linked_accounts"), None)}
        for h in HeldPayout.objects.filter(user_id__in=member_ids | {user.pk}).select_related("challenge")
        .order_by("-created_at")[:50]
    ]
    return Response({
        "user_id": user.pk,
        "cluster": None if cluster is None else {
            "key": cluster.key, "size": cluster.size, "strong_pairs": cluster.strong_pairs,
            "medium_pairs": cluster.medium_pairs, "max_pair_score": cluster.max_pair_score,
            "first_seen_at": cluster.first_seen_at.isoformat(), "computed_at": cluster.computed_at.isoformat()},
        "accounts": [_person(users[i], trust.get(i), clusters_of.get(i)) for i in sorted(ids) if i in users],
        "pairs": pair_rows,
        "edges": [_edge_row(e, active_marks) for e in edges],
        "households": [_mark_row(m, names) for m in marks],
        "holds": holds,
        "last_run": _last_run(),
        "policy_note": POLICY_NOTE,
    })


def _last_run():
    run = LinkageRun.objects.filter(finished_at__isnull=False).first()
    if run is None:
        return None
    return {"finished_at": run.finished_at.isoformat(), "ok": run.ok,
            "seconds": (run.stats or {}).get("seconds")}


@extend_schema(responses={200: OpenApiTypes.OBJECT})
@api_view(["GET"])
@permission_classes(ADMIN)
def user_timeline(request, user_id: int):
    user = get_object_or_404(User, pk=user_id)
    start, end = parse_range(request.query_params)
    return Response(build_timeline(user, start, end, parse_categories(request.query_params.get("types"))))


@extend_schema(responses={200: OpenApiTypes.OBJECT})
@api_view(["GET"])
@permission_classes(ADMIN)
def cluster_list(request):
    try:
        min_size = max(2, int(request.query_params.get("min_size", 2)))
        limit = max(1, min(200, int(request.query_params.get("limit", 100))))
    except (TypeError, ValueError):
        min_size, limit = 2, 100
    rows = list(LinkCluster.objects.filter(size__gte=min_size).order_by("-size", "-max_pair_score", "key")[:limit])
    members = {}
    for key, uid, username in (LinkClusterMember.objects.filter(cluster__in=rows)
                               .values_list("cluster__key", "user_id", "user__username").order_by("user_id")):
        members.setdefault(key, []).append({"user_id": uid, "username": username})
    return Response({
        "count": LinkCluster.objects.filter(size__gte=min_size).count(),
        "last_run": _last_run(),
        "results": [{"key": c.key, "size": c.size, "strong_pairs": c.strong_pairs, "medium_pairs": c.medium_pairs,
                     "max_pair_score": c.max_pair_score, "first_seen_at": c.first_seen_at.isoformat(),
                     "members": members.get(c.key, [])[:12]} for c in rows],
    })


def _clean_note(raw):
    note = str(raw or "").strip()
    if len(note) < NOTE_MIN:
        return None, f"A note of at least {NOTE_MIN} characters is required."
    if len(note) > NOTE_MAX:
        return None, f"The note must be {NOTE_MAX} characters or fewer."
    return note, None


def _audit(request, user_id, username, description, changes):
    AuditLog.log_action(admin=request.user, action="update", resource_type="user", resource_id=user_id,
                        resource_name=username, description=description,
                        changes={"kind": "linkage_household", **changes}, request=request)


@extend_schema(request=OpenApiTypes.OBJECT, responses={201: OpenApiTypes.OBJECT})
@api_view(["POST"])
@permission_classes(ADMIN)
def mark_household(request):
    raw = request.data.get("user_ids") or []
    try:
        ids = sorted({int(x) for x in raw})
    except (TypeError, ValueError):
        return Response({"error": "user_ids must be a list of account ids."}, status=status.HTTP_400_BAD_REQUEST)
    if not (2 <= len(ids) <= MAX_HOUSEHOLD):
        return Response({"error": f"Choose between 2 and {MAX_HOUSEHOLD} accounts."},
                        status=status.HTTP_400_BAD_REQUEST)
    note, err = _clean_note(request.data.get("note"))
    if err:
        return Response({"error": err}, status=status.HTTP_400_BAD_REQUEST)
    users = {u.pk: u for u in User.objects.filter(pk__in=ids)}
    if len(users) != len(ids):
        return Response({"error": "Unknown account in the list."}, status=status.HTTP_400_BAD_REQUEST)
    created = []
    with transaction.atomic():
        for i, a in enumerate(ids):
            for b in ids[i + 1:]:
                mark, new = HouseholdMark.objects.get_or_create(
                    user_a_id=a, user_b_id=b, defaults={"note": note, "created_by": request.user})
                if not new:
                    mark.note, mark.created_by, mark.created_at = note, request.user, timezone.now()
                    mark.revoked_at = mark.revoked_by = None
                    mark.revoke_note = ""
                    mark.save()
                created.append(mark.pk)
        names = ", ".join(users[i].username for i in ids)
        for uid in ids:
            _audit(request, uid, users[uid].username,
                   f"Marked known household: {names}",
                   {"action": "mark", "user_ids": ids, "mark_ids": created, "note": note})
    clusters = rebuild_clusters()
    return Response({"marks": created, "user_ids": ids, "clusters": clusters}, status=status.HTTP_201_CREATED)


@extend_schema(request=OpenApiTypes.OBJECT, responses={200: OpenApiTypes.OBJECT})
@api_view(["POST"])
@permission_classes(ADMIN)
def revoke_household(request, mark_id: int):
    note, err = _clean_note(request.data.get("note"))
    if err:
        return Response({"error": err}, status=status.HTTP_400_BAD_REQUEST)
    with transaction.atomic():
        mark = get_object_or_404(HouseholdMark.objects.select_for_update().select_related("user_a", "user_b"),
                                 pk=mark_id)
        if mark.revoked_at is not None:
            return Response({"id": mark.pk, "already_revoked": True})
        mark.revoked_at, mark.revoked_by, mark.revoke_note = timezone.now(), request.user, note
        mark.save(update_fields=["revoked_at", "revoked_by", "revoke_note"])
        for u in (mark.user_a, mark.user_b):
            _audit(request, u.pk, u.username,
                   f"Removed known-household mark: {mark.user_a.username}, {mark.user_b.username}",
                   {"action": "revoke", "mark_id": mark.pk, "user_ids": [mark.user_a_id, mark.user_b_id],
                    "note": note})
    rebuild_clusters()
    return Response({"id": mark.pk, "revoked": True})


@extend_schema(request=OpenApiTypes.OBJECT, responses={200: OpenApiTypes.OBJECT})
@api_view(["GET", "PATCH"])
@permission_classes(ADMIN)
def linkage_settings(request):
    cfg = LinkageSettings.load()
    if request.method == "GET":
        return Response({**cfg.as_dict(), "bounds": cfg.BOUNDS, "policy_note": POLICY_NOTE})
    changes, errors = {}, {}
    for field in cfg.EDITABLE:
        if field not in request.data:
            continue
        value = request.data[field]
        current = getattr(cfg, field)
        try:
            if isinstance(current, bool):
                if not isinstance(value, bool):
                    raise ValueError
            elif isinstance(current, int):
                value = int(value)
            else:
                value = float(value)
        except (TypeError, ValueError):
            errors[field] = "Invalid value."
            continue
        lo, hi = cfg.BOUNDS.get(field, (None, None))
        if lo is not None and not (lo <= value <= hi):
            errors[field] = f"Must be between {lo} and {hi}."
            continue
        if value != current:
            changes[field] = {"from": current, "to": value}
            setattr(cfg, field, value)
    if errors:
        return Response({"errors": errors}, status=status.HTTP_400_BAD_REQUEST)
    if changes:
        cfg.updated_by = request.user
        cfg.save()
        AuditLog.log_action(admin=request.user, action="settings_change", resource_type="settings",
                            resource_name="Account linkage settings",
                            description="Updated account linkage settings: " + ", ".join(sorted(changes)),
                            changes={"kind": "linkage_settings", **changes}, request=request)
        if "medium_link_threshold" in changes:
            rebuild_clusters(cfg)
    return Response({**cfg.as_dict(), "bounds": cfg.BOUNDS, "changed": sorted(changes)})
