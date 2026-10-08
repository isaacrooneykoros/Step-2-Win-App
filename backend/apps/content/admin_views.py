"""Staff endpoints (/api/admin/content/...): announcements and the help centre.

Every write is audited (AuditLog; resource_id = the integer primary key).
Announcements customers may have seen are archived, never deleted: only drafts
can be deleted. Help categories can be deleted only when they have no articles.
"""

import re
from datetime import datetime

from django.db import transaction
from django.shortcuts import get_object_or_404
from django.utils import timezone
from django.utils.dateparse import parse_datetime
from drf_spectacular.utils import OpenApiTypes, extend_schema
from rest_framework.decorators import api_view, permission_classes
from rest_framework.response import Response

from apps.admin_api.models import AuditLog
from apps.admin_api.roles import staff
from apps.core.sanitizers import sanitize_text

from .audience import reach
from .models import Announcement, HelpArticle, HelpCategory

# Reads: any staff (console.view); writes: content.announcements (content role).
ADMIN = staff("console.view", write="content.announcements")

LINK_RE = re.compile(r"^(https://[^\s<>\"']{3,290}|/[A-Za-z0-9/_\-?=&.#]{0,200})$")


def _audit(request, action, resource_type, obj, description, changes=None):
    AuditLog.log_action(
        admin=request.user, action=action, resource_type=resource_type, description=description,
        resource_id=obj.pk, resource_name=str(obj)[:255], changes=changes, request=request,
    )


def _dt(value):
    if value in (None, ""):
        return None
    if isinstance(value, datetime):
        return value
    parsed = parse_datetime(str(value))
    if parsed is None:
        raise ValueError
    if timezone.is_naive(parsed):
        parsed = timezone.make_aware(parsed)
    return parsed


# ── Announcements ──────────────────────────────────────────────────────────


def announcement_admin_json(a: Announcement, now=None) -> dict:
    now = now or timezone.now()
    return {
        "id": a.id,
        "title": a.title,
        "body": a.body,
        "severity": a.severity,
        "audience": a.audience,
        "segment": a.segment or None,
        "link_url": a.link_url or None,
        "link_label": a.link_label or None,
        "starts_at": a.starts_at.isoformat(),
        "ends_at": a.ends_at.isoformat() if a.ends_at else None,
        "dismissible": a.dismissible,
        "priority": a.priority,
        "status": a.status,
        "state": a.schedule_state(now),
        "published_at": a.published_at.isoformat() if a.published_at else None,
        "dismissals": a.dismissals.count(),
        "reach": reach(a),
        "created_by": a.created_by.username if a.created_by_id else None,
        "updated_by": a.updated_by.username if a.updated_by_id else None,
        "created_at": a.created_at.isoformat(),
        "updated_at": a.updated_at.isoformat(),
    }


ANNOUNCEMENT_FIELDS = ("title", "body", "severity", "audience", "segment", "link_url", "link_label",
                       "starts_at", "ends_at", "dismissible", "priority")


def _announcement_input(data, instance: Announcement | None):
    errors, out = {}, {}
    creating = instance is None
    for f in ANNOUNCEMENT_FIELDS:
        if f not in data and not (creating and f == "title"):
            continue
        v = data.get(f)
        if f == "title":
            v = sanitize_text(v or "")
            if not v:
                errors[f] = "Give the announcement a short title."
            elif len(v) > 120:
                errors[f] = "Keep the title under 120 characters."
        elif f == "body":
            v = sanitize_text(v or "")
            if len(v) > 1000:
                errors[f] = "Keep the message under 1,000 characters."
        elif f == "severity":
            if v not in dict(Announcement.SEVERITY_CHOICES):
                errors[f] = "Use info, warning or success."
        elif f == "audience":
            if v not in dict(Announcement.AUDIENCE_CHOICES):
                errors[f] = "Unknown audience."
        elif f == "segment":
            v = v or ""
            if v and v not in dict(Announcement.SEGMENT_CHOICES):
                errors[f] = "Unknown customer group."
        elif f == "link_url":
            v = str(v or "").strip()
            if v and not LINK_RE.match(v):
                errors[f] = "Use a full https:// address or an in-app path starting with /."
        elif f == "link_label":
            v = str(v or "").strip()
            if len(v) > 40:
                errors[f] = "Keep the button label under 40 characters."
        elif f in ("starts_at", "ends_at"):
            try:
                v = _dt(v)
            except ValueError:
                errors[f] = "Use a date and time."
                continue
            if f == "starts_at" and v is None:
                v = timezone.now()
        elif f == "dismissible":
            if not isinstance(v, bool):
                errors[f] = "Must be true or false."
        elif f == "priority":
            try:
                v = int(v)
            except (TypeError, ValueError):
                errors[f] = "Use a whole number."
                continue
            if not -100 <= v <= 100:
                errors[f] = "Use a number between -100 and 100."
        out[f] = v
    if errors:
        return None, errors
    merged = {f: out.get(f, getattr(instance, f, None)) for f in ANNOUNCEMENT_FIELDS}
    if merged.get("audience") == "segment" and not merged.get("segment"):
        errors["segment"] = "Pick the customer group."
    if merged.get("audience") != "segment" and "audience" in out:
        out["segment"] = ""
    starts, ends = merged.get("starts_at"), merged.get("ends_at")
    if starts and ends and ends <= starts:
        errors["ends_at"] = "The end must be after the start."
    if merged.get("link_label") and not merged.get("link_url"):
        errors["link_url"] = "Add the link the button opens, or remove the label."
    return (None, errors) if errors else (out, None)


def _diff(before: dict, after: dict) -> dict:
    return {k: {"old": before.get(k), "new": v} for k, v in after.items() if before.get(k) != v}


def _snapshot(a: Announcement) -> dict:
    d = {f: getattr(a, f) for f in ANNOUNCEMENT_FIELDS}
    for k in ("starts_at", "ends_at"):
        d[k] = d[k].isoformat() if d[k] else None
    return d


@extend_schema(request=OpenApiTypes.OBJECT, responses={200: OpenApiTypes.OBJECT})
@api_view(["GET", "POST"])
@permission_classes(ADMIN)
def announcements(request):
    if request.method == "POST":
        data, errors = _announcement_input(request.data or {}, None)
        if errors:
            return Response({"error": "Check the highlighted fields.", **errors}, status=400)
        a = Announcement.objects.create(created_by=request.user, updated_by=request.user, **data)
        _audit(request, "create", "announcement", a, f"Created announcement draft: {a.title}", _snapshot(a))
        return Response(announcement_admin_json(a), status=201)
    qs = Announcement.objects.select_related("created_by", "updated_by").order_by("-updated_at")
    status = request.query_params.get("status")
    if status in dict(Announcement.STATUS_CHOICES):
        qs = qs.filter(status=status)
    now = timezone.now()
    rows = [announcement_admin_json(a, now) for a in qs[:200]]
    return Response({"results": rows})


@extend_schema(request=OpenApiTypes.OBJECT, responses={200: OpenApiTypes.OBJECT})
@api_view(["GET", "PATCH", "DELETE"])
@permission_classes(ADMIN)
def announcement_detail(request, announcement_id):
    a = get_object_or_404(Announcement, pk=announcement_id)
    if request.method == "GET":
        return Response(announcement_admin_json(a))
    if request.method == "DELETE":
        if a.status != Announcement.STATUS_DRAFT or a.published_at:
            return Response(
                {"error": "Only drafts that were never published can be deleted. Archive it instead."},
                status=409,
            )
        _audit(request, "delete", "announcement", a, f"Deleted announcement draft: {a.title}", _snapshot(a))
        a.delete()
        return Response(status=204)
    if a.status == Announcement.STATUS_ARCHIVED:
        return Response({"error": "Archived announcements can't be edited. Duplicate it as a new draft."}, status=409)
    data, errors = _announcement_input(request.data or {}, a)
    if errors:
        return Response({"error": "Check the highlighted fields.", **errors}, status=400)
    before = _snapshot(a)
    for k, v in data.items():
        setattr(a, k, v)
    a.updated_by = request.user
    a.save()
    changes = _diff(before, _snapshot(a))
    if changes:
        _audit(request, "update", "announcement", a, f"Edited announcement: {a.title}"
               + (" (live)" if a.is_live() else ""), changes)
    return Response(announcement_admin_json(a))


@extend_schema(request=None, responses={200: OpenApiTypes.OBJECT})
@api_view(["POST"])
@permission_classes(ADMIN)
def announcement_publish(request, announcement_id):
    a = get_object_or_404(Announcement, pk=announcement_id)
    if a.status == Announcement.STATUS_PUBLISHED:
        return Response(announcement_admin_json(a))
    if a.ends_at and a.ends_at <= timezone.now():
        return Response({"error": "The end time has passed. Move it later before publishing."}, status=400)
    before = a.status
    a.status = Announcement.STATUS_PUBLISHED
    a.published_at = a.published_at or timezone.now()
    a.updated_by = request.user
    a.save()
    _audit(request, "publish", "announcement", a, f"Published announcement: {a.title}",
           {"status": {"old": before, "new": a.status}, "starts_at": a.starts_at.isoformat(),
            "audience": a.audience, "segment": a.segment or None})
    return Response(announcement_admin_json(a))


@extend_schema(request=None, responses={200: OpenApiTypes.OBJECT})
@api_view(["POST"])
@permission_classes(ADMIN)
def announcement_archive(request, announcement_id):
    """Unpublish: customers stop seeing it at once. Kept for the record."""
    a = get_object_or_404(Announcement, pk=announcement_id)
    if a.status == Announcement.STATUS_ARCHIVED:
        return Response(announcement_admin_json(a))
    before = a.status
    a.status = Announcement.STATUS_ARCHIVED
    a.updated_by = request.user
    a.save()
    _audit(request, "archive", "announcement", a, f"Archived announcement: {a.title}",
           {"status": {"old": before, "new": a.status}})
    return Response(announcement_admin_json(a))


@extend_schema(request=None, responses={201: OpenApiTypes.OBJECT})
@api_view(["POST"])
@permission_classes(ADMIN)
def announcement_duplicate(request, announcement_id):
    src = get_object_or_404(Announcement, pk=announcement_id)
    data = {f: getattr(src, f) for f in ANNOUNCEMENT_FIELDS}
    data["title"] = (f"Copy of {src.title}")[:120]
    data["starts_at"] = timezone.now()
    data["ends_at"] = None
    a = Announcement.objects.create(created_by=request.user, updated_by=request.user, **data)
    _audit(request, "create", "announcement", a, f"Duplicated announcement #{src.id} as a draft",
           {"source_id": src.id})
    return Response(announcement_admin_json(a), status=201)


# ── Help centre ────────────────────────────────────────────────────────────


def category_json(c: HelpCategory) -> dict:
    arts = list(c.articles.all())
    return {"id": c.id, "title": c.title, "description": c.description, "order": c.order,
            "is_published": c.is_published, "article_count": len(arts),
            "published_count": sum(1 for x in arts if x.is_published),
            "updated_at": c.updated_at.isoformat()}


def article_admin_json(a: HelpArticle) -> dict:
    return {"id": a.id, "category": a.category_id, "category_title": a.category.title, "title": a.title,
            "body": a.body, "order": a.order, "is_published": a.is_published,
            "updated_by": a.updated_by.username if a.updated_by_id else None,
            "created_at": a.created_at.isoformat(), "updated_at": a.updated_at.isoformat()}


def _category_input(data, creating):
    out, errors = {}, {}
    if "title" in data or creating:
        t = sanitize_text(data.get("title") or "")
        if not t:
            errors["title"] = "Give the category a name."
        elif len(t) > 80:
            errors["title"] = "Keep the name under 80 characters."
        out["title"] = t
    if "description" in data:
        d = sanitize_text(data.get("description") or "")
        if len(d) > 200:
            errors["description"] = "Keep the description under 200 characters."
        out["description"] = d
    if "is_published" in data:
        if not isinstance(data["is_published"], bool):
            errors["is_published"] = "Must be true or false."
        out["is_published"] = data.get("is_published")
    return out, errors


@extend_schema(request=OpenApiTypes.OBJECT, responses={200: OpenApiTypes.OBJECT})
@api_view(["GET", "POST"])
@permission_classes(ADMIN)
def help_categories(request):
    if request.method == "POST":
        data, errors = _category_input(request.data or {}, True)
        if errors:
            return Response({"error": "Check the highlighted fields.", **errors}, status=400)
        last = HelpCategory.objects.order_by("-order").values_list("order", flat=True).first() or 0
        c = HelpCategory.objects.create(order=last + 1, **data)
        _audit(request, "create", "faq_category", c, f"Created help category: {c.title}", data)
        return Response(category_json(c), status=201)
    qs = HelpCategory.objects.prefetch_related("articles").order_by("order", "id")
    return Response({"results": [category_json(c) for c in qs]})


@extend_schema(request=OpenApiTypes.OBJECT, responses={200: OpenApiTypes.OBJECT})
@api_view(["PATCH", "DELETE"])
@permission_classes(ADMIN)
def help_category_detail(request, category_id):
    c = get_object_or_404(HelpCategory, pk=category_id)
    if request.method == "DELETE":
        if c.articles.exists():
            return Response({"error": "Move or delete the articles in this category first."}, status=409)
        _audit(request, "delete", "faq_category", c, f"Deleted help category: {c.title}")
        c.delete()
        return Response(status=204)
    data, errors = _category_input(request.data or {}, False)
    if errors:
        return Response({"error": "Check the highlighted fields.", **errors}, status=400)
    before = {k: getattr(c, k) for k in data}
    for k, v in data.items():
        setattr(c, k, v)
    c.save()
    changes = _diff(before, data)
    if changes:
        action = "publish" if data.get("is_published") is True and before.get("is_published") is False else \
            "unpublish" if data.get("is_published") is False and before.get("is_published") is True else "update"
        _audit(request, action, "faq_category", c, f"Updated help category: {c.title}", changes)
    return Response(category_json(c))


def _reorder(request, model, qs_filter, resource_type, label):
    ids = request.data.get("ids")
    if not isinstance(ids, list) or not ids:
        return Response({"error": "Send ids in the new order."}, status=400)
    try:
        ids = [int(i) for i in ids]
    except (TypeError, ValueError):
        return Response({"error": "ids must be numbers."}, status=400)
    existing = set(model.objects.filter(**qs_filter).values_list("id", flat=True))
    if set(ids) != existing or len(ids) != len(existing):
        return Response({"error": "Send every item exactly once."}, status=400)
    with transaction.atomic():
        for position, pk in enumerate(ids, start=1):
            model.objects.filter(pk=pk).update(order=position)
    AuditLog.log_action(admin=request.user, action="reorder", resource_type=resource_type,
                        description=f"Reordered {label}", changes={"order": ids, **qs_filter}, request=request)
    return None


@extend_schema(request=OpenApiTypes.OBJECT, responses={200: OpenApiTypes.OBJECT})
@api_view(["POST"])
@permission_classes(ADMIN)
def help_categories_reorder(request):
    err = _reorder(request, HelpCategory, {}, "faq_category", "help categories")
    if err:
        return err
    qs = HelpCategory.objects.prefetch_related("articles").order_by("order", "id")
    return Response({"results": [category_json(c) for c in qs]})


def _article_input(data, creating):
    out, errors = {}, {}
    if "category" in data or creating:
        try:
            out["category"] = HelpCategory.objects.get(pk=int(data.get("category")))
        except (TypeError, ValueError, HelpCategory.DoesNotExist):
            errors["category"] = "Pick a category."
    if "title" in data or creating:
        t = sanitize_text(data.get("title") or "")
        if not t:
            errors["title"] = "Write the question or title."
        elif len(t) > 160:
            errors["title"] = "Keep the title under 160 characters."
        out["title"] = t
    if "body" in data or creating:
        b = sanitize_text(data.get("body") or "")
        if not b:
            errors["body"] = "Write the answer."
        elif len(b) > 10000:
            errors["body"] = "Keep the answer under 10,000 characters."
        out["body"] = b
    if "is_published" in data:
        if not isinstance(data["is_published"], bool):
            errors["is_published"] = "Must be true or false."
        out["is_published"] = data.get("is_published")
    return out, errors


@extend_schema(request=OpenApiTypes.OBJECT, responses={200: OpenApiTypes.OBJECT})
@api_view(["GET", "POST"])
@permission_classes(ADMIN)
def help_articles(request):
    if request.method == "POST":
        data, errors = _article_input(request.data or {}, True)
        if errors:
            return Response({"error": "Check the highlighted fields.", **errors}, status=400)
        last = HelpArticle.objects.filter(category=data["category"]).order_by("-order").values_list("order", flat=True).first() or 0
        a = HelpArticle.objects.create(order=last + 1, updated_by=request.user, **data)
        _audit(request, "create", "faq_article", a, f"Created help article: {a.title}",
               {"category": a.category_id, "is_published": a.is_published})
        return Response(article_admin_json(a), status=201)
    qs = HelpArticle.objects.select_related("category", "updated_by").order_by("category__order", "order", "id")
    cat = request.query_params.get("category")
    if cat and cat.isdigit():
        qs = qs.filter(category_id=int(cat))
    q = (request.query_params.get("q") or "").strip()
    if q:
        from django.db.models import Q

        qs = qs.filter(Q(title__icontains=q) | Q(body__icontains=q))
    return Response({"results": [article_admin_json(a) for a in qs[:500]]})


@extend_schema(request=OpenApiTypes.OBJECT, responses={200: OpenApiTypes.OBJECT})
@api_view(["PATCH", "DELETE"])
@permission_classes(ADMIN)
def help_article_detail(request, article_id):
    a = get_object_or_404(HelpArticle.objects.select_related("category"), pk=article_id)
    if request.method == "DELETE":
        _audit(request, "delete", "faq_article", a, f"Deleted help article: {a.title}",
               {"category": a.category_id, "was_published": a.is_published})
        a.delete()
        return Response(status=204)
    data, errors = _article_input(request.data or {}, False)
    if errors:
        return Response({"error": "Check the highlighted fields.", **errors}, status=400)
    before = {"category": a.category_id, "title": a.title, "body": a.body, "is_published": a.is_published}
    for k, v in data.items():
        setattr(a, k, v)
    a.updated_by = request.user
    a.save()
    after = {"category": a.category_id, "title": a.title, "body": a.body, "is_published": a.is_published}
    changes = _diff(before, after)
    if "body" in changes:
        changes["body"] = {"old": f"{len(before['body'])} chars", "new": f"{len(a.body)} chars"}
    if changes:
        action = "publish" if "is_published" in changes and a.is_published else \
            "unpublish" if "is_published" in changes else "update"
        _audit(request, action, "faq_article", a, f"Updated help article: {a.title}", changes)
    return Response(article_admin_json(a))


@extend_schema(request=OpenApiTypes.OBJECT, responses={200: OpenApiTypes.OBJECT})
@api_view(["POST"])
@permission_classes(ADMIN)
def help_articles_reorder(request):
    try:
        category_id = int(request.data.get("category"))
    except (TypeError, ValueError):
        return Response({"error": "category is required."}, status=400)
    err = _reorder(request, HelpArticle, {"category_id": category_id}, "faq_article", "help articles")
    if err:
        return err
    qs = HelpArticle.objects.filter(category_id=category_id).select_related("category").order_by("order", "id")
    return Response({"results": [article_admin_json(a) for a in qs]})
