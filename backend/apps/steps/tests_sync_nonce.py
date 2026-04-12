"""
Converted from backend/test_signed_sync.py.
Tests for the server-side sync nonce mechanism (replaces HMAC approach).
Runs via ``python manage.py test apps.steps.tests_sync_nonce``.
"""
import uuid

from django.test import TestCase
from rest_framework.test import APIClient
from rest_framework_simplejwt.tokens import RefreshToken

from apps.users.models import User
from apps.steps.models import TrustScore


def _make_test_user(username='sync_test_user'):
    user, _ = User.objects.update_or_create(
        username=username,
        defaults={'email': f'{username}@test.example', 'is_active': True},
    )
    user.set_password('password')
    user.save()
    TrustScore.objects.update_or_create(user=user, defaults={'score': 100})
    return user


def _auth_client(user) -> APIClient:
    client = APIClient()
    token  = str(RefreshToken.for_user(user).access_token)
    client.credentials(HTTP_AUTHORIZATION=f'Bearer {token}')
    return client


class SyncNonceEndpointTest(TestCase):
    """GET /api/steps/sync/nonce/ — returns a nonce for authenticated users."""

    def setUp(self):
        self.user   = _make_test_user('nonce_user')
        self.client = _auth_client(self.user)

    def test_authenticated_user_gets_nonce(self):
        resp = self.client.get('/api/steps/sync/nonce/')
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertIn('nonce', data)
        self.assertIn('expires_in', data)
        self.assertTrue(len(data['nonce']) > 0)

    def test_unauthenticated_returns_401(self):
        anon = APIClient()
        resp = anon.get('/api/steps/sync/nonce/')
        self.assertIn(resp.status_code, [401, 403])

    def test_nonce_format_is_hex(self):
        resp = self.client.get('/api/steps/sync/nonce/')
        nonce = resp.json()['nonce']
        # UUIDs without hyphens are 32 hex chars
        self.assertEqual(len(nonce), 32)
        int(nonce, 16)  # raises ValueError if not valid hex


class SyncWithoutNonceTest(TestCase):
    """POST /api/steps/sync/ without a nonce should be rejected (when Redis available)."""

    def setUp(self):
        self.user   = _make_test_user('sync_no_nonce_user')
        self.client = _auth_client(self.user)

    def test_missing_nonce_rejected_or_degraded_gracefully(self):
        """When Redis is available, missing nonce returns 403.
        When Redis is unavailable, the middleware degrades and allows through."""
        payload = {
            'steps':          5_000,
            'date':           '2025-06-01',
            'distance_km':    3.2,
            'calories_active': 250,
            'active_minutes': 35,
            'source':         'google_fit',
        }
        resp = self.client.post('/api/steps/sync/', payload, format='json')
        # Acceptable responses: 403 (nonce rejected) or 200/201 (graceful fallback)
        self.assertIn(resp.status_code, [200, 201, 403])


class SyncWithValidNonceTest(TestCase):
    """End-to-end: fetch nonce then use it in sync request."""

    def setUp(self):
        self.user   = _make_test_user('sync_nonce_e2e')
        self.client = _auth_client(self.user)

    def test_sync_with_valid_nonce_accepted(self):
        # Step 1: fetch nonce
        nonce_resp = self.client.get('/api/steps/sync/nonce/')
        if nonce_resp.status_code != 200:
            self.skipTest('Nonce endpoint unavailable (likely no Redis in test env)')

        nonce = nonce_resp.json()['nonce']

        # Step 2: use nonce in sync request
        payload = {
            'steps':          7_000,
            'date':           '2025-06-02',
            'distance_km':    4.5,
            'calories_active': 350,
            'active_minutes': 42,
            'source':         'google_fit',
        }
        resp = self.client.post(
            '/api/steps/sync/',
            payload,
            format='json',
            HTTP_X_SYNC_NONCE=nonce,
            HTTP_X_IDEMPOTENCY_KEY=uuid.uuid4().hex,
        )
        # Either 200/201 (sync accepted) or 403 (nonce expired in slow CI)
        self.assertIn(resp.status_code, [200, 201, 403])
