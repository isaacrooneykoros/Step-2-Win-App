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
            phone_number="254711223344",
            password="TestPassword123!",
            wallet_balance=Decimal("100.00"),
        )
        self.client.force_authenticate(user=self.user)

    def test_cancel_withdrawal_success_refunds_balance(self):
        withdrawal = WithdrawalRequest.objects.create(
            user=self.user,
            status="pending_review",
            amount_kes=Decimal("50.00"),
            method="mpesa",
            phone_number="254711223344",
        )

        response = self.client.post(f"/api/payments/withdrawal/{withdrawal.id}/cancel/")
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        withdrawal.refresh_from_db()
        self.user.refresh_from_db()
        self.assertEqual(withdrawal.status, "cancelled")
        self.assertEqual(self.user.wallet_balance, Decimal("150.00"))

    def test_cancel_withdrawal_already_cancelled_fails_without_double_refund(self):
        withdrawal = WithdrawalRequest.objects.create(
            user=self.user,
            status="cancelled",
            amount_kes=Decimal("50.00"),
            method="mpesa",
            phone_number="254711223344",
        )

        response = self.client.post(f"/api/payments/withdrawal/{withdrawal.id}/cancel/")
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

        self.user.refresh_from_db()
        self.assertEqual(self.user.wallet_balance, Decimal("100.00"))

    def test_cancel_withdrawal_other_user_not_found(self):
        other_user = User.objects.create_user(
            username="other_sec_user",
            email="other@example.com",
            phone_number="254799887766",
            password="TestPassword123!",
            wallet_balance=Decimal("50.00"),
        )
        withdrawal = WithdrawalRequest.objects.create(
            user=other_user,
            status="pending_review",
            amount_kes=Decimal("30.00"),
            method="mpesa",
            phone_number="254799887766",
        )

        response = self.client.post(f"/api/payments/withdrawal/{withdrawal.id}/cancel/")
        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)

        self.user.refresh_from_db()
        other_user.refresh_from_db()
        self.assertEqual(self.user.wallet_balance, Decimal("100.00"))
        self.assertEqual(other_user.wallet_balance, Decimal("50.00"))
