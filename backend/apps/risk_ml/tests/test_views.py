"""Admin endpoints: staff only, read-only scores, audited labelling."""

from datetime import timedelta

from django.contrib.auth import get_user_model
from django.test import TestCase
from rest_framework.test import APIClient

from apps.admin_api.models import AuditLog
from apps.risk_ml.feature_store import local_today
from apps.risk_ml.models import Label, ModelArtifact, RiskScore

User = get_user_model()


class RiskAdminEndpointTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.admin = User.objects.create_user(username="ops", email="ops@example.com", phone_number="254700000001",
                                              password="pass12345!", is_staff=True)
        self.user = User.objects.create_user(username="walker", email="w@example.com", phone_number="254712340001",
                                             password="pass12345!")
        self.day = local_today() - timedelta(days=1)
        RiskScore.objects.create(user=self.user, date=self.day, model_version="evidence-v1", feature_version="f1",
                                 score=0.81, context={"steps": 30000},
                                 explanations=[{"code": "volume_spike", "feature": "steps_ratio_to_median",
                                                "value": 3.4, "contribution": 0.4,
                                                "text": "3.4x your usual daily steps"}])
        RiskScore.objects.create(user=self.user, date=self.day, model_version="logreg-f1-x", feature_version="f1",
                                 score=0.5, context={"supervised": True})
        ModelArtifact.objects.create(kind="anomaly", version="iforest-f1-1", feature_version="f1",
                                     payload={"forest": {}}, is_active=True, model_card="# card")

    def test_non_staff_are_refused(self):
        self.client.force_authenticate(self.user)
        self.assertEqual(self.client.get(f"/api/admin/risk-ml/users/{self.user.pk}/scores/").status_code, 403)
        self.assertEqual(self.client.post("/api/admin/risk-ml/labels/", {"user_id": self.user.pk}, format="json")
                         .status_code, 403)
        self.assertEqual(self.client.get("/api/admin/risk-ml/models/").status_code, 403)
        self.client.force_authenticate(None)
        self.assertEqual(self.client.get(f"/api/admin/risk-ml/users/{self.user.pk}/scores/").status_code, 401)

    def test_scores_endpoint(self):
        self.client.force_authenticate(self.admin)
        res = self.client.get(f"/api/admin/risk-ml/users/{self.user.pk}/scores/?days=14")
        self.assertEqual(res.status_code, 200)
        body = res.json()
        self.assertTrue(body["shadow"])
        self.assertIn("does not change steps", body["note"])
        self.assertEqual(body["latest"]["score"], 0.81)
        self.assertEqual(body["latest"]["model_version"], "evidence-v1")
        self.assertEqual(body["latest"]["explanations"][0]["text"], "3.4x your usual daily steps")
        self.assertEqual(len(body["scores"]), 2)
        self.assertEqual(body["active_models"], {"anomaly": "iforest-f1-1"})
        self.assertEqual(self.client.get("/api/admin/risk-ml/users/999999/scores/").status_code, 404)

    def test_label_endpoint_creates_audited_label(self):
        self.client.force_authenticate(self.admin)
        res = self.client.post("/api/admin/risk-ml/labels/",
                               {"user_id": self.user.pk, "date": self.day.isoformat(), "label": "cheat",
                                "notes": "shaker video in support ticket"}, format="json")
        self.assertEqual(res.status_code, 201, res.content)
        lab = Label.objects.get()
        self.assertEqual((lab.label, lab.source, lab.created_by_id), ("cheat", "admin_manual", self.admin.pk))
        log = AuditLog.objects.get(resource_type="user", resource_id=self.user.pk)
        self.assertEqual(log.admin_id, self.admin.pk)
        self.assertEqual(log.changes["risk_label"], "cheat")
        # Re-labelling the same day by the same admin updates in place.
        res = self.client.post("/api/admin/risk-ml/labels/",
                               {"user_id": self.user.pk, "date": self.day.isoformat(), "label": "honest"},
                               format="json")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(Label.objects.get().label, "honest")
        self.assertEqual(AuditLog.objects.filter(resource_id=self.user.pk).count(), 2)
        body = self.client.get(f"/api/admin/risk-ml/users/{self.user.pk}/scores/").json()
        self.assertEqual(body["labels"][0]["label"], "honest")

    def test_label_validation(self):
        self.client.force_authenticate(self.admin)
        post = lambda data: self.client.post("/api/admin/risk-ml/labels/", data, format="json")  # noqa: E731
        base = {"user_id": self.user.pk, "date": self.day.isoformat(), "label": "cheat"}
        self.assertEqual(post({**base, "label": "guilty"}).status_code, 400)
        self.assertEqual(post({**base, "date": "not-a-date"}).status_code, 400)
        self.assertEqual(post({**base, "date": (local_today() + timedelta(days=2)).isoformat()}).status_code, 400)
        self.assertEqual(post({**base, "date_end": (self.day - timedelta(days=1)).isoformat()}).status_code, 400)
        self.assertEqual(post({**base, "user_id": self.admin.pk}).status_code, 400)  # own account
        self.assertEqual(post({**base, "user_id": "x"}).status_code, 400)
        self.assertFalse(Label.objects.exists())

    def test_models_endpoint_hides_payload(self):
        self.client.force_authenticate(self.admin)
        res = self.client.get("/api/admin/risk-ml/models/")
        self.assertEqual(res.status_code, 200)
        row = res.json()["results"][0]
        self.assertEqual(row["version"], "iforest-f1-1")
        self.assertNotIn("payload", row)
