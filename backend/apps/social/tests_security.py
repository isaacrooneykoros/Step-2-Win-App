from django.contrib.auth import get_user_model

from apps.social.models import Team
from apps.social.teams import create_team
from apps.social.tests.helpers import SocialAPITestCase, make_user

User = get_user_model()


class SocialSecurityTests(SocialAPITestCase):
    def setUp(self):
        super().setUp()
        self.user = make_user("security_user")
        self.as_user(self.user)

    def test_create_team_sanitizes_xss_in_name_and_description(self):
        payload = {
            "name": "Team <b>Alpha</b>",
            "description": "Best team <iframe src='javascript:alert(2)'></iframe> ever!",
        }
        res = self.client.post("/api/social/teams/", payload, format="json")
        self.assertEqual(res.status_code, 201)
        team_id = res.data["id"]

        team = Team.objects.get(id=team_id)
        self.assertNotIn("<b>", team.name)
        self.assertNotIn("<iframe", team.description)
        self.assertEqual(team.name, "Team Alpha")
        self.assertEqual(team.description, "Best team ever!")

    def test_update_team_sanitizes_xss_in_name_and_description(self):
        team = create_team(self.user, name="Initial Team", description="Initial Description")

        payload = {
            "name": "Updated <b>Team</b>",
            "description": "Updated <img src=x onerror=alert(1)> Description",
        }
        res = self.client.patch(f"/api/social/teams/{team.id}/", payload, format="json")
        self.assertEqual(res.status_code, 200)

        team.refresh_from_db()
        self.assertNotIn("<b", team.name)
        self.assertNotIn("<img", team.description)
        self.assertEqual(team.name, "Updated Team")
        self.assertEqual(team.description, "Updated Description")
