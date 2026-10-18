"""
Security tests for Social module: Stored XSS sanitization on report details
and team descriptions.
"""

from apps.social.models import SocialReport, Team
from apps.social.tests.helpers import SocialAPITestCase, make_user


class SocialSecurityTests(SocialAPITestCase):
    def setUp(self):
        super().setUp()
        self.user1 = make_user("xssuser1")
        self.user2 = make_user("xssuser2")

    def test_report_details_sanitization(self):
        """Verify that XSS / HTML payloads in report details are stripped."""
        payload = "<script>alert('xss')</script>This user is spamming <b>unwanted</b> content."
        response = self.as_user(self.user1).post(
            "/api/social/reports/",
            {
                "target_type": "user",
                "user_id": self.user2.id,
                "reason": "spam",
                "details": payload,
            },
            format="json",
        )
        self.assertEqual(response.status_code, 201)
        report = SocialReport.objects.get(id=response.data["id"])
        self.assertNotIn("<script>", report.details)
        self.assertNotIn("<b>", report.details)
        self.assertEqual(report.details, "alert('xss')This user is spamming unwanted content.")

    def test_team_description_sanitization(self):
        """Verify that XSS / HTML payloads in team creation/update description are stripped."""
        payload = "<img src=x onerror=alert('xss')>Best walking team <script>console.log('test')</script>"
        response = self.as_user(self.user1).post(
            "/api/social/teams/",
            {
                "name": "Security Team",
                "description": payload,
                "visibility": "public",
            },
            format="json",
        )
        self.assertEqual(response.status_code, 201)
        team_id = response.data["id"]
        team = Team.objects.get(id=team_id)
        self.assertNotIn("<img", team.description)
        self.assertNotIn("<script>", team.description)
        self.assertEqual(team.description, "Best walking team console.log('test')")
