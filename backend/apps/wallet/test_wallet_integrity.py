"""
Phase 2 Wallet Integrity Tests

Tests for:
- Balance operations under concurrent conditions
- Idempotency of financial operations
- Prevention of negative balances
- Prevention of duplicate transactions
- Race condition handling
"""
import uuid
from decimal import Decimal
from concurrent.futures import ThreadPoolExecutor, as_completed
from unittest.mock import patch, MagicMock

from django.test import TestCase, TransactionTestCase
from django.db import connection, transaction
from django.contrib.auth import get_user_model

from apps.wallet.models import WalletTransaction
from apps.payments.models import (
    PaymentTransaction, CallbackLog, WithdrawalRequest
)
from apps.payments.services import (
    credit_wallet, debit_wallet, process_deposit_callback,
    request_withdrawal, reject_withdrawal_request,
    PaymentsServiceError
)


User = get_user_model()


class WalletBalanceIntegrityTests(TestCase):
    """Test wallet balance integrity under various operations."""

    def setUp(self):
        self.user = User.objects.create_user(
            username="testuser",
            email="test@example.com",
            phone_number="254712345678",
            password="testpass123",
            wallet_balance=Decimal("1000.00"),
        )

    def test_credit_wallet_updates_balance_correctly(self):
        """Credit operation should correctly update balance and create transaction."""
        initial_balance = self.user.wallet_balance
        amount = Decimal("500.00")

        txn = credit_wallet(
            self.user,
            amount,
            reference_id=f"TEST-{uuid.uuid4().hex[:8]}",
            description="Test credit",
            transaction_type="deposit",
        )

        self.user.refresh_from_db()
        self.assertEqual(self.user.wallet_balance, initial_balance + amount)
        self.assertEqual(txn.balance_before, initial_balance)
        self.assertEqual(txn.balance_after, initial_balance + amount)
        self.assertEqual(txn.amount, amount)

    def test_debit_wallet_updates_balance_correctly(self):
        """Debit operation should correctly update balance and create transaction."""
        initial_balance = self.user.wallet_balance
        amount = Decimal("300.00")

        txn = debit_wallet(
            self.user,
            amount,
            reference_id=f"TEST-{uuid.uuid4().hex[:8]}",
            description="Test debit",
            transaction_type="withdrawal",
        )

        self.user.refresh_from_db()
        self.assertEqual(self.user.wallet_balance, initial_balance - amount)
        self.assertEqual(txn.balance_before, initial_balance)
        self.assertEqual(txn.balance_after, initial_balance - amount)
        self.assertEqual(txn.amount, -amount)  # Negative for debits

    def test_debit_wallet_prevents_negative_balance(self):
        """Debit should fail if it would result in negative balance."""
        amount = Decimal("2000.00")  # More than wallet_balance

        with self.assertRaises(PaymentsServiceError) as ctx:
            debit_wallet(
                self.user,
                amount,
                reference_id=f"TEST-{uuid.uuid4().hex[:8]}",
                description="Test overdraft",
                transaction_type="withdrawal",
            )

        self.assertIn("Insufficient balance", str(ctx.exception))
        self.user.refresh_from_db()
        # Balance should remain unchanged
        self.assertEqual(self.user.wallet_balance, Decimal("1000.00"))

    def test_balance_before_after_audit_trail(self):
        """Each transaction should maintain accurate balance audit trail."""
        # Perform multiple operations
        credit_wallet(
            self.user,
            Decimal("100.00"),
            reference_id=f"TEST-{uuid.uuid4().hex[:8]}",
            description="Credit 1",
            transaction_type="deposit",
        )
        credit_wallet(
            self.user,
            Decimal("200.00"),
            reference_id=f"TEST-{uuid.uuid4().hex[:8]}",
            description="Credit 2",
            transaction_type="deposit",
        )
        debit_wallet(
            self.user,
            Decimal("150.00"),
            reference_id=f"TEST-{uuid.uuid4().hex[:8]}",
            description="Debit 1",
            transaction_type="withdrawal",
        )

        # Verify audit trail
        transactions = WalletTransaction.objects.filter(
            user=self.user
        ).order_by("created_at")

        prev_balance = Decimal("1000.00")  # Initial balance
        for txn in transactions:
            self.assertEqual(txn.balance_before, prev_balance)
            prev_balance = txn.balance_after

        # Final balance should match user's wallet_balance
        self.user.refresh_from_db()
        self.assertEqual(self.user.wallet_balance, prev_balance)


class WithdrawalRequestTests(TestCase):
    """Test withdrawal request handling."""

    def setUp(self):
        self.user = User.objects.create_user(
            username="withdrawuser",
            email="withdraw@example.com",
            phone_number="254712345679",
            password="testpass123",
            wallet_balance=Decimal("5000.00"),
        )
        self.admin = User.objects.create_superuser(
            username="admin",
            email="admin@example.com",
            phone_number="254712345000",
            password="adminpass123",
        )

    def test_withdrawal_request_deducts_balance_immediately(self):
        """Creating a withdrawal request should deduct balance immediately."""
        initial_balance = self.user.wallet_balance
        amount = Decimal("1000.00")

        with patch('apps.payments.intasend.format_phone', return_value='254712345679'):
            withdrawal = request_withdrawal(
                self.user,
                {"method": "mpesa", "amount": amount, "phone_number": "254712345679"}
            )

        self.user.refresh_from_db()
        self.assertEqual(self.user.wallet_balance, initial_balance - amount)
        self.assertEqual(withdrawal.status, "pending_review")

    def test_cannot_create_multiple_active_withdrawals(self):
        """User cannot have multiple active withdrawal requests."""
        amount = Decimal("500.00")

        with patch('apps.payments.intasend.format_phone', return_value='254712345679'):
            # First withdrawal - should succeed
            request_withdrawal(
                self.user,
                {"method": "mpesa", "amount": amount, "phone_number": "254712345679"}
            )

            # Second withdrawal - should fail
            with self.assertRaises(PaymentsServiceError) as ctx:
                request_withdrawal(
                    self.user,
                    {"method": "mpesa", "amount": amount, "phone_number": "254712345679"}
                )

        self.assertIn("already have an active withdrawal", str(ctx.exception))

    def test_rejection_refunds_balance(self):
        """Rejecting a withdrawal should refund the balance."""
        amount = Decimal("1000.00")
        initial_balance = self.user.wallet_balance

        with patch('apps.payments.intasend.format_phone', return_value='254712345679'):
            withdrawal = request_withdrawal(
                self.user,
                {"method": "mpesa", "amount": amount, "phone_number": "254712345679"}
            )

        self.user.refresh_from_db()
        self.assertEqual(self.user.wallet_balance, initial_balance - amount)

        # Reject the withdrawal
        reject_withdrawal_request(
            withdrawal,
            reason="Test rejection",
            reviewer=self.admin
        )

        self.user.refresh_from_db()
        self.assertEqual(self.user.wallet_balance, initial_balance)
        withdrawal.refresh_from_db()
        self.assertEqual(withdrawal.status, "rejected")

    def test_cannot_reject_non_pending_withdrawal(self):
        """Cannot reject a withdrawal that's not in pending_review status."""
        amount = Decimal("500.00")

        with patch('apps.payments.intasend.format_phone', return_value='254712345679'):
            withdrawal = request_withdrawal(
                self.user,
                {"method": "mpesa", "amount": amount, "phone_number": "254712345679"}
            )

        # Manually change status
        withdrawal.status = "processing"
        withdrawal.save()

        with self.assertRaises(PaymentsServiceError):
            reject_withdrawal_request(
                withdrawal,
                reason="Test rejection",
                reviewer=self.admin
            )


class DepositCallbackIdempotencyTests(TestCase):
    """Test deposit callback idempotency."""

    def setUp(self):
        self.user = User.objects.create_user(
            username="deposituser",
            email="deposit@example.com",
            phone_number="254712345680",
            password="testpass123",
            wallet_balance=Decimal("0.00"),
        )
        self.order_id = f"DEP-{uuid.uuid4().hex[:20].upper()}"
        self.payment_txn = PaymentTransaction.objects.create(
            user=self.user,
            type="deposit",
            status="pending",
            amount_kes=Decimal("1000.00"),
            order_id=self.order_id,
            tracking_reference=f"TRK-{uuid.uuid4().hex[:16]}",
            phone_number="254712345680",
            narration="Test deposit",
        )

    def test_successful_callback_credits_wallet(self):
        """Successful callback should credit wallet once."""
        payload = {
            "invoice": {
                "api_ref": self.order_id,
                "state": "COMPLETE",
                "mpesa_reference": "MPR123456",
            }
        }

        process_deposit_callback(payload)

        self.user.refresh_from_db()
        self.assertEqual(self.user.wallet_balance, Decimal("1000.00"))
        self.payment_txn.refresh_from_db()
        self.assertEqual(self.payment_txn.status, "completed")

        # Verify wallet transaction created
        wallet_txn = WalletTransaction.objects.filter(
            user=self.user, type="deposit"
        ).first()
        self.assertIsNotNone(wallet_txn)
        self.assertEqual(wallet_txn.amount, Decimal("1000.00"))

    def test_duplicate_callback_does_not_double_credit(self):
        """Duplicate callback should not credit wallet twice."""
        payload = {
            "invoice": {
                "api_ref": self.order_id,
                "state": "COMPLETE",
                "mpesa_reference": "MPR123456",
            }
        }

        # First callback
        process_deposit_callback(payload)
        self.user.refresh_from_db()
        balance_after_first = self.user.wallet_balance

        # Duplicate callback
        process_deposit_callback(payload)
        self.user.refresh_from_db()
        balance_after_second = self.user.wallet_balance

        # Balance should be the same
        self.assertEqual(balance_after_first, balance_after_second)
        self.assertEqual(balance_after_first, Decimal("1000.00"))

        # Should have only one wallet transaction
        wallet_txns = WalletTransaction.objects.filter(
            user=self.user, type="deposit"
        )
        self.assertEqual(wallet_txns.count(), 1)

    def test_callback_after_failure_still_idempotent(self):
        """Callback after a failed transaction should not process."""
        # Mark transaction as failed
        self.payment_txn.status = "failed"
        self.payment_txn.save()

        payload = {
            "invoice": {
                "api_ref": self.order_id,
                "state": "COMPLETE",
                "mpesa_reference": "MPR123456",
            }
        }

        process_deposit_callback(payload)

        # Balance should remain unchanged
        self.user.refresh_from_db()
        self.assertEqual(self.user.wallet_balance, Decimal("0.00"))

    def test_failed_callback_does_not_credit(self):
        """Failed callback should not credit wallet."""
        payload = {
            "invoice": {
                "api_ref": self.order_id,
                "state": "FAILED",
                "failed_reason": "User cancelled",
            }
        }

        process_deposit_callback(payload)

        self.user.refresh_from_db()
        self.assertEqual(self.user.wallet_balance, Decimal("0.00"))
        self.payment_txn.refresh_from_db()
        self.assertEqual(self.payment_txn.status, "failed")


class ConcurrencyTests(TransactionTestCase):
    """Test behavior under concurrent operations.

    NOTE: These tests may fail with SQLite due to its limited
    concurrency support. They are designed for PostgreSQL.
    """

    def setUp(self):
        self.user = User.objects.create_user(
            username="concurrentuser",
            email="concurrent@example.com",
            phone_number="254712345681",
            password="testpass123",
            wallet_balance=Decimal("1000.00"),
        )
        # Check if we're using SQLite
        from django.conf import settings
        self.is_sqlite = 'sqlite' in settings.DATABASES['default']['ENGINE']

    def test_concurrent_debits_do_not_overdraw(self):
        """Multiple concurrent debits should not overdraw the account."""
        if self.is_sqlite:
            self.skipTest("SQLite doesn't support concurrent writes properly")

        # Try to debit 600 five times (3000 total, but only 1000 available)
        amount = Decimal("600.00")
        results = []

        def attempt_debit():
            try:
                user = User.objects.get(id=self.user.id)
                debit_wallet(
                    user,
                    amount,
                    reference_id=f"TEST-{uuid.uuid4().hex[:8]}",
                    description="Concurrent debit",
                    transaction_type="withdrawal",
                )
                return "success"
            except PaymentsServiceError:
                return "failed"
            except Exception as e:
                return f"error: {e}"

        # Run concurrent operations
        with ThreadPoolExecutor(max_workers=5) as executor:
            futures = [executor.submit(attempt_debit) for _ in range(5)]
            for future in as_completed(futures):
                results.append(future.result())

        # Count successes - should be at most 1 (600 <= 1000)
        successes = results.count("success")
        self.assertLessEqual(successes, 1)

        # Final balance should be non-negative
        self.user.refresh_from_db()
        self.assertGreaterEqual(self.user.wallet_balance, Decimal("0.00"))

    def test_concurrent_credits_all_succeed(self):
        """Multiple concurrent credits should all succeed."""
        if self.is_sqlite:
            self.skipTest("SQLite doesn't support concurrent writes properly")

        amount = Decimal("100.00")
        initial_balance = self.user.wallet_balance
        num_credits = 5
        results = []

        def attempt_credit():
            try:
                user = User.objects.get(id=self.user.id)
                credit_wallet(
                    user,
                    amount,
                    reference_id=f"TEST-{uuid.uuid4().hex[:8]}",
                    description="Concurrent credit",
                    transaction_type="deposit",
                )
                return "success"
            except Exception as e:
                return f"error: {e}"

        # Run concurrent operations
        with ThreadPoolExecutor(max_workers=num_credits) as executor:
            futures = [executor.submit(attempt_credit) for _ in range(num_credits)]
            for future in as_completed(futures):
                results.append(future.result())

        # All should succeed
        successes = results.count("success")
        self.assertEqual(successes, num_credits)

        # Final balance should reflect all credits
        self.user.refresh_from_db()
        expected_balance = initial_balance + (amount * num_credits)
        self.assertEqual(self.user.wallet_balance, expected_balance)


class DuplicateTransactionTests(TestCase):
    """Test prevention of duplicate transactions."""

    def setUp(self):
        self.user = User.objects.create_user(
            username="duplicateuser",
            email="duplicate@example.com",
            phone_number="254712345682",
            password="testpass123",
            wallet_balance=Decimal("1000.00"),
        )

    def test_duplicate_reference_id_fails(self):
        """Transactions with duplicate reference_id should fail."""
        reference_id = f"TEST-{uuid.uuid4().hex[:8]}"

        # First transaction
        credit_wallet(
            self.user,
            Decimal("100.00"),
            reference_id=reference_id,
            description="First credit",
            transaction_type="deposit",
        )

        # Duplicate should fail due to unique constraint
        from django.db import IntegrityError
        with self.assertRaises(IntegrityError):
            credit_wallet(
                self.user,
                Decimal("100.00"),
                reference_id=reference_id,
                description="Duplicate credit",
                transaction_type="deposit",
            )


class LockedBalanceTests(TestCase):
    """Test locked balance handling."""

    def setUp(self):
        self.user = User.objects.create_user(
            username="lockeduser",
            email="locked@example.com",
            phone_number="254712345683",
            password="testpass123",
            wallet_balance=Decimal("1000.00"),
            locked_balance=Decimal("0.00"),
        )

    def _commit_to_challenges(self, amount):
        """Mirror what create/join do: debit the wallet and track the entry as locked."""
        self.user.wallet_balance -= amount
        self.user.locked_balance += amount
        self.user.save()
        self.user.refresh_from_db()

    def test_available_balance_calculation(self):
        """Entries are debited from wallet_balance, so available == wallet_balance (no double count)."""
        self._commit_to_challenges(Decimal("300.00"))

        self.assertEqual(self.user.wallet_balance, Decimal("700.00"))
        self.assertEqual(self.user.locked_balance, Decimal("300.00"))
        self.assertEqual(self.user.available_balance, Decimal("700.00"))  # 1000 - 300 entry, counted once

    def test_withdrawal_respects_locked_balance(self):
        """Withdrawal request should respect available balance, not total balance."""
        from unittest.mock import patch

        self._commit_to_challenges(Decimal("800.00"))

        # Try to withdraw 500, but only 200 available (1000 - 800 in challenges)
        with patch('apps.payments.intasend.format_phone', return_value='254712345683'):
            with self.assertRaises(PaymentsServiceError) as ctx:
                request_withdrawal(
                    self.user,
                    {"method": "mpesa", "amount": Decimal("500.00"), "phone_number": "254712345683"}
                )

        self.assertIn("Insufficient available balance", str(ctx.exception))
        # Balance should remain unchanged
        self.user.refresh_from_db()
        self.assertEqual(self.user.wallet_balance, Decimal("200.00"))

    def test_withdrawal_allowed_within_available_balance(self):
        """Withdrawal within available balance should succeed."""
        from unittest.mock import patch

        self._commit_to_challenges(Decimal("800.00"))

        # Withdraw 100, which is within available balance (200)
        with patch('apps.payments.intasend.format_phone', return_value='254712345683'):
            withdrawal = request_withdrawal(
                self.user,
                {"method": "mpesa", "amount": Decimal("100.00"), "phone_number": "254712345683"}
            )

        self.assertEqual(withdrawal.status, "pending_review")
        self.user.refresh_from_db()
        self.assertEqual(self.user.wallet_balance, Decimal("100.00"))  # 200 available - 100
