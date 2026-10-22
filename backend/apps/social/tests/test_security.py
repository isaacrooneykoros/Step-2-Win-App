from django.test import TestCase
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from apps.social.models import Team, TeamMembership

User = get_user_model()


class SocialSecurityTestCase(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            username="testuser",
            email="testuser@example.com",
            password="password123",
            phone_number="254712345678",
        )
        self.client = APIClient()
        self.client.force_authenticate(user=self.user)

    def test_team_description_sanitizes_xss(self):
        xss_payload = "<script>alert('xss')</script>A team for runners <img src=x onerror=alert(1)>"
        response = self.client.post(
            "/api/social/teams/",
            {"name": "XSS Test Team", "description": xss_payload},
            format="json",
        )
        self.assertEqual(response.status_code, 201)
        team = Team.objects.get(id=response.data["id"])
        self.assertNotIn("<script>", team.description)
        self.assertNotIn("<img", team.description)
        self.assertEqual(team.description, "alert('xss')A team for runners")

    def test_team_update_description_sanitizes_xss(self):
        team = Team.objects.create(
            name="Update XSS Team",
            description="Initial description",
            created_by=self.user,
        )
        TeamMembership.objects.create(team=team, user=self.user, role=TeamMembership.OWNER)

        xss_payload = "<b>Updated description</b> <script>eval('xss')</script>"
        response = self.client.patch(
            f"/api/social/teams/{team.id}/",
            {"description": xss_payload},
            format="json",
        )
        self.assertEqual(response.status_code, 200)
        team.refresh_from_db()
        self.assertNotIn("<b>", team.description)
        self.assertNotIn("<script>", team.description)
        self.assertEqual(team.description, "Updated description eval('xss')")
