"""Account deletion coverage: every personal field is removed or anonymised,
including the tables added after apps.users.account_deletion was written."""

from datetime import timedelta
from decimal import Decimal

from auditlog.models import LogEntry
from django.apps import apps
from django.core.cache import cache
from django.test import TestCase
from django.utils import timezone

from apps.admin_api.models import AuditLog
from apps.privacy.erasure import deleted_accounts_missing_scrub, scrub_deleted_user
from apps.privacy.models import Consent, DataExportRequest
from apps.risk_ml.models import RiskScore, UserDayFeatures
from apps.steps.models import (DeviceRegistration, HealthRecord,
                               HourlyStepRecord, LocationWaypoint,
                               StepSyncEvent)
from apps.users.account_deletion import delete_account
from apps.users.models import DeviceSession, PasswordResetCode, User

from .helpers import make_user

# Personal fields on the user row and what they must look like after deletion.
USER_PII = ("username", "email", "phone_number", "first_name", "last_name", "device_id", "profile_picture",
            "weight_kg", "stride_length_cm", "calibration_quality", "last_calibrated_at", "last_login")


class ErasureCoverageTests(TestCase):
    def setUp(self):
        cache.clear()
        self.user = make_user(first_name="Akinyi", last_name="Odhiambo", device_id="dev-123",
                              weight_kg=58.5, stride_length_cm=66.0, calibration_quality="good")
        u = self.user
        now = timezone.now()
        User.objects.filter(pk=u.pk).update(last_login=now, last_calibrated_at=now)
        DeviceSession.objects.create(user=u, refresh_jti="jti-1", device_name="Tecno Spark 10",
                                     os_version="Android 13", ip_address="41.90.64.10", country="KE")
        PasswordResetCode.objects.create(user=u, code_hash="x", expires_at=now, request_ip="41.90.64.10")
        HealthRecord.objects.create(user=u, date=now.date(), steps=9000, verification={"counted": 9000})
        HourlyStepRecord.objects.create(user=u, date=now.date(), hour=8, steps=900)
        LocationWaypoint.objects.create(user=u, date=now.date(), hour=8, recorded_at=now, latitude=-1.3,
                                        longitude=36.8)
        StepSyncEvent.objects.create(user=u, client_event_id="e1", payload_hash="h", raw_payload={"steps": 1})
        DeviceRegistration.objects.create(user=u, device_id="dev-123", platform="android")
        UserDayFeatures.objects.create(user=u, date=now.date(), feature_version="f1", features={"a": 1})
        RiskScore.objects.create(user=u, date=now.date(), model_version="m", feature_version="f1", score=0.2)
        DataExportRequest.objects.create(user=u, status="ready", archive=b"PK", expires_at=now + timedelta(days=1))
        Consent.objects.create(user=u, purpose="terms", granted=True, version="terms=1;privacy=1")
        AuditLog.objects.create(admin=None, admin_username="staff", action="ban", resource_type="user",
                                resource_id=u.pk, resource_name="akinyi",
                                description="Banned akinyi (akinyi@example.com, 254711000101) for testing")
        LogEntry.objects.filter(actor__isnull=True).update(actor=u, remote_addr="41.90.64.10")
        self.axes = apps.get_model("axes", "AccessLog")
        self.axes.objects.create(username="akinyi", ip_address="41.90.64.10", user_agent="okhttp",
                                 attempt_time=now)

    def test_delete_account_leaves_no_personal_data(self):
        delete_account(self.user)
        u = User.objects.get(pk=self.user.pk)
        anon = f"deleted_{u.pk}"
        self.assertEqual(u.username, anon)
        self.assertNotIn("akinyi", u.email)
        self.assertEqual(u.phone_number, f"del_{u.pk}")
        self.assertEqual((u.first_name, u.last_name), ("", ""))
        self.assertIsNone(u.device_id)
        self.assertFalse(u.profile_picture)
        self.assertEqual((u.weight_kg, u.stride_length_cm), (70.0, 78.0))
        self.assertIsNone(u.calibration_quality)
        self.assertIsNone(u.last_calibrated_at)
        self.assertIsNone(u.last_login)

        # Activity / device / location data gone (users + risk_ml + this app).
        for Model in (HealthRecord, HourlyStepRecord, LocationWaypoint, StepSyncEvent, DeviceRegistration,
                      UserDayFeatures, RiskScore, DeviceSession, PasswordResetCode, DataExportRequest):
            self.assertFalse(Model.objects.filter(user_id=u.pk).exists(), Model.__name__)
        # Tables of phases merging later are covered by their own deletion code; when
        # they are installed, check them too.
        for label, name in (("steps", "WalkSession"), ("steps", "WalkPrivacyZone"),
                            ("social", "SocialProfile"), ("social", "FeedEvent")):
            try:
                Model = apps.get_model(label, name)
            except LookupError:
                continue
            self.assertFalse(Model.objects.filter(user_id=u.pk).exists(), name)

        # Consent ledger is kept (evidence), without contact details.
        self.assertTrue(Consent.objects.filter(user_id=u.pk).exists())
        # Staff audit text no longer names the person.
        row = AuditLog.objects.get(action="ban")
        for needle in ("akinyi", "254711000101"):
            self.assertNotIn(needle, row.description)
            self.assertNotIn(needle, row.resource_name)
        self.assertIn(anon, row.description)
        # IPs they caused in the change log, and login records, are gone.
        self.assertFalse(LogEntry.objects.filter(actor_id=u.pk, remote_addr__isnull=False).exists())
        self.assertFalse(self.axes.objects.filter(username="akinyi").exists())

    def test_financial_records_kept(self):
        from apps.wallet.models import WalletTransaction

        WalletTransaction.objects.create(user=self.user, type="deposit", amount=Decimal("100"),
                                         balance_before=Decimal("0"), balance_after=Decimal("0"),
                                         description="Deposit", reference_id="d1")
        delete_account(self.user)
        self.assertTrue(WalletTransaction.objects.filter(user_id=self.user.pk).exists())

    def test_backfill_for_accounts_deleted_earlier(self):
        # Simulate an account deleted before apps.privacy existed (no scrub ran).
        User.objects.filter(pk=self.user.pk).update(deleted_at=timezone.now(), username=f"deleted_{self.user.pk}")
        self.assertIn(self.user.pk, list(deleted_accounts_missing_scrub().values_list("pk", flat=True)))
        scrub_deleted_user(User.objects.get(pk=self.user.pk))
        self.assertFalse(DeviceSession.objects.filter(user_id=self.user.pk).exists())
        self.assertNotIn(self.user.pk, list(deleted_accounts_missing_scrub().values_list("pk", flat=True)))
        # Idempotent.
        scrub_deleted_user(User.objects.get(pk=self.user.pk))
