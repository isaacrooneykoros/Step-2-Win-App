"""Feed privacy and reactions, notifications, account deletion."""

from datetime import timedelta
from decimal import Decimal

from django.utils import timezone

from apps.gamification.models import Badge, UserBadge
from apps.social.common import current_week_start, get_profile, local_today
from apps.social.models import (Block, FeedEvent, FeedReaction, FriendRequest,
                                Friendship, SocialNotification, SocialProfile,
                                SocialReport, Team, TeamMembership,
                                WeeklyStepTotal)
from apps.social.tasks import refresh_weekly_totals
from apps.social.teams import create_team, join_team
from apps.steps.models import HealthRecord
from apps.users.account_deletion import delete_account

from .helpers import SocialAPITestCase, befriend, make_user


class FeedTests(SocialAPITestCase):
    def setUp(self):
        super().setUp()
        self.me = make_user("feed_me")
        self.friend = make_user("feed_friend", daily_goal=8000)
        self.stranger = make_user("feed_stranger", daily_goal=1000)
        befriend(self.me, self.friend)

    def feed(self, user=None):
        r = self.as_user(user or self.me).get("/api/social/feed/")
        self.assertEqual(r.status_code, 200, r.data)
        return r.data["items"]

    def test_goal_hit_and_streak_come_from_the_job_only_for_people_with_friends(self):
        today = local_today()
        HealthRecord.objects.create(user=self.friend, date=today, steps=9000)
        HealthRecord.objects.create(user=self.stranger, date=today, steps=5000)
        type(self.friend).objects.filter(pk=self.friend.pk).update(current_streak=7)
        refresh_weekly_totals(full=True)
        kinds = sorted(e["kind"] for e in self.feed())
        self.assertEqual(kinds, ["goal_hit", "streak"])
        self.assertFalse(FeedEvent.objects.filter(user=self.stranger).exists())
        # idempotent
        refresh_weekly_totals(full=True)
        self.assertEqual(FeedEvent.objects.filter(user=self.friend).count(), 2)

    def test_excluded_day_never_posts_a_goal(self):
        HealthRecord.objects.create(user=self.friend, date=local_today(), steps=30000, is_suspicious=True)
        refresh_weekly_totals(full=True)
        self.assertFalse(FeedEvent.objects.filter(kind="goal_hit").exists())

    def test_badge_signal_and_share_settings_apply_at_read_time(self):
        badge = Badge.objects.create(slug="first-10k", name="First 10k", description="d", icon="x", badge_type="milestone")
        UserBadge.objects.create(user=self.friend, badge=badge)
        self.assertEqual([e["data"]["badge_name"] for e in self.feed()], ["First 10k"])
        get_profile(self.friend)
        SocialProfile.objects.filter(user=self.friend).update(share_badges=False)
        self.assertEqual(self.feed(), [])

    def test_strangers_and_blocked_friends_see_nothing(self):
        FeedEvent.objects.create(user=self.friend, kind="goal_hit", key="d1", data={"goal": 8000})
        self.assertEqual(len(self.feed()), 1)
        self.assertEqual(self.feed(self.stranger), [])
        Block.objects.create(blocker=self.friend, blocked=self.me)
        self.assertEqual(self.feed(), [])

    def test_reactions_fixed_set_one_per_person_and_notify_when_opted_in(self):
        e = FeedEvent.objects.create(user=self.friend, kind="goal_hit", key="d1", data={})
        url = f"/api/social/feed/{e.id}/react/"
        self.assertEqual(self.as_user(self.me).post(url, {"kind": "love"}, format="json").status_code, 400)
        self.assertEqual(self.as_user(self.me).post(url, {"kind": "cheer"}, format="json").data["my_reaction"], "cheer")
        self.as_user(self.me).post(url, {"kind": "fire"}, format="json")
        self.assertEqual(FeedReaction.objects.get().kind, "fire")
        item = self.feed()[0]
        self.assertEqual(item["reactions"], {"fire": 1})
        self.assertEqual(item["my_reaction"], "fire")
        self.assertFalse(SocialNotification.objects.filter(kind="reaction").exists())  # off by default
        self.as_user(self.me).post(url, {"kind": None}, format="json")
        self.assertFalse(FeedReaction.objects.exists())
        # strangers can't react
        self.assertEqual(self.as_user(self.stranger).post(url, {"kind": "cheer"}, format="json").status_code, 404)

    def test_payload_has_no_location_or_money(self):
        FeedEvent.objects.create(user=self.friend, kind="challenge_qualified", key="1", data={"milestone": 50000})
        item = self.feed()[0]
        self.assertEqual(set(item["user"]), {"id", "username", "profile_picture_url"})
        self.assertEqual(item["data"], {"milestone": 50000})


class NotificationTests(SocialAPITestCase):
    def test_summary_list_read_and_preferences(self):
        me, other = make_user(), make_user()
        self.as_user(other).post("/api/social/friends/requests/", {"user_id": me.id}, format="json")
        s = self.as_user(me).get("/api/social/notifications/summary/").data
        self.assertEqual((s["unread"], s["pending_requests"], s["latest_kind"]), (1, 1, "friend_request"))
        items = self.as_user(me).get("/api/social/notifications/").data["results"]
        self.assertEqual(items[0]["actor"]["username"], other.username)
        self.as_user(me).post("/api/social/notifications/read/", {}, format="json")
        self.assertEqual(self.as_user(me).get("/api/social/notifications/summary/").data["unread"], 0)
        # switched off: nothing is stored
        third = make_user()
        get_profile(third)
        SocialProfile.objects.filter(user=third).update(notify_friend_requests=False)
        self.as_user(other).post("/api/social/friends/requests/", {"user_id": third.id}, format="json")
        self.assertFalse(SocialNotification.objects.filter(recipient=third).exists())
        self.assertTrue(FriendRequest.objects.filter(to_user=third, status="pending").exists())


class AccountDeletionTests(SocialAPITestCase):
    def test_deletion_removes_social_footprint_and_hands_over_teams(self):
        leaver = make_user("leaver", wallet_balance=Decimal("0"))
        friend = make_user("stays")
        heir = make_user("heir")
        befriend(leaver, friend)
        FriendRequest.objects.create(from_user=leaver, to_user=heir)
        Block.objects.create(blocker=friend, blocked=leaver)
        get_profile(leaver)
        team = create_team(leaver, name="Leavers Club")
        join_team(heir, team)
        solo = create_team(leaver, name="Solo Club")
        HealthRecord.objects.create(user=leaver, date=current_week_start(), steps=4000)
        refresh_weekly_totals(full=True)
        FeedEvent.objects.create(user=leaver, kind="goal_hit", key="x")
        e = FeedEvent.objects.create(user=friend, kind="goal_hit", key="y")
        FeedReaction.objects.create(event=e, user=leaver, kind="cheer")
        SocialNotification.objects.create(recipient=friend, actor=leaver, kind="friend_accepted")
        SocialReport.objects.create(reporter=leaver, target_type="user", target_user=friend, reason="spam")

        delete_account(leaver)

        self.assertFalse(Friendship.objects.filter(user=leaver).exists())
        self.assertFalse(Friendship.objects.filter(friend=leaver).exists())
        self.assertFalse(FriendRequest.objects.filter(from_user=leaver).exists())
        self.assertFalse(Block.objects.exists())
        self.assertFalse(SocialProfile.objects.filter(user=leaver).exists())
        self.assertFalse(FeedEvent.objects.filter(user=leaver).exists())
        self.assertFalse(FeedReaction.objects.exists())
        self.assertFalse(SocialNotification.objects.exists())
        self.assertFalse(WeeklyStepTotal.objects.filter(user=leaver).exists())
        self.assertIsNone(SocialReport.objects.get().reporter)
        self.assertEqual(TeamMembership.objects.get(team=team).user, heir)
        self.assertEqual(TeamMembership.objects.get(team=team).role, "owner")
        self.assertEqual(Team.objects.get(pk=team.pk).member_count, 1)
        self.assertFalse(Team.objects.filter(pk=solo.pk).exists())
