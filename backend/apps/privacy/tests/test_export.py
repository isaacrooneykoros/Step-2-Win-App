"""Data export: contents, privacy (own data only, no internals), expiry, rate limit."""

import io
import json
import uuid
import zipfile
from datetime import date, timedelta
from decimal import Decimal
from unittest import mock

from django.core.cache import cache
from django.utils import timezone
from rest_framework.test import APITestCase

from apps.admin_api.models import SupportTicket, SupportTicketMessage
from apps.challenges.models import Challenge, ChallengeMessage, Participant
from apps.privacy.export import build_archive, process_pending_exports
from apps.privacy.models import DataExportRequest, PrivacySettings
from apps.risk_ml.models import RiskScore
from apps.steps.models import FraudFlag, HealthRecord, StepSyncEvent
from apps.wallet.models import WalletTransaction

from .helpers import make_user

EXPORTS = "/api/privacy/exports/"


def unzip(data: bytes) -> dict:
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        return {n: (zf.read(n).decode() if n.endswith(".txt") else json.loads(zf.read(n))) for n in zf.namelist()}


class ExportContentTests(APITestCase):
    def setUp(self):
        cache.clear()
        self.user = make_user(first_name="Akinyi", last_name="Odhiambo")
        self.other = make_user("baraka", "254711000102")
        today = timezone.now().date()
        HealthRecord.objects.create(
            user=self.user, date=today, steps=8000, anticheat={"suspicion": {"rule": "SECRET_THRESHOLD_42"}},
            verification={"counted": 8000, "reasons": []},
        )
        HealthRecord.objects.create(user=self.other, date=today, steps=7777777)
        FraudFlag.objects.create(user=self.user, flag_type="SECRET_RULE_NAME", severity="high", date=today,
                                 details={"threshold": 999})
        RiskScore.objects.create(user=self.user, date=today, model_version="m1", feature_version="f1", score=0.91,
                                 explanations=[{"text": "SECRET_EXPLANATION"}])
        ch = Challenge.objects.create(creator=self.other, name="Nairobi Walkers", entry_fee=Decimal("100"),
                                      milestone=10000, start_date=date.today(), end_date=date.today(),
                                      status="active", total_pool=Decimal("200"))
        Participant.objects.create(challenge=ch, user=self.user, steps=8000)
        Participant.objects.create(challenge=ch, user=self.other, steps=7777777)
        ChallengeMessage.objects.create(challenge=ch, user=self.user, message="my own message")
        ChallengeMessage.objects.create(challenge=ch, user=self.other, message="OTHER PERSON MESSAGE")
        WalletTransaction.objects.create(user=self.user, type="deposit", amount=Decimal("100"),
                                         balance_before=Decimal("0"), balance_after=Decimal("100"),
                                         description="Deposit", reference_id="dep-9")
        t = SupportTicket.objects.create(user=self.user, subject="Help", category="other", message="hi",
                                         admin_notes="INTERNAL STAFF NOTE")
        SupportTicketMessage.objects.create(ticket=t, sender=self.other, sender_username="staff_jane", is_admin=True,
                                            message="We fixed it")
        old = StepSyncEvent.objects.create(user=self.user, client_event_id="a", payload_hash="h1", steps_delta=5)
        StepSyncEvent.objects.filter(pk=old.pk).update(timestamp_server=timezone.now() - timedelta(days=200))
        StepSyncEvent.objects.create(user=self.user, client_event_id="b", payload_hash="h2", steps_delta=7)

    def test_archive_contains_own_data(self):
        files = unzip(build_archive(self.user))
        self.assertIn("README.txt", files)
        self.assertEqual(files["account.json"]["username"], "akinyi")
        self.assertEqual(files["account.json"]["first_name"], "Akinyi")
        self.assertNotIn("password", files["account.json"])
        self.assertEqual([r["steps"] for r in files["activity/daily_steps.json"]], [8000])
        self.assertEqual(files["activity/daily_steps.json"][0]["verification"]["counted"], 8000)
        self.assertEqual([r["message"] for r in files["challenges/my_chat_messages.json"]], ["my own message"])
        self.assertEqual(len(files["money/wallet_transactions.json"]), 1)
        self.assertEqual([m["from"] for m in files["support/messages.json"]], ["Step2Win support"])
        # Upload log: last 90 days only.
        self.assertEqual([r["steps_delta"] for r in files["activity/step_syncs_last_90_days.json"]], [7])
        self.assertEqual(files["assessments.json"]["fair_play_flags"]["count"], 1)
        self.assertEqual(files["assessments.json"]["shadow_risk_scores"]["count"], 1)

    def test_archive_excludes_other_people_and_internals(self):
        raw = build_archive(self.user)
        text = b"".join(zipfile.ZipFile(io.BytesIO(raw)).read(n) for n in zipfile.ZipFile(io.BytesIO(raw)).namelist())
        for secret in (b"baraka", b"7777777", b"OTHER PERSON MESSAGE", b"SECRET_THRESHOLD_42", b"SECRET_RULE_NAME",
                       b"SECRET_EXPLANATION", b"INTERNAL STAFF NOTE", b"staff_jane", b"threshold", b"password"):
            self.assertNotIn(secret, text, secret)

    def test_sections_of_missing_apps_are_skipped(self):
        from django.apps import apps

        names = set(unzip(build_archive(self.user)))
        # Apps that aren't installed (e.g. social before Phase 4 merges): no file, no crash.
        self.assertEqual("social/profile.json" in names, apps.is_installed("apps.social"))


class ExportFlowTests(APITestCase):
    def setUp(self):
        cache.clear()
        self.user = make_user()
        self.client.force_authenticate(self.user)

    def test_request_build_download(self):
        res = self.client.post(EXPORTS)
        self.assertEqual(res.status_code, 201)
        export_id = res.data["id"]
        self.assertEqual(res.data["status"], "pending")
        self.assertIsNone(res.data["download_path"])
        # Not ready yet.
        self.assertEqual(self.client.get(f"{EXPORTS}{export_id}/download/").status_code, 409)
        # Double tap: the same open request comes back.
        again = self.client.post(EXPORTS)
        self.assertEqual(again.status_code, 200)
        self.assertEqual(again.data["id"], export_id)

        self.assertEqual(process_pending_exports(), {"built": 1, "failed": 0})
        listing = self.client.get(EXPORTS).data["exports"][0]
        self.assertEqual(listing["status"], "ready")
        self.assertTrue(listing["download_path"].endswith("/download/"))
        dl = self.client.get(listing["download_path"])
        self.assertEqual(dl.status_code, 200)
        self.assertEqual(dl["Content-Type"], "application/zip")
        self.assertEqual(dl["Cache-Control"], "no-store")
        files = unzip(b"".join(dl.streaming_content) if dl.streaming else dl.content)
        self.assertEqual(files["account.json"]["username"], "akinyi")
        self.assertEqual(DataExportRequest.objects.get(pk=export_id).download_count, 1)
        # Idempotent job: nothing more to build.
        self.assertEqual(process_pending_exports(), {"built": 0, "failed": 0})

    def test_other_user_cannot_download(self):
        self.client.post(EXPORTS)
        process_pending_exports()
        req = DataExportRequest.objects.get(user=self.user)
        intruder = make_user("mallory", "254711000199")
        self.client.force_authenticate(intruder)
        self.assertEqual(self.client.get(f"{EXPORTS}{req.id}/download/").status_code, 404)
        self.assertEqual(self.client.get(EXPORTS).data["exports"], [])
        self.client.force_authenticate(None)
        self.assertEqual(self.client.get(f"{EXPORTS}{req.id}/download/").status_code, 401)
        self.assertEqual(self.client.get(f"{EXPORTS}{uuid.uuid4()}/download/").status_code, 401)

    def test_link_expires(self):
        self.client.post(EXPORTS)
        process_pending_exports()
        req = DataExportRequest.objects.get(user=self.user)
        hours = PrivacySettings.load().export_link_hours
        self.assertAlmostEqual((req.expires_at - req.finished_at).total_seconds(), hours * 3600, delta=5)
        later = timezone.now() + timedelta(hours=hours, minutes=1)
        with mock.patch("apps.privacy.views.timezone.now", return_value=later):
            res = self.client.get(f"{EXPORTS}{req.id}/download/")
        self.assertEqual(res.status_code, 410)
        req.refresh_from_db()
        self.assertEqual(req.status, "expired")
        self.assertIsNone(req.archive)

    def test_rate_limited_to_one_per_cooldown(self):
        self.client.post(EXPORTS)
        process_pending_exports()
        res = self.client.post(EXPORTS)
        self.assertEqual(res.status_code, 429)
        self.assertEqual(res.data["code"], "export_rate_limited")
        self.assertEqual(DataExportRequest.objects.filter(user=self.user).count(), 1)
        DataExportRequest.objects.update(requested_at=timezone.now() - timedelta(hours=25))
        self.assertEqual(self.client.post(EXPORTS).status_code, 201)

    def test_failed_build_retries_then_gives_up(self):
        self.client.post(EXPORTS)
        with mock.patch("apps.privacy.export.build_archive", side_effect=RuntimeError("boom")):
            for _ in range(3):
                process_pending_exports()
        req = DataExportRequest.objects.get(user=self.user)
        self.assertEqual(req.status, "failed")
        self.assertIsNone(req.archive)
        # A failed request doesn't count against the cooldown.
        self.assertEqual(self.client.post(EXPORTS).status_code, 201)
