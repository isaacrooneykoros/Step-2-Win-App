"""
Admin console Part B: ops, anti-cheat policy versions and support desk actions.

* Scheduled jobs: pause / resume (every runner respects it) and run history.
* Privacy data exports queue: status, failure reason, retry. Staff never get the ZIP.
* Anti-cheat policy (steps.AntiCheatPolicy, read by steps/security.py): list versions,
  create a new version from the active one (validated), activate / roll back
  (superuser only). The active version is never edited in place.
* Support desk: open a ticket to a user (outbound), merge duplicate tickets, bulk
  assign / close.

Every write is audited. AuditLog.resource_id is an integer: UUIDs go in `changes`.
Permissions: IsAdminUser for now; `# ROLE:` markers show the intended staff role.
"""

from __future__ import annotations

import copy
import numbers

from django.contrib.auth import get_user_model
from django.db import transaction
from django.shortcuts import get_object_or_404
from django.utils import timezone
from drf_spectacular.utils import OpenApiTypes, extend_schema
from rest_framework import permissions
from rest_framework.decorators import api_view, permission_classes
from rest_framework.response import Response

from apps.admin_api import scheduler
from apps.admin_api.models import (AuditLog, ScheduledJobRun,
                                   ScheduledJobState, SupportTicket,
                                   SupportTicketMessage)
from apps.admin_api.views import IsAdminUser

User = get_user_model()
ADMIN = [permissions.IsAuthenticated, IsAdminUser]
REASON_MIN = 5


def _reason(request, key="reason", required=True):
    text = str((request.data or {}).get(key) or "").strip()[:255]
    if required and len(text) < REASON_MIN:
        return None, Response({"error": f"A reason of at least {REASON_MIN} characters is required."}, status=400)
    return text, None


def _superuser_only(request):
    if not request.user.is_superuser:
        return Response({"error": "Only a superuser can do this."}, status=403)
    return None


# ── Scheduled jobs ───────────────────────────────────────────────────────────


def _run_json(r: ScheduledJobRun) -> dict:
    return {"id": r.id, "trigger": r.trigger, "started_at": r.started_at, "finished_at": r.finished_at,
            "status": r.status, "duration_ms": r.duration_ms, "error": r.error or None, "result": r.result or None}


@extend_schema(responses={200: OpenApiTypes.OBJECT})
@api_view(["GET"])
@permission_classes(ADMIN)
def job_runs(request, name):
    # ROLE: settings
    if scheduler.get_job(name) is None:
        return Response({"detail": "Unknown job."}, status=404)
    rows = ScheduledJobRun.objects.filter(name=name).order_by("-started_at", "-id")[: ScheduledJobRun.RUN_HISTORY_PER_JOB]
    return Response({"name": name, "results": [_run_json(r) for r in rows]})


@extend_schema(request=OpenApiTypes.OBJECT, responses={200: OpenApiTypes.OBJECT})
@api_view(["POST"])
@permission_classes(ADMIN)
def job_pause(request, name):
    # ROLE: settings
    job = scheduler.get_job(name)
    if job is None:
        return Response({"detail": "Unknown job."}, status=404)
    reason, err = _reason(request)
    if err:
        return err
    state = scheduler.get_state(name)
    if not state.paused:
        ScheduledJobState.objects.filter(pk=state.pk).update(
            paused=True, paused_at=timezone.now(), paused_by=request.user.username, pause_reason=reason
        )
        AuditLog.log_action(
            admin=request.user, action="pause", resource_type="scheduled_job", resource_id=state.pk,
            resource_name=name, description=f"Paused scheduled job {name}",
            changes={"job": name, "reason": reason}, request=request,
        )
    return Response(_job_row(name))


@extend_schema(request=None, responses={200: OpenApiTypes.OBJECT})
@api_view(["POST"])
@permission_classes(ADMIN)
def job_resume(request, name):
    # ROLE: settings
    if scheduler.get_job(name) is None:
        return Response({"detail": "Unknown job."}, status=404)
    state = scheduler.get_state(name)
    if state.paused:
        ScheduledJobState.objects.filter(pk=state.pk).update(paused=False, paused_at=None, paused_by="", pause_reason="")
        AuditLog.log_action(
            admin=request.user, action="resume", resource_type="scheduled_job", resource_id=state.pk,
            resource_name=name, description=f"Resumed scheduled job {name}",
            changes={"job": name, "was_paused_by": state.paused_by, "reason": state.pause_reason}, request=request,
        )
    return Response(_job_row(name))


def _job_row(name):
    return next((r for r in scheduler.job_rows() if r["name"] == name), {"name": name})


# ── Privacy data export queue ───────────────────────────────────────────────


def _export_json(e) -> dict:
    # Never the archive itself, its hash, or anything from inside it.
    return {
        "id": str(e.id), "user_id": e.user_id, "username": e.user.username if e.user_id else None,
        "status": e.status, "status_label": e.get_status_display(), "requested_at": e.requested_at,
        "started_at": e.started_at, "finished_at": e.finished_at, "expires_at": e.expires_at,
        "attempts": e.attempts, "size_bytes": e.size_bytes, "download_count": e.download_count,
        "last_downloaded_at": e.last_downloaded_at, "error": e.error or None,
    }


@extend_schema(responses={200: OpenApiTypes.OBJECT})
@api_view(["GET"])
@permission_classes(ADMIN)
def export_queue(request):
    # ROLE: trust
    from apps.privacy.models import DataExportRequest

    qs = DataExportRequest.objects.select_related("user").defer("archive").order_by("-requested_at")
    status = request.query_params.get("status")
    if status in dict(DataExportRequest.STATUS_CHOICES):
        qs = qs.filter(status=status)
    q = (request.query_params.get("q") or "").strip()
    if q:
        qs = qs.filter(user__username__icontains=q)
    counts = {s: DataExportRequest.objects.filter(status=s).count() for s, _ in DataExportRequest.STATUS_CHOICES}
    return Response({"counts": counts, "results": [_export_json(e) for e in qs[:200]]})


@extend_schema(request=None, responses={200: OpenApiTypes.OBJECT})
@api_view(["POST"])
@permission_classes(ADMIN)
def export_retry(request, export_id):
    # ROLE: trust
    from apps.privacy.models import DataExportRequest

    e = get_object_or_404(DataExportRequest.objects.select_related("user").defer("archive"), pk=export_id)
    if e.status != DataExportRequest.STATUS_FAILED:
        return Response({"error": "Only failed exports can be retried."}, status=409)
    before = {"status": e.status, "attempts": e.attempts, "error": e.error}
    DataExportRequest.objects.filter(pk=e.pk, status=DataExportRequest.STATUS_FAILED).update(
        status=DataExportRequest.STATUS_PENDING, attempts=0, error="", started_at=None
    )
    AuditLog.log_action(
        admin=request.user, action="retry", resource_type="data_export", resource_id=e.user_id,
        resource_name=e.user.username if e.user_id else "", description="Retried a failed data export",
        changes={"export_id": str(e.id), "before": before}, request=request,
    )
    e.refresh_from_db()
    return Response(_export_json(e))


# ── Anti-cheat policy versions ───────────────────────────────────────────────

POLICY_VERSION_MAX = 64


def default_policy_config() -> dict:
    """The built-in policy used when no version is active (steps/security.py)."""
    from apps.steps.security import DEFAULT_ANTICHEAT_POLICY

    return copy.deepcopy(DEFAULT_ANTICHEAT_POLICY)


def validate_policy_config(config, base: dict) -> list[str]:
    """Same shape as the base: same sections, known keys, numbers stay numbers in range."""
    errors: list[str] = []
    if not isinstance(config, dict) or not config:
        return ["The policy must be a JSON object with sections."]
    for section, values in config.items():
        if section not in base:
            errors.append(f"Unknown section '{section}'. Allowed: {', '.join(sorted(base))}.")
            continue
        if not isinstance(values, dict):
            errors.append(f"'{section}' must be an object.")
            continue
        for key, value in values.items():
            if key not in base[section]:
                errors.append(f"Unknown setting '{section}.{key}'.")
                continue
            ref = base[section][key]
            if isinstance(ref, bool):
                if not isinstance(value, bool):
                    errors.append(f"'{section}.{key}' must be true or false.")
                continue
            if isinstance(ref, numbers.Number):
                if isinstance(value, bool) or not isinstance(value, numbers.Number):
                    errors.append(f"'{section}.{key}' must be a number.")
                    continue
                if value < 0:
                    errors.append(f"'{section}.{key}' can't be negative.")
                if key.endswith("_threshold") and value > 1:
                    errors.append(f"'{section}.{key}' is a probability between 0 and 1.")
                if section == "trust" and value > 100:
                    errors.append(f"'{section}.{key}' is a trust score (0-100).")
    for section, values in base.items():
        missing = [k for k in (values or {}) if k not in (config.get(section) or {})]
        if section not in config or missing:
            errors.append(f"'{section}' is missing: {', '.join(missing) or 'the whole section'}.")
    trust = config.get("trust") or {}
    if isinstance(trust, dict) and all(isinstance(trust.get(k), numbers.Number) for k in ("min_trust_score", "max_trust_score")):
        if trust["min_trust_score"] >= trust["max_trust_score"]:
            errors.append("trust.min_trust_score must be below trust.max_trust_score.")
    return errors


def _policy_json(p, with_config=True) -> dict:
    out = {"id": str(p.id), "version": p.version, "is_active": p.is_active, "description": p.description or "",
           "created_at": p.created_at, "updated_at": p.updated_at}
    if with_config:
        out["config"] = p.config
    return out


@extend_schema(request=OpenApiTypes.OBJECT, responses={200: OpenApiTypes.OBJECT})
@api_view(["GET", "POST"])
@permission_classes(ADMIN)
def anticheat_policies(request):
    # ROLE: trust (read) / owner (create)
    from apps.steps.models import AntiCheatPolicy

    if request.method == "GET":
        rows = AntiCheatPolicy.objects.order_by("-created_at")[:100]
        active = next((p for p in rows if p.is_active), None)
        return Response({
            "active_version": active.version if active else None,
            "default_config": default_policy_config(),
            "results": [_policy_json(p) for p in rows],
        })

    denied = _superuser_only(request)
    if denied:
        return denied
    data = request.data or {}
    version = str(data.get("version") or "").strip()
    if not version or len(version) > POLICY_VERSION_MAX:
        return Response({"version": "Give the new version a name (up to 64 characters)."}, status=400)
    if AntiCheatPolicy.objects.filter(version=version).exists():
        return Response({"version": "That version name is already used."}, status=400)
    active = AntiCheatPolicy.objects.filter(is_active=True).first()
    base = active.config if active else default_policy_config()
    config = data.get("config")
    errors = validate_policy_config(config, base)
    if errors:
        return Response({"error": errors[0], "errors": errors}, status=400)
    description, err = _reason(request, "description")
    if err:
        return Response({"description": "Describe what changed and why (at least 5 characters)."}, status=400)
    p = AntiCheatPolicy.objects.create(version=version, is_active=False, description=description, config=config)
    changed = {
        f"{s}.{k}": {"old": (base.get(s) or {}).get(k), "new": v}
        for s, vals in config.items() for k, v in vals.items() if (base.get(s) or {}).get(k) != v
    }
    AuditLog.log_action(
        admin=request.user, action="create", resource_type="anticheat_policy", resource_name=version,
        description=f"Created anti-cheat policy version {version} (inactive) from "
                    f"{active.version if active else 'the built-in default'}",
        changes={"policy_id": str(p.id), "based_on": active.version if active else "default", "changed": changed},
        request=request,
    )
    return Response(_policy_json(p), status=201)


@extend_schema(request=OpenApiTypes.OBJECT, responses={200: OpenApiTypes.OBJECT})
@api_view(["POST"])
@permission_classes(ADMIN)
def anticheat_policy_activate(request, policy_id):
    # ROLE: owner
    from apps.steps.models import AntiCheatPolicy

    denied = _superuser_only(request)
    if denied:
        return denied
    reason, err = _reason(request)
    if err:
        return err
    p = get_object_or_404(AntiCheatPolicy, pk=policy_id)
    with transaction.atomic():
        previous = AntiCheatPolicy.objects.select_for_update().filter(is_active=True).exclude(pk=p.pk).first()
        AntiCheatPolicy.objects.filter(is_active=True).exclude(pk=p.pk).update(is_active=False)
        AntiCheatPolicy.objects.filter(pk=p.pk).update(is_active=True)
    AuditLog.log_action(
        admin=request.user, action="activate", resource_type="anticheat_policy", resource_name=p.version,
        description=f"Activated anti-cheat policy {p.version}"
                    + (f" (was {previous.version})" if previous else ""),
        changes={"policy_id": str(p.id), "previous": previous.version if previous else None, "reason": reason},
        request=request,
    )
    p.refresh_from_db()
    return Response(_policy_json(p))


# ── Support desk: outbound, merge, bulk ─────────────────────────────────────


def _broadcast(ticket):
    try:
        from apps.admin_api.realtime import broadcast_support_ticket

        broadcast_support_ticket(ticket.id, {"id": ticket.id, "status": ticket.status, "priority": ticket.priority,
                                             "assigned_to": ticket.assigned_to_id,
                                             "updated_at": ticket.updated_at.isoformat()})
    except Exception:  # noqa: BLE001 - realtime is best effort
        pass


def _ticket_json(t: SupportTicket) -> dict:
    return {"id": t.id, "user": t.user_id, "user_username": t.user.username, "subject": t.subject,
            "category": t.category, "status": t.status, "priority": t.priority,
            "assigned_to": t.assigned_to_id, "created_at": t.created_at, "updated_at": t.updated_at}


@extend_schema(request=OpenApiTypes.OBJECT, responses={201: OpenApiTypes.OBJECT})
@api_view(["POST"])
@permission_classes(ADMIN)
def support_outbound(request):
    """Open a ticket to a user. Body: {user_id, subject, message, category?, priority?}.

    The ticket lands in the user's in-app Support inbox, assigned to the sender and
    waiting on the user's reply (status in_progress).
    """
    # ROLE: content (support agents)
    data = request.data or {}
    try:
        user = User.objects.get(pk=int(data.get("user_id")))
    except (TypeError, ValueError, User.DoesNotExist):
        return Response({"user_id": "User not found."}, status=404)
    if getattr(user, "deleted_at", None) is not None:
        return Response({"user_id": "This account was deleted."}, status=409)
    subject = str(data.get("subject") or "").strip()
    message = str(data.get("message") or "").strip()
    errors = {}
    if not subject:
        errors["subject"] = "Add a subject."
    elif len(subject) > 255:
        errors["subject"] = "Keep the subject under 255 characters."
    if not message:
        errors["message"] = "Write the message."
    elif len(message) > 5000:
        errors["message"] = "Keep the message under 5,000 characters."
    category = data.get("category") or "general"
    if category not in dict(SupportTicket.CATEGORY_CHOICES):
        errors["category"] = "Unknown category."
    priority = data.get("priority") or "medium"
    if priority not in dict(SupportTicket.PRIORITY_CHOICES):
        errors["priority"] = "Unknown priority."
    if errors:
        return Response({"error": next(iter(errors.values())), **errors}, status=400)
    with transaction.atomic():
        ticket = SupportTicket.objects.create(
            user=user, subject=subject, category=category, message=message, status="in_progress",
            priority=priority, assigned_to=request.user,
        )
        SupportTicketMessage.objects.create(
            ticket=ticket, sender=request.user, sender_username=request.user.username, is_admin=True, message=message,
        )
    AuditLog.log_action(
        admin=request.user, action="create", resource_type="support", resource_id=ticket.id, resource_name=subject,
        description=f"Opened support ticket #{ticket.id} to {user.username}",
        changes={"outbound": True, "user_id": user.id, "category": category, "priority": priority}, request=request,
    )
    _broadcast(ticket)
    return Response({**_ticket_json(ticket), "outbound": True}, status=201)


@extend_schema(request=OpenApiTypes.OBJECT, responses={200: OpenApiTypes.OBJECT})
@api_view(["POST"])
@permission_classes(ADMIN)
def support_merge(request, ticket_id):
    """Merge duplicates into this ticket. Body: {duplicate_ids: [..]}.

    Messages move to this ticket (kept in time order), tags are combined, each
    duplicate is closed with a note pointing here. Same customer only.
    """
    # ROLE: content (support agents)
    target = get_object_or_404(SupportTicket.objects.select_related("user"), pk=ticket_id)
    raw = (request.data or {}).get("duplicate_ids")
    if not isinstance(raw, list) or not raw:
        return Response({"duplicate_ids": "Pick the duplicate tickets."}, status=400)
    try:
        ids = sorted({int(x) for x in raw} - {target.id})
    except (TypeError, ValueError):
        return Response({"duplicate_ids": "Ticket ids must be numbers."}, status=400)
    if not ids or len(ids) > 20:
        return Response({"duplicate_ids": "Pick between 1 and 20 other tickets."}, status=400)
    dups = list(SupportTicket.objects.filter(pk__in=ids))
    if len(dups) != len(ids):
        return Response({"duplicate_ids": "Some tickets were not found."}, status=404)
    if any(d.user_id != target.user_id for d in dups):
        return Response({"duplicate_ids": "Only tickets from the same customer can be merged."}, status=400)
    moved = 0
    with transaction.atomic():
        for d in dups:
            moved += SupportTicketMessage.objects.filter(ticket=d).update(ticket=target)
            target.tags.add(*d.tags.all())
            d.status = "closed"
            d.resolved_at = timezone.now()
            note = f"Merged into #{target.id} by {request.user.username}."
            d.admin_notes = f"{d.admin_notes}\n{note}".strip()
            d.save(update_fields=["status", "resolved_at", "admin_notes", "updated_at"])
            SupportTicketMessage.objects.create(
                ticket=d, sender=request.user, sender_username=request.user.username, is_admin=True,
                message=f"This conversation continues in ticket #{target.id} ({target.subject}).",
            )
        if target.status in ("resolved", "closed"):
            target.status = "in_progress"
            target.resolved_at = None
        target.save()
    for d in dups:
        AuditLog.log_action(
            admin=request.user, action="merge", resource_type="support", resource_id=d.id, resource_name=d.subject,
            description=f"Merged support ticket #{d.id} into #{target.id}",
            changes={"merged_into": target.id}, request=request,
        )
        _broadcast(d)
    AuditLog.log_action(
        admin=request.user, action="merge", resource_type="support", resource_id=target.id, resource_name=target.subject,
        description=f"Merged {len(dups)} duplicate ticket(s) into #{target.id}",
        changes={"duplicates": ids, "messages_moved": moved}, request=request,
    )
    _broadcast(target)
    target.refresh_from_db()
    return Response({**_ticket_json(target), "merged": ids, "messages_moved": moved})


BULK_ACTIONS = ("assign", "unassign", "close", "resolve", "reopen")


@extend_schema(request=OpenApiTypes.OBJECT, responses={200: OpenApiTypes.OBJECT})
@api_view(["POST"])
@permission_classes(ADMIN)
def support_bulk(request):
    """Body: {ticket_ids: [..], action: assign|unassign|close|resolve|reopen, assigned_to?}."""
    # ROLE: content (support agents)
    data = request.data or {}
    action = data.get("action")
    if action not in BULK_ACTIONS:
        return Response({"action": f"Use one of: {', '.join(BULK_ACTIONS)}."}, status=400)
    try:
        ids = sorted({int(x) for x in (data.get("ticket_ids") or [])})
    except (TypeError, ValueError):
        return Response({"ticket_ids": "Ticket ids must be numbers."}, status=400)
    if not ids or len(ids) > 200:
        return Response({"ticket_ids": "Pick between 1 and 200 tickets."}, status=400)
    assignee = None
    if action == "assign":
        try:
            assignee = User.objects.get(pk=int(data.get("assigned_to")), is_staff=True, is_active=True)
        except (TypeError, ValueError, User.DoesNotExist):
            return Response({"assigned_to": "Pick an active staff member."}, status=400)
    tickets = list(SupportTicket.objects.filter(pk__in=ids))
    now = timezone.now()
    changed = []
    with transaction.atomic():
        for t in tickets:
            before = {"status": t.status, "assigned_to": t.assigned_to_id}
            if action == "assign":
                t.assigned_to = assignee
            elif action == "unassign":
                t.assigned_to = None
            elif action in ("close", "resolve"):
                t.status = "closed" if action == "close" else "resolved"
                t.resolved_at = now
            elif action == "reopen":
                t.status = "open"
                t.resolved_at = None
            after = {"status": t.status, "assigned_to": t.assigned_to_id}
            if after != before:
                t.save()
                changed.append(t)
                AuditLog.log_action(
                    admin=request.user, action="bulk_update", resource_type="support", resource_id=t.id,
                    resource_name=t.subject, description=f"Bulk {action} on support ticket #{t.id}",
                    changes={"old": before, "new": after}, request=request,
                )
    for t in changed:
        _broadcast(t)
    return Response({"action": action, "requested": len(ids), "found": len(tickets), "updated": sorted(t.id for t in changed)})
