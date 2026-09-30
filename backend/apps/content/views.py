"""Customer endpoints (/api/content/...).

GET  announcements/?platform=android|ios|web   live announcements for me (max 3)
POST announcements/<id>/dismiss/                hide a dismissible announcement for me
GET  help/?q=                                   published help categories + articles
"""

from django.db.models import Q
from django.utils import timezone
from drf_spectacular.utils import OpenApiTypes, extend_schema
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from .audience import PLATFORMS, matches
from .models import Announcement, AnnouncementDismissal, HelpArticle, HelpCategory

MAX_ANNOUNCEMENTS = 3


def announcement_json(a: Announcement) -> dict:
    return {
        "id": a.id,
        "title": a.title,
        "body": a.body,
        "severity": a.severity,
        "link_url": a.link_url or None,
        "link_label": a.link_label or None,
        "dismissible": a.dismissible,
        "starts_at": a.starts_at.isoformat(),
        "ends_at": a.ends_at.isoformat() if a.ends_at else None,
    }


def live_for(user, platform: str | None, now=None) -> list[Announcement]:
    now = now or timezone.now()
    qs = Announcement.objects.filter(status=Announcement.STATUS_PUBLISHED, starts_at__lte=now).filter(
        Q(ends_at__isnull=True) | Q(ends_at__gt=now)
    )
    dismissed = set(
        AnnouncementDismissal.objects.filter(user=user, announcement__in=qs).values_list("announcement_id", flat=True)
    )
    out = []
    for a in qs.order_by("-priority", "-starts_at", "-id")[:50]:
        if a.dismissible and a.id in dismissed:
            continue
        if not matches(a, user, platform):
            continue
        out.append(a)
        if len(out) >= MAX_ANNOUNCEMENTS:
            break
    return out


@extend_schema(responses={200: OpenApiTypes.OBJECT})
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def my_announcements(request):
    platform = (request.query_params.get("platform") or "").strip().lower()
    platform = platform if platform in PLATFORMS else None
    return Response({"results": [announcement_json(a) for a in live_for(request.user, platform)]})


@extend_schema(request=None, responses={200: OpenApiTypes.OBJECT})
@api_view(["POST"])
@permission_classes([IsAuthenticated])
def dismiss_announcement(request, announcement_id):
    a = Announcement.objects.filter(pk=announcement_id, status=Announcement.STATUS_PUBLISHED).first()
    if a is None:
        return Response({"error": "Announcement not found."}, status=404)
    if not a.dismissible:
        return Response({"error": "This announcement can't be dismissed."}, status=400)
    AnnouncementDismissal.objects.get_or_create(announcement=a, user=request.user)
    return Response({"dismissed": True, "id": a.id})


def article_json(a: HelpArticle) -> dict:
    return {"id": a.id, "title": a.title, "body": a.body, "updated_at": a.updated_at.isoformat()}


@extend_schema(responses={200: OpenApiTypes.OBJECT})
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def help_centre(request):
    q = (request.query_params.get("q") or "").strip()[:100]
    articles = HelpArticle.objects.filter(is_published=True, category__is_published=True).select_related("category")
    if q:
        cond = Q()
        for word in q.split()[:6]:
            cond &= Q(title__icontains=word) | Q(body__icontains=word)
        articles = articles.filter(cond)
    by_cat: dict[int, list] = {}
    for a in articles.order_by("category__order", "order", "id"):
        by_cat.setdefault(a.category_id, []).append(article_json(a))
    cats = HelpCategory.objects.filter(is_published=True).order_by("order", "id")
    return Response(
        {
            "query": q,
            "categories": [
                {"id": c.id, "title": c.title, "description": c.description, "articles": by_cat[c.id]}
                for c in cats
                if c.id in by_cat
            ],
            "total": sum(len(v) for v in by_cat.values()),
        }
    )
