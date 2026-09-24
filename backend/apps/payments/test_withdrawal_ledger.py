"""
Withdrawal ledger tests.

Every wallet balance change caused by a withdrawal must have a matching WalletTransaction,
and reconciliation must never refund or credit the same money twice.
"""
from datetime import timedelta
from decimal import Decimal
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.test import TestCase
from django.utils import timezone

from apps.payments.models import PaymentTransaction, WithdrawalRequest
from apps.payments.services import (
    approve_withdrawal_and_send,
    reject_withdrawal_request,
    request_withdrawal,
)
from apps.payments.tasks import _reconcile_deposit, reconcile_pending_payments
from apps.wallet.models import WalletTransaction

User = get_user_model()
PHONE = "254712345699"


class WithdrawalLedgerTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            username="ledgeruser",
            email="ledger@example.com",
            phone_number=PHONE,
            password="testpass123",
            wallet_balance=Decimal("1000.00"),
        )
        self.admin = User.objects.create_user(
            username="ledgeradmin",
            email="ledgeradmin@example.com",
            phone_number="254712345698",
            password="testpass123",
            is_staff=True,
        )

    def _request(self, amount="300.00"):
        with patch("apps.payments.intasend.format_phone", return_value=PHONE):
            return request_withdrawal(
                self.user, {"method": "mpesa", "amount": Decimal(amount), "phone_number": PHONE}
            )

    def _assert_ledger_explains_balance(self):
        """Opening balance + sum of ledger rows == current balance."""
        self.user.refresh_from_db()
        total = sum(WalletTransaction.objects.filter(user=self.user).values_list("amount", flat=True))
        self.assertEqual(Decimal("1000.00") + total, self.user.wallet_balance)

    def test_request_writes_debit_row(self):
        withdrawal = self._request()
        row = WalletTransaction.objects.get(user=self.user, type="withdrawal")
        self.assertEqual(row.amount, Decimal("-300.00"))
        self.assertEqual(row.balance_before, Decimal("1000.00"))
        self.assertEqual(row.balance_after, Decimal("700.00"))
        self.assertEqual(row.reference_id, f"WDR-{withdrawal.id}")
        self._assert_ledger_explains_balance()

    def test_reject_writes_refund_row(self):
        withdrawal = self._request()
        reject_withdrawal_request(withdrawal, reason="Destination mismatch", reviewer=self.admin)

        refund = WalletTransaction.objects.get(user=self.user, type="refund")
        self.assertEqual(refund.amount, Decimal("300.00"))
        self.assertEqual(refund.balance_after, Decimal("1000.00"))
        self.assertEqual(refund.reference_id, str(withdrawal.id))
        self._assert_ledger_explains_balance()

    def test_gateway_failure_on_approve_writes_refund_row(self):
        withdrawal = self._request()
        with patch("apps.payments.intasend.send_withdrawal_to_mobile", side_effect=RuntimeError("gateway down")):
            with self.assertRaises(RuntimeError):
                approve_withdrawal_and_send(withdrawal, reviewer=self.admin)

        withdrawal.refresh_from_db()
        self.assertEqual(withdrawal.status, "failed")
        self.assertEqual(WalletTransaction.objects.filter(user=self.user, type="refund").count(), 1)
        self._assert_ledger_explains_balance()

    def test_reconcile_failed_withdrawal_refunds_once(self):
        withdrawal = self._request()
        WithdrawalRequest.objects.filter(id=withdrawal.id).update(
            status="processing",
            tracking_reference="TRK-1",
            updated_at=timezone.now() - timedelta(hours=1),
        )
        failed = {"status": "FAILED", "transactions": [{"failed_reason": "Invalid account"}]}
        with patch("apps.payments.intasend.get_disbursement_status", return_value=failed):
            reconcile_pending_payments()
            # A second run (or a late callback) must not refund again.
            WithdrawalRequest.objects.filter(id=withdrawal.id).update(updated_at=timezone.now() - timedelta(hours=1))
            reconcile_pending_payments()

        self.assertEqual(WalletTransaction.objects.filter(user=self.user, type="refund").count(), 1)
        self._assert_ledger_explains_balance()


class DepositReconcileTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            username="depositor",
            email="depositor@example.com",
            phone_number="254712345697",
            password="testpass123",
            wallet_balance=Decimal("0.00"),
        )
        self.txn = PaymentTransaction.objects.create(
            user=self.user,
            type="deposit",
            status="pending",
            amount_kes=Decimal("500.00"),
            order_id="ORD-RECON-1",
            phone_number="254712345697",
        )

    def test_complete_credits_once_with_ledger_row(self):
        invoice = {"state": "COMPLETE", "mpesa_reference": "QK1234"}
        _reconcile_deposit(self.txn, invoice)
        _reconcile_deposit(self.txn, invoice)  # stale object, second run must be a no-op

        self.user.refresh_from_db()
        self.assertEqual(self.user.wallet_balance, Decimal("500.00"))
        row = WalletTransaction.objects.get(user=self.user, type="deposit")
        self.assertEqual(row.amount, Decimal("500.00"))
        self.assertEqual(row.reference_id, "ORD-RECON-1")

    def test_failed_does_not_overwrite_completed(self):
        PaymentTransaction.objects.filter(id=self.txn.id).update(status="completed")
        _reconcile_deposit(self.txn, {"state": "FAILED", "failed_reason": "Timeout"})
        self.txn.refresh_from_db()
        self.assertEqual(self.txn.status, "completed")
