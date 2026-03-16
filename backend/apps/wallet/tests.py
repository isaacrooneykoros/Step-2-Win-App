from decimal import Decimal

from django.contrib.auth import get_user_model
from rest_framework import status
from rest_framework.test import APITestCase

from apps.wallet.models import WalletTransaction


User = get_user_model()


class WalletIntegrationTests(APITestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            username='wallet_user',
            email='wallet@example.com',
            password='TestPass123!',
            wallet_balance=Decimal('50.00'),
        )

    def test_deposit_updates_balance_and_creates_transaction(self):
        self.client.force_authenticate(user=self.user)

        response = self.client.post(
            '/api/wallet/deposit/',
            {'amount': '150.00', 'payment_method': 'card'},
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)

        self.user.refresh_from_db()
        self.assertEqual(self.user.wallet_balance, Decimal('200.00'))

        deposit_txn = WalletTransaction.objects.filter(
            user=self.user,
            type='deposit',
            amount=Decimal('150.00'),
        ).first()
        self.assertIsNotNone(deposit_txn)

    def test_wallet_summary_reflects_updated_balance_and_totals(self):
        self.client.force_authenticate(user=self.user)

        deposit_response = self.client.post(
            '/api/wallet/deposit/',
            {'amount': '50.00', 'payment_method': 'card'},
            format='json',
        )
        self.assertEqual(deposit_response.status_code, status.HTTP_201_CREATED)

        self.user.refresh_from_db()
        self.client.force_authenticate(user=self.user)

        summary_response = self.client.get('/api/wallet/summary/')
        self.assertEqual(summary_response.status_code, status.HTTP_200_OK)
        self.assertEqual(summary_response.data['balance'], '100.00')
        self.assertEqual(summary_response.data['total_deposited'], '50.00')
