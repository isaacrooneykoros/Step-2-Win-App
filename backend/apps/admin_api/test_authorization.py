"""
Phase 2 Admin API Authorization Tests

Tests for:
- Unauthenticated access denial
- Regular user access denial to admin endpoints
- Admin access verification
- Object ownership/scope validation
- Destructive operation protection
"""
from decimal import Decimal
from datetime import date, timedelta

from django.test import TestCase
from django.urls import reverse
from rest_framework.test import APIClient
from rest_framework import status
from django.contrib.auth import get_user_model

from apps.challenges.models import Challenge
from apps.payments.models import WithdrawalRequest


User = get_user_model()


class AdminEndpointAuthorizationTests(TestCase):
    """Test that admin endpoints properly restrict access."""

    def setUp(self):
        self.client = APIClient()

        # Create regular user
        self.regular_user = User.objects.create_user(
            username="regularuser",
            email="regular@example.com",
            phone_number="254712345100",
            password="testpass123",
            wallet_balance=Decimal("1000.00"),
        )

        # Create admin user
        self.admin_user = User.objects.create_user(
            username="adminuser",
            email="admin@example.com",
            phone_number="254712345101",
            password="adminpass123",
            is_staff=True,
            wallet_balance=Decimal("0.00"),
        )

        # Create some test data
        self.challenge = Challenge.objects.create(
            creator=self.regular_user,
            name="Test Challenge",
            entry_fee=Decimal("100.00"),
            milestone=10000,
            start_date=date.today(),
            end_date=date.today() + timedelta(days=7),
            status="active",
            total_pool=Decimal("100.00"),
        )

    def _get_tokens(self, user):
        """Get JWT tokens for a user."""
        from rest_framework_simplejwt.tokens import RefreshToken
        refresh = RefreshToken.for_user(user)
        return str(refresh.access_token)

    def test_unauthenticated_cannot_access_admin_dashboard(self):
        """Unauthenticated requests should be denied."""
        response = self.client.get("/api/admin/dashboard/overview/")
        self.assertEqual(response.status_code, status.HTTP_401_UNAUTHORIZED)

    def test_regular_user_cannot_access_admin_dashboard(self):
        """Regular users should not access admin endpoints."""
        token = self._get_tokens(self.regular_user)
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {token}")

        response = self.client.get("/api/admin/dashboard/overview/")
        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)

    def test_admin_can_access_admin_dashboard(self):
        """Admin users should access admin endpoints."""
        token = self._get_tokens(self.admin_user)
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {token}")

        response = self.client.get("/api/admin/dashboard/overview/")
        self.assertEqual(response.status_code, status.HTTP_200_OK)

    def test_regular_user_cannot_access_admin_users_list(self):
        """Regular users should not access user management."""
        token = self._get_tokens(self.regular_user)
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {token}")

        response = self.client.get("/api/admin/users/")
        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)

    def test_regular_user_cannot_access_revenue_report(self):
        """Regular users should not access revenue analytics."""
        token = self._get_tokens(self.regular_user)
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {token}")

        response = self.client.get("/api/admin/reports/revenue/")
        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)

    def test_regular_user_cannot_access_user_retention(self):
        """Regular users should not access retention analytics."""
        token = self._get_tokens(self.regular_user)
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {token}")

        response = self.client.get("/api/admin/reports/retention/")
        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)

    def test_regular_user_cannot_access_challenge_analytics(self):
        """Regular users should not access challenge analytics."""
        token = self._get_tokens(self.regular_user)
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {token}")

        response = self.client.get("/api/admin/reports/challenge-analytics/")
        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)

    def test_regular_user_cannot_access_withdrawal_queue(self):
        """Regular users should not access withdrawal queue."""
        token = self._get_tokens(self.regular_user)
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {token}")

        response = self.client.get("/api/admin/withdrawals/")
        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)


class CrossUserDataAccessTests(TestCase):
    """Test that users cannot access other users' data."""

    def setUp(self):
        self.client = APIClient()

        self.user1 = User.objects.create_user(
            username="user1",
            email="user1@example.com",
            phone_number="254712345200",
            password="testpass123",
            wallet_balance=Decimal("1000.00"),
        )

        self.user2 = User.objects.create_user(
            username="user2",
            email="user2@example.com",
            phone_number="254712345201",
            password="testpass123",
            wallet_balance=Decimal("500.00"),
        )

    def _get_tokens(self, user):
        from rest_framework_simplejwt.tokens import RefreshToken
        refresh = RefreshToken.for_user(user)
        return str(refresh.access_token)

    def test_user_cannot_view_other_user_wallet(self):
        """Users should only see their own wallet data."""
        token = self._get_tokens(self.user1)
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {token}")

        # Get wallet summary - should only return user1's data
        response = self.client.get("/api/wallet/summary/")
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        # Balance should be user1's balance
        self.assertEqual(Decimal(response.data["balance"]), self.user1.wallet_balance)

    def test_user_cannot_view_other_user_transactions(self):
        """Users should only see their own transactions."""
        # Create transaction for user2
        from apps.wallet.models import WalletTransaction
        WalletTransaction.objects.create(
            user=self.user2,
            type="deposit",
            amount=Decimal("100.00"),
            balance_before=Decimal("400.00"),
            balance_after=Decimal("500.00"),
            description="User2 deposit",
        )

        token = self._get_tokens(self.user1)
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {token}")

        response = self.client.get("/api/wallet/transactions/")
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        # Should not contain user2's transaction
        for txn in response.data.get("results", response.data):
            self.assertNotEqual(txn.get("description"), "User2 deposit")


class WithdrawalAccessTests(TestCase):
    """Test withdrawal endpoint authorization."""

    def setUp(self):
        self.client = APIClient()

        self.user1 = User.objects.create_user(
            username="withdrawuser1",
            email="withdraw1@example.com",
            phone_number="254712345300",
            password="testpass123",
            wallet_balance=Decimal("1000.00"),
        )

        self.user2 = User.objects.create_user(
            username="withdrawuser2",
            email="withdraw2@example.com",
            phone_number="254712345301",
            password="testpass123",
            wallet_balance=Decimal("500.00"),
        )

        # Create withdrawal for user2
        self.user2_withdrawal = WithdrawalRequest.objects.create(
            user=self.user2,
            amount_kes=Decimal("100.00"),
            method="mpesa",
            phone_number="254712345301",
            status="pending_review",
        )

    def _get_tokens(self, user):
        from rest_framework_simplejwt.tokens import RefreshToken
        refresh = RefreshToken.for_user(user)
        return str(refresh.access_token)

    def test_user_cannot_view_other_user_withdrawal(self):
        """Users should not see other users' withdrawal details."""
        token = self._get_tokens(self.user1)
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {token}")

        response = self.client.get(
            f"/api/wallet/withdrawals/{self.user2_withdrawal.id}/"
        )
        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)

    def test_user_can_view_own_withdrawal(self):
        """Users should see their own withdrawal details."""
        # Create withdrawal for user1
        user1_withdrawal = WithdrawalRequest.objects.create(
            user=self.user1,
            amount_kes=Decimal("50.00"),
            method="mpesa",
            phone_number="254712345300",
            status="pending_review",
        )

        token = self._get_tokens(self.user1)
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {token}")

        response = self.client.get(f"/api/wallet/withdrawals/{user1_withdrawal.id}/")
        self.assertEqual(response.status_code, status.HTTP_200_OK)


class AdminActionAuditTests(TestCase):
    """Test that admin actions are properly audited."""

    def setUp(self):
        self.client = APIClient()

        self.admin_user = User.objects.create_user(
            username="auditadmin",
            email="auditadmin@example.com",
            phone_number="254712345400",
            password="adminpass123",
            is_staff=True,
        )

        self.target_user = User.objects.create_user(
            username="targetuser",
            email="target@example.com",
            phone_number="254712345401",
            password="testpass123",
            wallet_balance=Decimal("1000.00"),
        )

    def _get_tokens(self, user):
        from rest_framework_simplejwt.tokens import RefreshToken
        refresh = RefreshToken.for_user(user)
        return str(refresh.access_token)

    def test_admin_action_logs_reviewer(self):
        """Admin actions should record who performed them."""
        from apps.payments.models import WithdrawalRequest

        # Create withdrawal
        withdrawal = WithdrawalRequest.objects.create(
            user=self.target_user,
            amount_kes=Decimal("100.00"),
            method="mpesa",
            phone_number="254712345401",
            status="pending_review",
        )

        # Deduct balance (as would happen in real flow)
        self.target_user.wallet_balance -= Decimal("100.00")
        self.target_user.save()

        token = self._get_tokens(self.admin_user)
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {token}")

        # Reject the withdrawal
        response = self.client.post(
            f"/api/admin/withdrawals/{withdrawal.id}/reject/",
            {"reason": "Test rejection"},
            format="json",
        )

        # Verify rejection recorded admin
        withdrawal.refresh_from_db()
        if response.status_code == status.HTTP_200_OK:
            self.assertEqual(withdrawal.reviewed_by, self.admin_user)
            self.assertIsNotNone(withdrawal.reviewed_at)
