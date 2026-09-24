"""
Helpdesk endpoints for the admin console's Support page.

Read-only views over the existing support models. Mutations (reply, status,
priority, assignment, staff note) still go through the original endpoints in
views.py so their audit logging and realtime broadcasts stay in one place.

Notice tickets: trust & safety decisions that include a message to the user
are delivered as *resolved* support tickets (see trust_views._notice_to_user).
They are marked `is_notice` here and kept out of the working queue unless the
user replies (which reopens them as a normal conversation).
"""

from django.contrib.auth import get_user_model
from django.db.models import (F, BooleanField, Case, Count, IntegerField,
                              OuterRef, Q, Subquery, Value, When)
from django.shortcuts import get_object_or_404
from django.utils import timezone
from drf_spectacular.utils import OpenApiTypes, extend_schema
from rest_framework import permissions
from rest_framework.decorators import api_view, permission_classes
from rest_framework.response import Response

from apps.admin_api.models import (AuditLog, SupportReplyTemplate,
                                   SupportTag, SupportTicket,
                                   SupportTicketMessage)
from apps.admin_api.support_rules import overdue_q, sla_hours, with_wait_start
from apps.admin_api.serializers import (SupportTicketMessageSerializer,
                                        SupportTicketSerializer)
from apps.admin_api.views import IsAdminUser

User = get_user_model()

ADMIN = [permissions.IsAuthenticated, IsAdminUser]

# Must match the body written by trust_views._notice_to_user.
NOTICE_MESSAGE = "Notice from the Step2Win trust & safety team."
NOTICE_Q = Q(category="account", message=NOTICE_MESSAGE)

ACTIVE = ["open", "in_progress"]
DONE = ["resolved", "closed"]
VIEWS = {"active", "awaiting", "overdue", "mine", "unassigned", "resolved", "notices", "all"}
PRIORITY_RANK = Case(
    When(priority="urgent", then=Value(0)),
    When(priority="high", then=Value(1)),
    When(priority="medium", then=Value(2)),
    default=Value(3),
    output_field=IntegerField(),
)


def _annotated():
    last = SupportTicketMessage.objects.filter(ticket=OuterRef("pk")).order_by("-created_at", "-id")
    first_staff = SupportTicketMessage.objects.filter(ticket=OuterRef("pk"), is_admin=True).order_by("created_at", "id")
    return (
        SupportTicket.objects.select_related("user", "assigned_to")
        .prefetch_related("tags")
        .annotate(
            last_message_at=Subquery(last.values("created_at")[:1]),
            last_message_is_admin=Subquery(last.values("is_admin")[:1]),
            last_message_text=Subquery(last.values("message")[:1]),
            first_staff_reply_at=Subquery(first_staff.values("created_at")[:1]),
            n_messages=Count("messages", distinct=True),
            priority_rank=PRIORITY_RANK,
            is_notice=Case(When(NOTICE_Q, then=Value(True)), default=Value(False), output_field=BooleanField()),
        )
    )


def _hours_since(value, now):
    if not value:
        return None
    return round((now - value).total_seconds() / 3600, 2)


def _serialize(ticket, now, targets=None):
    targets = targets or sla_hours()
    data = SupportTicketSerializer(ticket).data
    data["message_count"] = getattr(ticket, "n_messages", data.get("message_count"))
    active = ticket.status in ACTIVE
    last_is_admin = ticket.last_message_is_admin
    # Waiting on staff when the customer spoke last (or nobody has yet).
    waiting_on = None
    waiting_since = None
    if active:
        if last_is_admin:
            waiting_on = "user"
        else:
            waiting_on = "staff"
            waiting_since = ticket.last_message_at or ticket.created_at
    preview = (ticket.last_message_text or ticket.message or "").strip().replace("\n", " ")
    waiting_hours = _hours_since(waiting_since, now)
    target = targets.get(ticket.priority, 24)
    overdue = waiting_on == "staff" and waiting_hours is not None and waiting_hours >= target
    escalated = bool(
        waiting_on == "staff"
        and ticket.escalated_at
        and waiting_since
        and ticket.escalated_at >= waiting_since
    )
    data.update(
        {
            "tags": [tag.name for tag in ticket.tags.all()],
            "sla_target_hours": target,
            "overdue": overdue,
            "escalated": escalated,
            "escalated_at": ticket.escalated_at,
            "is_notice": bool(ticket.is_notice),
            "user_email": ticket.user.email if ticket.user_id else None,
            "last_message_at": ticket.last_message_at,
            "last_message_is_admin": last_is_admin,
            "last_message_preview": preview[:160],
            "first_staff_reply_at": ticket.first_staff_reply_at,
            "waiting_on": waiting_on,
            "waiting_since": waiting_since,
            "waiting_hours": waiting_hours,
            "age_hours": _hours_since(ticket.created_at, now),
        }
    )
    return data


def _apply_view(qs, view, user, now=None, targets=None):
    if view == "active":
        return qs.filter(status__in=ACTIVE)
    if view == "awaiting":
        return qs.filter(status__in=ACTIVE).filter(Q(last_message_is_admin=False) | Q(last_message_is_admin__isnull=True))
    if view == "overdue":
        awaiting = with_wait_start(_apply_view(qs, "awaiting", user))
        return awaiting.filter(overdue_q(now or timezone.now(), targets or sla_hours()))
    if view == "mine":
        return qs.filter(status__in=ACTIVE, assigned_to=user)
    if view == "unassigned":
        return qs.filter(status__in=ACTIVE, assigned_to__isnull=True)
    if view == "resolved":
        return qs.filter(status__in=DONE).exclude(NOTICE_Q)
    if view == "notices":
        return qs.filter(NOTICE_Q)
    # "all": every conversation, but untouched notices stay out.
    return qs.exclude(Q(NOTICE_Q) & Q(status__in=DONE))


@extend_schema(responses={200: OpenApiTypes.OBJECT})
@api_view(["GET"])
@permission_classes(ADMIN)
def support_queue(request):
    """Ticket queue with helpdesk views, filters, counts and waiting times.

    Query: view (active|awaiting|overdue|mine|unassigned|resolved|notices|all),
    status, priority, category, tag, assigned_to (id|unassigned), q,
    sort (priority|oldest|newest|updated), limit, offset.
    """
    p = request.query_params
    view = p.get("view", "active")
    if view not in VIEWS:
        return Response({"error": f"Unknown view. Use one of: {', '.join(sorted(VIEWS))}"}, status=400)

    base = _annotated()
    for field, choices in (
        ("status", SupportTicket.STATUS_CHOICES),
        ("priority", SupportTicket.PRIORITY_CHOICES),
        ("category", SupportTicket.CATEGORY_CHOICES),
    ):
        value = p.get(field)
        if value:
            if value not in {c[0] for c in choices}:
                return Response({"error": f"Invalid {field}"}, status=400)
            base = base.filter(**{field: value})

    assigned = p.get("assigned_to")
    if assigned:
        if assigned == "unassigned":
            base = base.filter(assigned_to__isnull=True)
        elif assigned.isdigit():
            base = base.filter(assigned_to_id=int(assigned))
        else:
            return Response({"error": "Invalid assigned_to"}, status=400)

    tag = (p.get("tag") or "").strip().lower()
    if tag:
        base = base.filter(tags__name=tag)

    q = (p.get("q") or "").strip()
    if q:
        cond = Q(subject__icontains=q) | Q(message__icontains=q) | Q(user__username__icontains=q) | Q(user__email__icontains=q)
        if q.lstrip("#").isdigit():
            cond |= Q(id=int(q.lstrip("#")))
        base = base.filter(cond)

    try:
        limit = max(1, min(100, int(p.get("limit", 50))))
        offset = max(0, int(p.get("offset", 0)))
    except ValueError:
        return Response({"error": "Invalid pagination parameters"}, status=400)

    now = timezone.now()
    targets = sla_hours()
    qs = _apply_view(base, view, request.user, now, targets)
    sort = p.get("sort") or ("updated" if view in {"resolved", "notices", "all"} else "priority")
    ordering = {
        "priority": ["priority_rank", "last_message_at", "created_at"],
        "oldest": ["last_message_at", "created_at"],
        "newest": ["-created_at"],
        "updated": ["-updated_at"],
    }.get(sort)
    if ordering is None:
        return Response({"error": "Invalid sort"}, status=400)
    qs = qs.order_by(*ordering, "id")

    total = qs.count()
    rows = [_serialize(t, now, targets) for t in qs[offset : offset + limit]]

    counts = {v: _apply_view(base, v, request.user, now, targets).count() for v in VIEWS}
    awaiting = _apply_view(base, "awaiting", request.user)
    urgent_active = _apply_view(base, "active", request.user).filter(priority__in=["urgent", "high"]).count()
    oldest = awaiting.order_by("last_message_at", "created_at").first()
    oldest_wait = None
    if oldest:
        oldest_wait = _hours_since(oldest.last_message_at or oldest.created_at, now)

    return Response(
        {
            "view": view,
            "total": total,
            "results": rows,
            "counts": counts,
            "urgent_active": urgent_active,
            "oldest_waiting_hours": oldest_wait,
            "sla_hours": targets,
        }
    )


@extend_schema(responses={200: OpenApiTypes.OBJECT, 404: OpenApiTypes.OBJECT})
@api_view(["GET"])
@permission_classes(ADMIN)
def support_conversation(request, ticket_id):
    """One ticket with its messages and the staff activity on it (audit trail)."""
    ticket = get_object_or_404(_annotated(), pk=ticket_id)
    messages = ticket.messages.select_related("sender").order_by("created_at", "id")
    events = AuditLog.objects.filter(resource_type="support", resource_id=ticket.id).order_by("created_at")[:200]
    return Response(
        {
            "ticket": _serialize(ticket, timezone.now()),
            "messages": SupportTicketMessageSerializer(messages, many=True).data,
            "events": [
                {
                    "id": e.id,
                    "admin_username": e.admin_username,
                    "action": e.action,
                    "description": e.description,
                    "changes": e.changes,
                    "created_at": e.created_at,
                }
                for e in events
            ],
        }
    )


# ── Tags ────────────────────────────────────────────────────────────────────

MAX_TAGS_PER_TICKET = 10


def _clean_tag(raw) -> str:
    name = " ".join(str(raw or "").strip().lower().split())
    return name[:40]


@extend_schema(request=OpenApiTypes.OBJECT, responses={200: OpenApiTypes.OBJECT})
@api_view(["GET", "POST"])
@permission_classes(ADMIN)
def support_tags(request):
    """GET: every tag with how many open tickets carry it. POST {name}: create."""
    if request.method == "POST":
        name = _clean_tag(request.data.get("name"))
        if not name:
            return Response({"name": "Enter a tag name."}, status=400)
        tag, created = SupportTag.objects.get_or_create(name=name)
        return Response({"id": tag.id, "name": tag.name}, status=201 if created else 200)
    tags = SupportTag.objects.annotate(
        open_count=Count("tickets", filter=Q(tickets__status__in=ACTIVE), distinct=True),
        total_count=Count("tickets", distinct=True),
    ).order_by("name")
    return Response(
        {
            "results": [
                {"id": t.id, "name": t.name, "open_count": t.open_count, "total_count": t.total_count}
                for t in tags
            ]
        }
    )


@extend_schema(responses={204: None})
@api_view(["DELETE"])
@permission_classes(ADMIN)
def support_tag_delete(request, tag_id):
    tag = get_object_or_404(SupportTag, pk=tag_id)
    tag.delete()
    return Response(status=204)


@extend_schema(request=OpenApiTypes.OBJECT, responses={200: OpenApiTypes.OBJECT})
@api_view(["POST"])
@permission_classes(ADMIN)
def support_ticket_tags(request, ticket_id):
    """Replace a ticket's tags. Body: {"tags": ["refund", "mpesa-delay"]}. Unknown names are created."""
    ticket = get_object_or_404(SupportTicket, pk=ticket_id)
    raw = request.data.get("tags")
    if not isinstance(raw, list):
        return Response({"tags": "Send a list of tag names."}, status=400)
    names = []
    for item in raw:
        name = _clean_tag(item)
        if name and name not in names:
            names.append(name)
    if len(names) > MAX_TAGS_PER_TICKET:
        return Response({"tags": f"Use at most {MAX_TAGS_PER_TICKET} tags."}, status=400)
    before = sorted(ticket.tags.values_list("name", flat=True))
    tags = [SupportTag.objects.get_or_create(name=n)[0] for n in names]
    ticket.tags.set(tags)
    after = sorted(names)
    if before != after:
        AuditLog.log_action(
            admin=request.user,
            action="update",
            resource_type="support",
            resource_id=ticket.id,
            resource_name=ticket.subject,
            description=f"Updated tags on support ticket #{ticket.id}",
            changes={"tags": {"old": ", ".join(before) or None, "new": ", ".join(after) or None}},
            request=request,
        )
    return Response({"id": ticket.id, "tags": after})


# ── Saved replies ───────────────────────────────────────────────────────────

CATEGORIES = {c[0] for c in SupportTicket.CATEGORY_CHOICES}


def _template_json(t: SupportReplyTemplate):
    return {
        "id": t.id,
        "title": t.title,
        "body": t.body,
        "category": t.category or None,
        "usage_count": t.usage_count,
        "created_by": t.created_by.username if t.created_by_id else None,
        "created_at": t.created_at,
        "updated_at": t.updated_at,
    }


def _template_input(data, partial=False):
    errors, out = {}, {}
    if "title" in data or not partial:
        title = str(data.get("title") or "").strip()
        if not title:
            errors["title"] = "Give the reply a short name."
        elif len(title) > 120:
            errors["title"] = "Keep the name under 120 characters."
        out["title"] = title
    if "body" in data or not partial:
        body = str(data.get("body") or "").strip()
        if not body:
            errors["body"] = "Write the reply text."
        elif len(body) > 5000:
            errors["body"] = "Keep the reply under 5,000 characters."
        out["body"] = body
    if "category" in data:
        category = data.get("category") or ""
        if category and category not in CATEGORIES:
            errors["category"] = "Unknown category."
        out["category"] = category
    return out, errors


@extend_schema(request=OpenApiTypes.OBJECT, responses={200: OpenApiTypes.OBJECT})
@api_view(["GET", "POST"])
@permission_classes(ADMIN)
def support_templates(request):
    """GET: saved replies (most used first within title order is left to the client). POST: create."""
    if request.method == "POST":
        data, errors = _template_input(request.data)
        if errors:
            return Response(errors, status=400)
        t = SupportReplyTemplate.objects.create(created_by=request.user, **data)
        return Response(_template_json(t), status=201)
    qs = SupportReplyTemplate.objects.select_related("created_by").order_by("-usage_count", "title")
    return Response({"results": [_template_json(t) for t in qs]})


@extend_schema(request=OpenApiTypes.OBJECT, responses={200: OpenApiTypes.OBJECT})
@api_view(["PATCH", "DELETE"])
@permission_classes(ADMIN)
def support_template_detail(request, template_id):
    t = get_object_or_404(SupportReplyTemplate, pk=template_id)
    if request.method == "DELETE":
        t.delete()
        return Response(status=204)
    data, errors = _template_input(request.data, partial=True)
    if errors:
        return Response(errors, status=400)
    for k, v in data.items():
        setattr(t, k, v)
    t.save()
    return Response(_template_json(t))


@extend_schema(responses={200: OpenApiTypes.OBJECT})
@api_view(["POST"])
@permission_classes(ADMIN)
def support_template_used(request, template_id):
    """Count an insert so the most useful replies float to the top."""
    updated = SupportReplyTemplate.objects.filter(pk=template_id).update(usage_count=F("usage_count") + 1)
    if not updated:
        return Response({"error": "Saved reply not found"}, status=404)
    return Response({"ok": True})