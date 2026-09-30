"""Legal archive / unarchive, draft-only delete, audit and acceptance stats; badge retire vs delete."""

from django.contrib.auth import get_user_model
from django.test import TestCase
from rest_framework.test import APIClient

from apps.admin_api.models import AuditLog
from apps.gamification.models import Badge, UserBadge
from apps.legal.models import LegalDocument, UserDocumentAck

User = get_user_model()


def mk(username, **extra):
    return User.objects.create_user(username=username, email=f"{username}@example.com",
                                    phone_number=f"2547{abs(hash(username)) % 10**8:08d}",
                                    password="TestPass123!", **extra)


class LegalConsoleTests(TestCase):
    def setUp(self):
        self.admin = mk("legal_admin", is_staff=True)
        self.user = mk("legal_user")
        self.client = APIClient()
        self.client.force_authenticate(self.admin)

    def _create(self, doc_type="cookie_policy", title="Cookie Policy"):
        r = self.client.post("/api/legal/admin/documents/create/", {"document_type": doc_type, "title": title}, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        return r.json()["id"]

    def test_lifecycle_audit_archive_and_acks(self):
        pk = self._create()
        self.client.patch(f"/api/legal/admin/documents/{pk}/", {"content_html": "<p>We use cookies.</p>"}, format="json")
        self.assertEqual(self.client.post(f"/api/legal/admin/documents/{pk}/publish/", {"change_summary": "First"}, format="json").status_code, 200)
        # Status can't be changed by a plain edit.
        self.client.patch(f"/api/legal/admin/documents/{pk}/", {"status": "draft"}, format="json")
        self.assertEqual(LegalDocument.objects.get(pk=pk).status, "published")
        doc = LegalDocument.objects.get(pk=pk)
        UserDocumentAck.objects.create(user=self.user, document=doc, version_seen=doc.version)
        stats = self.client.get(f"/api/legal/admin/documents/{pk}/acks/").json()
        self.assertEqual(stats["acknowledged_current"], 1)
        self.assertEqual(stats["by_version"][0]["count"], 1)
        # Published: can't be deleted; archive hides it from customers.
        self.assertEqual(self.client.delete(f"/api/legal/admin/documents/{pk}/").status_code, 409)
        self.assertEqual(self.client.post(f"/api/legal/admin/documents/{pk}/archive/").status_code, 200)
        self.assertEqual(APIClient().get(f"/api/legal/{doc.slug}/").status_code, 404)
        self.assertEqual(self.client.post(f"/api/legal/admin/documents/{pk}/unarchive/").status_code, 200)
        self.assertEqual(APIClient().get(f"/api/legal/{doc.slug}/").status_code, 200)
        history = self.client.get(f"/api/legal/admin/documents/{pk}/history/").json()["history"]
        self.client.post(f"/api/legal/admin/documents/{pk}/restore/{history[0]['id']}/")
        actions = list(AuditLog.objects.filter(resource_type="legal_document", resource_id=pk).order_by("id").values_list("action", flat=True))
        self.assertEqual(actions, ["create", "update", "publish", "archive", "publish", "restore"])

    def test_draft_only_delete_and_core_docs_never_archived(self):
        pk = self._create()
        self.assertEqual(self.client.delete(f"/api/legal/admin/documents/{pk}/").status_code, 204)
        terms = self._create("terms_and_conditions", "Terms")
        self.client.patch(f"/api/legal/admin/documents/{terms}/", {"content_html": "<p>Terms</p>"}, format="json")
        self.client.post(f"/api/legal/admin/documents/{terms}/publish/", {}, format="json")
        self.assertEqual(self.client.post(f"/api/legal/admin/documents/{terms}/archive/").status_code, 409)


class BadgeConsoleTests(TestCase):
    def setUp(self):
        self.admin = mk("badge_admin", is_staff=True)
        self.user = mk("badge_user")
        self.client = APIClient()
        self.client.force_authenticate(self.admin)
        self.held = Badge.objects.create(slug="held", name="Held", description="d", icon="x", criteria_type="manual")
        self.free = Badge.objects.create(slug="free", name="Free", description="d", icon="x", criteria_type="manual")
        UserBadge.objects.create(user=self.user, badge=self.held)

    def test_retire_instead_of_delete_when_held(self):
        self.assertEqual(self.client.delete(f"/api/admin/badges/{self.held.id}/").status_code, 409)
        self.assertTrue(UserBadge.objects.filter(badge=self.held).exists())
        r = self.client.post(f"/api/admin/badges/{self.held.id}/retire/", {"retired": True}, format="json")
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.json()["is_retired"])
        # Customers: holders keep it, it's no longer offered as upcoming.
        c = APIClient()
        c.force_authenticate(mk("badge_other"))
        upcoming = [b["slug"] for b in c.get("/api/gamification/badges/upcoming/").json()]
        self.assertNotIn("held", upcoming)
        self.assertEqual(self.client.delete(f"/api/admin/badges/{self.free.id}/").status_code, 204)
        actions = set(AuditLog.objects.filter(resource_type="badge").values_list("action", flat=True))
        self.assertTrue({"retire", "delete"} <= actions)

    def test_protect_at_database_level(self):
        from django.db.models import ProtectedError

        with self.assertRaises(ProtectedError):
            self.held.delete()
