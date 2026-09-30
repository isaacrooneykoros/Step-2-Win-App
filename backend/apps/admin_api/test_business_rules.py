"""Business switches moved from env into SystemSettings (apps/admin_api/business_rules.py).

Precedence: console value when set, else the server value; numbers never looser than
the server's hard limits (caps are ceilings, floors are floors). Every reader uses it.
"""

from datetime import date, timedelta
from decimal import Decimal

from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.test import TestCase, override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from apps.admin_api import business_rules as br
from apps.admin_api.models import AuditLog, SystemSettings
from apps.payments.models import WithdrawalRequest
from apps.payments.services import PaymentsServiceError, request_withdrawal

User = get_user_model()


def set_console(**values):
    s = SystemSettings.load()
    for k, v in values.items():
        setattr(s, k, v)
    s.save()  # clears the settings cache
    return s


class PrecedenceTests(TestCase):
    def setUp(self):
        cache.clear()

    def tearDown(self):
        cache.clear()

    @override_settings(RANK_PAYOUTS_ENABLED=True)
    def test_blank_console_value_uses_server_value(self):
        self.assertTrue(br.rank_payouts_enabled())
        self.assertEqual(br.source("rank_payouts_enabled"), "server")

    @override_settings(RANK_PAYOUTS_ENABLED=True)
    def test_console_value_wins_over_server(self):
        set_console(rank_payouts_enabled=False)
        self.assertFalse(br.rank_payouts_enabled())
        self.assertEqual(br.source("rank_payouts_enabled"), "console")

    @override_settings(MAX_DEPOSIT_KES=50_000)
    def test_cap_never_exceeded_even_if_stored(self):
        # Stored directly (bypassing validation), e.g. after the server cap was lowered.
        set_console(max_deposit_kes=Decimal("90000"))
        self.assertEqual(br.effective("max_deposit_kes"), Decimal("50000"))
        set_console(max_deposit_kes=Decimal("20000"))
        self.assertEqual(br.effective("max_deposit_kes"), Decimal("20000"))

    @override_settings(MIN_SECONDS_BETWEEN_WITHDRAWALS=300)
    def test_floor_never_undercut(self):
        set_console(min_seconds_between_withdrawals=10)
        self.assertEqual(br.effective("min_seconds_between_withdrawals"), 300)
        set_console(min_seconds_between_withdrawals=900)
        self.assertEqual(br.effective("min_seconds_between_withdrawals"), 900)

    @override_settings(PAID_CHALLENGE_TRUST_FLOOR=40)
    def test_trust_score_floor(self):
        set_console(paid_challenge_min_trust_score=10)
        self.assertEqual(br.effective("paid_challenge_min_trust_score"), 40)

    @override_settings(MAX_WITHDRAWAL_KES=70_000)
    def test_validation_refuses_values_above_cap(self):
        clean, err = br.validate_console_value("max_withdrawal_kes", "80000")
        self.assertIsNone(clean)
        self.assertIn("at most", err)
        clean, err = br.validate_console_value("max_withdrawal_kes", "5000")
        self.assertEqual((clean, err), (Decimal("5000"), None))
        self.assertEqual(br.validate_console_value("max_withdrawal_kes", None), (None, None))

    @override_settings(STEP_EVIDENCE_CUTOVER_DATE="2026-01-05")
    def test_dates(self):
        self.assertEqual(br.evidence_cutover_date(), date(2026, 1, 5))
        set_console(step_evidence_cutover_date=date(2026, 10, 1))
        self.assertEqual(br.evidence_cutover_date(), date(2026, 10, 1))

    def test_describe_lists_every_rule(self):
        d = br.describe()
        self.assertEqual(set(d), set(br.RULES))
        self.assertEqual(d["max_deposit_kes"]["bound"], "cap")
        self.assertEqual(d["min_deposit_kes"]["bound"], "floor")


class ReaderTests(TestCase):
    """Every reader follows the console value."""

    def setUp(self):
        cache.clear()
        self.user = User.objects.create_user(
            username="rules_user", email="rules@example.com", phone_number="254712000111",
            password="TestPass123!", wallet_balance=Decimal("100000.00"), challenges_joined=0,
        )

    def tearDown(self):
        cache.clear()

    def test_payout_policy(self):
        from apps.challenges.payout_policy import allowed_win_conditions

        self.assertEqual(allowed_win_conditions(), ["proportional"])
        set_console(rank_payouts_enabled=True)
        self.assertIn("winner_takes_all", allowed_win_conditions())

    @override_settings(STEP_MONEY_REQUIRES_EVIDENCE=False, STEP_EVIDENCE_CUTOVER_DATE="")
    def test_evidence_readers(self):
        from apps.steps import evidence

        self.assertFalse(evidence.money_requires_evidence())
        self.assertIsNone(evidence.cutover_date())
        set_console(step_money_requires_evidence=True, step_evidence_cutover_date=date(2026, 9, 1))
        self.assertTrue(evidence.money_requires_evidence())
        self.assertEqual(evidence.cutover_date(), date(2026, 9, 1))

    @override_settings(PLAY_INTEGRITY_ACCEPT_BASIC=False)
    def test_integrity_accept_basic(self):
        from apps.steps import integrity

        payload = {
            "requestDetails": {"nonce": "n", "requestPackageName": "", "timestampMillis": str(int(timezone.now().timestamp() * 1000))},
            "appIntegrity": {"appRecognitionVerdict": "PLAY_RECOGNIZED"},
            "deviceIntegrity": {"deviceRecognitionVerdict": ["MEETS_BASIC_INTEGRITY"]},
            "accountDetails": {},
        }
        before = integrity.evaluate_payload(payload, expected_nonce="n", expected_package="")
        set_console(play_integrity_accept_basic=True)
        after = integrity.evaluate_payload(payload, expected_nonce="n", expected_package="")
        self.assertIn("device_not_recognized", before[1]["reasons"])
        self.assertNotIn("device_not_recognized", after[1]["reasons"])

    def test_risk_ml_threshold(self):
        from apps.risk_ml.training import hold_threshold

        set_console(risk_ml_hold_threshold=0.66)
        self.assertAlmostEqual(hold_threshold(), 0.66)

    def test_deposit_limits_used_by_serializer_and_service(self):
        from apps.payments.serializers import InitiateDepositSerializer
        from apps.payments.services import initiate_deposit

        set_console(max_deposit_kes=Decimal("2000"))
        ser = InitiateDepositSerializer(data={"amount": "2500", "phone_number": "254712000111"})
        self.assertFalse(ser.is_valid())
        self.assertIn("2,000", str(ser.errors["amount"]))
        with self.assertRaises(PaymentsServiceError):
            initiate_deposit(self.user, Decimal("2500"), "254712000111")

    def _withdraw(self, amount="500"):
        return request_withdrawal(self.user, {"method": "mpesa", "amount": amount, "phone_number": "254712000111"})

    def test_withdrawal_single_and_daily_limits(self):
        set_console(max_withdrawal_kes=Decimal("1000"))
        with self.assertRaises(PaymentsServiceError) as ctx:
            self._withdraw("1500")
        self.assertIn("largest single", ctx.exception.message)
        set_console(max_withdrawal_kes=None, max_daily_withdrawal_kes=Decimal("800"))
        with self.assertRaises(PaymentsServiceError) as ctx:
            self._withdraw("900")
        self.assertIn("Daily withdrawal limit", ctx.exception.message)

    def test_withdrawal_request_count_limits(self):
        set_console(max_withdrawals_per_hour=1, min_seconds_between_withdrawals=None)
        first = self._withdraw("100")
        # The one-active-request rule would block too; finish the first one.
        WithdrawalRequest.objects.filter(pk=first.pk).update(status="completed")
        with self.assertRaises(PaymentsServiceError) as ctx:
            self._withdraw("100")
        self.assertEqual(ctx.exception.status_code, 429)
        # Older than an hour and outside the gap: allowed again.
        WithdrawalRequest.objects.filter(pk=first.pk).update(created_at=timezone.now() - timedelta(hours=2))
        self._withdraw("100")

    def test_paid_challenge_eligibility(self):
        from apps.challenges.models import get_configured_milestones

        client = APIClient()
        client.force_authenticate(self.user)
        body = {"name": "Rules", "milestone": get_configured_milestones()[0], "entry_fee": 100,
                "is_public": False, "duration_days": 7, "max_participants": 5}
        set_console(paid_challenge_min_joined=0)
        ok = client.post("/api/challenges/create/", body, format="json")
        self.assertIn(ok.status_code, (200, 201), ok.content)
        set_console(paid_challenge_min_joined=5)
        blocked = client.post("/api/challenges/create/", {**body, "name": "Rules 2"}, format="json")
        self.assertEqual(blocked.status_code, 403)
        self.assertIn("5 challenge", blocked.json()["error"])

    def test_monitoring_thresholds(self):
        set_console(recon_max_stuck_processing=3, drift_min_samples=7)
        self.assertEqual(br.reconciliation_thresholds().max_stuck_processing, 3)
        self.assertEqual(br.drift_thresholds().min_samples, 7)

    @override_settings(WALK_RAW_POINTS_RETENTION_DAYS=30, WALK_RAW_POINTS_MAX_DAYS=60)
    def test_walk_retention_from_privacy_settings(self):
        from apps.privacy.models import PrivacySettings

        s = PrivacySettings.load()
        self.assertEqual(s.effective_walk_raw_points_days(), 30)
        s.walk_raw_points_days = 14
        s.save()
        self.assertEqual(s.effective_walk_raw_points_days(), 14)
        s.walk_raw_points_days = 365
        s.save()
        self.assertEqual(s.effective_walk_raw_points_days(), 60)


class AdminApiTests(TestCase):
    def setUp(self):
        cache.clear()
        self.admin = User.objects.create_user(
            username="rules_admin", email="rulesadmin@example.com", phone_number="254712000112",
            password="TestPass123!", is_staff=True,
        )
        self.client = APIClient()
        self.client.force_authenticate(self.admin)

    def tearDown(self):
        cache.clear()

    @override_settings(MAX_DEPOSIT_KES=100_000)
    def test_update_validates_against_caps_and_audits(self):
        bad = self.client.post("/api/admin/settings/update/", {"max_deposit_kes": "200000"}, format="json")
        self.assertEqual(bad.status_code, 400)
        self.assertIn("max_deposit_kes", bad.json())
        ok = self.client.post("/api/admin/settings/update/", {"max_deposit_kes": "5000", "rank_payouts_enabled": True}, format="json")
        self.assertEqual(ok.status_code, 200, ok.content)
        self.assertEqual(ok.json()["max_deposit_kes"], "5000.00")
        log = AuditLog.objects.filter(resource_type="settings").latest("created_at")
        self.assertIn("max_deposit_kes", log.changes)
        self.assertIn("rank_payouts_enabled", log.changes)
        # Clearing returns to the server value.
        cleared = self.client.post("/api/admin/settings/update/", {"max_deposit_kes": None}, format="json")
        self.assertEqual(cleared.status_code, 200)
        self.assertIsNone(cleared.json()["max_deposit_kes"])

    def test_cross_field_deposit_check(self):
        r = self.client.post("/api/admin/settings/update/", {"min_deposit_kes": "5000", "max_deposit_kes": "1000"}, format="json")
        self.assertEqual(r.status_code, 400)

    def test_context_exposes_rules(self):
        data = self.client.get("/api/admin/settings/context/").json()
        self.assertIn("rules", data)
        self.assertIn("step_money_requires_evidence", data["rules"])
        self.assertIn("step_money_requires_evidence", data["enforced_by"])

    def test_privacy_settings_walk_retention(self):
        url = "/api/privacy/admin/settings/"
        r = self.client.patch(url, {"walk_raw_points_days": 14}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["walk_raw_points_days"], 14)
        self.assertEqual(r.json()["server"]["walk_raw_points_effective_days"], 14)
        r = self.client.patch(url, {"walk_raw_points_days": 5000}, format="json")
        self.assertEqual(r.status_code, 400)
        r = self.client.patch(url, {"walk_raw_points_days": None}, format="json")
        self.assertEqual(r.status_code, 200)
        self.assertIsNone(r.json()["walk_raw_points_days"])
