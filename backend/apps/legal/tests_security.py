"""Security test suite for Legal Documents app."""

from django.contrib.auth import get_user_model
from django.test import TestCase
from rest_framework.test import APIClient

User = get_user_model()


class LegalSecurityTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.admin = User.objects.create_user(
            username="legal_security_admin",
            email="legalsec@example.com",
            phone_number="254700000042",
            password="pass12345!",
            is_staff=True,
        )
        self.client.force_authenticate(self.admin)

    def test_xss_stripped_on_document_creation(self):
        payload = {
            "document_type": "cookie_policy",
            "title": "Cookie Policy",
            "content_html": "<h1>Cookie Policy</h1><script>alert('xss')</script><p>We use cookies.</p>",
        }
        res = self.client.post(
            "/api/legal/admin/documents/create/",
            payload,
            format="json",
        )
        self.assertEqual(res.status_code, 201)
        doc = res.json()
        self.assertNotIn("<script>", doc["draft_html"])
        self.assertIn("alert('xss')", doc["draft_html"])
        self.assertIn("<h1>Cookie Policy</h1>", doc["draft_html"])

    def test_xss_stripped_on_document_update_and_publish(self):
        create_res = self.client.post(
            "/api/legal/admin/documents/create/",
            {"document_type": "terms_and_conditions", "title": "Terms"},
            format="json",
        )
        doc_id = create_res.json()["id"]
        base_url = f"/api/legal/admin/documents/{doc_id}/"

        xss_payload = "<p>Terms content</p><img src=x onerror=alert('xss')><a href='javascript:alert(1)'>Link</a>"
        update_res = self.client.patch(
            base_url,
            {"content_html": xss_payload},
            format="json",
        )
        self.assertEqual(update_res.status_code, 200)
        draft_html = update_res.json()["draft_html"]
        self.assertNotIn("onerror", draft_html)
        self.assertNotIn("javascript:", draft_html)
        self.assertIn("<p>Terms content</p>", draft_html)

        publish_res = self.client.post(f"{base_url}publish/", format="json")
        self.assertEqual(publish_res.status_code, 200)

        public_res = APIClient().get("/api/legal/terms_and_conditions/")
        if public_res.status_code != 200:
            public_res = APIClient().get(f"/api/legal/{create_res.json()['slug']}/")
        self.assertEqual(public_res.status_code, 200)
        content_html = public_res.json()["content_html"]
        self.assertNotIn("onerror", content_html)
        self.assertNotIn("javascript:", content_html)
