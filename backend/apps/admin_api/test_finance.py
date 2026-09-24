"""Tests for the read-only admin finance endpoints (finance_views.py)."""

from decimal import Decimal

from django.contrib.auth import get_user_model
from django.test import TestCase
from rest_framework.test import APIClient

from apps.payments.models import WithdrawalRequest
from apps.wallet.models import WalletTransaction, Withdrawal

User = get_user_model()


class FinanceEndpointsTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.admin = User.objects.create_user(
            username="fin_admin", email="fa@example.com", phone_number="254700000001",
            password="pass12345!", is_staff=True,
        )
        self.user = User.objects.create_user(
            username="walker", email="w@example.com", phone_number="254712345678",
            password="pass12345!", wallet_balance=Decimal("700.00"),
        )
        WalletTransaction.objects.create(
            user=self.user, type="deposit", amount=Decimal("1000.00"),
            balance_before=Decimal("0"), balance_after=Decimal("1000.00"),
            description="M-Pesa deposit", reference_id="DEP-ABC123",
        )
        WalletTransaction.objects.create(
            user=self.user, type="challenge_entry", amount=Decimal("-200.00"),
            balance_before=Decimal("1000.00"), balance_after=Decimal("800.00"),
            description="Entry: Morning Movers", reference_id="ENT-1",
        )
        self.pending = WithdrawalRequest.objects.create(
            user=self.user, status="pending_review", amount_kes=Decimal("100.00"),
            method="mpesa", phone_number="254712345678",
        )
        self.failed = WithdrawalRequest.objects.create(
            user=self.user, status="failed", amount_kes=Decimal("50.00"),
            method="mpesa", phone_number="254712345678", fail_reason="IntaSend error: x",
        )

    def auth(self, user=None):
        self.client.force_authenticate(user or self.admin)

    def test_requires_staff(self):
        for url in [
            "/api/admin/finance/withdrawals/", "/api/admin/finance/ledger/",
            "/api/admin/finance/ledger/export/", "/api/admin/finance/report/",
            "/api/admin/finance/analytics/",
            f"/api/admin/finance/withdrawals/{self.pending.id}/",
        ]:
            self.client.force_authenticate(None)
            self.assertIn(self.client.get(url).status_code, (401, 403), url)
            self.auth(self.user)
            self.assertEqual(self.client.get(url).status_code, 403, url)

    def test_withdrawal_queue_defaults_to_pending_and_filters(self):
        self.auth()
        r = self.client.get("/api/admin/finance/withdrawals/").json()
        self.assertEqual(r["count"], 1)
        self.assertEqual(r["total_amount_kes"], "100.00")
        self.assertEqual(r["results"][0]["id"], str(self.pending.id))

        r = self.client.get("/api/admin/finance/withdrawals/?status=all").json()
        self.assertEqual(r["count"], 2)
        r = self.client.get("/api/admin/finance/withdrawals/?status=failed").json()
        self.assertEqual(r["results"][0]["fail_reason"], "IntaSend error: x")
        r = self.client.get("/api/admin/finance/withdrawals/?status=all&q=nobody").json()
        self.assertEqual(r["count"], 0)

    def test_withdrawal_detail_context(self):
        self.auth()
        r = self.client.get(f"/api/admin/finance/withdrawals/{self.pending.id}/").json()
        self.assertEqual(r["user"]["wallet_balance"], "700.00")
        self.assertEqual(len(r["history"]["previous"]), 1)
        self.assertEqual(r["ledger"]["totals_by_type"]["deposit"]["amount_kes"], "1000.00")
        self.assertEqual(r["trust"]["open_flags"], 0)

    def test_ledger_filters_and_totals(self):
        self.auth()
        r = self.client.get("/api/admin/finance/ledger/").json()
        self.assertEqual(r["count"], 2)
        self.assertEqual(r["totals"]["credits"], "1000.00")
        self.assertEqual(r["totals"]["debits"], "-200.00")
        r = self.client.get("/api/admin/finance/ledger/?type=deposit").json()
        self.assertEqual(r["count"], 1)
        r = self.client.get("/api/admin/finance/ledger/?q=ENT-1").json()
        self.assertEqual(r["results"][0]["type"], "challenge_entry")
        self.assertTrue(r["results"][0]["arithmetic_ok"])
        r = self.client.get("/api/admin/finance/ledger/?direction=debit&user=walk").json()
        self.assertEqual(r["count"], 1)

    def test_ledger_export_csv(self):
        self.auth()
        resp = self.client.get("/api/admin/finance/ledger/export/?type=deposit")
        self.assertEqual(resp.status_code, 200)
        self.assertIn("text/csv", resp["Content-Type"])
        body = resp.content.decode()
        self.assertIn("DEP-ABC123", body)
        self.assertNotIn("ENT-1", body)

    def test_report_and_reconciliation(self):
        self.auth()
        r = self.client.get("/api/admin/finance/report/?days=7").json()
        self.assertEqual(r["period"]["days"], 7)
        self.assertEqual(len(r["daily"]), 7)
        self.assertEqual(r["ledger"]["deposit"]["amount_kes"], "1000.00")
        self.assertEqual(r["withdrawals"]["requested_by_status"]["pending_review"]["count"], 1)
        checks = {c["key"]: c for c in r["reconciliation"]}
        # wallet 700 vs ledger 800: withdrawal debits are not in the ledger
        self.assertFalse(checks["wallet_vs_ledger"]["ok"])
        self.assertEqual(checks["wallet_vs_ledger"]["rows"][0]["difference"], "-100.00")
        self.assertTrue(checks["ledger_arithmetic"]["ok"])

    def test_analytics(self):
        self.auth()
        r = self.client.get("/api/admin/finance/analytics/?days=14").json()
        self.assertEqual(len(r["daily"]), 14)
        self.assertEqual(r["users"]["total"], 2)
        self.assertEqual(len(r["cohorts"]), 8)

    def test_overview_pending_withdrawals_use_live_model(self):
        # A legacy row must not be counted; the live request queue is.
        Withdrawal.objects.create(user=self.user, amount=Decimal("300"), account_details="x", status="pending")
        self.auth()
        r = self.client.get("/api/admin/dashboard/overview/?days=7").json()
        self.assertEqual(r["pending_withdrawals_count"], 1)
        self.assertEqual(r["pending_withdrawals_amount"], 100.0)

    def test_notifications_with_pending_withdrawal(self):
        # Regression: the notification text read a non-existent `amount` field.
        self.auth()
        resp = self.client.get("/api/admin/notifications/")
        self.assertEqual(resp.status_code, 200)
        self.assertIn("100.00", str(resp.json()))
