"""Teams: roles, joining rules, limits, leave / kick / transfer, moderation, reports."""

from apps.admin_api.models import AuditLog
from apps.social.models import (Block, SocialNotification, SocialReport,
                                SocialSettings, Team, TeamMembership)

from .helpers import SocialAPITestCase, make_user

TEAMS = "/api/social/teams/"


class TeamLifecycleTests(SocialAPITestCase):
    def setUp(self):
        super().setUp()
        self.owner = make_user("owner")
        self.alice = make_user("alice")
        self.bob = make_user("bob")
        r = self.as_user(self.owner).post(TEAMS, {"name": "Karura  Runners", "visibility": "public"}, format="json")
        self.assertEqual(r.status_code, 201, r.data)
        self.team_id = r.data["id"]
        self.assertEqual(r.data["name"], "Karura Runners")  # whitespace collapsed
        self.assertEqual(r.data["my_role"], "owner")

    def url(self, suffix=""):
        return f"{TEAMS}{self.team_id}/{suffix}"

    def join(self, user, code=None):
        return self.as_user(user).post(self.url("join/"), {"code": code} if code else {}, format="json")

    def test_names_are_validated_and_unique(self):
        for bad in ("ab", "x" * 41, "<script>", "  "):
            r = self.as_user(self.alice).post(TEAMS, {"name": bad}, format="json")
            self.assertEqual(r.status_code, 400, bad)
        r = self.as_user(self.alice).post(TEAMS, {"name": "karura runners"}, format="json")
        self.assertEqual(r.status_code, 409)

    def test_join_public_and_invite_only(self):
        self.assertEqual(self.join(self.alice).status_code, 200)
        self.assertEqual(Team.objects.get(pk=self.team_id).member_count, 2)
        self.as_user(self.owner).patch(self.url(), {"visibility": "invite_only"}, format="json")
        r = self.join(self.bob)
        self.assertEqual(r.status_code, 403)
        # Invite-only teams aren't visible to outsiders without the code
        self.assertEqual(self.as_user(self.bob).get(self.url()).status_code, 404)
        code = Team.objects.get(pk=self.team_id).invite_code
        self.assertEqual(self.as_user(self.bob).get(self.url(), {"code": code}).status_code, 200)
        r = self.as_user(self.bob).post(f"{TEAMS}join-by-code/", {"code": code.lower()}, format="json")
        self.assertEqual(r.status_code, 200, r.data)
        self.assertEqual(r.data["my_role"], "member")
        self.assertEqual(r.data["invite_code"], code)  # members can invite friends

    def test_member_limit_and_teams_per_user(self):
        SocialSettings.objects.update_or_create(pk=1, defaults={"max_team_members": 2, "max_teams_per_user": 1})
        self.assertEqual(self.join(self.alice).status_code, 200)
        r = self.join(self.bob)
        self.assertEqual((r.status_code, r.data["code"]), (409, "team_full"))
        r = self.as_user(self.alice).post(TEAMS, {"name": "Second Team"}, format="json")
        self.assertEqual((r.status_code, r.data["code"]), (409, "team_limit"))

    def test_roles_kick_and_transfer(self):
        self.join(self.alice)
        self.join(self.bob)
        # members can't kick or promote
        r = self.as_user(self.alice).post(self.url(f"members/{self.bob.id}/remove/"))
        self.assertEqual(r.status_code, 403)
        r = self.as_user(self.owner).post(self.url(f"members/{self.alice.id}/role/"), {"role": "admin"}, format="json")
        self.assertEqual(r.status_code, 200)
        self.assertTrue(SocialNotification.objects.filter(recipient=self.alice, kind="team_role").exists())
        # admins can remove members but not other admins / the owner
        self.assertEqual(self.as_user(self.alice).post(self.url(f"members/{self.owner.id}/remove/")).status_code, 403)
        self.assertEqual(self.as_user(self.alice).post(self.url(f"members/{self.bob.id}/remove/")).status_code, 200)
        self.assertFalse(TeamMembership.objects.filter(team_id=self.team_id, user=self.bob).exists())
        self.assertTrue(SocialNotification.objects.filter(recipient=self.bob, kind="team_removed").exists())
        # admins can't change roles
        r = self.as_user(self.alice).post(self.url(f"members/{self.owner.id}/role/"), {"role": "member"}, format="json")
        self.assertEqual(r.status_code, 403)
        # owner can't leave while others remain; transfer then leave
        r = self.as_user(self.owner).post(self.url("leave/"))
        self.assertEqual((r.status_code, r.data["code"]), (409, "owner_must_transfer"))
        r = self.as_user(self.owner).post(self.url("transfer/"), {"user_id": self.alice.id}, format="json")
        self.assertEqual(r.status_code, 200, r.data)
        roles = dict(TeamMembership.objects.filter(team_id=self.team_id).values_list("user__username", "role"))
        self.assertEqual(roles, {"alice": "owner", "owner": "admin"})
        self.assertEqual(self.as_user(self.owner).post(self.url("leave/")).data["status"], "left")
        # the last member leaving disbands the team
        self.assertEqual(self.as_user(self.alice).post(self.url("leave/")).data["status"], "disbanded")
        self.assertFalse(Team.objects.filter(pk=self.team_id).exists())

    def test_only_owner_disbands_and_admin_can_edit(self):
        self.join(self.alice)
        self.assertEqual(self.as_user(self.alice).delete(self.url()).status_code, 403)
        self.assertEqual(self.as_user(self.alice).patch(self.url(), {"description": "hi"}, format="json").status_code, 403)
        self.as_user(self.owner).post(self.url(f"members/{self.alice.id}/role/"), {"role": "admin"}, format="json")
        r = self.as_user(self.alice).patch(self.url(), {"description": "Saturday long walks"}, format="json")
        self.assertEqual(r.data["description"], "Saturday long walks")
        old = Team.objects.get(pk=self.team_id).invite_code
        self.as_user(self.alice).post(self.url("reset-code/"))
        self.assertNotEqual(Team.objects.get(pk=self.team_id).invite_code, old)
        self.assertEqual(self.as_user(self.owner).delete(self.url()).status_code, 204)

    def test_blocked_members_are_hidden_from_each_other(self):
        self.join(self.alice)
        self.join(self.bob)
        Block.objects.create(blocker=self.alice, blocked=self.bob)
        names = [m["user"]["username"] for m in self.as_user(self.bob).get(self.url()).data["members"]]
        self.assertNotIn("alice", names)
        names = [m["user"]["username"] for m in self.as_user(self.alice).get(self.url()).data["members"]]
        self.assertNotIn("bob", names)

    def test_discover_public_teams(self):
        self.as_user(self.alice).post(TEAMS, {"name": "Secret Squad", "visibility": "invite_only"}, format="json")
        r = self.as_user(self.bob).get(f"{TEAMS}discover/", {"q": "kar"})
        self.assertEqual([t["name"] for t in r.data["results"]], ["Karura Runners"])
        r = self.as_user(self.bob).get(f"{TEAMS}discover/", {"q": "sec"})
        self.assertEqual(r.data["results"], [])
        self.assertEqual(self.as_user(self.bob).get(f"{TEAMS}discover/", {"q": "ka"}).status_code, 400)

    def test_teams_switch(self):
        SocialSettings.objects.update_or_create(pk=1, defaults={"teams_enabled": False})
        self.assertEqual(self.as_user(self.alice).post(TEAMS, {"name": "New One"}, format="json").status_code, 503)


class ReportsAndModerationTests(SocialAPITestCase):
    def setUp(self):
        super().setUp()
        self.staff = make_user("moderator", is_staff=True)
        self.owner = make_user("teamowner")
        self.reporter = make_user("reporter")
        self.team_id = self.as_user(self.owner).post(TEAMS, {"name": "Rude Name"}, format="json").data["id"]

    def test_report_user_and_block_in_one_go(self):
        r = self.as_user(self.reporter).post(
            "/api/social/reports/",
            {"target_type": "user", "user_id": self.owner.id, "reason": "harassment", "details": "x" * 900, "block": True},
            format="json",
        )
        self.assertEqual(r.status_code, 201, r.data)
        self.assertTrue(r.data["blocked"])
        self.assertEqual(len(SocialReport.objects.get().details), 500)
        self.assertTrue(Block.objects.filter(blocker=self.reporter, blocked=self.owner).exists())
        r = self.as_user(self.reporter).post(
            "/api/social/reports/", {"target_type": "user", "user_id": self.owner.id, "reason": "spam"}, format="json"
        )
        self.assertEqual(r.data["status"], "already_reported")

    def test_report_validation(self):
        c = self.as_user(self.reporter)
        self.assertEqual(c.post("/api/social/reports/", {"target_type": "user", "user_id": self.reporter.id, "reason": "spam"}, format="json").status_code, 400)
        self.assertEqual(c.post("/api/social/reports/", {"target_type": "team", "team_id": self.team_id, "reason": "nope"}, format="json").status_code, 400)

    def test_report_details_sanitizes_html(self):
        other = make_user("xssuser")
        r = self.as_user(self.reporter).post(
            "/api/social/reports/",
            {"target_type": "user", "user_id": other.id, "reason": "harassment", "details": "<script>alert('xss')</script>bad text"},
            format="json",
        )
        self.assertEqual(r.status_code, 201)
        rep = SocialReport.objects.get(reporter=self.reporter, target_user=other)
        self.assertNotIn("<script>", rep.details)
        self.assertIn("alert('xss')bad text", rep.details)

    def test_admin_queue_resolve_and_team_moderation(self):
        self.as_user(self.reporter).post(
            "/api/social/reports/", {"target_type": "team", "team_id": self.team_id, "reason": "offensive_name"}, format="json"
        )
        other = make_user()
        self.as_user(other).post(
            "/api/social/reports/", {"target_type": "team", "team_id": self.team_id, "reason": "offensive_name"}, format="json"
        )
        # customers can't reach the admin endpoints
        self.assertEqual(self.as_user(self.reporter).get("/api/admin/social/reports/").status_code, 403)
        admin = self.as_user(self.staff)
        r = admin.get("/api/admin/social/reports/")
        self.assertEqual(len(r.data["results"]), 2)
        self.assertEqual(r.data["results"][0]["target_open_reports"], 2)
        report_id = r.data["results"][0]["id"]

        r = admin.post(f"/api/admin/social/teams/{self.team_id}/moderate/", {"action": "rename", "name": "Team 42"}, format="json")
        self.assertEqual(r.status_code, 200, r.data)
        self.assertEqual(Team.objects.get(pk=self.team_id).name, "Team 42")
        self.assertEqual(admin.post(f"/api/admin/social/teams/{self.team_id}/moderate/", {"action": "disable"}, format="json").status_code, 400)
        admin.post(f"/api/admin/social/teams/{self.team_id}/moderate/", {"action": "disable", "reason": "Name broke the rules"}, format="json")
        team = Team.objects.get(pk=self.team_id)
        self.assertTrue(team.is_disabled)
        # a disabled team is frozen for members and gone for everyone else
        self.assertEqual(self.as_user(self.reporter).get(f"{TEAMS}{self.team_id}/").status_code, 404)
        r = self.as_user(self.owner).get(f"{TEAMS}{self.team_id}/")
        self.assertEqual(r.data["disabled_reason"], "Name broke the rules")
        self.assertEqual(self.as_user(self.owner).patch(f"{TEAMS}{self.team_id}/", {"description": "x"}, format="json").status_code, 409)

        admin = self.as_user(self.staff)
        r = admin.post(f"/api/admin/social/reports/{report_id}/resolve/", {"status": "actioned", "note": "renamed"}, format="json")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(SocialReport.objects.filter(status="open").count(), 0)  # both reports closed
        self.assertTrue(AuditLog.objects.filter(resource_type="team", resource_id=self.team_id).exists())

    def test_admin_settings(self):
        admin = self.as_user(self.staff)
        r = admin.patch("/api/admin/social/settings/", {"max_team_members": 12, "feed_enabled": False}, format="json")
        self.assertEqual(r.status_code, 200, r.data)
        self.assertEqual(r.data["max_team_members"], 12)
        self.assertEqual(admin.patch("/api/admin/social/settings/", {"max_team_members": 1}, format="json").status_code, 400)
        self.assertEqual(self.as_user(self.owner).get("/api/social/feed/").status_code, 503)
        self.assertEqual(self.as_user(self.owner).get("/api/social/me/").data["features"]["max_team_members"], 12)
        self.assertEqual(self.as_user(self.owner).patch("/api/admin/social/settings/", {"max_team_members": 99}, format="json").status_code, 403)
