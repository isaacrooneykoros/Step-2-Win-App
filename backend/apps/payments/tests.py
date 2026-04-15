import hashlib
import hmac
import json
from decimal import Decimal

from django.contrib.auth import get_user_model
from django.test import override_settings
from rest_framework import status
from rest_framework.test import APITestCase

from apps.payments.models import PaymentTransaction, WithdrawalRequest
from apps.payments.tasks import _reconcile_payout
from apps.wallet.models import WalletTransaction


User = get_user_model()


@override_settings(INTASEND_WEBHOOK_SECRET='test-secret')
class PaymentWorkflowTests(APITestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            username='pay_user',
            email='pay@example.com',
            password='TestPass123!',
            wallet_balance=Decimal('100.00'),
        )

    def _signed_body(self, payload):
        body = json.dumps(payload)
        signature = hmac.new(
            b'test-secret',
            body.encode('utf-8'),
            hashlib.sha256,
        ).hexdigest()
        return body, signature

    def test_deposit_callback_requires_signature_when_secret_configured(self):
        payload = {
            'invoice': {
                'api_ref': 'DEP-REQ-SIG',
                'state': 'COMPLETE',
                'mpesa_reference': 'MPESA-001',
            }
        }

        response = self.client.generic(
            'POST',
            '/api/payments/mpesa/deposit-callback/',
            data=json.dumps(payload),
            content_type='application/json',
        )

        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)

    def test_deposit_callback_credits_wallet_once_and_ignores_duplicate_retry(self):
        PaymentTransaction.objects.create(
            user=self.user,
            type='deposit',
            status='pending',
            amount_kes=Decimal('50.00'),
            order_id='DEP-001',
            tracking_reference='DEP-TRACK-001',
            collection_id='COLL-001',
            request_id='REQ-001',
            phone_number='254700000001',
            narration='Deposit test',
        )

        payload = {
            'invoice': {
                'api_ref': 'DEP-001',
                'state': 'COMPLETE',
                'mpesa_reference': 'MPESA-DEP-001',
            }
        }
        body, signature = self._signed_body(payload)

        response = self.client.generic(
            'POST',
            '/api/payments/mpesa/deposit-callback/',
            data=body,
            content_type='application/json',
            HTTP_X_INTASEND_SIGNATURE=signature,
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        self.user.refresh_from_db()
        self.assertEqual(self.user.wallet_balance, Decimal('150.00'))
        self.assertEqual(WalletTransaction.objects.filter(user=self.user, type='deposit').count(), 1)

        retry_response = self.client.generic(
            'POST',
            '/api/payments/mpesa/deposit-callback/',
            data=body,
            content_type='application/json',
            HTTP_X_INTASEND_SIGNATURE=signature,
        )
        self.assertEqual(retry_response.status_code, status.HTTP_200_OK)

        self.user.refresh_from_db()
        self.assertEqual(self.user.wallet_balance, Decimal('150.00'))
        self.assertEqual(WalletTransaction.objects.filter(user=self.user, type='deposit').count(), 1)

    def test_withdrawal_callback_failure_refunds_wallet(self):
        withdrawal = WithdrawalRequest.objects.create(
            user=self.user,
            status='processing',
            amount_kes=Decimal('40.00'),
            method='mpesa',
            phone_number='254700000002',
            tracking_reference='WDR-TRACK-001',
            request_id='WDR-TRACK-001',
            narration='Withdrawal test',
        )

        self.user.wallet_balance = Decimal('60.00')
        self.user.save(update_fields=['wallet_balance'])

        payload = {
            'tracking_id': 'WDR-TRACK-001',
            'status': 'FAILED',
            'transactions': [{'failed_reason': 'Insufficient funds'}],
        }
        body, signature = self._signed_body(payload)

        response = self.client.generic(
            'POST',
            '/api/payments/mpesa/withdrawal-callback/',
            data=body,
            content_type='application/json',
            HTTP_X_INTASEND_SIGNATURE=signature,
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)

        withdrawal.refresh_from_db()
        self.user.refresh_from_db()
        self.assertEqual(withdrawal.status, 'failed')
        self.assertEqual(self.user.wallet_balance, Decimal('100.00'))

    def test_payout_callback_failure_refunds_linked_withdrawal(self):
        withdrawal = WithdrawalRequest.objects.create(
            user=self.user,
            status='processing',
            amount_kes=Decimal('35.00'),
            method='mpesa',
            phone_number='254700000003',
            tracking_reference='WDR-TRACK-002',
            request_id='WDR-TRACK-002',
            narration='Payout withdrawal test',
        )
        PaymentTransaction.objects.create(
            user=self.user,
            type='payout',
            status='pending',
            amount_kes=Decimal('35.00'),
            order_id=str(withdrawal.id),
            tracking_reference='PAY-TRACK-001',
            request_id='',
            phone_number='254700000003',
            narration='Payout test',
        )

        self.user.wallet_balance = Decimal('65.00')
        self.user.save(update_fields=['wallet_balance'])

        payload = {
            'tracking_id': 'PAY-TRACK-001',
            'status': 'FAILED',
            'transactions': [{'failed_reason': 'Gateway rejected'}],
        }
        body, signature = self._signed_body(payload)

        response = self.client.generic(
            'POST',
            '/api/payments/mpesa/payout-callback/',
            data=body,
            content_type='application/json',
            HTTP_X_INTASEND_SIGNATURE=signature,
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)

        withdrawal.refresh_from_db()
        self.user.refresh_from_db()
        self.assertEqual(withdrawal.status, 'failed')
        self.assertEqual(self.user.wallet_balance, Decimal('100.00'))
        self.assertEqual(WalletTransaction.objects.filter(user=self.user, type='refund').count(), 1)

    def test_failed_payout_reconciliation_refunds_wallet(self):
        withdrawal = WithdrawalRequest.objects.create(
            user=self.user,
            status='processing',
            amount_kes=Decimal('20.00'),
            method='mpesa',
            phone_number='254700000004',
            tracking_reference='WDR-TRACK-003',
            request_id='WDR-TRACK-003',
            narration='Reconcile withdrawal test',
        )
        txn = PaymentTransaction.objects.create(
            user=self.user,
            type='payout',
            status='pending',
            amount_kes=Decimal('20.00'),
            order_id=str(withdrawal.id),
            tracking_reference='PAY-TRACK-002',
            request_id='',
            phone_number='254700000004',
            narration='Reconcile payout test',
        )

        self.user.wallet_balance = Decimal('80.00')
        self.user.save(update_fields=['wallet_balance'])

        _reconcile_payout(
            txn,
            {
                'status': 'FAILED',
                'transactions': [{'failed_reason': 'Timed out'}],
            },
        )

        withdrawal.refresh_from_db()
        self.user.refresh_from_db()
        txn.refresh_from_db()
        self.assertEqual(txn.status, 'failed')
        self.assertEqual(withdrawal.status, 'failed')
        self.assertEqual(self.user.wallet_balance, Decimal('100.00'))