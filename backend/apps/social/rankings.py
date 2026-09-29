"""Weekly rankings (bragging rights only: no money, no prizes, ever).

Which steps count
-----------------
Everything here reads steps through ONE place: ``day_steps_expression()`` via
``ranking_records()``, wrapped by ``ranking_steps(user, date)`` (single day) and
``weekly_steps_by_user(user_ids, week_start)`` (batch, same rule).

* MONEY-ELIGIBLE steps, the same per-day rule challenges pay on
  (``apps.steps.evidence.challenge_steps_expression()``): Phase 1b's
  ``HealthRecord.eligible_steps``, or the credited ``steps`` for days written before
  Phase 1b (NULL). While STEP_MONEY_REQUIRES_EVIDENCE is off, eligible == credited.
* Excluded days (``HealthRecord.is_suspicious``, sticky "strong evidence" days) never
  count.
* To rank on a different figure (e.g. all credited steps, like goals and streaks),
  change the single ``return`` line in ``day_steps_expression()``.
* Phase 1b re-evaluations write ``eligible_steps`` with queryset.update() (no
  synced_at bump): the nightly full reconcile picks those up.

Who is ranked
-------------
Active, non-deleted accounts that haven't opted out (``show_in_rankings``) and whose
trust score is above the SUSPEND band (> 20). Nobody is shown to someone they blocked
or were blocked by (a block also ends the friendship).

Weeks
-----
Monday to Sunday on the Africa/Nairobi calendar (``HealthRecord.date`` is the phone's
local day; Kenya has no DST). "Current week" is derived from the Nairobi clock, not
the server's UTC clock, so Sunday 23:30 EAT is still the old week.

Performance
-----------
Per-user weekly totals (WeeklyStepTotal) and per-team totals (TeamWeeklyTotal) are
precomputed: the ``social-refresh-weekly-totals`` job recomputes only users whose
HealthRecords changed since its watermark; reads are indexed lookups over a friend
list (<= max_friends) or the top N teams. The viewer's own total is recomputed on read
so "you" is always fresh.
"""

from __future__ import annotations

import logging
from datetime import date, timedelta

from django.contrib.auth import get_user_model
from django.db.models import Count, Q, Sum

from apps.steps.models import HealthRecord

from .common import current_week_start, hidden_user_ids, public_user
from .models import (Team, TeamMembership, TeamWeeklyTotal, WeeklyStepTotal)

logger = logging.getLogger(__name__)
User = get_user_model()

# Trust scores at or below this (SUSPEND / BAN bands) are left out of rankings.
RANKING_MIN_TRUST_EXCLUSIVE = 20
TEAM_LEADERBOARD_SIZE = 50


def day_steps_expression():
    """THE switch: the ORM expression for one day's ranking steps.

    Money-eligible steps, exactly as challenges count them. For all credited steps
    instead, return F("steps")."""
    from apps.steps.evidence import challenge_steps_expression

    return challenge_steps_expression()


def ranking_records():
    """HealthRecords that may count for rankings, annotated with ``rank_steps``.
    Excluded (suspicious) days never count."""
    return HealthRecord.objects.filter(is_suspicious=False).annotate(rank_steps=day_steps_expression())


def ranking_steps(user, day: date) -> int:
    """Ranking steps for one user on one day (0 for no record or an excluded day)."""
    user_id = getattr(user, "pk", user)
    value = (
        ranking_records()
        .filter(user_id=user_id, date=day)
        .values_list("rank_steps", flat=True)
        .first()
    )
    return max(0, int(value or 0))


def weekly_steps_by_user(user_ids, week_start: date) -> dict[int, tuple[int, int]]:
    """{user_id: (steps, days_counted)} for the week, same rule as ``ranking_steps``."""
    ids = list(user_ids)
    if not ids:
        return {}
    rows = (
        ranking_records()
        .filter(user_id__in=ids, date__gte=week_start, date__lte=week_start + timedelta(days=6))
        .values("user_id")
        .annotate(total=Sum("rank_steps"), days=Count("id", filter=Q(rank_steps__gt=0)))
    )
    return {r["user_id"]: (max(0, int(r["total"] or 0)), int(r["days"] or 0)) for r in rows}


def eligible_q(prefix: str = "user__") -> Q:
    """Filter for rows (via ``prefix``) whose user may appear in rankings."""
    return (
        Q(**{f"{prefix}is_active": True, f"{prefix}deleted_at__isnull": True})
        & ~Q(**{f"{prefix}social_profile__show_in_rankings": False})
        & ~Q(**{f"{prefix}trust_score__score__lte": RANKING_MIN_TRUST_EXCLUSIVE})
    )


def eligible_user_ids(user_ids) -> set[int]:
    ids = list(user_ids)
    if not ids:
        return set()
    return set(User.objects.filter(eligible_q(""), id__in=ids).values_list("id", flat=True))


# ── maintenance (used by jobs and on read) ───────────────────────────────────


def refresh_user_weeks(user_ids, week_starts) -> int:
    """Recompute WeeklyStepTotal for these users and weeks. Returns rows written."""
    ids = list({int(i) for i in user_ids})
    written = 0
    for ws in set(week_starts):
        for i in range(0, len(ids), 500):
            chunk = ids[i : i + 500]
            totals = weekly_steps_by_user(chunk, ws)
            existing = {r.user_id: r for r in WeeklyStepTotal.objects.filter(week_start=ws, user_id__in=chunk)}
            to_create, to_update = [], []
            for uid in chunk:
                steps, days = totals.get(uid, (0, 0))
                row = existing.get(uid)
                if row is None:
                    if steps > 0:
                        to_create.append(WeeklyStepTotal(user_id=uid, week_start=ws, steps=steps, days_counted=days))
                elif row.steps != steps or row.days_counted != days:
                    row.steps, row.days_counted = steps, days
                    to_update.append(row)
            if to_create:
                WeeklyStepTotal.objects.bulk_create(to_create, ignore_conflicts=True)
            if to_update:
                WeeklyStepTotal.objects.bulk_update(to_update, ["steps", "days_counted", "updated_at"])
            written += len(to_create) + len(to_update)
    return written


def refresh_team_totals(week_start: date, team_ids=None) -> int:
    """Recompute TeamWeeklyTotal (sum of current eligible members' weekly steps)."""
    teams = Team.objects.filter(is_disabled=False)
    if team_ids is not None:
        teams = teams.filter(id__in=list(team_ids))
    team_list = list(teams.values_list("id", flat=True))
    if not team_list:
        return 0
    sums = {
        r["team_id"]: (int(r["total"] or 0), int(r["n"] or 0))
        for r in TeamMembership.objects.filter(team_id__in=team_list)
        .filter(eligible_q("user__"))
        .filter(user__weekly_step_totals__week_start=week_start)
        .values("team_id")
        .annotate(total=Sum("user__weekly_step_totals__steps"), n=Count("user_id", distinct=True))
    }
    existing = {r.team_id: r for r in TeamWeeklyTotal.objects.filter(week_start=week_start, team_id__in=team_list)}
    to_create, to_update = [], []
    for tid in team_list:
        steps, n = sums.get(tid, (0, 0))
        row = existing.get(tid)
        if row is None:
            if steps > 0:
                to_create.append(TeamWeeklyTotal(team_id=tid, week_start=week_start, steps=steps, members_counted=n))
        elif row.steps != steps or row.members_counted != n:
            row.steps, row.members_counted = steps, n
            to_update.append(row)
    if to_create:
        TeamWeeklyTotal.objects.bulk_create(to_create, ignore_conflicts=True)
    if to_update:
        TeamWeeklyTotal.objects.bulk_update(to_update, ["steps", "members_counted", "updated_at"])
    return len(to_create) + len(to_update)


# ── ranking helpers ──────────────────────────────────────────────────────────


def competition_ranks(values: dict[int, int]) -> dict[int, int]:
    """Standard competition ranking ("1, 2, 2, 4"): equal steps share a rank."""
    ordered = sorted(values.items(), key=lambda kv: -kv[1])
    ranks: dict[int, int] = {}
    prev = None
    for position, (key, val) in enumerate(ordered, start=1):
        if prev is None or val != prev[1]:
            prev = (position, val)
        ranks[key] = prev[0]
    return ranks


def _week_payload(week_start: date) -> dict:
    return {"week_start": week_start.isoformat(), "week_end": (week_start + timedelta(days=6)).isoformat()}


def friends_leaderboard(me, *, week_start: date | None = None, request=None) -> dict:
    """The viewer and their friends for a week, with movement vs the week before."""
    from .friends import friend_ids

    ws = week_start or current_week_start()
    prev_ws = ws - timedelta(days=7)
    current = ws == current_week_start()
    if current:
        refresh_user_weeks([me.id], [ws])  # "you" is always fresh

    hidden = hidden_user_ids(me.id)
    group = (friend_ids(me.id) - hidden) & eligible_user_ids(friend_ids(me.id))
    group.add(me.id)

    this_week = {uid: 0 for uid in group}
    days = {uid: 0 for uid in group}
    for r in WeeklyStepTotal.objects.filter(week_start=ws, user_id__in=group).values("user_id", "steps", "days_counted"):
        this_week[r["user_id"]] = r["steps"]
        days[r["user_id"]] = r["days_counted"]
    last_week = {uid: 0 for uid in group}
    for r in WeeklyStepTotal.objects.filter(week_start=prev_ws, user_id__in=group).values("user_id", "steps"):
        last_week[r["user_id"]] = r["steps"]

    ranks = competition_ranks(this_week)
    active_last = {k: v for k, v in last_week.items() if v > 0}
    last_ranks = competition_ranks(active_last)
    users = {u.id: u for u in User.objects.filter(id__in=group)}

    rows = []
    for uid, steps in sorted(this_week.items(), key=lambda kv: (-kv[1], users[kv[0]].username.lower() if kv[0] in users else "")):
        u = users.get(uid)
        if u is None:
            continue
        last_rank = last_ranks.get(uid)
        rows.append(
            {
                "rank": ranks[uid],
                "user": public_user(u, request),
                "steps": steps,
                "days_counted": days[uid],
                "last_week_steps": last_week[uid],
                "last_week_rank": last_rank,
                "movement": (last_rank - ranks[uid]) if last_rank is not None else None,
                "is_me": uid == me.id,
            }
        )
    me_row = next((r for r in rows if r["is_me"]), None)
    return {
        **_week_payload(ws),
        "is_current_week": current,
        "size": len(rows),
        "me": me_row,
        "rows": rows,
    }


class _RankIndex:
    """Rank of any step total among a week's teams (one query, then bisect)."""

    def __init__(self, ws: date):
        self.ascending = sorted(
            TeamWeeklyTotal.objects.filter(week_start=ws, team__is_disabled=False, steps__gt=0).values_list(
                "steps", flat=True
            )
        )

    def rank(self, steps: int) -> int | None:
        if steps <= 0:
            return None
        from bisect import bisect_right

        return len(self.ascending) - bisect_right(self.ascending, steps) + 1


def teams_leaderboard(me, *, week_start: date | None = None) -> dict:
    ws = week_start or current_week_start()
    prev_ws = ws - timedelta(days=7)
    top = list(
        TeamWeeklyTotal.objects.filter(week_start=ws, team__is_disabled=False, steps__gt=0)
        .select_related("team")
        .order_by("-steps", "team__name")[:TEAM_LEADERBOARD_SIZE]
    )
    my_team_ids = set(TeamMembership.objects.filter(user=me, team__is_disabled=False).values_list("team_id", flat=True))
    wanted = {t.team_id for t in top} | my_team_ids
    last = dict(TeamWeeklyTotal.objects.filter(week_start=prev_ws, team_id__in=wanted).values_list("team_id", "steps"))
    ranks = competition_ranks({t.team_id: t.steps for t in top})
    prev_index = _RankIndex(prev_ws)

    def row(team: Team, steps: int, members_counted: int, rank: int | None) -> dict:
        last_steps = last.get(team.id, 0)
        last_rank = prev_index.rank(last_steps)
        return {
            "rank": rank,
            "team": {"id": team.id, "name": team.name, "member_count": team.member_count, "visibility": team.visibility},
            "steps": steps,
            "members_counted": members_counted,
            "last_week_steps": last_steps,
            "last_week_rank": last_rank,
            "movement": (last_rank - rank) if (last_rank and rank) else None,
            "is_mine": team.id in my_team_ids,
        }

    rows = [row(t.team, t.steps, t.members_counted, ranks[t.team_id]) for t in top]
    listed = {t.team_id for t in top}
    mine = []
    my_totals = {t.team_id: t for t in TeamWeeklyTotal.objects.filter(team_id__in=my_team_ids, week_start=ws)}
    index = _RankIndex(ws) if my_team_ids - listed else None
    for team in Team.objects.filter(id__in=my_team_ids).order_by("name"):
        total = my_totals.get(team.id)
        steps = total.steps if total else 0
        n = total.members_counted if total else 0
        r = ranks.get(team.id) if team.id in listed else index.rank(steps)
        mine.append(row(team, steps, n, r))
    return {**_week_payload(ws), "is_current_week": ws == current_week_start(), "rows": rows, "mine": mine}


def team_members_ranking(team: Team, me, *, week_start: date | None = None, request=None) -> list[dict]:
    ws = week_start or current_week_start()
    hidden = hidden_user_ids(me.id)
    members = list(
        TeamMembership.objects.filter(team=team).exclude(user_id__in=hidden).select_related("user")
    )
    ids = [m.user_id for m in members]
    eligible = eligible_user_ids(ids)
    steps = dict(WeeklyStepTotal.objects.filter(week_start=ws, user_id__in=ids).values_list("user_id", "steps"))
    ranked = {m.user_id: steps.get(m.user_id, 0) for m in members if m.user_id in eligible}
    ranks = competition_ranks(ranked)
    out = []
    for m in members:
        out.append(
            {
                "user": public_user(m.user, request),
                "role": m.role,
                "joined_at": m.joined_at.isoformat(),
                "steps": ranked.get(m.user_id) if m.user_id in eligible else None,
                "rank": ranks.get(m.user_id),
                "is_me": m.user_id == me.id,
            }
        )
    out.sort(key=lambda r: (r["rank"] is None, r["rank"] or 0, r["user"]["username"].lower()))
    return out
