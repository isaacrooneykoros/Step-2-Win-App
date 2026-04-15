from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import patch

from django.contrib.auth import get_user_model
from rest_framework import status
from rest_framework.test import APITestCase

from apps.payments.models import WithdrawalRequest
from apps.wallet.models import WalletTransaction


User = get_user_model()


class WalletIntegrationTests(APITestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            username='wallet_user',
            email='wallet@example.com',
            password='TestPass123!',
            phone_number='254712345678',
            wallet_balance=Decimal('50.00'),
        )

    @patch('apps.wallet.views.initiate_deposit_service')
    def test_deposit_initiates_payment_without_crediting_wallet(self, mock_initiate_deposit):
        self.client.force_authenticate(user=self.user)
        mock_initiate_deposit.return_value = SimpleNamespace(
            order_id='DEP-TEST-001',
            amount_kes=Decimal('150.00'),
            status='pending',
        )

        response = self.client.post(
            '/api/wallet/deposit/',
            {'amount': '150.00', 'payment_method': 'card'},
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(response.data['order_id'], 'DEP-TEST-001')
        self.assertEqual(response.data['amount_kes'], '150.00')
        self.assertEqual(response.data['status'], 'pending')
        mock_initiate_deposit.assert_called_once_with(self.user, Decimal('150.00'), self.user.phone_number)

        self.user.refresh_from_db()
        self.assertEqual(self.user.wallet_balance, Decimal('50.00'))

        deposit_txn = WalletTransaction.objects.filter(
            user=self.user,
            type='deposit',
            amount=Decimal('150.00'),
        ).first()
        self.assertIsNone(deposit_txn)

    def test_withdraw_updates_balance_and_creates_pending_request(self):
        self.client.force_authenticate(user=self.user)

        response = self.client.post(
            '/api/wallet/withdraw/',
            {
                'method': 'mpesa',
                'amount': '20.00',
                'phone_number': self.user.phone_number,
            },
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(response.data['status'], 'pending_review')
        self.assertEqual(response.data['amount_kes'], '20.00')
        self.assertEqual(response.data['method'], 'mpesa')

        self.user.refresh_from_db()
        self.assertEqual(self.user.wallet_balance, Decimal('30.00'))

        withdrawal = WithdrawalRequest.objects.get(id=response.data['withdrawal_id'])
        self.assertEqual(withdrawal.user, self.user)
        self.assertEqual(withdrawal.amount_kes, Decimal('20.00'))
        self.assertEqual(withdrawal.status, 'pending_review')
        self.assertEqual(withdrawal.method, 'mpesa')
