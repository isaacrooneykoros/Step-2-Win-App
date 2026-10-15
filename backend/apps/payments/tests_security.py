import uuid
from decimal import Decimal

from django.contrib.auth import get_user_model
from rest_framework import status
from rest_framework.test import APITestCase

from apps.payments.models import WithdrawalRequest

User = get_user_model()


class TestWithdrawalSecurity(APITestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            username="security_user",
            email="security@example.com",
            password="TestPassword123!",
            wallet_balance=Decimal("100.00"),
        )
        self.other_user = User.objects.create_user(
            username="other_user",
            email="other@example.com",
            password="TestPassword123!",
            wallet_balance=Decimal("50.00"),
        )
        self.client.force_authenticate(user=self.user)

    def test_cancel_pending_withdrawal_success(self):
        withdrawal = WithdrawalRequest.objects.create(
            user=self.user,
            status="pending_review",
            amount_kes=Decimal("50.00"),
            method="mpesa",
            phone_number="254700000001",
        )

        url = f"/api/payments/withdrawal/{withdrawal.id}/cancel/"
        response = self.client.post(url)

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        withdrawal.refresh_from_db()
        self.user.refresh_from_db()
        self.assertEqual(withdrawal.status, "cancelled")
        self.assertEqual(self.user.wallet_balance, Decimal("150.00"))

    def test_cancel_already_cancelled_or_approved_withdrawal_fails(self):
        withdrawal = WithdrawalRequest.objects.create(
            user=self.user,
            status="approved",
            amount_kes=Decimal("30.00"),
            method="mpesa",
            phone_number="254700000001",
        )

        url = f"/api/payments/withdrawal/{withdrawal.id}/cancel/"
        response = self.client.post(url)

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("Cannot cancel", response.data["error"])

    def test_cancel_nonexistent_or_malformed_uuid_returns_404(self):
        random_uuid = uuid.uuid4()
        url_nonexistent = f"/api/payments/withdrawal/{random_uuid}/cancel/"
        response = self.client.post(url_nonexistent)
        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)

        url_malformed = "/api/payments/withdrawal/invalid-uuid-string/cancel/"
        response_malformed = self.client.post(url_malformed)
        self.assertEqual(response_malformed.status_code, status.HTTP_404_NOT_FOUND)

    def test_cancel_other_users_withdrawal_returns_404(self):
        other_withdrawal = WithdrawalRequest.objects.create(
            user=self.other_user,
            status="pending_review",
            amount_kes=Decimal("20.00"),
            method="mpesa",
            phone_number="254700000002",
        )

        url = f"/api/payments/withdrawal/{other_withdrawal.id}/cancel/"
        response = self.client.post(url)

        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)
        other_withdrawal.refresh_from_db()
        self.assertEqual(other_withdrawal.status, "pending_review")
