"""Admin console Part B moderation: hidden feed items / chat messages are excluded from
customer APIs; team member removal, ownership transfer, delete rules; report follow-ups."""

from datetime import date, timedelta
from decimal import Decimal

from apps.admin_api.models import AuditLog
from apps.challenges.models import Challenge, ChallengeMessage, Participant
from apps.social.feed import record
from apps.social.models import (FeedEvent, SocialReport, Team,
                                TeamMembership)

from .helpers import SocialAPITestCase, befriend, make_user


class HideContentTests(SocialAPITestCase):
    def setUp(self):
        super().setUp()
        self.admin = make_user("mod_admin", is_staff=True)
        self.me = make_user("mod_me")
        self.friend = make_user("mod_friend")
        befriend(self.me, self.friend)

    def test_hidden_feed_item_is_excluded_and_cannot_be_reacted_to(self):
        e = record(self.friend.id, FeedEvent.BADGE, "first-10k", {"badge_name": "First 10k"})
        self.assertEqual(len(self.as_user(self.me).get("/api/social/feed/").data["items"]), 1)
        staff = self.as_user(self.admin)
        self.assertEqual(staff.post(f"/api/admin/social/feed/{e.id}/hide/", {"reason": ""}, format="json").status_code, 400)
        r = staff.post(f"/api/admin/social/feed/{e.id}/hide/", {"reason": "Offensive badge name"}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertTrue(r.json()["hidden"])
        me = self.as_user(self.me)
        self.assertEqual(me.get("/api/social/feed/").data["items"], [])
        self.assertEqual(me.post(f"/api/social/feed/{e.id}/react/", {"kind": "cheer"}, format="json").status_code, 404)
        self.as_user(self.admin).post(f"/api/admin/social/feed/{e.id}/unhide/", {}, format="json")
        self.assertEqual(len(self.as_user(self.me).get("/api/social/feed/").data["items"]), 1)
        self.assertEqual(list(AuditLog.objects.filter(resource_type="feed_event").values_list("action", flat=True).order_by("id")),
                         ["hide", "unhide"])

    def test_hidden_chat_message_is_excluded(self):
        ch = Challenge.objects.create(name="Chatty", creator=self.me, milestone=50000, entry_fee=Decimal("0"),
                                      total_pool=Decimal("0"), max_participants=10, status="active",
                                      start_date=date.today(), end_date=date.today() + timedelta(days=7), is_private=True)
        Participant.objects.create(challenge=ch, user=self.me)
        bad = ChallengeMessage.objects.create(challenge=ch, user=self.me, message="rude words")
        ChallengeMessage.objects.create(challenge=ch, user=self.me, message="hello")
        r = self.as_user(self.admin).post(f"/api/admin/social/challenge-messages/{bad.id}/hide/",
                                          {"reason": "Harassment in chat"}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        msgs = self.as_user(self.me).get(f"/api/challenges/{ch.id}/chat/").json()["messages"]
        self.assertEqual([m["content"] for m in msgs], ["hello"])
        listing = self.as_user(self.admin).get(f"/api/admin/social/challenge-messages/?challenge={ch.id}&hidden=1").json()
        self.assertEqual([m["id"] for m in listing["results"]], [bad.id])
        self.assertTrue(AuditLog.objects.filter(resource_type="challenge_message", action="hide", resource_id=bad.id).exists())


class TeamAdminTests(SocialAPITestCase):
    def setUp(self):
        super().setUp()
        self.admin = make_user("team_admin", is_staff=True)
        self.owner = make_user("team_owner")
        self.member = make_user("team_member")
        self.team = Team.objects.create(name="Walkers", name_key="walkers", invite_code="ABC123", created_by=self.owner, member_count=2)
        TeamMembership.objects.create(team=self.team, user=self.owner, role=TeamMembership.OWNER)
        TeamMembership.objects.create(team=self.team, user=self.member, role=TeamMembership.MEMBER)

    def test_remove_transfer_and_delete_rules(self):
        staff = self.as_user(self.admin)
        base = f"/api/admin/social/teams/{self.team.id}"
        self.assertEqual(staff.post(f"{base}/members/{self.owner.id}/remove/", {"reason": "Spam team owner"}, format="json").status_code, 409)
        r = staff.post(f"{base}/transfer/", {"user_id": self.member.id, "reason": "Owner abusive"}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(TeamMembership.objects.get(team=self.team, user=self.member).role, "owner")
        self.assertEqual(TeamMembership.objects.get(team=self.team, user=self.owner).role, "admin")
        r = staff.post(f"{base}/members/{self.owner.id}/remove/", {"reason": "Abusive messages"}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.team.refresh_from_db()
        self.assertEqual(self.team.member_count, 1)
        # Not disabled / not empty: delete refused.
        self.assertEqual(staff.delete(f"{base}/").status_code, 409)
        staff.post(f"{base}/members/{self.member.id}/remove/", {"reason": "Closing the team"}, format="json")
        self.assertEqual(staff.delete(f"{base}/").status_code, 409)  # still not disabled
        staff.post(f"{base}/moderate/", {"action": "disable", "reason": "Closed by moderators"}, format="json")
        self.assertEqual(staff.delete(f"{base}/").status_code, 204)
        self.assertFalse(Team.objects.filter(pk=self.team.pk).exists())
        actions = set(AuditLog.objects.filter(resource_type="team").values_list("action", flat=True))
        self.assertTrue({"transfer_ownership", "remove_member", "delete"} <= actions)

    def test_report_follow_up_actions(self):
        from apps.steps.models import FraudFlag

        rep = SocialReport.objects.create(reporter=self.member, target_type="team", target_team=self.team, reason="offensive_name")
        staff = self.as_user(self.admin)
        r = staff.post(f"/api/admin/social/reports/{rep.id}/resolve/",
                       {"status": "actioned", "action": "disable_team", "note": "Offensive team name"}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.team.refresh_from_db()
        self.assertTrue(self.team.is_disabled)
        urep = SocialReport.objects.create(reporter=self.member, target_type="user", target_user=self.owner, reason="cheating")
        r = staff.post(f"/api/admin/social/reports/{urep.id}/resolve/",
                       {"status": "actioned", "action": "open_trust_case", "note": "Looks like shaking"}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertTrue(FraudFlag.objects.filter(user=self.owner, flag_type="social_report").exists())
        e = record(self.owner.id, FeedEvent.BADGE, "b1", {"badge_name": "x"})
        urep2 = SocialReport.objects.create(reporter=self.member, target_type="user", target_user=self.owner, reason="harassment")
        r = staff.post(f"/api/admin/social/reports/{urep2.id}/resolve/",
                       {"status": "actioned", "action": "hide_feed_event", "feed_event_id": e.id, "note": "Hide it now"}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        e.refresh_from_db()
        self.assertIsNotNone(e.hidden_at)
