import uuid
from decimal import Decimal

from django.contrib.auth import get_user_model
from rest_framework import status
from rest_framework.test import APITestCase

User = get_user_model()


class WalletSecurityTests(APITestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            username="security_wallet_user",
            email="secwallet@example.com",
            password="TestPass123!",
            phone_number="254712345678",
            wallet_balance=Decimal("100.00"),
        )

    def test_withdrawal_detail_handles_invalid_and_malformed_uuids(self):
        self.client.force_authenticate(user=self.user)

        # Non-existent valid UUID
        random_uuid = str(uuid.uuid4())
        response = self.client.get(f"/api/wallet/withdrawals/{random_uuid}/")
        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)

        # Malformed UUID string
        malformed_id = "invalid-uuid-12345"
        response = self.client.get(f"/api/wallet/withdrawals/{malformed_id}/")
        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)
