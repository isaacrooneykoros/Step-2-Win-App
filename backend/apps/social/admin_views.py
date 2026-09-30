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
from apps.admin_api.roles import staff

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
@permission_classes(staff("console.view", write="settings.system"))
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
@permission_classes(staff("trust.view"))
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
@permission_classes(staff("trust.view"))
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
@permission_classes(staff("trust.act"))
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
    # Optional follow-through when actioned (admin console Part B):
    #   disable_team     disable the reported team (the note is the reason members see)
    #   hide_feed_event  hide one feed item of the reported user (feed_event_id)
    #   open_trust_case  open a medium anti-cheat flag on the reported user for review
    follow = data.get("action") or ""
    if follow and status != SocialReport.ACTIONED:
        raise SocialError("invalid_action", "Follow-up actions need status actioned.", 400)
    if follow not in ("", "disable_team", "hide_feed_event", "open_trust_case"):
        raise SocialError("invalid_action", "Unknown follow-up action.", 400)
    if follow == "disable_team" and r.target_type != "team":
        raise SocialError("invalid_action", "Only team reports can disable a team.", 400)
    if follow in ("hide_feed_event", "open_trust_case") and r.target_type != "user":
        raise SocialError("invalid_action", "That action applies to reports about a person.", 400)
    if follow and len(note) < REASON_MIN:
        raise SocialError("reason_required", f"Add a note of at least {REASON_MIN} characters.", 400)
    follow_result = {}
    if follow == "disable_team":
        team = r.target_team
        if not team.is_disabled:
            team.is_disabled, team.disabled_reason = True, note[:255]
            team.save(update_fields=["is_disabled", "disabled_reason", "updated_at"])
            AuditLog.log_action(request.user, "update", "team", f"Team disable: {team.name} (from report)",
                                resource_id=team.id, resource_name=team.name,
                                changes={"action": "disable", "reason": note, "report_id": r.id}, request=request)
        follow_result = {"team_disabled": team.id}
    elif follow == "hide_feed_event":
        try:
            event_id = int(data.get("feed_event_id"))
        except (TypeError, ValueError):
            raise SocialError("invalid_feed_event", "Pick the feed item to hide.", 400)
        e = FeedEvent.objects.filter(id=event_id, user_id=r.target_user_id).first()
        if e is None:
            raise SocialError("invalid_feed_event", "That feed item isn't from the reported person.", 400)
        if e.hidden_at is None:
            e.hidden_at, e.hidden_by, e.hidden_reason = timezone.now(), request.user, note[:255]
            e.save(update_fields=["hidden_at", "hidden_by", "hidden_reason"])
            AuditLog.log_action(request.user, "hide", "feed_event", f"Hid feed item #{e.id} (from report)",
                                resource_id=e.id, resource_name=r.target_user.username,
                                changes={"reason": note, "report_id": r.id}, request=request)
        follow_result = {"feed_event_hidden": e.id}
    elif follow == "open_trust_case":
        from apps.steps.models import FraudFlag

        flag = FraudFlag.objects.create(
            user=r.target_user, flag_type="social_report", severity="medium", date=timezone.localdate(),
            details={"source": "social_report", "report_id": r.id, "reason": r.reason, "note": note},
        )
        follow_result = {"trust_flag_id": flag.id}
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
        changes={"report_ids": ids, "status": status, "note": note, "action": follow or None, **follow_result},
        request=request,
    )
    r.refresh_from_db()
    return Response({**_report_row(r), "follow_up": follow_result or None})


@api_view(["GET"])
@permission_classes(staff("trust.view"))
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
@permission_classes(staff("trust.act"))
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


# ── Admin console Part B: hide content, team members, ownership, delete ──────

REASON_MIN = 5


def _reason(data) -> str:
    reason = str((data or {}).get("reason") or "").strip()[:255]
    if len(reason) < REASON_MIN:
        raise SocialError("reason_required", f"Give a reason (at least {REASON_MIN} characters).", 400)
    return reason


def _feed_row(e: FeedEvent) -> dict:
    return {
        "id": e.id, "kind": e.kind, "kind_label": e.get_kind_display(), "user": _user_ref(e.user),
        "data": e.data, "created_at": e.created_at.isoformat(),
        "hidden": e.hidden_at is not None, "hidden_at": e.hidden_at.isoformat() if e.hidden_at else None,
        "hidden_by": e.hidden_by.username if e.hidden_by_id else None, "hidden_reason": e.hidden_reason or None,
    }


@api_view(["GET"])
@permission_classes(staff("trust.view"))
def feed_items(request):
    qs = FeedEvent.objects.select_related("user", "hidden_by").order_by("-id")
    q = (request.query_params.get("q") or "").strip()
    if q:
        qs = qs.filter(user__username__icontains=q)
    if request.query_params.get("hidden") == "1":
        qs = qs.filter(hidden_at__isnull=False)
    return Response({"results": [_feed_row(e) for e in qs[:200]]})


def _set_hidden(obj, request, hide: bool, resource_type: str, label: str, name: str):
    data = request.data or {}
    reason = _reason(data) if hide else str(data.get("reason") or "").strip()[:255]
    if hide and obj.hidden_at is None:
        obj.hidden_at, obj.hidden_by, obj.hidden_reason = timezone.now(), request.user, reason
    elif not hide and obj.hidden_at is not None:
        obj.hidden_at, obj.hidden_by, obj.hidden_reason = None, None, ""
    else:
        return False
    obj.save(update_fields=["hidden_at", "hidden_by", "hidden_reason"])
    AuditLog.log_action(
        request.user, "hide" if hide else "unhide", resource_type,
        f"{'Hid' if hide else 'Restored'} {label}", resource_id=obj.id, resource_name=name[:255],
        changes={"reason": reason}, request=request,
    )
    return True


@api_view(["POST"])
@permission_classes(staff("trust.act"))
@social_endpoint
def feed_item_visibility(request, event_id, verb):
    if verb not in ("hide", "unhide"):
        raise SocialError("not_found", "Unknown action.", 404)
    e = FeedEvent.objects.select_related("user").filter(id=event_id).first()
    if e is None:
        raise SocialError("not_found", "Feed item not found.", 404)
    _set_hidden(e, request, verb == "hide", "feed_event", f"feed item #{e.id} by {e.user.username}", e.user.username)
    e.refresh_from_db()
    return Response(_feed_row(e))


def _message_row(m) -> dict:
    return {
        "id": m.id, "challenge_id": m.challenge_id, "challenge_name": m.challenge.name,
        "user": _user_ref(m.user), "message": m.message, "is_system": m.is_system,
        "created_at": m.created_at.isoformat(), "hidden": m.hidden_at is not None,
        "hidden_at": m.hidden_at.isoformat() if m.hidden_at else None,
        "hidden_by": m.hidden_by.username if m.hidden_by_id else None, "hidden_reason": m.hidden_reason or None,
    }


@api_view(["GET"])
@permission_classes(staff("trust.view"))
def challenge_messages(request):
    from apps.challenges.models import ChallengeMessage

    qs = ChallengeMessage.objects.select_related("user", "challenge", "hidden_by").filter(is_system=False).order_by("-id")
    ch = request.query_params.get("challenge")
    if ch and ch.isdigit():
        qs = qs.filter(challenge_id=int(ch))
    q = (request.query_params.get("q") or "").strip()
    if q:
        qs = qs.filter(Q(message__icontains=q) | Q(user__username__icontains=q) | Q(challenge__name__icontains=q))
    if request.query_params.get("hidden") == "1":
        qs = qs.filter(hidden_at__isnull=False)
    return Response({"results": [_message_row(m) for m in qs[:200]]})


@api_view(["POST"])
@permission_classes(staff("trust.act"))
@social_endpoint
def challenge_message_visibility(request, message_id, verb):
    if verb not in ("hide", "unhide"):
        raise SocialError("not_found", "Unknown action.", 404)
    from apps.challenges.models import ChallengeMessage

    m = ChallengeMessage.objects.select_related("user", "challenge").filter(id=message_id).first()
    if m is None:
        raise SocialError("not_found", "Message not found.", 404)
    who = m.user.username if m.user_id else "system"
    _set_hidden(m, request, verb == "hide", "challenge_message",
                f"chat message #{m.id} by {who} in {m.challenge.name}", who)
    m.refresh_from_db()
    return Response(_message_row(m))


def _members(team: Team) -> list[dict]:
    rows = TeamMembership.objects.filter(team=team).select_related("user").order_by("role", "joined_at")
    order = {TeamMembership.OWNER: 0, TeamMembership.ADMIN: 1, TeamMembership.MEMBER: 2}
    out = [{"user": _user_ref(m.user), "role": m.role, "joined_at": m.joined_at.isoformat()} for m in rows]
    return sorted(out, key=lambda r: (order.get(r["role"], 9), r["joined_at"]))


@api_view(["GET"])
@permission_classes(staff("trust.view"))
def team_members(request, team_id):
    team = Team.objects.filter(id=team_id).first()
    if team is None:
        return Response({"error": "Team not found."}, status=404)
    return Response({"team": _team_ref(team), "members": _members(team)})


@api_view(["POST"])
@permission_classes(staff("trust.act"))
@social_endpoint
def team_remove_member(request, team_id, user_id):
    from django.db import transaction

    from .models import SocialNotification
    from .notify import notify

    reason = _reason(request.data)
    with transaction.atomic():
        team = Team.objects.select_for_update().filter(id=team_id).first()
        if team is None:
            raise SocialError("team_not_found", "Team not found.", 404)
        m = TeamMembership.objects.filter(team=team, user_id=user_id).select_related("user").first()
        if m is None:
            raise SocialError("not_member", "That person isn't in this team.", 404)
        others = TeamMembership.objects.filter(team=team).exclude(pk=m.pk)
        if m.role == TeamMembership.OWNER and others.exists():
            raise SocialError("owner_must_transfer", "Transfer ownership to another member first.", 409)
        role = m.role
        m.delete()
        team.member_count = TeamMembership.objects.filter(team=team).count()
        team.save(update_fields=["member_count", "updated_at"])
    notify(m.user, SocialNotification.TEAM_REMOVED, data={"team_id": team.id, "team_name": team.name})
    from .rankings import refresh_team_totals

    refresh_team_totals(current_week_start(), [team.id])
    AuditLog.log_action(
        request.user, "remove_member", "team", f"Removed {m.user.username} from team {team.name}",
        resource_id=team.id, resource_name=team.name,
        changes={"user_id": m.user_id, "username": m.user.username, "role": role, "reason": reason}, request=request,
    )
    return Response({"team": _team_ref(team), "members": _members(team)})


@api_view(["POST"])
@permission_classes(staff("trust.act"))
@social_endpoint
def team_transfer_ownership(request, team_id):
    from django.db import transaction

    from .models import SocialNotification
    from .notify import notify

    data = request.data or {}
    reason = _reason(data)
    try:
        new_owner_id = int(data.get("user_id"))
    except (TypeError, ValueError):
        raise SocialError("invalid_user", "Choose the new owner.", 400)
    with transaction.atomic():
        team = Team.objects.select_for_update().filter(id=team_id).first()
        if team is None:
            raise SocialError("team_not_found", "Team not found.", 404)
        target = TeamMembership.objects.filter(team=team, user_id=new_owner_id).select_related("user").first()
        if target is None:
            raise SocialError("not_member", "The new owner must already be a member.", 400)
        if target.role == TeamMembership.OWNER:
            raise SocialError("already_owner", "That person already owns the team.", 400)
        previous = list(TeamMembership.objects.filter(team=team, role=TeamMembership.OWNER).select_related("user"))
        TeamMembership.objects.filter(team=team, role=TeamMembership.OWNER).update(role=TeamMembership.ADMIN)
        target.role = TeamMembership.OWNER
        target.save(update_fields=["role"])
    notify(target.user, SocialNotification.TEAM_ROLE, data={"team_id": team.id, "team_name": team.name, "role": "owner"})
    AuditLog.log_action(
        request.user, "transfer_ownership", "team", f"Made {target.user.username} owner of team {team.name}",
        resource_id=team.id, resource_name=team.name,
        changes={"new_owner": target.user.username, "previous_owner": [p.user.username for p in previous],
                 "reason": reason},
        request=request,
    )
    return Response({"team": _team_ref(team), "members": _members(team)})


@api_view(["DELETE"])
@permission_classes(staff("trust.act"))
@social_endpoint
def team_delete(request, team_id):
    """Only a disabled team with no members and no open reports; otherwise disable it."""
    team = Team.objects.filter(id=team_id).first()
    if team is None:
        raise SocialError("team_not_found", "Team not found.", 404)
    members = TeamMembership.objects.filter(team=team).count()
    if not team.is_disabled or members:
        raise SocialError(
            "team_not_deletable",
            "Only a disabled team with no members can be deleted. Disable it (and remove members) first.", 409)
    if SocialReport.objects.filter(target_team=team, status=SocialReport.OPEN).exists():
        raise SocialError("team_has_reports", "Resolve the open reports about this team first.", 409)
    AuditLog.log_action(
        request.user, "delete", "team", f"Deleted empty disabled team {team.name}",
        resource_id=team.id, resource_name=team.name,
        changes={"name": team.name, "disabled_reason": team.disabled_reason}, request=request,
    )
    team.delete()
    return Response(status=204)
