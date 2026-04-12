from decimal import Decimal
from datetime import timedelta
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.test import override_settings
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APITestCase

from apps.payments.models import PaymentTransaction, WithdrawalRequest
from apps.payments.tasks import reconcile_pending_payments
from apps.wallet.models import Withdrawal, WalletTransaction


User = get_user_model()


@override_settings(POCHIPAY_WEBHOOK_SECRET='')
class PaymentsE2ETests(APITestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            username='payer_user',
            email='payer@example.com',
            password='TestPass123!',
            wallet_balance=Decimal('1000.00'),
            phone_number='254712345678',
        )
        self.admin = User.objects.create_user(
            username='admin_user',
            email='admin@example.com',
            password='AdminPass123!',
            is_staff=True,
        )

    @patch('apps.payments.views.pochipay.initiate_mpesa_collection')
    def test_deposit_end_to_end_callback_credits_wallet_once(self, mock_initiate):
        mock_initiate.return_value = {'collectionId': 'COL-123', 'isProcessing': True}

        self.client.force_authenticate(user=self.user)
        start_balance = self.user.wallet_balance

        init_response = self.client.post(
            '/api/payments/deposit/',
            {'amount': '100.00', 'phone_number': '0712345678'},
            format='json',
        )
        self.assertEqual(init_response.status_code, status.HTTP_200_OK)

        order_id = init_response.data['order_id']
        txn = PaymentTransaction.objects.get(order_id=order_id)
        self.assertEqual(txn.status, 'pending')

        callback_payload = {
            'orderId': order_id,
            'isSuccessful': True,
            'thirdPartyReference': 'MPESA-REF-123',
            'failReason': '',
        }

        callback_response = self.client.post(
            '/api/payments/mpesa/deposit-callback/',
            callback_payload,
            format='json',
        )
        self.assertEqual(callback_response.status_code, status.HTTP_200_OK)

        self.user.refresh_from_db()
        txn.refresh_from_db()
        self.assertEqual(self.user.wallet_balance, start_balance + Decimal('100.00'))
        self.assertEqual(txn.status, 'completed')
        self.assertTrue(
            WalletTransaction.objects.filter(
                user=self.user,
                type='deposit',
                reference_id=order_id,
                amount=Decimal('100.00'),
            ).exists()
        )

        duplicate_callback = self.client.post(
            '/api/payments/mpesa/deposit-callback/',
            callback_payload,
            format='json',
        )
        self.assertEqual(duplicate_callback.status_code, status.HTTP_200_OK)

        self.user.refresh_from_db()
        self.assertEqual(self.user.wallet_balance, start_balance + Decimal('100.00'))

    @patch('apps.admin_api.views.pochipay.send_withdrawal_to_mobile')
    def test_withdrawal_end_to_end_success(self, mock_send_withdrawal):
        mock_send_withdrawal.return_value = {'result': {'isProcessing': True}}

        self.client.force_authenticate(user=self.user)
        start_balance = self.user.wallet_balance

        request_response = self.client.post(
            '/api/payments/withdrawal/request/',
            {
                'method': 'mpesa',
                'amount': '200.00',
                'phone_number': '0712345678',
            },
            format='json',
        )
        self.assertEqual(request_response.status_code, status.HTTP_201_CREATED)

        withdrawal_id = request_response.data['withdrawal_id']
        self.user.refresh_from_db()
        self.assertEqual(self.user.wallet_balance, start_balance - Decimal('200.00'))

        self.client.force_authenticate(user=self.admin)
        approve_response = self.client.post(
            f'/api/admin/withdrawals/{withdrawal_id}/approve/',
            {},
            format='json',
        )
        self.assertEqual(approve_response.status_code, status.HTTP_200_OK)

        withdrawal = WithdrawalRequest.objects.get(id=withdrawal_id)
        self.assertEqual(withdrawal.status, 'processing')

        callback_response = self.client.post(
            '/api/payments/mpesa/withdrawal-callback/',
            {
                'trackingReference': withdrawal.tracking_reference,
                'successful': True,
                'thirdPartyReference': 'WD-MPESA-REF-001',
                'failReason': '',
            },
            format='json',
        )
        self.assertEqual(callback_response.status_code, status.HTTP_200_OK)

        self.user.refresh_from_db()
        withdrawal.refresh_from_db()
        self.assertEqual(withdrawal.status, 'completed')
        self.assertEqual(self.user.wallet_balance, start_balance - Decimal('200.00'))

    @patch('apps.admin_api.views.pochipay.send_withdrawal_to_mobile')
    def test_withdrawal_end_to_end_failure_refunds_wallet(self, mock_send_withdrawal):
        mock_send_withdrawal.return_value = {'result': {'isProcessing': True}}

        self.client.force_authenticate(user=self.user)
        start_balance = self.user.wallet_balance

        request_response = self.client.post(
            '/api/payments/withdrawal/request/',
            {
                'method': 'mpesa',
                'amount': '150.00',
                'phone_number': '0712345678',
            },
            format='json',
        )
        self.assertEqual(request_response.status_code, status.HTTP_201_CREATED)

        withdrawal_id = request_response.data['withdrawal_id']

        self.client.force_authenticate(user=self.admin)
        approve_response = self.client.post(
            f'/api/admin/withdrawals/{withdrawal_id}/approve/',
            {},
            format='json',
        )
        self.assertEqual(approve_response.status_code, status.HTTP_200_OK)

        withdrawal = WithdrawalRequest.objects.get(id=withdrawal_id)
        callback_response = self.client.post(
            '/api/payments/mpesa/withdrawal-callback/',
            {
                'trackingReference': withdrawal.tracking_reference,
                'successful': False,
                'thirdPartyReference': '',
                'failReason': 'Insufficient float',
            },
            format='json',
        )
        self.assertEqual(callback_response.status_code, status.HTTP_200_OK)

        self.user.refresh_from_db()
        withdrawal.refresh_from_db()
        self.assertEqual(withdrawal.status, 'failed')
        self.assertEqual(self.user.wallet_balance, start_balance)

    def test_admin_reject_withdrawal_refunds_wallet(self):
        self.client.force_authenticate(user=self.user)
        start_balance = self.user.wallet_balance

        request_response = self.client.post(
            '/api/payments/withdrawal/request/',
            {
                'method': 'mpesa',
                'amount': '120.00',
                'phone_number': '0712345678',
            },
            format='json',
        )
        self.assertEqual(request_response.status_code, status.HTTP_201_CREATED)
        withdrawal_id = request_response.data['withdrawal_id']

        self.client.force_authenticate(user=self.admin)
        reject_response = self.client.post(
            f'/api/admin/withdrawals/{withdrawal_id}/reject/',
            {'reason': 'Compliance check failed'},
            format='json',
        )
        self.assertEqual(reject_response.status_code, status.HTTP_200_OK)

        self.user.refresh_from_db()
        withdrawal = WithdrawalRequest.objects.get(id=withdrawal_id)
        self.assertEqual(withdrawal.status, 'rejected')
        self.assertEqual(self.user.wallet_balance, start_balance)

    @patch('apps.payments.pochipay.get_disbursement_status')
    def test_reconcile_failed_payout_refunds_wallet_when_callback_missed(self, mock_disbursement_status):
        mock_disbursement_status.return_value = {
            'result': {
                'status': 'Failed',
                'message': 'Provider timeout',
            }
        }

        self.user.wallet_balance = Decimal('800.00')
        self.user.save(update_fields=['wallet_balance', 'updated_at'])

        legacy_withdrawal = Withdrawal.objects.create(
            user=self.user,
            amount=Decimal('200.00'),
            account_details='254712345678',
            status='processing',
        )

        payout_txn = PaymentTransaction.objects.create(
            user=self.user,
            type='payout',
            status='pending',
            amount_kes=Decimal('200.00'),
            order_id=str(legacy_withdrawal.reference_number),
            tracking_reference='WDR-RECON-TEST-001',
            request_id='REQ-RECON-001',
            phone_number='254712345678',
            narration='Reconcile fallback test',
        )

        stale_time = timezone.now() - timedelta(minutes=20)
        PaymentTransaction.objects.filter(id=payout_txn.id).update(created_at=stale_time)

        reconcile_pending_payments()

        self.user.refresh_from_db()
        payout_txn.refresh_from_db()
        legacy_withdrawal.refresh_from_db()

        self.assertEqual(self.user.wallet_balance, Decimal('1000.00'))
        self.assertEqual(payout_txn.status, 'failed')
        self.assertEqual(legacy_withdrawal.status, 'failed')
