from decimal import Decimal
from django.contrib.auth import get_user_model
from rest_framework import status
from rest_framework.test import APITestCase

from apps.payments.models import WithdrawalRequest

User = get_user_model()


class WithdrawalSecurityTests(APITestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            username="withdrawal_sec_user",
            email="sec_user@example.com",
            password="TestPassword123!",
            wallet_balance=Decimal("100.00"),
        )
        self.client.force_authenticate(user=self.user)

    def test_cancel_withdrawal_refunds_balance_and_updates_status(self):
        withdrawal = WithdrawalRequest.objects.create(
            user=self.user,
            status="pending_review",
            amount_kes=Decimal("50.00"),
            method="mpesa",
            phone_number="254712345678",
        )

        response = self.client.post(f"/api/payments/withdrawal/{withdrawal.id}/cancel/")
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        withdrawal.refresh_from_db()
        self.user.refresh_from_db()

        self.assertEqual(withdrawal.status, "cancelled")
        self.assertEqual(self.user.wallet_balance, Decimal("150.00"))

    def test_cancel_withdrawal_twice_fails_without_double_refunding(self):
        withdrawal = WithdrawalRequest.objects.create(
            user=self.user,
            status="pending_review",
            amount_kes=Decimal("50.00"),
            method="mpesa",
            phone_number="254712345678",
        )

        # First cancellation
        response1 = self.client.post(f"/api/payments/withdrawal/{withdrawal.id}/cancel/")
        self.assertEqual(response1.status_code, status.HTTP_200_OK)

        self.user.refresh_from_db()
        self.assertEqual(self.user.wallet_balance, Decimal("150.00"))

        # Second cancellation attempt
        response2 = self.client.post(f"/api/payments/withdrawal/{withdrawal.id}/cancel/")
        self.assertEqual(response2.status_code, status.HTTP_400_BAD_REQUEST)

        self.user.refresh_from_db()
        # Balance must remain 150.00 and NOT be credited again to 200.00
        self.assertEqual(self.user.wallet_balance, Decimal("150.00"))
