"""Security tests for risk_ml endpoints (sanitization and validation)."""

from datetime import timedelta

from django.contrib.auth import get_user_model
from django.test import TestCase
from rest_framework.test import APIClient

from apps.admin_api.models import AuditLog
from apps.risk_ml.feature_store import local_today
from apps.risk_ml.models import Label, ModelArtifact

User = get_user_model()


class RiskMLSecurityTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.admin = User.objects.create_superuser(
            username="risk_admin",
            email="risk_admin@example.com",
            phone_number="254700000099",
            password="pass12345!Secure",
        )
        self.user = User.objects.create_user(
            username="walker_user",
            email="walker_user@example.com",
            phone_number="254712340099",
            password="pass12345!Secure",
        )
        self.day = local_today() - timedelta(days=1)
        self.artifact = ModelArtifact.objects.create(
            kind="anomaly",
            version="iforest-v2",
            feature_version="f1",
            payload={"forest": {}},
            is_active=False,
            model_card="# v2 card",
        )

    def test_label_user_day_sanitizes_xss_in_notes(self):
        self.client.force_authenticate(self.admin)
        xss_payload = "<script>alert('xss')</script><b>Suspicious step count</b>"
        res = self.client.post(
            "/api/admin/risk-ml/labels/",
            {
                "user_id": self.user.pk,
                "date": self.day.isoformat(),
                "label": "cheat",
                "notes": xss_payload,
            },
            format="json",
        )
        self.assertEqual(res.status_code, 201)
        label = Label.objects.get(user=self.user)
        self.assertEqual(label.notes, "alert('xss')Suspicious step count")
        self.assertNotIn("<script>", label.notes)
        self.assertNotIn("<b>", label.notes)

    def test_label_user_day_length_limit(self):
        self.client.force_authenticate(self.admin)
        long_notes = "a" * 1001
        res = self.client.post(
            "/api/admin/risk-ml/labels/",
            {
                "user_id": self.user.pk,
                "date": self.day.isoformat(),
                "label": "cheat",
                "notes": long_notes,
            },
            format="json",
        )
        self.assertEqual(res.status_code, 400)
        self.assertEqual(res.json()["error"], "notes must be 1000 characters or fewer")

    def test_activate_model_sanitizes_xss_in_reason(self):
        self.client.force_authenticate(self.admin)
        xss_reason = "Model upgrade <script>alert(1)</script> approved by team"
        res = self.client.post(
            f"/api/admin/risk-ml/models/{self.artifact.version}/activate/",
            {"reason": xss_reason},
            format="json",
        )
        self.assertEqual(res.status_code, 200)
        log = AuditLog.objects.get(action="activate", resource_id=self.artifact.pk)
        sanitized_reason = log.changes["reason"]
        self.assertEqual(sanitized_reason, "Model upgrade alert(1) approved by team")
        self.assertNotIn("<script>", sanitized_reason)

    def test_activate_model_length_limit(self):
        self.client.force_authenticate(self.admin)
        long_reason = "a" * 501
        res = self.client.post(
            f"/api/admin/risk-ml/models/{self.artifact.version}/activate/",
            {"reason": long_reason},
            format="json",
        )
        self.assertEqual(res.status_code, 400)
