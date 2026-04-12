"""
Tests for wallet balance floor enforcement and the wallet summary endpoint.
Covers: available_balance computation, WalletTransaction.clean() validation,
and the wallet_summary API response.
"""
from decimal import Decimal

from django.core.exceptions import ValidationError
from django.test import TestCase
from django.urls import reverse
from rest_framework.test import APIClient

from apps.users.models import User
from apps.wallet.models import WalletTransaction


def _make_user(username='wallettest', balance=Decimal('500'), locked=Decimal('100')):
    u = User.objects.create_user(username=username, password='pass')
    u.wallet_balance = balance
    u.locked_balance = locked
    u.save()
    return u


def _make_txn(user=None, type='deposit', amount=Decimal('100')):
    return WalletTransaction(
        user           = user,
        type           = type,
        amount         = amount,
        balance_before = Decimal('0'),
        balance_after  = amount,
        description    = 'test',
    )


class AvailableBalanceTest(TestCase):
    """User.available_balance = wallet_balance − locked_balance."""

    def test_basic_calculation(self):
        u = _make_user(balance=Decimal('500'), locked=Decimal('100'))
        self.assertEqual(u.available_balance, Decimal('400'))

    def test_zero_balance(self):
        u = _make_user(balance=Decimal('0'), locked=Decimal('0'))
        self.assertEqual(u.available_balance, Decimal('0'))

    def test_fully_locked(self):
        u = _make_user(balance=Decimal('300'), locked=Decimal('300'))
        self.assertEqual(u.available_balance, Decimal('0'))


class WalletTransactionCleanTest(TestCase):
    """WalletTransaction.clean() must reject non-fee transactions with user=None."""

    def test_deposit_requires_user(self):
        txn = _make_txn(user=None, type='deposit')
        with self.assertRaises(ValidationError) as ctx:
            txn.clean()
        self.assertIn('user', str(ctx.exception))

    def test_payout_requires_user(self):
        txn = _make_txn(user=None, type='payout')
        with self.assertRaises(ValidationError):
            txn.clean()

    def test_refund_requires_user(self):
        txn = _make_txn(user=None, type='refund')
        with self.assertRaises(ValidationError):
            txn.clean()

    def test_fee_allows_null_user(self):
        txn = _make_txn(user=None, type='fee')
        try:
            txn.clean()  # must not raise
        except ValidationError:
            self.fail('clean() raised ValidationError for fee transaction with user=None')

    def test_deposit_with_user_passes(self):
        user = _make_user()
        txn  = _make_txn(user=user, type='deposit')
        txn.clean()  # must not raise


class WalletSummaryEndpointTest(TestCase):
    """GET /api/wallet/summary/ returns correct balance figures."""

    def setUp(self):
        self.user   = _make_user(balance=Decimal('750'), locked=Decimal('200'))
        self.client = APIClient()
        self.client.force_authenticate(user=self.user)

    def test_returns_200(self):
        url  = reverse('wallet_summary')
        resp = self.client.get(url)
        self.assertEqual(resp.status_code, 200)

    def test_balance_fields_correct(self):
        url  = reverse('wallet_summary')
        resp = self.client.get(url)
        data = resp.json()
        self.assertEqual(Decimal(data['balance']), Decimal('750'))
        self.assertEqual(Decimal(data['locked_balance']), Decimal('200'))
        self.assertEqual(Decimal(data['available_balance']), Decimal('550'))

    def test_unauthenticated_returns_401(self):
        url  = reverse('wallet_summary')
        resp = self.client.get(url, HTTP_AUTHORIZATION='')
        anon_client = APIClient()
        resp = anon_client.get(url)
        self.assertIn(resp.status_code, [401, 403])


class WalletTransactionTotalsTest(TestCase):
    """Wallet summary totals are computed correctly from transaction history."""

    def setUp(self):
        self.user   = _make_user(balance=Decimal('1000'), locked=Decimal('0'))
        self.client = APIClient()
        self.client.force_authenticate(user=self.user)

    def _create_txn(self, type, amount):
        WalletTransaction.objects.create(
            user           = self.user,
            type           = type,
            amount         = amount,
            balance_before = Decimal('0'),
            balance_after  = amount,
            description    = f'{type} test',
        )

    def test_deposit_total(self):
        self._create_txn('deposit', Decimal('500'))
        self._create_txn('deposit', Decimal('300'))
        url  = reverse('wallet_summary')
        resp = self.client.get(url)
        data = resp.json()
        self.assertEqual(Decimal(data['total_deposited']), Decimal('800'))

    def test_earned_total(self):
        self._create_txn('payout', Decimal('1200'))
        url  = reverse('wallet_summary')
        resp = self.client.get(url)
        data = resp.json()
        self.assertEqual(Decimal(data['total_earned']), Decimal('1200'))
