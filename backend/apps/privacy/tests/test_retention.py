"""Retention: correct cut-offs, idempotent, batched, financial records untouched."""

import uuid
from datetime import date, timedelta
from decimal import Decimal

from django.test import TestCase
from django.utils import timezone

from apps.challenges.models import Challenge, HeldPayout, Participant
from apps.payments.models import CallbackLog, PaymentTransaction, WithdrawalRequest
from apps.privacy.models import DataExportRequest, PrivacySettings
from apps.privacy.retention import TRIM_MARKER, run_retention, trim_payload
from apps.risk_ml.models import Label, RiskScore, UserDayFeatures
from apps.steps.models import (IntervalVerificationResult, LocationWaypoint,
                               StepSession, StepSyncEvent,
                               SuspiciousSessionReview)
from apps.users.models import PasswordResetCode
from apps.wallet.models import WalletTransaction

from .helpers import make_user

RAW = {
    "date": "2026-01-01",
    "steps": 5400,
    "steps_total": 5400,
    "cadence_spm": 104.5,
    "gait_confidence": 0.8,
    "device_id": "abc-device",
    "install_id": "f0e1d2c3-0000-4000-8000-000000000000",
    "tz_name": "Africa/Nairobi",
    "session_token": "[redacted]",
    "walking_evidence": [{"minute": 1, "steps": 90}],
    "waypoints": [{"lat": -1.28, "lng": 36.82}],
    "signature": "x" * 200,
}


class RetentionTests(TestCase):
    def setUp(self):
        self.now = timezone.now()
        self.user = make_user()
        s = PrivacySettings.load()
        s.retention_batch_size = 100  # exercise batching
        s.save()

    # ── helpers ──
    def sync_event(self, age_days, payload=None, session=None):
        e = StepSyncEvent.objects.create(
            user=self.user, session=session, client_event_id=str(uuid.uuid4()), payload_hash=uuid.uuid4().hex,
            raw_payload=dict(payload or RAW),
        )
        StepSyncEvent.objects.filter(pk=e.pk).update(created_at=self.now - timedelta(days=age_days))
        return e

    def waypoint(self, age_days):
        t = self.now - timedelta(days=age_days)
        return LocationWaypoint.objects.create(user=self.user, date=t.date(), hour=t.hour, recorded_at=t,
                                               latitude=-1.28, longitude=36.82)

    def money(self):
        """Old financial records (10 years) that retention must never touch."""
        old = self.now - timedelta(days=3650)
        ch = Challenge.objects.create(creator=self.user, name="Old", entry_fee=Decimal("100"), milestone=10000,
                                      start_date=date(2016, 1, 1), end_date=date(2016, 1, 7), status="completed",
                                      total_pool=Decimal("100"))
        p = Participant.objects.create(challenge=ch, user=self.user, steps=12000, qualified=True)
        HeldPayout.objects.create(challenge=ch, participant=p, user=self.user, amount=Decimal("90"), status="forfeited")
        WalletTransaction.objects.create(user=self.user, type="deposit", amount=Decimal("100"),
                                         balance_before=Decimal("0"), balance_after=Decimal("100"),
                                         description="Deposit", reference_id="dep-1")
        PaymentTransaction.objects.create(user=self.user, type="deposit", status="completed",
                                          amount_kes=Decimal("100"), order_id="o-1", tracking_reference="t-1",
                                          phone_number="254711000101", narration="Deposit")
        WithdrawalRequest.objects.create(user=self.user, amount_kes=Decimal("50"), method="mpesa",
                                         phone_number="254711000101", status="completed")
        CallbackLog.objects.create(type="deposit", raw_payload={"phone": "254711000101"}, order_id="o-1")
        for Model in (WalletTransaction, PaymentTransaction, WithdrawalRequest):
            Model.objects.update(created_at=old)
        CallbackLog.objects.update(created_at=old)
        HeldPayout.objects.update(created_at=old)

    def money_snapshot(self):
        return (
            list(WalletTransaction.objects.values_list("pk", "amount", "description")),
            list(PaymentTransaction.objects.values_list("pk", "phone_number", "amount_kes")),
            list(WithdrawalRequest.objects.values_list("pk", "phone_number")),
            list(CallbackLog.objects.values_list("pk", "raw_payload")),
            list(HeldPayout.objects.values_list("pk", "amount", "status")),
            list(Participant.objects.values_list("pk", "steps")),
        )

    # ── tests ──
    def test_trim_payload_keeps_aggregates_only(self):
        trimmed = trim_payload(RAW)
        self.assertEqual(trimmed["steps"], 5400)
        self.assertEqual(trimmed["cadence_spm"], 104.5)
        self.assertTrue(trimmed[TRIM_MARKER])
        for key in ("device_id", "install_id", "tz_name", "walking_evidence", "waypoints", "signature",
                    "session_token"):
            self.assertNotIn(key, trimmed)
        self.assertIsNone(trim_payload(["not", "a", "dict"]))

    def test_sync_payload_cutoff_and_idempotence(self):
        old = [self.sync_event(91) for _ in range(150)]  # > one batch
        edge = self.sync_event(89)
        first = run_retention(now=self.now)
        self.assertEqual(first["sync_payloads"]["trimmed"], 150)
        for e in old:
            e.refresh_from_db()
            self.assertNotIn("device_id", e.raw_payload)
            self.assertTrue(e.raw_payload[TRIM_MARKER])
        edge.refresh_from_db()
        self.assertEqual(edge.raw_payload["device_id"], "abc-device")
        second = run_retention(now=self.now)
        self.assertEqual(second["sync_payloads"]["trimmed"], 0)

    def test_sync_payload_of_session_under_review_is_kept(self):
        session = StepSession.objects.create(user=self.user, session_token_hash="h", server_nonce="n",
                                             expires_at=self.now)
        SuspiciousSessionReview.objects.create(user=self.user, session=session, risk_score=80, reason_summary="r")
        e = self.sync_event(200, session=session)
        run_retention(now=self.now)
        e.refresh_from_db()
        self.assertIn("device_id", e.raw_payload)
        SuspiciousSessionReview.objects.update(status="approved")
        run_retention(now=self.now)
        e.refresh_from_db()
        self.assertNotIn("device_id", e.raw_payload)

    def test_legacy_waypoints_deleted_after_30_days(self):
        old = [self.waypoint(31) for _ in range(120)]
        recent = self.waypoint(29)
        out = run_retention(now=self.now)
        self.assertEqual(out["legacy_waypoints"]["deleted"], 120)
        self.assertFalse(LocationWaypoint.objects.filter(pk__in=[w.pk for w in old]).exists())
        self.assertTrue(LocationWaypoint.objects.filter(pk=recent.pk).exists())
        self.assertEqual(run_retention(now=self.now)["legacy_waypoints"]["deleted"], 0)

    def test_risk_ml_kept_12_months_labels_kept(self):
        today = self.now.date()
        for d in (today - timedelta(days=366), today - timedelta(days=364)):
            UserDayFeatures.objects.create(user=self.user, date=d, feature_version="f1", features={"x": 1})
            RiskScore.objects.create(user=self.user, date=d, model_version="m1", feature_version="f1", score=0.5)
        Label.objects.create(user=self.user, date_start=today - timedelta(days=500),
                             date_end=today - timedelta(days=500), label="honest", source="admin_manual",
                             source_ref="admin:1")
        run_retention(now=self.now)
        self.assertEqual(list(UserDayFeatures.objects.values_list("date", flat=True)), [today - timedelta(days=364)])
        self.assertEqual(list(RiskScore.objects.values_list("date", flat=True)), [today - timedelta(days=364)])
        self.assertEqual(Label.objects.count(), 1)

    def test_interval_results_and_password_resets(self):
        iv = IntervalVerificationResult.objects.create(user=self.user, date=self.now.date(),
                                                       interval_start=self.now, interval_end=self.now)
        IntervalVerificationResult.objects.filter(pk=iv.pk).update(created_at=self.now - timedelta(days=400))
        keep = IntervalVerificationResult.objects.create(user=self.user, date=self.now.date(),
                                                         interval_start=self.now, interval_end=self.now)
        code = PasswordResetCode.objects.create(user=self.user, code_hash="x", expires_at=self.now,
                                                request_ip="41.90.1.2")
        PasswordResetCode.objects.filter(pk=code.pk).update(created_at=self.now - timedelta(days=31))
        fresh = PasswordResetCode.objects.create(user=self.user, code_hash="y", expires_at=self.now)
        run_retention(now=self.now)
        self.assertEqual(list(IntervalVerificationResult.objects.values_list("pk", flat=True)), [keep.pk])
        self.assertEqual(list(PasswordResetCode.objects.values_list("pk", flat=True)), [fresh.pk])

    def test_financial_records_untouched(self):
        self.money()
        self.sync_event(400)
        self.waypoint(400)
        before = self.money_snapshot()
        run_retention(now=self.now)
        run_retention(now=self.now + timedelta(days=4000))
        self.assertEqual(self.money_snapshot(), before)

    def test_zero_disables_a_rule_and_master_switch(self):
        s = PrivacySettings.load()
        s.legacy_waypoint_days = 0
        s.save()
        self.waypoint(100)
        self.assertEqual(run_retention(now=self.now)["legacy_waypoints"], "off")
        self.assertEqual(LocationWaypoint.objects.count(), 1)
        s.legacy_waypoint_days = 30
        s.retention_enabled = False
        s.save()
        out = run_retention(now=self.now)
        self.assertEqual(out["skipped"], "retention disabled")
        self.assertEqual(LocationWaypoint.objects.count(), 1)

    def test_time_budget_defers_and_next_run_continues(self):
        for _ in range(5):
            self.waypoint(40)
        out = run_retention(now=self.now, budget_seconds=0)
        self.assertEqual(out["sync_payloads"], "deferred")
        self.assertEqual(LocationWaypoint.objects.count(), 5)
        run_retention(now=self.now)
        self.assertEqual(LocationWaypoint.objects.count(), 0)

    def test_expired_export_archives_are_deleted(self):
        req = DataExportRequest.objects.create(user=self.user, status="ready", archive=b"PK..",
                                               expires_at=self.now - timedelta(minutes=1))
        live = DataExportRequest.objects.create(user=self.user, status="ready", archive=b"PK..",
                                                expires_at=self.now + timedelta(hours=1))
        run_retention(now=self.now)
        req.refresh_from_db()
        live.refresh_from_db()
        self.assertEqual(req.status, "expired")
        self.assertIsNone(req.archive)
        self.assertEqual(live.status, "ready")
        self.assertIsNotNone(live.archive)
