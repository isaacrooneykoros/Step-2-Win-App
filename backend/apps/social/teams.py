"""Teams (clubs): create, join (public or by invite code), leave, kick, roles, transfer.

Roles: owner (exactly one) > admin > member.
  - owner: everything; the only one who can change roles, transfer or disband.
  - admin: edit name/description/visibility, reset the invite code, remove members.
  - member: leave.
The owner can't leave while others remain: transfer ownership first (or disband).
The last member leaving deletes the team. A team disabled by a moderator is frozen:
hidden from discovery and rankings, no joins, no edits.
"""

from __future__ import annotations

import re

from django.db import IntegrityError, transaction
from django.db.models import Q

from apps.core.sanitizers import sanitize_text
from .common import SocialError, current_week_start, require_social_enabled
from .models import SocialNotification, Team, TeamMembership, new_code
from .notify import notify

NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 .'_-]{1,38}[A-Za-z0-9.']$")
MIN_QUERY = 3


def name_key(name: str) -> str:
    return re.sub(r"\s+", " ", (name or "").strip()).lower()


def clean_name(name: str) -> str:
    name = sanitize_text(name)
    if not name or not NAME_RE.match(name):
        raise SocialError(
            "invalid_name",
            "Team names are 3 to 40 letters, numbers, spaces, dots, dashes or apostrophes.",
            400,
        )
    return name


def clean_description(text: str) -> str:
    text = sanitize_text(text) or ""
    return text[:160]


def _membership(team: Team, user) -> TeamMembership | None:
    return TeamMembership.objects.filter(team=team, user=user).first()


def _require_role(team: Team, user, roles: tuple[str, ...]) -> TeamMembership:
    m = _membership(team, user)
    if m is None or m.role not in roles:
        raise SocialError("forbidden", "You don't have permission to do that in this team.", 403)
    return m


def _require_active(team: Team):
    if team.is_disabled:
        raise SocialError("team_disabled", "This team has been paused by our moderators.", 409)


def _recount(team: Team):
    team.member_count = TeamMembership.objects.filter(team=team).count()
    team.save(update_fields=["member_count", "updated_at"])


def _refresh_total(team: Team):
    from .rankings import refresh_team_totals

    refresh_team_totals(current_week_start(), [team.id])


def create_team(me, *, name: str, description: str = "", visibility: str = Team.PUBLIC) -> Team:
    s = require_social_enabled("teams")
    name = clean_name(name)
    if visibility not in (Team.PUBLIC, Team.INVITE_ONLY):
        raise SocialError("invalid_visibility", "Choose public or invite only.", 400)
    if TeamMembership.objects.filter(user=me).count() >= s.max_teams_per_user:
        raise SocialError("team_limit", f"You can be in up to {s.max_teams_per_user} teams.", 409)
    if Team.objects.filter(name_key=name_key(name)).exists():
        raise SocialError("name_taken", "A team with that name already exists.", 409)
    try:
        with transaction.atomic():
            team = Team.objects.create(
                name=name,
                name_key=name_key(name),
                description=clean_description(description),
                visibility=visibility,
                invite_code=new_code(),
                created_by=me,
                member_count=1,
            )
            TeamMembership.objects.create(team=team, user=me, role=TeamMembership.OWNER)
    except IntegrityError:
        raise SocialError("name_taken", "A team with that name already exists.", 409)
    _refresh_total(team)
    return team


def get_team(team_id: int, *, include_disabled_for=None) -> Team:
    team = Team.objects.filter(id=team_id).first()
    if team is None:
        raise SocialError("team_not_found", "We couldn't find that team.", 404)
    if team.is_disabled and not (include_disabled_for and _membership(team, include_disabled_for)):
        raise SocialError("team_not_found", "We couldn't find that team.", 404)
    return team


def find_by_code(code: str) -> Team:
    code = (code or "").strip().upper()
    team = Team.objects.filter(invite_code=code, is_disabled=False).first() if code and len(code) <= 12 else None
    if team is None:
        raise SocialError("team_not_found", "That team code isn't valid.", 404)
    return team


def join_team(me, team: Team, *, code: str | None = None) -> TeamMembership:
    s = require_social_enabled("teams")
    with transaction.atomic():
        team = Team.objects.select_for_update().get(pk=team.pk)
        _require_active(team)
        existing = _membership(team, me)
        if existing:
            return existing
        if team.visibility == Team.INVITE_ONLY and (code or "").strip().upper() != team.invite_code:
            raise SocialError("invite_required", "This team is invite only. Ask a member for the code.", 403)
        if TeamMembership.objects.filter(user=me).count() >= s.max_teams_per_user:
            raise SocialError("team_limit", f"You can be in up to {s.max_teams_per_user} teams.", 409)
        if TeamMembership.objects.filter(team=team).count() >= s.max_team_members:
            raise SocialError("team_full", f"This team is full ({s.max_team_members} members).", 409)
        m = TeamMembership.objects.create(team=team, user=me, role=TeamMembership.MEMBER)
        _recount(team)
    _refresh_total(team)
    return m


def leave_team(me, team: Team) -> str:
    """Returns "left" or "disbanded" (last member)."""
    require_social_enabled()
    with transaction.atomic():
        team = Team.objects.select_for_update().get(pk=team.pk)
        m = _membership(team, me)
        if m is None:
            raise SocialError("not_member", "You're not in this team.", 404)
        others = TeamMembership.objects.filter(team=team).exclude(user=me).count()
        if m.role == TeamMembership.OWNER and others:
            raise SocialError("owner_must_transfer", "Make someone else the owner before you leave.", 409)
        m.delete()
        if not others:
            team.delete()
            return "disbanded"
        _recount(team)
    _refresh_total(team)
    return "left"


def remove_member(me, team: Team, user_id: int) -> None:
    require_social_enabled()
    with transaction.atomic():
        team = Team.objects.select_for_update().get(pk=team.pk)
        _require_active(team)
        actor = _require_role(team, me, (TeamMembership.OWNER, TeamMembership.ADMIN))
        target = TeamMembership.objects.filter(team=team, user_id=user_id).select_related("user").first()
        if target is None:
            raise SocialError("not_member", "That person isn't in this team.", 404)
        if target.user_id == me.id:
            raise SocialError("self", "Use Leave team instead.", 400)
        allowed = target.role == TeamMembership.MEMBER or (
            actor.role == TeamMembership.OWNER and target.role == TeamMembership.ADMIN
        )
        if not allowed:
            raise SocialError("forbidden", "You don't have permission to remove this member.", 403)
        target.delete()
        _recount(team)
    notify(target.user, SocialNotification.TEAM_REMOVED, data={"team_id": team.id, "team_name": team.name})
    _refresh_total(team)


def set_role(me, team: Team, user_id: int, role: str) -> TeamMembership:
    require_social_enabled()
    if role not in (TeamMembership.ADMIN, TeamMembership.MEMBER):
        raise SocialError("invalid_role", "Role must be admin or member.", 400)
    with transaction.atomic():
        team = Team.objects.select_for_update().get(pk=team.pk)
        _require_active(team)
        _require_role(team, me, (TeamMembership.OWNER,))
        target = TeamMembership.objects.filter(team=team, user_id=user_id).select_related("user").first()
        if target is None:
            raise SocialError("not_member", "That person isn't in this team.", 404)
        if target.role == TeamMembership.OWNER:
            raise SocialError("forbidden", "Transfer ownership instead.", 400)
        if target.role != role:
            target.role = role
            target.save(update_fields=["role"])
            notify(target.user, SocialNotification.TEAM_ROLE, data={"team_id": team.id, "team_name": team.name, "role": role})
    return target


def transfer_ownership(me, team: Team, user_id: int) -> None:
    require_social_enabled()
    with transaction.atomic():
        team = Team.objects.select_for_update().get(pk=team.pk)
        _require_active(team)
        mine = _require_role(team, me, (TeamMembership.OWNER,))
        target = TeamMembership.objects.filter(team=team, user_id=user_id).select_related("user").first()
        if target is None or target.user_id == me.id:
            raise SocialError("not_member", "Choose another member of this team.", 400)
        mine.role = TeamMembership.ADMIN
        mine.save(update_fields=["role"])
        target.role = TeamMembership.OWNER
        target.save(update_fields=["role"])
    notify(target.user, SocialNotification.TEAM_ROLE, data={"team_id": team.id, "team_name": team.name, "role": "owner"})


def update_team(me, team: Team, *, name=None, description=None, visibility=None) -> Team:
    require_social_enabled("teams")
    _require_active(team)
    _require_role(team, me, (TeamMembership.OWNER, TeamMembership.ADMIN))
    fields = []
    if name is not None:
        name = clean_name(name)
        key = name_key(name)
        if key != team.name_key and Team.objects.filter(name_key=key).exclude(pk=team.pk).exists():
            raise SocialError("name_taken", "A team with that name already exists.", 409)
        team.name, team.name_key = name, key
        fields += ["name", "name_key"]
    if description is not None:
        team.description = clean_description(description)
        fields.append("description")
    if visibility is not None:
        if visibility not in (Team.PUBLIC, Team.INVITE_ONLY):
            raise SocialError("invalid_visibility", "Choose public or invite only.", 400)
        team.visibility = visibility
        fields.append("visibility")
    if fields:
        try:
            team.save(update_fields=fields + ["updated_at"])
        except IntegrityError:
            raise SocialError("name_taken", "A team with that name already exists.", 409)
    return team


def reset_invite_code(me, team: Team) -> str:
    require_social_enabled("teams")
    _require_active(team)
    _require_role(team, me, (TeamMembership.OWNER, TeamMembership.ADMIN))
    for _ in range(5):
        try:
            with transaction.atomic():
                team.invite_code = new_code()
                team.save(update_fields=["invite_code", "updated_at"])
                return team.invite_code
        except IntegrityError:
            continue
    raise SocialError("retry", "Please try again.", 503)


def disband(me, team: Team) -> None:
    require_social_enabled()
    _require_role(team, me, (TeamMembership.OWNER,))
    team.delete()


def discover(me, query: str = "") -> list[Team]:
    """Public, active teams: by name prefix (>= 3 chars) or the biggest ones."""
    require_social_enabled("teams")
    qs = Team.objects.filter(visibility=Team.PUBLIC, is_disabled=False).exclude(memberships__user=me)
    q = (query or "").strip()
    if q:
        if len(q) < MIN_QUERY:
            raise SocialError("query_too_short", f"Type at least {MIN_QUERY} characters.", 400)
        qs = qs.filter(Q(name_key__startswith=name_key(q)) | Q(name_key__contains=f" {name_key(q)}"))
    return list(qs.order_by("-member_count", "name")[:20])
