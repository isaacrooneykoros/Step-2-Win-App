"""
Support desk rules driven by SystemSettings:

- response targets (hours by priority) -> overdue filter for the queue
- auto-assignment of new tickets (off | round_robin | category)
- escalation of tickets waiting past their target (Celery beat, idempotent)
"""

from __future__ import annotations

import logging
from datetime import timedelta

from django.contrib.auth import get_user_model
from django.db.models import Q
from django.db.models.functions import Coalesce
from django.utils import timezone

from apps.admin_api.models import AuditLog, SupportTicket, SystemSettings

logger = logging.getLogger(__name__)
User = get_user_model()

PRIORITIES = ("urgent", "high", "medium", "low")
NEXT_PRIORITY = {"low": "medium", "medium": "high", "high": "urgent"}
AUTO_ASSIGN_MODES = ("off", "round_robin", "category")


def sla_hours(s: SystemSettings | None = None) -> dict[str, int]:
    s = s or SystemSettings.load()
    return {p: int(getattr(s, f"support_sla_{p}_hours")) for p in PRIORITIES}


def with_wait_start(qs):
    """Annotate when the customer started waiting (needs _annotated() fields)."""
    return qs.annotate(wait_start=Coalesce("last_message_at", "created_at"))


def overdue_q(now, targets: dict[str, int]) -> Q:
    cond = Q(pk__in=[])
    for p, hours in targets.items():
        cond |= Q(priority=p, wait_start__lte=now - timedelta(hours=hours))
    return cond


# ── Auto-assignment ─────────────────────────────────────────────────────────


def pick_assignee(ticket: SupportTicket, s: SystemSettings) -> int | None:
    mode = s.support_auto_assign_mode
    if mode not in ("round_robin", "category"):
        return None
    staff_ids = set(
        User.objects.filter(is_staff=True, is_active=True).values_list("id", flat=True)
    )
    if mode == "category":
        uid = (s.support_category_assignees or {}).get(ticket.category)
        try:
            if uid is not None and int(uid) in staff_ids:
                return int(uid)
        except (TypeError, ValueError):
            pass
    agents = []
    for raw in s.support_agent_ids or []:
        try:
            uid = int(raw)
        except (TypeError, ValueError):
            continue
        if uid in staff_ids and uid not in agents:
            agents.append(uid)
    agents.sort()
    if not agents:
        return None
    # Round robin: the agent after whoever got the most recent ticket.
    last = (
        SupportTicket.objects.filter(assigned_to_id__in=agents)
        .exclude(pk=ticket.pk)
        .order_by("-created_at", "-id")
        .values_list("assigned_to_id", flat=True)
        .first()
    )
    if last is None:
        return agents[0]
    return agents[(agents.index(last) + 1) % len(agents)]


def auto_assign(ticket: SupportTicket) -> int | None:
    """Assign a new ticket according to the configured rule. Never raises."""
    try:
        if ticket.assigned_to_id:
            return None
        s = SystemSettings.load()
        uid = pick_assignee(ticket, s)
        if not uid:
            return None
        ticket.assigned_to_id = uid
        ticket.save(update_fields=["assigned_to"])
        username = User.objects.filter(pk=uid).values_list("username", flat=True).first()
        rule = "category rule" if s.support_auto_assign_mode == "category" else "round robin"
        AuditLog.log_action(
            admin=None,
            action="update",
            resource_type="support",
            resource_id=ticket.id,
            resource_name=ticket.subject,
            description=f"Auto-assigned support ticket #{ticket.id} to {username} ({rule})",
            changes={"assigned_to": {"old": None, "new": username}},
        )
        return uid
    except Exception:
        logger.exception("Support auto-assignment failed for ticket %s", ticket.pk)
        return None


# ── Escalation ──────────────────────────────────────────────────────────────


def escalate_overdue(now=None) -> int:
    """Flag (and optionally raise the priority of) tickets past their target.

    Idempotent: a ticket escalates at most once per waiting episode — it is
    skipped while escalated_at is newer than the moment the customer started
    waiting. A new customer message after a staff reply starts a new episode.
    """
    from apps.admin_api.support_views import _annotated, _apply_view

    s = SystemSettings.load()
    if not s.support_escalation_enabled:
        return 0
    now = now or timezone.now()
    targets = sla_hours(s)
    qs = with_wait_start(_apply_view(_annotated(), "awaiting", None)).filter(
        overdue_q(now, targets)
    )
    count = 0
    for t in qs:
        if t.escalated_at and t.escalated_at >= t.wait_start:
            continue
        waited = (now - t.wait_start).total_seconds() / 3600
        changes = {"escalated": {"old": None, "new": f"over {targets[t.priority]}h target"}}
        fields = ["escalated_at"]
        t.escalated_at = now
        if s.support_escalation_raise_priority and t.priority in NEXT_PRIORITY:
            changes["priority"] = {"old": t.priority, "new": NEXT_PRIORITY[t.priority]}
            t.priority = NEXT_PRIORITY[t.priority]
            fields.append("priority")
        SupportTicket.objects.filter(pk=t.pk).update(**{f: getattr(t, f) for f in fields})
        AuditLog.log_action(
            admin=None,
            action="update",
            resource_type="support",
            resource_id=t.id,
            resource_name=t.subject,
            description=f"Escalated support ticket #{t.id}: customer waiting {waited:.1f}h",
            changes=changes,
        )
        count += 1
    return count
