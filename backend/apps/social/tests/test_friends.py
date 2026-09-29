"""Friendship state machine, search privacy / anti-enumeration, blocking, limits."""

from datetime import timedelta

from django.utils import timezone

from apps.social import friends as svc
from apps.social.common import SocialError, get_profile
from apps.social.models import (Block, FriendRequest, Friendship,
                                SocialNotification, SocialProfile,
                                SocialSettings)

from .helpers import SocialAPITestCase, befriend, make_user

REQUESTS = "/api/social/friends/requests/"


class FriendRequestStateMachineTests(SocialAPITestCase):
    def setUp(self):
        super().setUp()
        self.amina = make_user("amina")
        self.brian = make_user("brian")

    def send(self, sender, target):
        return self.as_user(sender).post(REQUESTS, {"user_id": target.id}, format="json")

    def test_send_accept_creates_symmetric_friendship_and_notifies(self):
        r = self.send(self.amina, self.brian)
        self.assertEqual(r.status_code, 201, r.data)
        self.assertEqual(r.data["status"], "sent")
        req_id = r.data["request_id"]
        self.assertTrue(
            SocialNotification.objects.filter(recipient=self.brian, kind="friend_request", actor=self.amina).exists()
        )
        # Sending again is idempotent
        r2 = self.send(self.amina, self.brian)
        self.assertEqual(r2.data["status"], "already_sent")
        self.assertEqual(FriendRequest.objects.filter(status="pending").count(), 1)

        r = self.as_user(self.brian).post(f"{REQUESTS}{req_id}/accept/")
        self.assertEqual(r.status_code, 200, r.data)
        self.assertTrue(Friendship.objects.filter(user=self.amina, friend=self.brian).exists())
        self.assertTrue(Friendship.objects.filter(user=self.brian, friend=self.amina).exists())
        self.assertEqual(FriendRequest.objects.get(id=req_id).status, "accepted")
        self.assertTrue(SocialNotification.objects.filter(recipient=self.amina, kind="friend_accepted").exists())
        # The request notice is marked read on accept
        self.assertFalse(
            SocialNotification.objects.filter(recipient=self.brian, kind="friend_request", read_at__isnull=True).exists()
        )

    def test_only_recipient_can_accept_or_decline_and_only_sender_can_cancel(self):
        req_id = self.send(self.amina, self.brian).data["request_id"]
        self.assertEqual(self.as_user(self.amina).post(f"{REQUESTS}{req_id}/accept/").status_code, 404)
        self.assertEqual(self.as_user(self.amina).post(f"{REQUESTS}{req_id}/decline/").status_code, 404)
        self.assertEqual(self.as_user(self.brian).post(f"{REQUESTS}{req_id}/cancel/").status_code, 404)
        self.assertEqual(self.as_user(self.amina).post(f"{REQUESTS}{req_id}/cancel/").status_code, 200)
        self.assertEqual(FriendRequest.objects.get(id=req_id).status, "cancelled")
        # Cancelled: the notice is withdrawn and the request can't be accepted any more
        self.assertFalse(SocialNotification.objects.filter(recipient=self.brian, kind="friend_request").exists())
        self.assertEqual(self.as_user(self.brian).post(f"{REQUESTS}{req_id}/accept/").status_code, 404)

    def test_decline_then_cooldown_before_asking_again(self):
        req_id = self.send(self.amina, self.brian).data["request_id"]
        self.assertEqual(self.as_user(self.brian).post(f"{REQUESTS}{req_id}/decline/").status_code, 200)
        self.assertFalse(Friendship.objects.exists())
        self.assertFalse(SocialNotification.objects.filter(recipient=self.amina).exists())  # sender not told
        r = self.send(self.amina, self.brian)
        self.assertEqual(r.status_code, 429)
        self.assertEqual(r.data["code"], "recently_requested")
        FriendRequest.objects.filter(id=req_id).update(responded_at=timezone.now() - timedelta(days=8))
        self.assertEqual(self.send(self.amina, self.brian).status_code, 201)

    def test_mutual_requests_become_a_friendship(self):
        self.send(self.amina, self.brian)
        r = self.send(self.brian, self.amina)
        self.assertEqual(r.data["status"], "accepted")
        self.assertEqual(Friendship.objects.count(), 2)
        self.assertEqual(FriendRequest.objects.filter(status="pending").count(), 0)

    def test_cannot_friend_self_or_existing_friend(self):
        self.assertEqual(self.send(self.amina, self.amina).status_code, 400)
        befriend(self.amina, self.brian)
        r = self.send(self.amina, self.brian)
        self.assertEqual(r.status_code, 409)
        self.assertEqual(r.data["code"], "already_friends")

    def test_remove_friend_removes_both_rows(self):
        befriend(self.amina, self.brian)
        r = self.as_user(self.brian).delete(f"/api/social/friends/{self.amina.id}/")
        self.assertEqual(r.status_code, 204)
        self.assertFalse(Friendship.objects.exists())

    def test_daily_request_limit(self):
        SocialSettings.objects.update_or_create(pk=1, defaults={"friend_requests_per_day": 2})
        others = [make_user() for _ in range(3)]
        self.assertEqual(self.send(self.amina, others[0]).status_code, 201)
        self.assertEqual(self.send(self.amina, others[1]).status_code, 201)
        r = self.send(self.amina, others[2])
        self.assertEqual(r.status_code, 429)
        self.assertEqual(r.data["code"], "daily_limit")

    def test_friend_limit_on_accept(self):
        SocialSettings.objects.update_or_create(pk=1, defaults={"max_friends": 10})
        for _ in range(10):
            befriend(self.brian, make_user())
        req_id = self.send(self.amina, self.brian)
        self.assertEqual(req_id.status_code, 201)
        r = self.as_user(self.brian).post(f"{REQUESTS}{req_id.data['request_id']}/accept/")
        self.assertEqual(r.status_code, 409)
        self.assertEqual(r.data["code"], "friend_limit")
        self.assertFalse(Friendship.objects.filter(user=self.brian, friend=self.amina).exists())

    def test_social_switched_off(self):
        SocialSettings.objects.update_or_create(pk=1, defaults={"social_enabled": False})
        r = self.send(self.amina, self.brian)
        self.assertEqual(r.status_code, 503)
        self.assertEqual(r.data["code"], "social_disabled")


class SearchPrivacyTests(SocialAPITestCase):
    def setUp(self):
        super().setUp()
        self.me = make_user("searcher")
        self.open = make_user("kipchoge_open")
        self.fof = make_user("kipchoge_fof")
        self.hidden = make_user("kipchoge_hidden")
        get_profile(self.fof)
        SocialProfile.objects.filter(user=self.fof).update(discoverability="friends_of_friends")
        get_profile(self.hidden)
        SocialProfile.objects.filter(user=self.hidden).update(discoverability="nobody")

    def search(self, q, user=None):
        return self.as_user(user or self.me).get("/api/social/users/search/", {"q": q})

    def names(self, r):
        return [x["username"] for x in r.data["results"]]

    def test_short_queries_are_refused(self):
        r = self.search("ki")
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.data["code"], "query_too_short")

    def test_respects_who_can_find_me(self):
        self.assertEqual(self.names(self.search("kipchoge")), ["kipchoge_open"])
        # A mutual friend makes the friends-of-friends account findable, not the "nobody" one
        mutual = make_user("mutual")
        befriend(self.me, mutual)
        befriend(mutual, self.fof)
        befriend(mutual, self.hidden)
        self.assertEqual(sorted(self.names(self.search("kipchoge"))), ["kipchoge_fof", "kipchoge_open"])

    def test_search_sends_only_public_fields_and_prefix_matches(self):
        r = self.search("kipchoge_o")
        self.assertEqual(self.names(r), ["kipchoge_open"])
        row = r.data["results"][0]
        self.assertEqual(set(row), {"id", "username", "profile_picture_url", "relationship"})
        self.assertEqual(self.names(self.search("choge")), [])  # no substring enumeration

    def test_results_are_capped(self):
        for i in range(15):
            make_user(f"otieno{i:02d}")
        self.assertEqual(len(self.search("otieno").data["results"]), svc.SEARCH_MAX_RESULTS)

    def test_staff_and_deleted_accounts_never_listed(self):
        make_user("kipchoge_staff", is_staff=True)
        gone = make_user("kipchoge_gone")
        gone.is_active = False
        gone.deleted_at = timezone.now()
        gone.save()
        self.assertEqual(self.names(self.search("kipchoge")), ["kipchoge_open"])

    def test_nobody_setting_still_allows_their_shared_code(self):
        code = get_profile(self.hidden).friend_code
        r = self.as_user(self.me).get(f"/api/social/users/code/{code}/")
        self.assertEqual(r.status_code, 200)
        r = self.as_user(self.me).post(REQUESTS, {"code": code}, format="json")
        self.assertEqual(r.status_code, 201)
        # ...but a direct request by id (i.e. found some other way) is refused like "not found"
        other = make_user()
        r = self.as_user(other).post(REQUESTS, {"user_id": self.hidden.id}, format="json")
        self.assertEqual(r.status_code, 404)

    def test_search_is_rate_limited(self):
        statuses = [self.search("kipchoge").status_code for _ in range(32)]
        self.assertIn(429, statuses)


class BlockingTests(SocialAPITestCase):
    def setUp(self):
        super().setUp()
        self.me = make_user("wanjiku")
        self.other = make_user("wanjiku_troll")

    def test_block_ends_friendship_requests_and_notifications(self):
        befriend(self.me, self.other)
        FriendRequest.objects.create(from_user=self.other, to_user=self.me)
        SocialNotification.objects.create(recipient=self.me, actor=self.other, kind="reaction")
        r = self.as_user(self.me).post("/api/social/blocks/", {"user_id": self.other.id}, format="json")
        self.assertEqual(r.status_code, 201)
        self.assertFalse(Friendship.objects.exists())
        self.assertFalse(FriendRequest.objects.filter(status="pending").exists())
        self.assertFalse(SocialNotification.objects.exists())

    def test_blocked_pair_cannot_find_or_request_each_other(self):
        Block.objects.create(blocker=self.me, blocked=self.other)
        for viewer, target in ((self.me, self.other), (self.other, self.me)):
            names = [x["username"] for x in self.as_user(viewer).get("/api/social/users/search/", {"q": "wanjiku"}).data["results"]]
            self.assertNotIn(target.username, names)
            r = self.as_user(viewer).post(REQUESTS, {"user_id": target.id}, format="json")
            self.assertEqual(r.status_code, 404)  # indistinguishable from "no such account"
            code = get_profile(target).friend_code
            self.assertEqual(self.as_user(viewer).get(f"/api/social/users/code/{code}/").status_code, 404)

    def test_unblock(self):
        Block.objects.create(blocker=self.me, blocked=self.other)
        self.assertEqual(self.as_user(self.other).delete(f"/api/social/blocks/{self.me.id}/").status_code, 204)
        self.assertTrue(Block.objects.exists())  # only the blocker can lift it
        self.assertEqual(self.as_user(self.me).delete(f"/api/social/blocks/{self.other.id}/").status_code, 204)
        self.assertFalse(Block.objects.exists())

    def test_accepting_after_being_blocked_fails(self):
        req = FriendRequest.objects.create(from_user=self.other, to_user=self.me)
        Block.objects.create(blocker=self.other, blocked=self.me)
        with self.assertRaises(SocialError):
            svc.accept(self.me, req.id)
        self.assertFalse(Friendship.objects.exists())


class ProfileSettingsTests(SocialAPITestCase):
    def test_defaults_and_updates(self):
        me = make_user()
        r = self.as_user(me).get("/api/social/me/")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.data["discoverability"], "everyone")
        self.assertTrue(r.data["share_goal_hits"])
        self.assertEqual(len(r.data["friend_code"]), 8)
        r = self.as_user(me).patch("/api/social/me/", {"discoverability": "nobody", "share_streaks": False}, format="json")
        self.assertEqual(r.data["discoverability"], "nobody")
        self.assertFalse(r.data["share_streaks"])
        self.assertEqual(self.as_user(me).patch("/api/social/me/", {"discoverability": "all"}, format="json").status_code, 400)
        self.assertEqual(self.as_user(me).patch("/api/social/me/", {"share_badges": "yes"}, format="json").status_code, 400)
        old = r.data["friend_code"]
        new = self.as_user(me).post("/api/social/me/reset-code/").data["friend_code"]
        self.assertNotEqual(old, new)
