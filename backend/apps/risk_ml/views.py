"""
Staff-only endpoints for the shadow risk model.

- GET  /api/admin/risk-ml/users/<id>/scores/?days=30  recent scores + reasons (read-only)
- POST /api/admin/risk-ml/labels/                     label a user-day (audited)
- GET  /api/admin/risk-ml/models/                     model artifacts (no payloads)

Nothing here changes steps, trust, standings or payouts.
"""

from __future__ import annotations

from datetime import date, timedelta

from django.contrib.auth import get_user_model
from django.shortcuts import get_object_or_404
from drf_spectacular.utils import OpenApiTypes, extend_schema
from rest_framework import permissions
from rest_framework.decorators import api_view, permission_classes
from rest_framework.response import Response

from apps.admin_api.models import AuditLog
from apps.admin_api.views import IsAdminUser

from .feature_store import local_today
from .labels import MAX_WINDOW_DAYS, upsert_label
from .models import Label, ModelArtifact, RiskScore

User = get_user_model()
ADMIN = [permissions.IsAuthenticated, IsAdminUser]
SHADOW_NOTE = ("Shadow mode: this score is recorded for evaluation only. It does not change steps, "
               "rankings, trust or payouts.")


def _score_row(s: RiskScore) -> dict:
    return {"date": s.date.isoformat(), "score": s.score, "model_version": s.model_version,
            "explanations": s.explanations, "context": s.context,
            "supervised": bool((s.context or {}).get("supervised")),
            "updated_at": s.updated_at.isoformat()}


def _label_row(lab: Label) -> dict:
    return {"id": lab.pk, "date_start": lab.date_start.isoformat(), "date_end": lab.date_end.isoformat(),
            "label": lab.label, "source": lab.source, "notes": lab.notes,
            "created_by": lab.created_by.username if lab.created_by_id else None,
            "created_at": lab.created_at.isoformat()}


@extend_schema(responses={200: OpenApiTypes.OBJECT})
@api_view(["GET"])
@permission_classes(ADMIN)
def user_risk_scores(request, user_id: int):
    user = get_object_or_404(User, pk=user_id)
    try:
        days = max(1, min(120, int(request.query_params.get("days", 30))))
    except (TypeError, ValueError):
        days = 30
    since = local_today() - timedelta(days=days - 1)
    rows = list(RiskScore.objects.filter(user=user, date__gte=since).order_by("-date", "model_version"))
    anomaly_rows = [r for r in rows if not (r.context or {}).get("supervised")]
    latest = anomaly_rows[0] if anomaly_rows else None
    labels = Label.objects.filter(user=user, date_end__gte=since).exclude(source=Label.SOURCE_SYNTHETIC) \
        .select_related("created_by").order_by("-date_start")[:50]
    active = {a.kind: a.version for a in ModelArtifact.objects.filter(is_active=True)}
    return Response({
        "user_id": user.pk,
        "shadow": True,
        "note": SHADOW_NOTE,
        "days": days,
        "latest": _score_row(latest) if latest else None,
        "scores": [_score_row(r) for r in rows],
        "labels": [_label_row(lab) for lab in labels],
        "active_models": active,
    })


def _parse_day(v):
    try:
        return date.fromisoformat(str(v)[:10]) if v else None
    except ValueError:
        return None


@extend_schema(request=OpenApiTypes.OBJECT, responses={201: OpenApiTypes.OBJECT, 400: OpenApiTypes.OBJECT})
@api_view(["POST"])
@permission_classes(ADMIN)
def label_user_day(request):
    data = request.data
    try:
        user_id = int(data.get("user_id"))
    except (TypeError, ValueError):
        return Response({"error": "user_id is required"}, status=400)
    user = get_object_or_404(User, pk=user_id)
    if user.pk == request.user.pk:
        return Response({"error": "You cannot label your own account."}, status=400)
    start = _parse_day(data.get("date_start") or data.get("date"))
    end = _parse_day(data.get("date_end")) or start
    if start is None:
        return Response({"error": "date (YYYY-MM-DD) is required"}, status=400)
    if end < start:
        return Response({"error": "date_end is before date_start"}, status=400)
    if (end - start).days > MAX_WINDOW_DAYS:
        return Response({"error": f"a label can cover at most {MAX_WINDOW_DAYS + 1} days"}, status=400)
    if end > local_today():
        return Response({"error": "can't label a day in the future"}, status=400)
    label = data.get("label")
    if label not in dict(Label.LABEL_CHOICES):
        return Response({"error": "label must be cheat, honest or unsure"}, status=400)
    notes = str(data.get("notes") or "").strip()
    if len(notes) > 1000:
        return Response({"error": "notes must be 1000 characters or fewer"}, status=400)

    obj, created = upsert_label(user_id=user.pk, date_start=start, date_end=end, label=label,
                                source=Label.SOURCE_ADMIN_MANUAL, source_ref=f"admin:{request.user.pk}",
                                notes=notes, created_by=request.user)
    AuditLog.log_action(
        admin=request.user,
        action="update",
        resource_type="user",
        resource_id=user.pk,
        resource_name=user.username,
        description=f"Risk-model label '{label}' for {user.username} ({start}"
                    + (f" to {end}" if end != start else "") + "). Shadow model only; no enforcement.",
        changes={"risk_label": label, "date_start": str(start), "date_end": str(end),
                 "label_id": obj.pk, "created": created, "notes": notes},
        request=request,
    )
    return Response({"status": "ok", "created": created, "label": _label_row(obj)}, status=201 if created else 200)


@extend_schema(responses={200: OpenApiTypes.OBJECT})
@api_view(["GET"])
@permission_classes(ADMIN)
def model_artifacts(request):
    rows = ModelArtifact.objects.defer("payload").order_by("-created_at")[:50]
    return Response({"shadow": True, "note": SHADOW_NOTE, "results": [
        {"version": a.version, "kind": a.kind, "feature_version": a.feature_version, "trained_on": a.trained_on,
         "is_active": a.is_active, "metrics": a.metrics, "model_card": a.model_card,
         "created_at": a.created_at.isoformat()} for a in rows]})
