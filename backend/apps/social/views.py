"""Customer API for the social layer (/api/social/...). See README.md for the list.

Never exposes email, phone, wallet or anti-cheat data: people are id + username +
photo only.
"""

from __future__ import annotations

import functools
from datetime import date, timedelta

from django.contrib.auth import get_user_model
from django.db.models import Q
from django.utils import timezone
from rest_framework import permissions
from rest_framework.decorators import api_view, permission_classes, throttle_classes
from rest_framework.response import Response

from apps.core.sanitizers import sanitize_text
from . import feed as feed_svc
from . import friends as friends_svc
from . import teams as teams_svc
from .common import (SocialError, current_week_start, get_profile,
                     hidden_user_ids, public_user, require_social_enabled,
                     social_settings)
from .models import (Block, FriendRequest, Friendship, SocialNotification,
                     SocialProfile, SocialReport, Team, TeamMembership,
                     TeamWeeklyTotal, WeeklyStepTotal, new_code)
from .rankings import friends_leaderboard, team_members_ranking, teams_leaderboard
from .throttles import (FriendRequestThrottle, SocialReportThrottle,
                        SocialSearchThrottle, SocialWriteThrottle)

User = get_user_model()
AUTH = [permissions.IsAuthenticated]


def social_endpoint(view):
    """Turns SocialError into a JSON error ({"error", "code"}) with its status."""

    @functools.wraps(view)
    def wrapper(request, *args, **kwargs):
        try:
            return view(request, *args, **kwargs)
        except SocialError as exc:
            return Response({"error": exc.message, "code": exc.code}, status=exc.status)

    return wrapper


def _int(value, name="id") -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        raise SocialError("invalid_" + name, f"Invalid {name}.", 400)


def _week_param(request) -> date:
    which = (request.query_params.get("week") or "current").lower()
    ws = current_week_start()
    if which == "previous":
        return ws - timedelta(days=7)
    if which != "current":
        try:
            d = date.fromisoformat(which)
        except ValueError:
            raise SocialError("invalid_week", "Use week=current, previous or a YYYY-MM-DD Monday.", 400)
        d = d - timedelta(days=d.weekday())
        if d > ws or d < ws - timedelta(weeks=52):
            raise SocialError("invalid_week", "That week isn't available.", 400)
        return d
    return ws


# ── me / settings ────────────────────────────────────────────────────────────

PROFILE_FIELDS = (
    "discoverability", "share_goal_hits", "share_streaks", "share_badges", "share_challenges",
    "show_in_rankings", "notify_friend_requests", "notify_weekly_results", "notify_reactions",
)


def _profile_payload(profile: SocialProfile, user) -> dict:
    s = social_settings()
    return {
        "friend_code": profile.friend_code,
        **{f: getattr(profile, f) for f in PROFILE_FIELDS},
        "friends_count": Friendship.objects.filter(user=user).count(),
        "incoming_requests": FriendRequest.objects.filter(to_user=user, status=FriendRequest.PENDING)
        .exclude(from_user_id__in=hidden_user_ids(user.id)).count(),
        "features": {
            "social": s.social_enabled,
            "teams": s.social_enabled and s.teams_enabled,
            "feed": s.social_enabled and s.feed_enabled,
            "max_team_members": s.max_team_members,
            "max_teams_per_user": s.max_teams_per_user,
            "max_friends": s.max_friends,
        },
    }


@api_view(["GET", "PATCH"])
@permission_classes(AUTH)
@social_endpoint
def me(request):
    profile = get_profile(request.user)
    if request.method == "PATCH":
        require_social_enabled()
        data = request.data or {}
        changed = []
        for field in PROFILE_FIELDS:
            if field not in data:
                continue
            value = data[field]
            if field == "discoverability":
                if value not in dict(SocialProfile.DISCOVERABILITY_CHOICES):
                    raise SocialError("invalid_discoverability", "Choose everyone, friends of friends or nobody.", 400)
            elif not isinstance(value, bool):
                raise SocialError("invalid_" + field, f"{field} must be true or false.", 400)
            setattr(profile, field, value)
            changed.append(field)
        if changed:
            profile.save(update_fields=changed + ["updated_at"])
            if "show_in_rankings" in changed:
                from .rankings import refresh_team_totals

                refresh_team_totals(
                    current_week_start(),
                    TeamMembership.objects.filter(user=request.user).values_list("team_id", flat=True),
                )
    return Response(_profile_payload(profile, request.user))


@api_view(["POST"])
@permission_classes(AUTH)
@throttle_classes([SocialWriteThrottle])
@social_endpoint
def reset_friend_code(request):
    require_social_enabled()
    profile = get_profile(request.user)
    for _ in range(5):
        code = new_code()
        if not SocialProfile.objects.filter(friend_code=code).exists():
            profile.friend_code = code
            profile.save(update_fields=["friend_code", "updated_at"])
            break
    return Response({"friend_code": profile.friend_code})


# ── people ───────────────────────────────────────────────────────────────────


def _person(u, me, request, relationship=None) -> dict:
    return {**public_user(u, request), "relationship": relationship or friends_svc.relationship(me, u.id)}


@api_view(["GET"])
@permission_classes(AUTH)
@throttle_classes([SocialSearchThrottle])
@social_endpoint
def search_users(request):
    results = friends_svc.search(request.user, request.query_params.get("q", ""))
    return Response({"results": [_person(u, request.user, request) for u in results]})


@api_view(["GET"])
@permission_classes(AUTH)
@throttle_classes([SocialSearchThrottle])
@social_endpoint
def user_by_code(request, code):
    u = friends_svc.find_by_code(request.user, code)
    return Response(_person(u, request.user, request))


# ── friends ──────────────────────────────────────────────────────────────────


@api_view(["GET"])
@permission_classes(AUTH)
@social_endpoint
def friends_list(request):
    require_social_enabled()
    me_ = request.user
    ws = current_week_start()
    rows = list(
        Friendship.objects.filter(user=me_, friend__is_active=True, friend__deleted_at__isnull=True)
        .exclude(friend_id__in=hidden_user_ids(me_.id))
        .select_related("friend")
        .order_by("friend__username")
    )
    steps = dict(
        WeeklyStepTotal.objects.filter(week_start=ws, user_id__in=[r.friend_id for r in rows]).values_list("user_id", "steps")
    )
    return Response(
        {
            "results": [
                {**public_user(r.friend, request), "since": r.created_at.isoformat(), "week_steps": steps.get(r.friend_id, 0)}
                for r in rows
            ]
        }
    )


@api_view(["DELETE"])
@permission_classes(AUTH)
@throttle_classes([SocialWriteThrottle])
@social_endpoint
def remove_friend(request, user_id):
    friends_svc.remove_friend(request.user, _int(user_id))
    return Response(status=204)


def _request_row(r: FriendRequest, other, request) -> dict:
    return {"id": r.id, "user": public_user(other, request), "created_at": r.created_at.isoformat(), "via": r.via}


@api_view(["GET", "POST"])
@permission_classes(AUTH)
@social_endpoint
def friend_requests(request):
    me_ = request.user
    if request.method == "GET":
        require_social_enabled()
        hidden = hidden_user_ids(me_.id)
        incoming = (
            FriendRequest.objects.filter(to_user=me_, status=FriendRequest.PENDING, from_user__is_active=True)
            .exclude(from_user_id__in=hidden).select_related("from_user")[:100]
        )
        outgoing = (
            FriendRequest.objects.filter(from_user=me_, status=FriendRequest.PENDING, to_user__is_active=True)
            .exclude(to_user_id__in=hidden).select_related("to_user")[:100]
        )
        return Response(
            {
                "incoming": [_request_row(r, r.from_user, request) for r in incoming],
                "outgoing": [_request_row(r, r.to_user, request) for r in outgoing],
            }
        )
    # POST: send (throttled separately so reading the list isn't limited)
    throttle = FriendRequestThrottle()
    if not throttle.allow_request(request, None):
        return Response(
            {"error": "You're sending requests too quickly. Try again later.", "code": "throttled"}, status=429
        )
    data = request.data or {}
    if data.get("code"):
        target = friends_svc.find_by_code(me_, str(data["code"]))
        via = "code"
    else:
        target = User.objects.filter(id=_int(data.get("user_id"), "user_id")).first()
        via = "search"
    outcome, req = friends_svc.send_request(me_, target, via=via)
    return Response(
        {"status": outcome, "request_id": req.id if req else None, "user": _person(target, me_, request)},
        status=201 if outcome == "sent" else 200,
    )


@api_view(["POST"])
@permission_classes(AUTH)
@throttle_classes([SocialWriteThrottle])
@social_endpoint
def friend_request_action(request, request_id, action):
    rid = _int(request_id)
    if action == "accept":
        friends_svc.accept(request.user, rid)
    elif action == "decline":
        friends_svc.decline(request.user, rid)
    elif action == "cancel":
        friends_svc.cancel(request.user, rid)
    else:
        raise SocialError("invalid_action", "Unknown action.", 400)
    return Response({"status": {"accept": "accepted", "decline": "declined", "cancel": "cancelled"}[action]})


# ── blocks & reports ─────────────────────────────────────────────────────────


@api_view(["GET", "POST"])
@permission_classes(AUTH)
@throttle_classes([SocialWriteThrottle])
@social_endpoint
def blocks(request):
    if request.method == "POST":
        friends_svc.block(request.user, _int((request.data or {}).get("user_id"), "user_id"))
        return Response({"status": "blocked"}, status=201)
    rows = Block.objects.filter(blocker=request.user).select_related("blocked").order_by("-created_at")
    return Response(
        {"results": [{**public_user(b.blocked, request), "blocked_at": b.created_at.isoformat()} for b in rows]}
    )


@api_view(["DELETE"])
@permission_classes(AUTH)
@throttle_classes([SocialWriteThrottle])
@social_endpoint
def unblock(request, user_id):
    friends_svc.unblock(request.user, _int(user_id))
    return Response(status=204)


@api_view(["POST"])
@permission_classes(AUTH)
@throttle_classes([SocialReportThrottle])
@social_endpoint
def report(request):
    data = request.data or {}
    target_type = data.get("target_type")
    reason = data.get("reason")
    if reason not in dict(SocialReport.REASON_CHOICES):
        raise SocialError("invalid_reason", "Choose a reason.", 400)
    details = sanitize_text(str(data.get("details") or "")[:500])
    kwargs = {}
    if target_type == SocialReport.TARGET_USER:
        uid = _int(data.get("user_id"), "user_id")
        if uid == request.user.id:
            raise SocialError("self", "You can't report yourself.", 400)
        target = User.objects.filter(id=uid).first()
        if target is None:
            raise friends_svc.NOT_FOUND
        kwargs["target_user"] = target
    elif target_type == SocialReport.TARGET_TEAM:
        team = Team.objects.filter(id=_int(data.get("team_id"), "team_id")).first()
        if team is None:
            raise SocialError("team_not_found", "We couldn't find that team.", 404)
        kwargs["target_team"] = team
    else:
        raise SocialError("invalid_target", "Report a person or a team.", 400)
    # One open report per reporter and target is enough.
    existing = SocialReport.objects.filter(reporter=request.user, status=SocialReport.OPEN, **kwargs).first()
    if existing:
        return Response({"status": "already_reported", "id": existing.id})
    r = SocialReport.objects.create(
        reporter=request.user, target_type=target_type, reason=reason, details=details, **kwargs
    )
    also_blocked = False
    if target_type == SocialReport.TARGET_USER and data.get("block") is True:
        friends_svc.block(request.user, kwargs["target_user"].id)
        also_blocked = True
    return Response({"status": "reported", "id": r.id, "blocked": also_blocked}, status=201)


# ── rankings ─────────────────────────────────────────────────────────────────


@api_view(["GET"])
@permission_classes(AUTH)
@social_endpoint
def rankings_friends(request):
    require_social_enabled()
    return Response(friends_leaderboard(request.user, week_start=_week_param(request), request=request))


@api_view(["GET"])
@permission_classes(AUTH)
@social_endpoint
def rankings_teams(request):
    require_social_enabled("teams")
    return Response(teams_leaderboard(request.user, week_start=_week_param(request)))


@api_view(["GET"])
@permission_classes(AUTH)
@social_endpoint
def rankings_history(request):
    require_social_enabled()
    from .models import WeeklyArchive

    weeks = list(WeeklyArchive.objects.order_by("-week_start").values_list("week_start", flat=True)[:12])
    mine = {r.week_start: r for r in WeeklyStepTotal.objects.filter(user=request.user, week_start__in=weeks)}
    team_ids = list(TeamMembership.objects.filter(user=request.user).values_list("team_id", flat=True))
    team_rows: dict = {}
    for t in TeamWeeklyTotal.objects.filter(team_id__in=team_ids, week_start__in=weeks, rank__isnull=False).select_related("team"):
        best = team_rows.get(t.week_start)
        if best is None or t.rank < best["rank"]:
            team_rows[t.week_start] = {"team_id": t.team_id, "team_name": t.team.name, "rank": t.rank, "steps": t.steps}
    wins = WeeklyStepTotal.objects.filter(user=request.user, friends_rank=1, friends_size__gte=2).count()
    return Response(
        {
            "friends_wins": wins,
            "weeks": [
                {
                    "week_start": w.isoformat(),
                    "week_end": (w + timedelta(days=6)).isoformat(),
                    "steps": mine[w].steps if w in mine else 0,
                    "friends_rank": mine[w].friends_rank if w in mine else None,
                    "friends_size": mine[w].friends_size if w in mine else None,
                    "team": team_rows.get(w),
                }
                for w in weeks
            ],
        }
    )


# ── teams ────────────────────────────────────────────────────────────────────


def _team_summary(team: Team, me_, *, role=None) -> dict:
    ws = current_week_start()
    total = TeamWeeklyTotal.objects.filter(team=team, week_start=ws).values_list("steps", flat=True).first()
    return {
        "id": team.id,
        "name": team.name,
        "description": team.description,
        "visibility": team.visibility,
        "member_count": team.member_count,
        "week_steps": total or 0,
        "my_role": role,
        "is_disabled": team.is_disabled,
    }


@api_view(["GET", "POST"])
@permission_classes(AUTH)
@throttle_classes([SocialWriteThrottle])
@social_endpoint
def teams(request):
    if request.method == "POST":
        data = request.data or {}
        team = teams_svc.create_team(
            request.user,
            name=str(data.get("name") or ""),
            description=str(data.get("description") or ""),
            visibility=str(data.get("visibility") or Team.PUBLIC),
        )
        return Response(_team_detail(team, request), status=201)
    require_social_enabled("teams")
    memberships = TeamMembership.objects.filter(user=request.user).select_related("team").order_by("team__name")
    return Response({"results": [_team_summary(m.team, request.user, role=m.role) for m in memberships]})


@api_view(["GET"])
@permission_classes(AUTH)
@throttle_classes([SocialSearchThrottle])
@social_endpoint
def teams_discover(request):
    found = teams_svc.discover(request.user, request.query_params.get("q", ""))
    return Response({"results": [_team_summary(t, request.user) for t in found]})


@api_view(["POST"])
@permission_classes(AUTH)
@throttle_classes([SocialWriteThrottle])
@social_endpoint
def teams_join_by_code(request):
    code = str((request.data or {}).get("code") or "")
    team = teams_svc.find_by_code(code)
    teams_svc.join_team(request.user, team, code=code)
    return Response(_team_detail(team, request))


def _team_detail(team: Team, request) -> dict:
    me_ = request.user
    membership = TeamMembership.objects.filter(team=team, user=me_).first()
    role = membership.role if membership else None
    data = _team_summary(team, me_, role=role)
    data["members"] = team_members_ranking(team, me_, request=request) if (membership or team.visibility == Team.PUBLIC) else []
    # Every member may invite friends; outsiders never see the code.
    data["invite_code"] = team.invite_code if membership and not team.is_disabled else None
    data["disabled_reason"] = team.disabled_reason if team.is_disabled and membership else ""
    data["week_start"] = current_week_start().isoformat()
    return data


@api_view(["GET", "PATCH", "DELETE"])
@permission_classes(AUTH)
@throttle_classes([SocialWriteThrottle])
@social_endpoint
def team_detail(request, team_id):
    require_social_enabled("teams")
    team = teams_svc.get_team(_int(team_id), include_disabled_for=request.user)
    is_member = TeamMembership.objects.filter(team=team, user=request.user).exists()
    if request.method == "GET":
        if team.visibility == Team.INVITE_ONLY and not is_member:
            code = (request.query_params.get("code") or "").strip().upper()
            if code != team.invite_code:
                raise SocialError("team_not_found", "We couldn't find that team.", 404)
        return Response(_team_detail(team, request))
    if request.method == "DELETE":
        teams_svc.disband(request.user, team)
        return Response(status=204)
    data = request.data or {}
    teams_svc.update_team(
        request.user,
        team,
        name=data.get("name"),
        description=data.get("description"),
        visibility=data.get("visibility"),
    )
    return Response(_team_detail(team, request))


@api_view(["POST"])
@permission_classes(AUTH)
@throttle_classes([SocialWriteThrottle])
@social_endpoint
def team_action(request, team_id, action):
    team = teams_svc.get_team(_int(team_id), include_disabled_for=request.user)
    data = request.data or {}
    if action == "join":
        teams_svc.join_team(request.user, team, code=data.get("code"))
    elif action == "leave":
        outcome = teams_svc.leave_team(request.user, team)
        return Response({"status": outcome})
    elif action == "reset-code":
        teams_svc.reset_invite_code(request.user, team)
    elif action == "transfer":
        teams_svc.transfer_ownership(request.user, team, _int(data.get("user_id"), "user_id"))
    else:
        raise SocialError("invalid_action", "Unknown action.", 400)
    team.refresh_from_db()
    return Response(_team_detail(team, request))


@api_view(["POST"])
@permission_classes(AUTH)
@throttle_classes([SocialWriteThrottle])
@social_endpoint
def team_member_action(request, team_id, user_id, action):
    team = teams_svc.get_team(_int(team_id), include_disabled_for=request.user)
    uid = _int(user_id, "user_id")
    if action == "remove":
        teams_svc.remove_member(request.user, team, uid)
    elif action == "role":
        teams_svc.set_role(request.user, team, uid, str((request.data or {}).get("role") or ""))
    else:
        raise SocialError("invalid_action", "Unknown action.", 400)
    team.refresh_from_db()
    return Response(_team_detail(team, request))


# ── feed ─────────────────────────────────────────────────────────────────────


@api_view(["GET"])
@permission_classes(AUTH)
@social_endpoint
def feed(request):
    before = request.query_params.get("before")
    return Response(feed_svc.list_feed(request.user, before_id=_int(before, "before") if before else None, request=request))


@api_view(["POST"])
@permission_classes(AUTH)
@throttle_classes([SocialWriteThrottle])
@social_endpoint
def feed_react(request, event_id):
    kind = (request.data or {}).get("kind")
    return Response(feed_svc.react(request.user, _int(event_id), kind))


# ── notifications ────────────────────────────────────────────────────────────


@api_view(["GET"])
@permission_classes(AUTH)
@social_endpoint
def notifications(request):
    hidden = hidden_user_ids(request.user.id)
    rows = (
        SocialNotification.objects.filter(recipient=request.user)
        .exclude(actor_id__in=hidden)
        .filter(Q(actor__isnull=True) | Q(actor__is_active=True))
        .select_related("actor")[:50]
    )
    return Response(
        {
            "results": [
                {
                    "id": n.id,
                    "kind": n.kind,
                    "actor": public_user(n.actor, request) if n.actor else None,
                    "data": n.data,
                    "read": n.read_at is not None,
                    "created_at": n.created_at.isoformat(),
                }
                for n in rows
            ]
        }
    )


@api_view(["GET"])
@permission_classes(AUTH)
def notifications_summary(request):
    """Cheap poll target: unread count + newest id (the app raises a local notification
    only for ids newer than the last one it saw)."""
    s = social_settings()
    if not s.social_enabled:
        return Response({"enabled": False, "unread": 0, "latest_id": None, "pending_requests": 0})
    unread = SocialNotification.objects.filter(recipient=request.user, read_at__isnull=True)
    latest = unread.order_by("-id").values("id", "kind").first()
    return Response(
        {
            "enabled": True,
            "unread": unread.count(),
            "latest_id": latest["id"] if latest else None,
            "latest_kind": latest["kind"] if latest else None,
            "pending_requests": FriendRequest.objects.filter(to_user=request.user, status=FriendRequest.PENDING).count(),
        }
    )


@api_view(["POST"])
@permission_classes(AUTH)
@social_endpoint
def notifications_read(request):
    ids = (request.data or {}).get("ids")
    qs = SocialNotification.objects.filter(recipient=request.user, read_at__isnull=True)
    if isinstance(ids, list) and ids:
        qs = qs.filter(id__in=[_int(i) for i in ids[:200]])
    updated = qs.update(read_at=timezone.now())
    return Response({"marked": updated})
