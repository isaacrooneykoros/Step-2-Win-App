"""Tests for the trust & safety console endpoints (trust_views.py)."""

from datetime import timedelta

from django.contrib.auth import get_user_model
from django.test import TestCase
from django.utils import timezone
from rest_framework.test import APIClient

from apps.admin_api.models import AuditLog, SupportTicket
from apps.steps.models import (DeviceRegistration, FraudFlag, StepSession,
                               StepSyncEvent, SuspiciousSessionReview,
                               TrustScore)

User = get_user_model()


class TrustConsoleTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.admin = User.objects.create_user(
            username="ts_admin", email="ts@example.com", phone_number="254700000011",
            password="pass12345!", is_staff=True,
        )
        self.user = User.objects.create_user(
            username="walker", email="w@example.com", phone_number="254712345671", password="pass12345!",
        )
        self.other = User.objects.create_user(
            username="runner", email="r@example.com", phone_number="254712345672", password="pass12345!",
        )
        today = timezone.localdate()
        self.low = FraudFlag.objects.create(user=self.user, flag_type="gait_confidence_low", severity="low", date=today,
                                            details={"message": "Low gait confidence."})
        self.crit = FraudFlag.objects.create(user=self.other, flag_type="steps_per_min_impossible", severity="critical",
                                             date=today, details={"message": "Too fast.", "payload_hash": "abc", "steps_per_min": 250})
        self.device = DeviceRegistration.objects.create(user=self.user, device_id="device-1234567890", platform="android",
                                                        device_public_key="SECRET-PUBLIC-KEY")
        self.session = StepSession.objects.create(user=self.user, device=self.device, session_token_hash="TOKENHASH",
                                                  server_nonce="NONCE", expires_at=timezone.now() + timedelta(hours=1),
                                                  total_steps=5000, avg_walk_probability=0.2, avg_shake_probability=0.8,
                                                  session_risk_score=72.0)
        StepSyncEvent.objects.create(user=self.user, session=self.session, client_event_id="e1", payload_hash="PAYLOADHASH",
                                     steps_delta=300, ml_walk_probability=0.2, ml_shake_probability=0.8, accepted=False,
                                     rejection_reason="shake", raw_payload={"sig": "RAW"})
        self.review = SuspiciousSessionReview.objects.create(
            user=self.user, session=self.session, risk_score=72.0, reason_summary="Session risk score 72.0 exceeds review threshold",
            risk_hits=[{"rule": "session_high_avg_shake", "severity": "high", "penalty": 20.0, "details": "Average shake probability 0.80"}],
        )

    def auth(self, user=None):
        self.client.force_authenticate(user or self.admin)

    def test_requires_staff(self):
        self.client.force_authenticate(self.user)
        self.assertEqual(self.client.get("/api/admin/trust/cases/").status_code, 403)

    def test_cases_sorted_by_severity_and_filterable(self):
        self.auth()
        res = self.client.get("/api/admin/trust/cases/")
        self.assertEqual(res.status_code, 200)
        sev = [r["severity"] for r in res.data["results"]]
        self.assertEqual(sev, ["critical", "high", "low"])
        self.assertEqual(res.data["by_severity"]["critical"], 1)
        res = self.client.get("/api/admin/trust/cases/", {"kind": "session"})
        self.assertEqual([r["kind"] for r in res.data["results"]], ["session"])
        res = self.client.get("/api/admin/trust/cases/", {"q": "runner"})
        self.assertEqual([r["user"]["username"] for r in res.data["results"]], ["runner"])
        res = self.client.get("/api/admin/trust/cases/", {"severity": "low"})
        self.assertEqual(res.data["count"], 1)

    def test_detail_hides_secrets(self):
        self.auth()
        res = self.client.get(f"/api/admin/trust/cases/session/{self.review.id}/")
        self.assertEqual(res.status_code, 200)
        body = str(res.data)
        for secret in ("TOKENHASH", "NONCE", "PAYLOADHASH", "SECRET-PUBLIC-KEY", "RAW"):
            self.assertNotIn(secret, body)
        self.assertEqual(len(res.data["session"]["events"]), 1)
        self.assertEqual(res.data["rule_hits"][0]["rule_code"], "session_high_avg_shake")
        res = self.client.get(f"/api/admin/trust/cases/flag/{self.crit.id}/")
        self.assertEqual(res.status_code, 200)
        self.assertNotIn("abc", str(res.data["evidence"]))
        self.assertEqual(self.client.get("/api/admin/trust/cases/nope/1/").status_code, 404)

    def test_flag_action_requires_reason_and_audits(self):
        self.auth()
        url = f"/api/admin/trust/flags/{self.crit.id}/action/"
        self.assertEqual(self.client.post(url, {"action": "restrict"}, format="json").status_code, 400)
        self.assertEqual(self.client.post(url, {"action": "delete", "reason": "valid reason"}, format="json").status_code, 400)
        res = self.client.post(url, {"action": "restrict", "reason": "Impossible pace confirmed", "message_to_user": "Your step sync is limited."}, format="json")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.data["trust_score"]["after"], 35)
        self.crit.refresh_from_db()
        self.assertTrue(self.crit.reviewed and self.crit.actioned)
        self.assertEqual(self.crit.details["reviewed_by"], "ts_admin")
        log = AuditLog.objects.get(action="restrict", resource_id=self.other.id)
        self.assertEqual(log.changes["reason"], "Impossible pace confirmed")
        self.assertTrue(SupportTicket.objects.filter(user=self.other, status="resolved").exists())
        # Second decision on the same flag is refused.
        self.assertEqual(self.client.post(url, {"action": "dismiss", "reason": "again please"}, format="json").status_code, 409)

    def test_trust_mapping_matches_legacy_endpoint(self):
        self.auth()
        for action, expected in (("warn", 95), ("restrict", 35), ("suspend", 10), ("ban", 0)):
            TrustScore.objects.update_or_create(user=self.user, defaults={"score": 100})
            f1 = FraudFlag.objects.create(user=self.user, flag_type="x", severity="high", date=timezone.localdate())
            self.client.post(f"/api/admin/fraud/{f1.id}/action/", {"action": action}, format="json")
            legacy = TrustScore.objects.get(user=self.user).score
            TrustScore.objects.update_or_create(user=self.user, defaults={"score": 100})
            f2 = FraudFlag.objects.create(user=self.user, flag_type="x", severity="high", date=timezone.localdate())
            self.client.post(f"/api/admin/trust/flags/{f2.id}/action/", {"action": action, "reason": "mapping check"}, format="json")
            self.assertEqual(TrustScore.objects.get(user=self.user).score, legacy)
            self.assertEqual(legacy, expected)

    def test_session_decision(self):
        self.auth()
        url = f"/api/admin/trust/sessions/{self.review.id}/decision/"
        self.assertEqual(self.client.post(url, {"decision": "approved"}, format="json").status_code, 400)
        res = self.client.post(url, {"decision": "escalated", "reason": "Needs a second look"}, format="json")
        self.assertEqual(res.status_code, 200)
        self.review.refresh_from_db()
        self.assertEqual(self.review.status, "escalated")
        # Escalated stays in the open queue and can still be decided.
        res = self.client.post(url, {"decision": "rejected", "reason": "Shake pattern confirmed"}, format="json")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(self.client.post(url, {"decision": "approved", "reason": "late change"}, format="json").status_code, 409)
        self.assertEqual(AuditLog.objects.filter(action="session_review").count(), 2)

    def test_moderation_queue_action_and_history(self):
        self.auth()
        res = self.client.get("/api/admin/trust/moderation/users/")
        names = [r["username"] for r in res.data["results"]]
        self.assertIn("runner", names)
        self.assertEqual(res.data["results"][0]["top_severity"], "critical")
        res = self.client.post(f"/api/admin/trust/users/{self.other.id}/moderate/", {"action": "suspend", "reason": "Repeat offender"}, format="json")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.data["trust_status"]["after"], "SUSPEND")
        enforced = self.client.get("/api/admin/trust/moderation/users/", {"view": "enforced"})
        self.assertIn("runner", [r["username"] for r in enforced.data["results"]])
        hist = self.client.get("/api/admin/trust/moderation/history/")
        self.assertEqual(hist.data["results"][0]["action"], "suspend")
        self.assertEqual(hist.data["results"][0]["reason"], "Repeat offender")
        self.assertEqual(self.client.post(f"/api/admin/trust/users/{self.admin.id}/moderate/", {"action": "ban", "reason": "self test"}, format="json").status_code, 400)

    def test_summary_and_ops_history(self):
        self.auth()
        res = self.client.get("/api/admin/trust/summary/", {"days": 7})
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.data["open_total"], 3)
        self.assertEqual(len(res.data["daily"]), 7)
        self.assertEqual(res.data["daily"][-1]["critical"], 1)
        res = self.client.get("/api/admin/monitoring/ops/history/", {"days": 7})
        self.assertEqual(res.status_code, 200)
        self.assertEqual(len(res.data["daily"]), 7)
