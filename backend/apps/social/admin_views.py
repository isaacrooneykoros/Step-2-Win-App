"""Staff endpoints (/api/admin/social/...): social settings, reports queue, team moderation.

Every change is written to the admin AuditLog.
"""

from __future__ import annotations

from datetime import timedelta

from django.db.models import Count, Q
from django.utils import timezone
from rest_framework import permissions
from rest_framework.decorators import api_view, permission_classes
from rest_framework.response import Response

from apps.admin_api.models import AuditLog
from apps.admin_api.views import IsAdminUser

from . import teams as teams_svc
from .common import SocialError, current_week_start
from .models import (FeedEvent, Friendship, SocialReport, SocialSettings, Team,
                     TeamMembership, TeamWeeklyTotal, WeeklyStepTotal)
from .views import social_endpoint

ADMIN = [permissions.IsAuthenticated, IsAdminUser]

SETTINGS_FIELDS = {
    "social_enabled": bool,
    "feed_enabled": bool,
    "teams_enabled": bool,
    "max_team_members": int,
    "max_teams_per_user": int,
    "max_friends": int,
    "friend_requests_per_day": int,
}
LIMITS = {
    "max_team_members": (2, 500),
    "max_teams_per_user": (1, 20),
    "max_friends": (10, 5000),
    "friend_requests_per_day": (1, 500),
}


def _settings_payload(s: SocialSettings) -> dict:
    return {**{f: getattr(s, f) for f in SETTINGS_FIELDS}, "updated_at": s.updated_at.isoformat() if s.updated_at else None}


@api_view(["GET", "PATCH"])
@permission_classes(ADMIN)
@social_endpoint
def social_settings_view(request):
    s = SocialSettings.load()
    if request.method == "PATCH":
        data = request.data or {}
        before, changed = {}, []
        for field, typ in SETTINGS_FIELDS.items():
            if field not in data:
                continue
            value = data[field]
            if typ is bool and not isinstance(value, bool):
                raise SocialError("invalid_" + field, f"{field} must be true or false.", 400)
            if typ is int:
                try:
                    value = int(value)
                except (TypeError, ValueError):
                    raise SocialError("invalid_" + field, f"{field} must be a number.", 400)
                lo, hi = LIMITS[field]
                if not lo <= value <= hi:
                    raise SocialError("invalid_" + field, f"{field} must be between {lo} and {hi}.", 400)
            before[field] = getattr(s, field)
            setattr(s, field, value)
            changed.append(field)
        if changed:
            s.updated_by = request.user
            s.save()
            AuditLog.log_action(
                request.user, "settings_change", "settings", "Social settings updated",
                resource_name="social",
                changes={f: {"from": before[f], "to": getattr(s, f)} for f in changed},
                request=request,
            )
    return Response(_settings_payload(s))


@api_view(["GET"])
@permission_classes(ADMIN)
def overview(request):
    ws = current_week_start()
    return Response(
        {
            "friendships": Friendship.objects.count() // 2,
            "teams": Team.objects.filter(is_disabled=False).count(),
            "disabled_teams": Team.objects.filter(is_disabled=True).count(),
            "open_reports": SocialReport.objects.filter(status=SocialReport.OPEN).count(),
            "ranked_this_week": WeeklyStepTotal.objects.filter(week_start=ws, steps__gt=0).count(),
            "feed_items_7d": FeedEvent.objects.filter(created_at__gte=timezone.now() - timedelta(days=7)).count(),
            "week_start": ws.isoformat(),
        }
    )


def _user_ref(u) -> dict | None:
    if u is None:
        return None
    return {"id": u.id, "username": u.username, "is_active": u.is_active, "deleted": u.deleted_at is not None}


def _team_ref(t: Team | None) -> dict | None:
    if t is None:
        return None
    owner = TeamMembership.objects.filter(team=t, role=TeamMembership.OWNER).select_related("user").first()
    return {
        "id": t.id, "name": t.name, "description": t.description, "visibility": t.visibility,
        "member_count": t.member_count, "is_disabled": t.is_disabled, "disabled_reason": t.disabled_reason,
        "owner": _user_ref(owner.user) if owner else None, "created_at": t.created_at.isoformat(),
    }


def _report_row(r: SocialReport) -> dict:
    return {
        "id": r.id,
        "target_type": r.target_type,
        "target_user": _user_ref(r.target_user),
        "target_team": _team_ref(r.target_team),
        "reporter": _user_ref(r.reporter),
        "reason": r.reason,
        "reason_label": r.get_reason_display(),
        "details": r.details,
        "status": r.status,
        "reviewed_by": r.reviewed_by.username if r.reviewed_by else None,
        "reviewed_at": r.reviewed_at.isoformat() if r.reviewed_at else None,
        "resolution_note": r.resolution_note,
        "created_at": r.created_at.isoformat(),
        # How many open reports point at the same target: repeated reports rise first.
        "target_open_reports": SocialReport.objects.filter(
            status=SocialReport.OPEN,
            **({"target_user_id": r.target_user_id} if r.target_type == "user" else {"target_team_id": r.target_team_id}),
        ).count(),
    }


@api_view(["GET"])
@permission_classes(ADMIN)
def reports(request):
    status = request.query_params.get("status", SocialReport.OPEN)
    qs = SocialReport.objects.select_related("reporter", "target_user", "target_team", "reviewed_by")
    if status in dict(SocialReport.STATUS_CHOICES):
        qs = qs.filter(status=status)
    target_type = request.query_params.get("target_type")
    if target_type in ("user", "team"):
        qs = qs.filter(target_type=target_type)
    rows = list(qs.order_by("-created_at")[:200])
    counts = dict(SocialReport.objects.values_list("status").annotate(n=Count("id")))
    return Response({"results": [_report_row(r) for r in rows], "counts": counts})


@api_view(["POST"])
@permission_classes(ADMIN)
@social_endpoint
def resolve_report(request, report_id):
    r = SocialReport.objects.select_related("target_team", "target_user").filter(id=report_id).first()
    if r is None:
        raise SocialError("not_found", "Report not found.", 404)
    data = request.data or {}
    status = data.get("status")
    if status not in (SocialReport.ACTIONED, SocialReport.DISMISSED):
        raise SocialError("invalid_status", "Status must be actioned or dismissed.", 400)
    note = str(data.get("note") or "").strip()[:500]
    # Resolve every open report about the same target in one go.
    same = SocialReport.objects.filter(status=SocialReport.OPEN)
    same = same.filter(target_user_id=r.target_user_id) if r.target_type == "user" else same.filter(target_team_id=r.target_team_id)
    ids = list(same.values_list("id", flat=True)) or [r.id]
    SocialReport.objects.filter(id__in=ids).update(
        status=status, reviewed_by=request.user, reviewed_at=timezone.now(), resolution_note=note
    )
    AuditLog.log_action(
        request.user, "approve" if status == SocialReport.ACTIONED else "reject", r.target_type,
        f"Social report {status}: {r.get_reason_display()}",
        resource_id=r.target_user_id or r.target_team_id,
        resource_name=(r.target_user.username if r.target_user else r.target_team.name if r.target_team else ""),
        changes={"report_ids": ids, "status": status, "note": note},
        request=request,
    )
    r.refresh_from_db()
    return Response(_report_row(r))


@api_view(["GET"])
@permission_classes(ADMIN)
def teams_list(request):
    qs = Team.objects.all()
    q = (request.query_params.get("q") or "").strip()
    if q:
        qs = qs.filter(Q(name__icontains=q) | Q(invite_code__iexact=q))
    flt = request.query_params.get("filter")
    if flt == "disabled":
        qs = qs.filter(is_disabled=True)
    elif flt == "reported":
        qs = qs.filter(reports__status=SocialReport.OPEN).distinct()
    ws = current_week_start()
    rows = list(qs.annotate(open_reports=Count("reports", filter=Q(reports__status=SocialReport.OPEN))).order_by("-open_reports", "-member_count", "name")[:200])
    steps = dict(TeamWeeklyTotal.objects.filter(week_start=ws, team_id__in=[t.id for t in rows]).values_list("team_id", "steps"))
    return Response(
        {"results": [{**_team_ref(t), "open_reports": t.open_reports, "week_steps": steps.get(t.id, 0)} for t in rows]}
    )


@api_view(["POST"])
@permission_classes(ADMIN)
@social_endpoint
def moderate_team(request, team_id):
    team = Team.objects.filter(id=team_id).first()
    if team is None:
        raise SocialError("team_not_found", "Team not found.", 404)
    data = request.data or {}
    action = data.get("action")
    reason = str(data.get("reason") or "").strip()[:255]
    before = {"name": team.name, "is_disabled": team.is_disabled}
    if action == "rename":
        name = teams_svc.clean_name(str(data.get("name") or ""))
        key = teams_svc.name_key(name)
        if Team.objects.filter(name_key=key).exclude(pk=team.pk).exists():
            raise SocialError("name_taken", "Another team already uses that name.", 409)
        team.name, team.name_key = name, key
        team.save(update_fields=["name", "name_key", "updated_at"])
    elif action == "disable":
        if not reason:
            raise SocialError("reason_required", "Give a reason members will see.", 400)
        team.is_disabled, team.disabled_reason = True, reason
        team.save(update_fields=["is_disabled", "disabled_reason", "updated_at"])
    elif action == "enable":
        team.is_disabled, team.disabled_reason = False, ""
        team.save(update_fields=["is_disabled", "disabled_reason", "updated_at"])
        from .rankings import refresh_team_totals

        refresh_team_totals(current_week_start(), [team.id])
    else:
        raise SocialError("invalid_action", "Action must be rename, disable or enable.", 400)
    AuditLog.log_action(
        request.user, "update", "team", f"Team {action}: {team.name}",
        resource_id=team.id, resource_name=team.name,
        changes={"action": action, "before": before, "reason": reason, "name": team.name},
        request=request,
    )
    team.open_reports = SocialReport.objects.filter(target_team=team, status=SocialReport.OPEN).count()
    return Response({**_team_ref(team), "open_reports": team.open_reports})
