from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from apps.social.models import SocialSettings, Team, TeamMembership

User = get_user_model()


class TeamSanitizationSecurityTests(APITestCase):
    def setUp(self):
        s = SocialSettings.load()
        s.social_enabled = True
        s.teams_enabled = True
        s.save()

        self.user = User.objects.create_user(
            username="teamowner",
            email="teamowner@example.com",
            phone_number="254712345678",
            password="TestPassword123!",
        )
        self.client.force_authenticate(user=self.user)

    def test_create_team_sanitizes_html_tags(self):
        payload = {
            "name": "<b>Alpha</b> <i>Runners</i>",
            "description": "A <b onclick='evil()'>great</b> club <iframe src='malicious.com'></iframe>",
            "visibility": "public",
        }
        res = self.client.post("/api/social/teams/", payload, format="json")
        self.assertEqual(res.status_code, 201)

        team_id = res.data["id"]
        team = Team.objects.get(id=team_id)

        # HTML tags should be completely stripped
        self.assertNotIn("<b>", team.name)
        self.assertNotIn("<i>", team.name)
        self.assertEqual(team.name, "Alpha Runners")

        self.assertNotIn("<b>", team.description)
        self.assertNotIn("<iframe>", team.description)
        self.assertEqual(team.description, "A great club")

    def test_update_team_sanitizes_html_tags(self):
        team = Team.objects.create(
            name="Original Team",
            name_key="original team",
            description="Original description",
            created_by=self.user,
        )
        TeamMembership.objects.create(team=team, user=self.user, role=TeamMembership.OWNER)

        payload = {
            "name": "<img src=x> Updated Team",
            "description": "<p>New</p> <span>Description</span>",
        }
        res = self.client.patch(f"/api/social/teams/{team.id}/", payload, format="json")
        self.assertEqual(res.status_code, 200)

        team.refresh_from_db()
        self.assertNotIn("<img", team.name)
        self.assertEqual(team.name, "Updated Team")
        self.assertNotIn("<p>", team.description)
        self.assertNotIn("<span>", team.description)
        self.assertEqual(team.description, "New Description")
