"""Scheduled social jobs (registered in settings.CELERY_BEAT_SCHEDULE, run by the
built-in runner; priorities/leases in apps/admin_api/scheduler.py JOB_OPTIONS).

* social-refresh-weekly-totals (every 10 min): incremental. Recomputes WeeklyStepTotal
  only for users whose HealthRecords changed since the watermark, then every team's
  weekly total (one aggregate query), then feed milestones for those users.
* social-reconcile-weekly-totals (nightly, full=True): recomputes the open weeks for
  every user with records in them. Catches changes made with queryset.update() (which
  doesn't bump HealthRecord.synced_at), e.g. an admin re-including a day.
* social-finalize-week (Mondays 09:00 UTC = 12:00 EAT): archives the week that ended
  on Sunday (12 hours of grace for late/offline syncs): friends-rank snapshots, team
  ranks, weekly-winner badges and feed items, "weekly results" notifications.
  Idempotent via WeeklyArchive.
"""

from __future__ import annotations

import logging
from datetime import date, timedelta

from celery import shared_task
from django.contrib.auth import get_user_model
from django.db import transaction
from django.db.models import F
from django.utils import timezone

from apps.steps.models import HealthRecord

from .common import current_week_start, local_today
from .feed import STREAK_MILESTONES, record
from .models import (FeedEvent, Friendship, SocialNotification, SocialProfile,
                     SocialSettings, TeamMembership, TeamWeeklyTotal,
                     WeeklyArchive, WeeklyStepTotal)
from .notify import notify
from .rankings import (competition_ranks, eligible_user_ids,
                       refresh_team_totals, refresh_user_weeks)

logger = logging.getLogger(__name__)
User = get_user_model()

CHUNK = 500
WATERMARK_OVERLAP = timedelta(minutes=2)
WEEKLY_FRIENDS_BADGE = "weekly-friends-champion"
WEEKLY_TEAM_BADGE = "weekly-team-champion"
# A friends ranking only has a "winner" when at least this many people walked that week.
MIN_ACTIVE_FOR_WINNER = 3
MIN_TEAMS_FOR_WINNER = 2


def _open_weeks(today_ws: date) -> list[date]:
    prev = today_ws - timedelta(days=7)
    weeks = [today_ws]
    if not WeeklyArchive.objects.filter(week_start=prev).exists():
        weeks.append(prev)
    return weeks


def _chunks(ids):
    ids = list(ids)
    for i in range(0, len(ids), CHUNK):
        yield ids[i : i + CHUNK]


@shared_task
def refresh_weekly_totals(full: bool = False) -> str:
    s = SocialSettings.load()
    if not s.social_enabled:
        return "social disabled"
    started = timezone.now()
    ws = current_week_start(started)
    weeks = _open_weeks(ws)
    oldest = min(weeks)

    records = HealthRecord.objects.filter(date__gte=oldest)
    if not full and s.totals_watermark:
        records = records.filter(synced_at__gte=s.totals_watermark - WATERMARK_OVERLAP)
    user_ids = sorted(set(records.values_list("user_id", flat=True)))

    written = 0
    for chunk in _chunks(user_ids):
        written += refresh_user_weeks(chunk, weeks)
        _feed_milestones(chunk)
    for w in weeks:
        refresh_team_totals(w)

    SocialSettings.objects.filter(pk=1).update(totals_watermark=started)
    return f"users={len(user_ids)} rows={written} weeks={[w.isoformat() for w in weeks]}"


def _feed_milestones(user_ids: list[int]) -> None:
    """Goal hits (today / yesterday), streak milestones, challenge milestones reached.

    Only for users with at least one friend (nobody else would see them)."""
    with_friends = set(Friendship.objects.filter(user_id__in=user_ids).values_list("user_id", flat=True))
    if not with_friends:
        return
    today = local_today()
    # Goal hits are "generous": credited day steps vs the personal goal, excluded days never.
    for uid, day, goal in (
        HealthRecord.objects.filter(
            user_id__in=with_friends, is_suspicious=False, date__gte=today - timedelta(days=1), date__lte=today,
            user__daily_goal__gt=0, steps__gte=F("user__daily_goal"),
        ).values_list("user_id", "date", "user__daily_goal")
    ):
        record(uid, FeedEvent.GOAL_HIT, day.isoformat(), {"date": day.isoformat(), "goal": goal})

    milestones = set(STREAK_MILESTONES)
    for uid, streak in User.objects.filter(id__in=with_friends, current_streak__in=milestones).values_list(
        "id", "current_streak"
    ):
        started_on = today - timedelta(days=streak - 1)
        record(uid, FeedEvent.STREAK, f"{streak}:{started_on.isoformat()}", {"days": streak})

    from apps.challenges.models import Participant

    for uid, challenge_id, milestone in Participant.objects.filter(
        user_id__in=with_friends, qualified=True, challenge__end_date__gte=today - timedelta(days=7),
    ).values_list("user_id", "challenge_id", "challenge__milestone"):
        # No challenge name (private groups) and nothing about money.
        record(uid, FeedEvent.CHALLENGE_QUALIFIED, str(challenge_id), {"milestone": milestone})


# ── weekly archive ──────────────────────────────────────────────────────────


def _badge(slug: str, name: str, description: str):
    from apps.gamification.models import Badge

    badge, _ = Badge.objects.get_or_create(
        slug=slug,
        defaults={
            "name": name,
            "description": description,
            "icon": "trophy",
            "badge_type": "rank",
            "criteria_type": "manual",
            "color": "#14855D",
        },
    )
    return badge


def _award(user_id: int, badge) -> None:
    if getattr(badge, "is_retired", False):  # retired in the admin console: no new awards
        return
    from apps.gamification.models import UserBadge

    UserBadge.objects.get_or_create(user_id=user_id, badge=badge)


@shared_task
def finalize_week(week_start: str | None = None) -> str:
    s = SocialSettings.load()
    if not s.social_enabled:
        return "social disabled"
    ws = date.fromisoformat(week_start) if week_start else current_week_start() - timedelta(days=7)
    if ws >= current_week_start():
        return "week still open"
    if WeeklyArchive.objects.filter(week_start=ws).exists():
        return f"{ws} already archived"

    # 1. Final totals for everyone with records that week.
    end = ws + timedelta(days=6)
    users = sorted(set(HealthRecord.objects.filter(date__gte=ws, date__lte=end).values_list("user_id", flat=True)))
    for chunk in _chunks(users):
        refresh_user_weeks(chunk, [ws])
    refresh_team_totals(ws)

    # 2. Friends-rank snapshots for every user who walked and has friends.
    totals = dict(WeeklyStepTotal.objects.filter(week_start=ws, steps__gt=0).values_list("user_id", "steps"))
    friends_badge = _badge(
        WEEKLY_FRIENDS_BADGE, "Weekly friends champion", "Topped your friends' weekly steps ranking."
    )
    team_badge = _badge(WEEKLY_TEAM_BADGE, "Weekly team champion", "Your team topped the weekly team ranking.")
    ranked_users = winners = 0
    results: dict[int, dict] = {}
    walkers = list(totals.keys())
    for chunk in _chunks(walkers):
        pairs = list(Friendship.objects.filter(user_id__in=chunk).values_list("user_id", "friend_id"))
        friends: dict[int, set[int]] = {}
        for a, b in pairs:
            friends.setdefault(a, set()).add(b)
        everyone = set(chunk) | {b for _, b in pairs}
        eligible = eligible_user_ids(everyone)
        updates = []
        for uid in chunk:
            group = {f for f in friends.get(uid, set()) if f in eligible} | {uid}
            if len(group) < 2 or uid not in eligible:
                continue
            steps = {g: totals.get(g, 0) for g in group}
            ranks = competition_ranks(steps)
            active = sum(1 for v in steps.values() if v > 0)
            row = WeeklyStepTotal(user_id=uid, week_start=ws)
            row.friends_rank, row.friends_size = ranks[uid], len(group)
            updates.append(row)
            results[uid] = {"friends_rank": ranks[uid], "friends_size": len(group), "steps": totals.get(uid, 0)}
            if ranks[uid] == 1 and active >= MIN_ACTIVE_FOR_WINNER:
                winners += 1
                _award(uid, friends_badge)
                record(uid, FeedEvent.WEEKLY_WINNER, ws.isoformat(), {"week_start": ws.isoformat(), "scope": "friends"})
        for row in updates:
            WeeklyStepTotal.objects.filter(user_id=row.user_id, week_start=ws).update(
                friends_rank=row.friends_rank, friends_size=row.friends_size
            )
        ranked_users += len(updates)

    # 3. Team ranks.
    team_totals = list(
        TeamWeeklyTotal.objects.filter(week_start=ws, steps__gt=0, team__is_disabled=False).select_related("team")
    )
    team_ranks = competition_ranks({t.team_id: t.steps for t in team_totals})
    for t in team_totals:
        TeamWeeklyTotal.objects.filter(pk=t.pk).update(rank=team_ranks[t.team_id])
    team_result: dict[int, dict] = {}
    if team_totals:
        for m in TeamMembership.objects.filter(team_id__in=list(team_ranks)).select_related("team"):
            best = team_result.get(m.user_id)
            r = team_ranks[m.team_id]
            if best is None or r < best["rank"]:
                team_result[m.user_id] = {"team_id": m.team_id, "team_name": m.team.name, "rank": r, "teams": len(team_ranks)}
        if len(team_ranks) >= MIN_TEAMS_FOR_WINNER:
            top_ids = [tid for tid, r in team_ranks.items() if r == 1]
            member_ids = TeamMembership.objects.filter(team_id__in=top_ids).values_list("user_id", flat=True)
            for uid in eligible_user_ids(member_ids):
                if totals.get(uid, 0) > 0:
                    _award(uid, team_badge)

    # 4. One "weekly results" notification per person who was ranked anywhere.
    recipients = set(results) | {uid for uid in team_result if totals.get(uid, 0) > 0}
    profiles = {p.user_id: p for p in SocialProfile.objects.filter(user_id__in=recipients)}
    users_by_id = {u.id: u for u in User.objects.filter(id__in=recipients, is_active=True, deleted_at__isnull=True)}
    for uid in recipients:
        u = users_by_id.get(uid)
        if u is None:
            continue
        data = {"week_start": ws.isoformat(), "steps": totals.get(uid, 0)}
        if uid in results:
            data.update({"friends_rank": results[uid]["friends_rank"], "friends_size": results[uid]["friends_size"]})
        if uid in team_result:
            data["team"] = team_result[uid]
        notify(u, SocialNotification.WEEKLY_RESULTS, data=data, profile=profiles.get(uid))

    with transaction.atomic():
        WeeklyArchive.objects.get_or_create(
            week_start=ws,
            defaults={"users_ranked": ranked_users, "teams_ranked": len(team_totals), "friends_winners": winners},
        )
    return f"week={ws} users_ranked={ranked_users} teams={len(team_totals)} winners={winners}"
