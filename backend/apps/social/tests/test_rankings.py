"""Weekly rankings: which steps count, EAT week boundaries, ranks, movement, privacy,
incremental refresh, weekly archive (badges + notifications), team totals."""

from datetime import date, datetime, timedelta
from datetime import timezone as dt_timezone
from unittest.mock import patch

from django.test import TestCase

from apps.gamification.models import UserBadge
from apps.social import rankings
from apps.social.common import current_week_start, get_profile, week_start_for
from apps.social.models import (Block, SocialNotification, SocialProfile,
                                SocialSettings, Team, TeamMembership,
                                TeamWeeklyTotal, WeeklyArchive, WeeklyStepTotal)
from apps.social.tasks import finalize_week, refresh_weekly_totals
from apps.social.teams import create_team, join_team
from apps.steps.models import HealthRecord, TrustScore

from .helpers import SocialAPITestCase, befriend, make_user


def walk(user, day, steps, suspicious=False):
    return HealthRecord.objects.update_or_create(
        user=user, date=day, defaults={"steps": steps, "is_suspicious": suspicious}
    )[0]


class WeekBoundaryTests(TestCase):
    def test_week_follows_nairobi_clock_not_utc(self):
        # Sunday 2026-09-27 20:59 UTC = 23:59 EAT Sunday: still the week of Mon 21 Sep
        self.assertEqual(
            current_week_start(datetime(2026, 9, 27, 20, 59, tzinfo=dt_timezone.utc)), date(2026, 9, 21)
        )
        # Sunday 21:00 UTC = Monday 00:00 EAT: the new week has started
        self.assertEqual(
            current_week_start(datetime(2026, 9, 27, 21, 0, tzinfo=dt_timezone.utc)), date(2026, 9, 28)
        )
        # Monday 01:00 EAT is Sunday 22:00 UTC: UTC would still say the old week
        self.assertEqual(
            current_week_start(datetime(2026, 9, 27, 22, 0, tzinfo=dt_timezone.utc)), date(2026, 9, 28)
        )

    def test_week_start_for_is_monday(self):
        self.assertEqual(week_start_for(date(2026, 9, 21)), date(2026, 9, 21))  # Monday
        self.assertEqual(week_start_for(date(2026, 9, 27)), date(2026, 9, 21))  # Sunday
        self.assertEqual(week_start_for(date(2026, 9, 28)), date(2026, 9, 28))


class RankingStepsTests(TestCase):
    def setUp(self):
        self.user = make_user()
        self.ws = date(2026, 9, 21)

    def test_excluded_days_never_count(self):
        walk(self.user, self.ws, 8000)
        walk(self.user, self.ws + timedelta(days=1), 40000, suspicious=True)
        walk(self.user, self.ws + timedelta(days=6), 5000)
        walk(self.user, self.ws + timedelta(days=7), 9999)  # next week's Monday
        walk(self.user, self.ws - timedelta(days=1), 9999)  # previous Sunday
        self.assertEqual(rankings.ranking_steps(self.user, self.ws), 8000)
        self.assertEqual(rankings.ranking_steps(self.user, self.ws + timedelta(days=1)), 0)
        self.assertEqual(rankings.weekly_steps_by_user([self.user.id], self.ws), {self.user.id: (13000, 2)})

    def test_single_switch(self):
        """ranking_steps and the weekly aggregate read the same, single expression."""
        from django.db.models import F

        walk(self.user, self.ws, 8000)
        HealthRecord.objects.filter(user=self.user).update(last_raw_steps=12345)
        with patch.object(rankings, "day_steps_expression", lambda: F("last_raw_steps")):
            self.assertEqual(rankings.ranking_steps(self.user, self.ws), 12345)
            self.assertEqual(rankings.weekly_steps_by_user([self.user.id], self.ws)[self.user.id][0], 12345)

    def test_money_eligible_steps_rank_and_pre_phase_1b_days_count_in_full(self):
        walk(self.user, self.ws, 8000)  # eligible_steps NULL: written before Phase 1b
        walk(self.user, self.ws + timedelta(days=1), 10000)
        HealthRecord.objects.filter(user=self.user, date=self.ws + timedelta(days=1)).update(eligible_steps=6000)
        self.assertEqual(rankings.ranking_steps(self.user, self.ws), 8000)
        self.assertEqual(rankings.ranking_steps(self.user, self.ws + timedelta(days=1)), 6000)
        self.assertEqual(rankings.weekly_steps_by_user([self.user.id], self.ws), {self.user.id: (14000, 2)})

    def test_competition_ranking_shares_ties(self):
        self.assertEqual(rankings.competition_ranks({1: 100, 2: 300, 3: 100, 4: 50}), {2: 1, 1: 2, 3: 2, 4: 4})


class FriendsLeaderboardTests(SocialAPITestCase):
    def setUp(self):
        super().setUp()
        self.ws = current_week_start()
        self.prev = self.ws - timedelta(days=7)
        self.me = make_user("me_walker")
        self.a = make_user("friend_a")
        self.b = make_user("friend_b")
        self.stranger = make_user("stranger")
        befriend(self.me, self.a)
        befriend(self.me, self.b)
        # This week (Monday only, so the test works on any weekday)
        walk(self.me, self.ws, 9000)
        walk(self.a, self.ws, 12000)
        walk(self.b, self.ws, 3000)
        walk(self.b, self.ws, 3000)
        walk(self.stranger, self.ws, 50000)
        # Last week: me first, a second, b third
        walk(self.me, self.prev, 20000)
        walk(self.a, self.prev, 10000)
        walk(self.b, self.prev, 5000)
        refresh_weekly_totals(full=True)

    def board(self, user=None, week="current"):
        r = self.as_user(user or self.me).get("/api/social/rankings/friends/", {"week": week})
        self.assertEqual(r.status_code, 200, r.data)
        return r.data

    def test_ranks_steps_movement_and_you(self):
        data = self.board()
        self.assertEqual(data["week_start"], self.ws.isoformat())
        rows = [(r["user"]["username"], r["rank"], r["steps"], r["movement"], r["is_me"]) for r in data["rows"]]
        self.assertEqual(
            rows,
            [("friend_a", 1, 12000, 1, False), ("me_walker", 2, 9000, -1, True), ("friend_b", 3, 3000, 0, False)],
        )
        self.assertEqual(data["me"]["rank"], 2)
        self.assertNotIn("stranger", [r["user"]["username"] for r in data["rows"]])

    def test_suspicious_day_is_dropped_on_refresh(self):
        walk(self.a, self.ws, 12000, suspicious=True)
        refresh_weekly_totals(full=True)
        rows = {r["user"]["username"]: r for r in self.board()["rows"]}
        self.assertEqual(rows["friend_a"]["steps"], 0)
        self.assertEqual(rows["me_walker"]["rank"], 1)

    def test_own_total_is_fresh_on_read(self):
        walk(self.me, self.ws, 30000)  # no job run
        self.assertEqual(self.board()["me"]["steps"], 30000)

    def test_opt_out_low_trust_and_blocks_are_hidden(self):
        get_profile(self.a)
        SocialProfile.objects.filter(user=self.a).update(show_in_rankings=False)
        TrustScore.objects.create(user=self.b, score=15)
        names = [r["user"]["username"] for r in self.board()["rows"]]
        self.assertEqual(names, ["me_walker"])
        SocialProfile.objects.filter(user=self.a).update(show_in_rankings=True)
        Block.objects.create(blocker=self.a, blocked=self.me)
        names = [r["user"]["username"] for r in self.board()["rows"]]
        self.assertNotIn("friend_a", names)

    def test_previous_week_view(self):
        data = self.board(week="previous")
        self.assertEqual([r["user"]["username"] for r in data["rows"]], ["me_walker", "friend_a", "friend_b"])
        self.assertFalse(data["is_current_week"])

    def test_invalid_week(self):
        r = self.as_user(self.me).get("/api/social/rankings/friends/", {"week": "2099-01-05"})
        self.assertEqual(r.status_code, 400)

    def test_no_money_in_payloads(self):
        text = str(self.board()).lower()
        for word in ("kes", "prize", "payout", "fee", "wallet", "balance"):
            self.assertNotIn(word, text)


class IncrementalRefreshTests(TestCase):
    def test_only_changed_users_are_recomputed_after_the_watermark(self):
        ws = current_week_start()
        u1, u2 = make_user(), make_user()
        walk(u1, ws, 1000)
        walk(u2, ws, 2000)
        refresh_weekly_totals()
        self.assertEqual(WeeklyStepTotal.objects.get(user=u1, week_start=ws).steps, 1000)
        self.assertIsNotNone(SocialSettings.load().totals_watermark)
        # A queryset.update() doesn't bump synced_at: the incremental run misses it
        # (synced_at placed before the watermark's 2-minute overlap)...
        from django.utils import timezone

        HealthRecord.objects.filter(user=u2).update(steps=2500, synced_at=timezone.now() - timedelta(minutes=10))
        walk(u1, ws, 1500)  # save() bumps synced_at
        refresh_weekly_totals()
        self.assertEqual(WeeklyStepTotal.objects.get(user=u1, week_start=ws).steps, 1500)
        self.assertEqual(WeeklyStepTotal.objects.get(user=u2, week_start=ws).steps, 2000)
        # ...and the nightly full reconcile catches it
        refresh_weekly_totals(full=True)
        self.assertEqual(WeeklyStepTotal.objects.get(user=u2, week_start=ws).steps, 2500)

    def test_disabled_social_does_nothing(self):
        SocialSettings.objects.update_or_create(pk=1, defaults={"social_enabled": False})
        walk(make_user(), current_week_start(), 1000)
        self.assertEqual(refresh_weekly_totals(), "social disabled")
        self.assertFalse(WeeklyStepTotal.objects.exists())


class WeeklyArchiveTests(TestCase):
    def setUp(self):
        self.prev = current_week_start() - timedelta(days=7)
        self.users = [make_user(f"arch{i}") for i in range(4)]
        a, b, c, d = self.users
        for x in (b, c, d):
            befriend(a, x)
        for u, steps in zip(self.users, (30000, 20000, 10000, 0)):
            if steps:
                walk(u, self.prev + timedelta(days=2), steps)

    def test_finalize_snapshots_ranks_awards_badge_and_notifies_once(self):
        a, b, c, d = self.users
        get_profile(c)
        SocialProfile.objects.filter(user=c).update(notify_weekly_results=False)
        result = finalize_week()
        self.assertIn("users_ranked=3", result)
        row = WeeklyStepTotal.objects.get(user=a, week_start=self.prev)
        self.assertEqual((row.friends_rank, row.friends_size), (1, 4))
        self.assertEqual(WeeklyStepTotal.objects.get(user=b, week_start=self.prev).friends_rank, 2)
        self.assertTrue(UserBadge.objects.filter(user=a, badge__slug="weekly-friends-champion").exists())
        self.assertFalse(UserBadge.objects.filter(user=b, badge__slug="weekly-friends-champion").exists())
        self.assertTrue(SocialNotification.objects.filter(recipient=a, kind="weekly_results").exists())
        self.assertTrue(SocialNotification.objects.filter(recipient=b, kind="weekly_results").exists())
        self.assertFalse(SocialNotification.objects.filter(recipient=c).exists())  # preference off
        self.assertFalse(SocialNotification.objects.filter(recipient=d).exists())  # didn't walk
        self.assertTrue(WeeklyArchive.objects.filter(week_start=self.prev).exists())
        # Idempotent
        self.assertIn("already archived", finalize_week())
        self.assertEqual(SocialNotification.objects.filter(recipient=a, kind="weekly_results").count(), 1)

    def test_no_winner_badge_when_too_few_walked(self):
        a, b, c, d = self.users
        HealthRecord.objects.filter(user__in=[c]).delete()
        HealthRecord.objects.filter(user=b).update(is_suspicious=True)
        finalize_week()
        self.assertFalse(UserBadge.objects.filter(badge__slug="weekly-friends-champion").exists())

    def test_current_week_cannot_be_finalized(self):
        self.assertEqual(finalize_week(current_week_start().isoformat()), "week still open")


class TeamRankingTests(SocialAPITestCase):
    def setUp(self):
        super().setUp()
        self.ws = current_week_start()
        self.owner1, self.m1, self.owner2, self.outsider = (make_user() for _ in range(4))
        self.t1 = create_team(self.owner1, name="Nairobi Striders")
        join_team(self.m1, self.t1)
        self.t2 = create_team(self.owner2, name="Kisumu Walkers")
        walk(self.owner1, self.ws, 5000)
        walk(self.m1, self.ws, 6000)
        walk(self.owner2, self.ws, 8000)
        walk(self.outsider, self.ws, 90000)
        walk(self.m1, self.ws - timedelta(days=7), 1000)  # previous week doesn't leak in
        refresh_weekly_totals(full=True)

    def test_team_totals_and_leaderboard(self):
        self.assertEqual(TeamWeeklyTotal.objects.get(team=self.t1, week_start=self.ws).steps, 11000)
        self.assertEqual(TeamWeeklyTotal.objects.get(team=self.t1, week_start=self.ws).members_counted, 2)
        r = self.as_user(self.m1).get("/api/social/rankings/teams/")
        self.assertEqual(r.status_code, 200)
        self.assertEqual([(x["team"]["name"], x["rank"], x["steps"]) for x in r.data["rows"]],
                         [("Nairobi Striders", 1, 11000), ("Kisumu Walkers", 2, 8000)])
        self.assertTrue(r.data["rows"][0]["is_mine"])
        self.assertEqual(r.data["mine"][0]["rank"], 1)

    def test_disabled_team_leaves_the_leaderboard(self):
        Team.objects.filter(pk=self.t1.pk).update(is_disabled=True)
        r = self.as_user(self.owner2).get("/api/social/rankings/teams/")
        self.assertEqual([x["team"]["name"] for x in r.data["rows"]], ["Kisumu Walkers"])

    def test_team_members_ranking_in_detail(self):
        r = self.as_user(self.owner1).get(f"/api/social/teams/{self.t1.id}/")
        self.assertEqual([(m["user"]["username"], m["rank"], m["steps"]) for m in r.data["members"]],
                         [(self.m1.username, 1, 6000), (self.owner1.username, 2, 5000)])
        self.assertEqual(r.data["week_steps"], 11000)

    def test_joining_updates_team_total_immediately(self):
        join_team(self.outsider, self.t2)
        self.assertEqual(TeamWeeklyTotal.objects.get(team=self.t2, week_start=self.ws).steps, 98000)
        self.assertEqual(TeamMembership.objects.filter(team=self.t2).count(), 2)
