"""
Tests for the payment deposit callback endpoint (apps.payments.views.webhooks).

Covers: successful credit, failed deposit, duplicate callback idempotency,
missing orderId, and unknown orderId scenarios.
"""
import json
from decimal import Decimal
from unittest.mock import patch

from django.test import TestCase
from django.urls import reverse

from apps.payments.models import CallbackLog, PaymentTransaction
from apps.users.models import User
from apps.wallet.models import WalletTransaction


def _make_user(username='testpayer', balance=Decimal('500')):
    u = User.objects.create_user(username=username, password='pass')
    u.wallet_balance = balance
    u.save()
    return u


def _make_pending_txn(user, order_id='DEP-TEST001', amount=Decimal('200')):
    return PaymentTransaction.objects.create(
        user               = user,
        type               = 'deposit',
        status             = 'pending',
        amount_kes         = amount,
        order_id           = order_id,
        tracking_reference = 'TRK-TEST001',
        phone_number       = '+254700000000',
        narration          = 'Test deposit',
    )


class DepositCallbackSuccessTest(TestCase):
    """A successful deposit credits the user's wallet and marks txn completed."""

    def setUp(self):
        self.user = _make_user(balance=Decimal('0'))
        self.txn  = _make_pending_txn(self.user)
        self.url  = reverse('deposit_callback')

    def _post(self, payload):
        return self.client.post(
            self.url,
            data=json.dumps(payload),
            content_type='application/json',
        )

    def test_successful_deposit_credits_wallet(self):
        payload = {
            'orderId':            self.txn.order_id,
            'isSuccessful':       True,
            'thirdPartyReference': 'MPESA12345',
            'failReason':         '',
        }
        resp = self._post(payload)
        self.assertEqual(resp.status_code, 200)

        self.user.refresh_from_db()
        self.assertEqual(self.user.wallet_balance, Decimal('200'))

    def test_transaction_marked_completed(self):
        payload = {
            'orderId':            self.txn.order_id,
            'isSuccessful':       True,
            'thirdPartyReference': 'MPESA12345',
        }
        self._post(payload)

        self.txn.refresh_from_db()
        self.assertEqual(self.txn.status, 'completed')
        self.assertEqual(self.txn.mpesa_reference, 'MPESA12345')

    def test_wallet_transaction_record_created(self):
        payload = {
            'orderId':            self.txn.order_id,
            'isSuccessful':       True,
            'thirdPartyReference': 'MPESA12345',
        }
        self._post(payload)

        txns = WalletTransaction.objects.filter(user=self.user, type='deposit')
        self.assertEqual(txns.count(), 1)
        self.assertEqual(txns.first().amount, Decimal('200'))

    def test_callback_log_marked_processed(self):
        payload = {
            'orderId':    self.txn.order_id,
            'isSuccessful': True,
            'thirdPartyReference': 'MPESA12345',
        }
        self._post(payload)

        log = CallbackLog.objects.filter(order_id=self.txn.order_id).first()
        self.assertIsNotNone(log)
        self.assertTrue(log.processed)


class DepositCallbackFailureTest(TestCase):
    """A failed deposit marks the transaction failed and does NOT credit wallet."""

    def setUp(self):
        self.user = _make_user(balance=Decimal('0'))
        self.txn  = _make_pending_txn(self.user)
        self.url  = reverse('deposit_callback')

    def test_failed_deposit_does_not_credit_wallet(self):
        payload = {
            'orderId':      self.txn.order_id,
            'isSuccessful': False,
            'failReason':   'User cancelled',
        }
        self.client.post(
            self.url,
            data=json.dumps(payload),
            content_type='application/json',
        )
        self.user.refresh_from_db()
        self.assertEqual(self.user.wallet_balance, Decimal('0'))

    def test_transaction_marked_failed_with_reason(self):
        payload = {
            'orderId':      self.txn.order_id,
            'isSuccessful': False,
            'failReason':   'Insufficient M-Pesa balance',
        }
        self.client.post(
            self.url,
            data=json.dumps(payload),
            content_type='application/json',
        )
        self.txn.refresh_from_db()
        self.assertEqual(self.txn.status, 'failed')
        self.assertIn('Insufficient', self.txn.fail_reason)

    def test_cancelled_when_no_fail_reason(self):
        payload = {
            'orderId':      self.txn.order_id,
            'isSuccessful': False,
            'failReason':   '',
        }
        self.client.post(
            self.url,
            data=json.dumps(payload),
            content_type='application/json',
        )
        self.txn.refresh_from_db()
        self.assertEqual(self.txn.status, 'cancelled')


class DepositCallbackIdempotencyTest(TestCase):
    """Duplicate callbacks must not double-credit the wallet."""

    def setUp(self):
        self.user = _make_user(balance=Decimal('0'))
        self.txn  = _make_pending_txn(self.user)
        self.url  = reverse('deposit_callback')
        self.payload = {
            'orderId':            self.txn.order_id,
            'isSuccessful':       True,
            'thirdPartyReference': 'MPESA-IDEM',
        }

    def test_second_callback_ignored(self):
        for _ in range(3):
            self.client.post(
                self.url,
                data=json.dumps(self.payload),
                content_type='application/json',
            )

        self.user.refresh_from_db()
        # Wallet credited only once
        self.assertEqual(self.user.wallet_balance, Decimal('200'))
        # Only one WalletTransaction record
        self.assertEqual(
            WalletTransaction.objects.filter(user=self.user, type='deposit').count(),
            1,
        )


class DepositCallbackEdgeCasesTest(TestCase):

    def setUp(self):
        self.url = reverse('deposit_callback')

    def test_missing_order_id_returns_200(self):
        resp = self.client.post(
            self.url,
            data=json.dumps({'isSuccessful': True}),
            content_type='application/json',
        )
        self.assertEqual(resp.status_code, 200)

    def test_unknown_order_id_returns_200(self):
        resp = self.client.post(
            self.url,
            data=json.dumps({'orderId': 'DEP-UNKNOWN999', 'isSuccessful': True}),
            content_type='application/json',
        )
        self.assertEqual(resp.status_code, 200)

    def test_invalid_json_returns_400(self):
        resp = self.client.post(
            self.url,
            data='not-json',
            content_type='application/json',
        )
        self.assertEqual(resp.status_code, 400)

    def test_webhook_signature_rejected(self):
        with self.settings(POCHIPAY_WEBHOOK_SECRET='super-secret'):
            resp = self.client.post(
                self.url,
                data=json.dumps({'orderId': 'DEP-SIG-TEST', 'isSuccessful': True}),
                content_type='application/json',
                HTTP_X_POCHIPAY_SIGNATURE='wrong-signature',
            )
        self.assertEqual(resp.status_code, 403)
