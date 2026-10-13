"""Security tests for the social module: Stored XSS protection and input sanitization."""

from apps.social.models import SocialReport, Team
from .helpers import SocialAPITestCase, make_user

TEAMS = "/api/social/teams/"
REPORTS = "/api/social/reports/"


class SocialSecurityTests(SocialAPITestCase):
    def setUp(self):
        super().setUp()
        self.user = make_user("secuser")
        self.target = make_user("sectarget")

    def test_report_details_xss_sanitization(self):
        """Report details must strip HTML/script tags to prevent Stored XSS."""
        payload = {
            "target_type": "user",
            "user_id": self.target.id,
            "reason": "harassment",
            "details": "<script>alert('xss')</script><b>Inappropriate behavior</b>",
        }
        res = self.as_user(self.user).post(REPORTS, payload, format="json")
        self.assertEqual(res.status_code, 201)

        report = SocialReport.objects.get(reporter=self.user, target_user=self.target)
        self.assertNotIn("<script>", report.details)
        self.assertNotIn("<b>", report.details)
        self.assertIn("Inappropriate behavior", report.details)

    def test_team_description_xss_sanitization(self):
        """Team descriptions must strip HTML/script tags to prevent Stored XSS on creation and update."""
        payload = {
            "name": "Security Walkers",
            "description": "<script>alert('xss')</script><em>Daily stepping club</em>",
            "visibility": "public",
        }
        res = self.as_user(self.user).post(TEAMS, payload, format="json")
        self.assertEqual(res.status_code, 201)

        team_id = res.data["id"]
        team = Team.objects.get(pk=team_id)
        self.assertNotIn("<script>", team.description)
        self.assertNotIn("<em>", team.description)
        self.assertIn("Daily stepping club", team.description)

        # Test PATCH update sanitization
        patch_payload = {
            "description": "<iframe src='javascript:alert(1)'></iframe>Updated description",
        }
        res = self.as_user(self.user).patch(f"{TEAMS}{team_id}/", patch_payload, format="json")
        self.assertEqual(res.status_code, 200)

        team.refresh_from_db()
        self.assertNotIn("<iframe", team.description)
        self.assertIn("Updated description", team.description)
