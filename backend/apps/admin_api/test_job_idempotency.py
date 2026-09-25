"""Scheduled jobs that touch money or rewards: running them late or twice has one effect."""

import uuid
from datetime import date, datetime, timedelta
from datetime import timezone as dt_timezone
from decimal import Decimal
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.test import TestCase
from django.utils import timezone

from apps.challenges.models import Challenge, Participant
from apps.payments.models import CallbackLog, PaymentTransaction, WithdrawalRequest
from apps.payments.tasks import (_reconcile_payout, process_unprocessed_callbacks,
                                 reconcile_pending_payments)
from apps.steps.models import FraudFlag, HealthRecord
from apps.steps.tasks import (finalize_completed_challenges, nightly_fraud_scan,
                              update_user_streak_records)
from apps.users.models import UserXP
from apps.users.tasks import check_wallet_balance_consistency
from apps.wallet.models import WalletTransaction

User = get_user_model()
_n = iter(range(100, 999))


def make_user(**kw):
    i = next(_n)
    return User.objects.create_user(
        username=f"u{i}", email=f"u{i}@example.com", phone_number=f"254712350{i}", password="pw12345678x", **kw
    )


class FinalizeTwiceTests(TestCase):
    def test_finalize_job_twice_pays_once(self):
        a = make_user(wallet_balance=Decimal("400.00"), locked_balance=Decimal("100.00"))
        b = make_user(wallet_balance=Decimal("400.00"), locked_balance=Decimal("100.00"))
        c = Challenge.objects.create(
            creator=a, name="Done", entry_fee=Decimal("100.00"), milestone=10000,
            start_date=date.today() - timedelta(days=7), end_date=date.today() - timedelta(days=1),
            status="active", total_pool=Decimal("200.00"),
        )
        Participant.objects.create(challenge=c, user=a, steps=15000)
        Participant.objects.create(challenge=c, user=b, steps=12000)

        finalize_completed_challenges()
        a.refresh_from_db(); b.refresh_from_db()
        after_first = (a.wallet_balance, b.wallet_balance, WalletTransaction.objects.count())
        finalize_completed_challenges()  # late / duplicate run
        a.refresh_from_db(); b.refresh_from_db()
        self.assertEqual((a.wallet_balance, b.wallet_balance, WalletTransaction.objects.count()), after_first)
        c.refresh_from_db()
        self.assertEqual(c.status, "completed")
        self.assertEqual(c.revenue_records.count(), 1)


class PaymentReconciliationTwiceTests(TestCase):
    def setUp(self):
        self.user = make_user(wallet_balance=Decimal("0.00"))

    def _old(self, obj):
        type(obj).objects.filter(pk=obj.pk).update(
            created_at=timezone.now() - timedelta(hours=1), updated_at=timezone.now() - timedelta(hours=1)
        )

    def test_failed_payout_reconciled_twice_refunds_once(self):
        """A stale copy of a pending payout (e.g. the callback settled it meanwhile) must not refund again."""
        w = WithdrawalRequest.objects.create(user=self.user, amount_kes=Decimal("500.00"), method="mpesa", status="processing", tracking_reference="TRK-W1")
        txn = PaymentTransaction.objects.create(
            user=self.user, type="payout", status="pending", amount_kes=Decimal("500.00"),
            order_id=str(w.id), tracking_reference="TRK-P1",
        )
        stale = PaymentTransaction.objects.get(pk=txn.pk)
        failed = {"status": "FAILED", "transactions": [{"failed_reason": "bad number"}]}
        _reconcile_payout(txn, failed)
        _reconcile_payout(stale, failed)  # still says "pending" in memory
        self.user.refresh_from_db()
        self.assertEqual(self.user.wallet_balance, Decimal("500.00"))
        self.assertEqual(WalletTransaction.objects.filter(user=self.user, type="refund").count(), 1)
        w.refresh_from_db()
        self.assertEqual(w.status, "failed")

    def test_pending_deposit_reconciled_twice_credits_once(self):
        txn = PaymentTransaction.objects.create(
            user=self.user, type="deposit", status="pending", amount_kes=Decimal("250.00"),
            order_id=f"DEP-{uuid.uuid4().hex[:8]}", tracking_reference=f"T-{uuid.uuid4().hex[:8]}", collection_id="INV-1",
        )
        self._old(txn)
        with patch("apps.payments.intasend.query_collection", return_value={"state": "COMPLETE", "mpesa_reference": "QX1"}):
            reconcile_pending_payments()
            reconcile_pending_payments()
        self.user.refresh_from_db()
        self.assertEqual(self.user.wallet_balance, Decimal("250.00"))
        self.assertEqual(WalletTransaction.objects.filter(user=self.user, type="deposit").count(), 1)

    def test_failed_withdrawal_reconciled_twice_refunds_once_and_never_flips_to_completed(self):
        w = WithdrawalRequest.objects.create(user=self.user, amount_kes=Decimal("300.00"), method="mpesa", status="processing", tracking_reference="TRK-W2")
        self._old(w)
        with patch("apps.payments.intasend.get_disbursement_status", return_value={"status": "FAILED", "transactions": []}):
            reconcile_pending_payments()
            reconcile_pending_payments()
        self.user.refresh_from_db()
        self.assertEqual(self.user.wallet_balance, Decimal("300.00"))
        self.assertEqual(WalletTransaction.objects.filter(user=self.user, type="refund").count(), 1)

    def test_withdrawal_settled_by_callback_during_query_is_not_overwritten(self):
        w = WithdrawalRequest.objects.create(user=self.user, amount_kes=Decimal("300.00"), method="mpesa", status="processing", tracking_reference="TRK-W4")
        self._old(w)

        def gateway(_ref):
            # The failure callback lands (and refunds) while we wait on the gateway.
            WithdrawalRequest.objects.filter(pk=w.pk).update(status="failed")
            return {"status": "COMPLETE", "transactions": [{"mpesa_reference": "LATE"}]}

        with patch("apps.payments.intasend.get_disbursement_status", side_effect=gateway):
            reconcile_pending_payments()
        w.refresh_from_db()
        self.assertEqual(w.status, "failed")

    def test_unprocessed_deposit_callback_processed_twice_credits_once(self):
        txn = PaymentTransaction.objects.create(
            user=self.user, type="deposit", status="pending", amount_kes=Decimal("150.00"),
            order_id="DEP-CB1", tracking_reference="T-CB1",
        )
        payload = {"invoice": {"api_ref": "DEP-CB1", "state": "COMPLETE", "mpesa_reference": "QCB1"}}
        from apps.payments.services import log_callback

        log = log_callback("deposit", payload, "DEP-CB1")
        CallbackLog.objects.filter(pk=log.pk).update(created_at=timezone.now() - timedelta(minutes=10))
        process_unprocessed_callbacks()
        CallbackLog.objects.filter(pk=log.pk).update(processed=False)  # pretend a crash lost the flag
        process_unprocessed_callbacks()
        self.user.refresh_from_db()
        self.assertEqual(self.user.wallet_balance, Decimal("150.00"))
        self.assertEqual(WalletTransaction.objects.filter(user=self.user, type="deposit").count(), 1)
        txn.refresh_from_db()
        self.assertEqual(txn.status, "completed")

    def test_unprocessed_withdrawal_callback_is_processed_once(self):
        w = WithdrawalRequest.objects.create(user=self.user, amount_kes=Decimal("200.00"), method="mpesa", status="processing", tracking_reference="TRK-W3")
        payload = {"tracking_id": "TRK-W3", "status": "FAILED", "transactions": [{"failed_reason": "x"}]}
        from apps.payments.services import log_callback

        log = log_callback("withdrawal", payload, "TRK-W3")
        CallbackLog.objects.filter(pk=log.pk).update(created_at=timezone.now() - timedelta(minutes=10))
        process_unprocessed_callbacks()
        process_unprocessed_callbacks()
        self.user.refresh_from_db()
        self.assertEqual(self.user.wallet_balance, Decimal("200.00"))
        self.assertEqual(WalletTransaction.objects.filter(user=self.user, type="refund").count(), 1)
        w.refresh_from_db()
        self.assertEqual(w.status, "failed")
        self.assertTrue(CallbackLog.objects.get(pk=log.pk).processed)


class WalletConsistencyTwiceTests(TestCase):
    def test_orphaned_lock_released_once(self):
        u = make_user(wallet_balance=Decimal("100.00"), locked_balance=Decimal("50.00"))
        first = check_wallet_balance_consistency()
        second = check_wallet_balance_consistency()
        u.refresh_from_db()
        self.assertEqual((u.wallet_balance, u.locked_balance), (Decimal("150.00"), Decimal("0.00")))
        self.assertEqual((first["fixes_applied"], second["fixes_applied"]), (1, 0))

    def test_lock_with_open_challenge_is_kept(self):
        u = make_user(wallet_balance=Decimal("100.00"), locked_balance=Decimal("50.00"))
        c = Challenge.objects.create(
            creator=u, name="Open", entry_fee=Decimal("50.00"), milestone=10000,
            start_date=date.today(), end_date=date.today() + timedelta(days=6), status="active", total_pool=Decimal("50.00"),
        )
        Participant.objects.create(challenge=c, user=u)
        check_wallet_balance_consistency()
        u.refresh_from_db()
        self.assertEqual((u.wallet_balance, u.locked_balance), (Decimal("100.00"), Decimal("50.00")))


class RewardsTwiceTests(TestCase):
    def test_weekly_xp_reset_once_per_week_and_catches_up(self):
        from apps.gamification.tasks import reset_weekly_xp

        u = make_user()
        xp = UserXP.objects.get(user=u)
        last_week = timezone.now() - timedelta(days=8)
        UserXP.objects.filter(pk=xp.pk).update(xp_this_week=120, weekly_reset=last_week)
        # Missed Monday: runs mid-week and still resets.
        wednesday = datetime(2026, 9, 23, 10, 0, tzinfo=dt_timezone.utc)
        UserXP.objects.filter(pk=xp.pk).update(weekly_reset=wednesday - timedelta(days=8))
        with patch("django.utils.timezone.now", return_value=wednesday):
            reset_weekly_xp()
            xp.refresh_from_db()
            self.assertEqual(xp.xp_this_week, 0)
            UserXP.objects.filter(pk=xp.pk).update(xp_this_week=30)  # earned after the reset
            reset_weekly_xp()  # duplicate run in the same week
        xp.refresh_from_db()
        self.assertEqual(xp.xp_this_week, 30)

    def test_streak_job_keeps_yesterdays_streak_after_midnight(self):
        u = make_user()
        today = timezone.now().date()
        for i in range(1, 4):  # yesterday and the two days before
            HealthRecord.objects.create(user=u, date=today - timedelta(days=i), steps=5000)
        User.objects.filter(pk=u.pk).update(current_streak=3, best_streak=2)
        update_user_streak_records()
        update_user_streak_records()
        u.refresh_from_db()
        self.assertEqual((u.current_streak, u.best_streak), (3, 3))

    def test_fraud_scan_twice_flags_once(self):
        u = make_user()
        today = timezone.now().date()
        for i in range(1, 8):
            HealthRecord.objects.create(user=u, date=today - timedelta(days=i), steps=65_000)
        nightly_fraud_scan()
        nightly_fraud_scan()
        self.assertEqual(FraudFlag.objects.filter(user=u, flag_type="weekly_cap").count(), 1)
