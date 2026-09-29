import uuid
from decimal import Decimal
from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase
from rest_framework import status
from apps.payments.models import WithdrawalRequest

User = get_user_model()


class PaymentsSecurityTests(APITestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            username="securityuser",
            email="secuser@example.com",
            phone_number="254712345600",
            password="testpass123",
            wallet_balance=Decimal("500.00"),
        )
        self.client.force_authenticate(user=self.user)

    def test_cancel_withdrawal_non_existent_uuid_returns_404(self):
        non_existent_id = uuid.uuid4()
        response = self.client.post(f"/api/payments/withdrawal/{non_existent_id}/cancel/")
        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)
        self.assertEqual(response.data, {"error": "Withdrawal not found"})

    def test_withdrawal_detail_non_existent_uuid_returns_404(self):
        non_existent_id = uuid.uuid4()
        response = self.client.get(f"/api/wallet/withdrawals/{non_existent_id}/")
        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)
        self.assertEqual(response.data, {"error": "Withdrawal not found"})

    def test_cancel_withdrawal_success_and_second_cancel_rejected(self):
        withdrawal = WithdrawalRequest.objects.create(
            user=self.user,
            amount_kes=Decimal("100.00"),
            method="mpesa",
            phone_number="254712345600",
            status="pending_review",
        )
        response = self.client.post(f"/api/payments/withdrawal/{withdrawal.id}/cancel/")
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        self.user.refresh_from_db()
        withdrawal.refresh_from_db()
        self.assertEqual(self.user.wallet_balance, Decimal("600.00"))
        self.assertEqual(withdrawal.status, "cancelled")

        # Second cancel attempt must fail with 400 Bad Request (preventing double refunds)
        second_response = self.client.post(f"/api/payments/withdrawal/{withdrawal.id}/cancel/")
        self.assertEqual(second_response.status_code, status.HTTP_400_BAD_REQUEST)
        self.user.refresh_from_db()
        self.assertEqual(self.user.wallet_balance, Decimal("600.00"))
