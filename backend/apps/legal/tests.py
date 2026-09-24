"""Draft / publish / restore behaviour of the legal CMS."""

from django.contrib.auth import get_user_model
from django.test import TestCase
from rest_framework.test import APIClient

from .models import LegalDocument

User = get_user_model()


class LegalPublishFlowTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.admin = User.objects.create_user(
            username="legal_admin", email="legal@example.com", phone_number="254700000041",
            password="pass12345!", is_staff=True,
        )
        self.client.force_authenticate(self.admin)
        res = self.client.post(
            "/api/legal/admin/documents/create/",
            {"document_type": "privacy_policy", "title": "Privacy Policy"},
            format="json",
        )
        self.assertEqual(res.status_code, 201, res.content)
        self.doc_id = res.json()["id"]
        self.base = f"/api/legal/admin/documents/{self.doc_id}/"

    def _save(self, html):
        res = self.client.patch(self.base, {"content_html": html}, format="json")
        self.assertEqual(res.status_code, 200, res.content)
        return res.json()

    def _publish(self, summary="", notify=False):
        res = self.client.post(f"{self.base}publish/", {"change_summary": summary, "notify_users": notify}, format="json")
        self.assertEqual(res.status_code, 200, res.content)
        return res.json()

    def _public(self):
        return APIClient().get("/api/legal/privacy-policy/")

    def test_saving_stages_a_draft_and_publish_makes_it_live(self):
        body = self._save("<p>First</p>")
        self.assertEqual(body["draft_html"], "<p>First</p>")
        self.assertTrue(body["has_unpublished_changes"])
        self.assertEqual(self._public().status_code, 404)

        self.assertEqual(self._publish("Initial")["version"], 1)
        self.assertEqual(self._public().json()["content_html"], "<p>First</p>")

        # Editing a published policy does not change what users see.
        self._save("<p>Second</p>")
        self.assertEqual(self._public().json()["content_html"], "<p>First</p>")

        published = self._publish("Clarified section 2", notify=True)
        self.assertEqual(published["version"], 2)
        live = self._public().json()
        self.assertEqual(live["content_html"], "<p>Second</p>")
        self.assertEqual(live["change_summary"], "Clarified section 2")
        doc = LegalDocument.objects.get(pk=self.doc_id)
        self.assertEqual(doc.draft_html, "")
        history = self.client.get(f"{self.base}history/").json()["history"]
        self.assertEqual(sorted(h["version"] for h in history), [1, 2])
        v1 = next(h for h in history if h["version"] == 1)
        self.assertEqual(v1["change_summary"], "Initial")

    def test_restore_keeps_the_live_version_online_and_republishes_cleanly(self):
        self._save("<p>First</p>")
        self._publish("Initial")
        self._save("<p>Second</p>")
        self._publish("Update")
        v1 = next(h for h in self.client.get(f"{self.base}history/").json()["history"] if h["version"] == 1)

        res = self.client.post(f"{self.base}restore/{v1['id']}/")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(self._public().json()["content_html"], "<p>Second</p>")
        doc = self.client.get(self.base).json()
        self.assertEqual(doc["status"], "published")
        self.assertEqual(doc["draft_html"], "<p>First</p>")

        self.assertEqual(self._publish("Rolled back")["version"], 3)
        self.assertEqual(self._public().json()["content_html"], "<p>First</p>")

    def test_cannot_publish_empty_document(self):
        res = self.client.post(f"{self.base}publish/", {}, format="json")
        self.assertEqual(res.status_code, 400)

    def test_content_html_cannot_be_written_directly(self):
        self._save("<p>First</p>")
        self._publish()
        self.client.put(self.base, {"document_type": "privacy_policy", "title": "Privacy Policy",
                                    "content_html": "<p>Sneaky</p>"}, format="json")
        self.assertEqual(self._public().json()["content_html"], "<p>First</p>")
