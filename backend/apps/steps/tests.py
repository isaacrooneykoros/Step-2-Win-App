import hashlib
import hmac
import json
import time
import uuid

from django.contrib.auth import get_user_model
from django.test import override_settings
from rest_framework import status
from rest_framework.test import APITestCase
from rest_framework_simplejwt.tokens import RefreshToken


User = get_user_model()


@override_settings(APP_SIGNING_SECRET='test-signing-secret-for-ci')
class SignedSyncTests(APITestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            username='signed_sync_user',
            email='signed_sync_user@example.com',
            password='TestPass123!',
            device_id='test-device-id',
            device_platform='android',
        )
        self.access = str(RefreshToken.for_user(self.user).access_token)

    def _signed_headers(self, payload, secret='test-signing-secret-for-ci'):
        body = json.dumps(payload)
        timestamp = str(int(time.time()))
        body_hash = hashlib.sha256(body.encode()).hexdigest()
        message = f'{self.user.id}:{timestamp}:{body_hash}'
        signature = hmac.new(secret.encode(), message.encode(), hashlib.sha256).hexdigest()

        return body, {
            'HTTP_AUTHORIZATION': f'Bearer {self.access}',
            'HTTP_X_APP_SIGNATURE': signature,
            'HTTP_X_TIMESTAMP': timestamp,
            'HTTP_X_IDEMPOTENCY_KEY': str(uuid.uuid4()),
        }

    def test_valid_signed_sync_is_accepted(self):
        payload = {
            'steps': 8200,
            'date': '2026-03-16',
            'distance_km': 5.1,
            'calories_active': 410,
            'active_minutes': 44,
            'source': 'google_fit',
        }
        body, headers = self._signed_headers(payload)

        response = self.client.post(
            '/api/steps/sync/',
            data=body,
            content_type='application/json',
            **headers,
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data.get('submitted_steps'), payload['steps'])
        self.assertIn('approved_steps', response.data)

    def test_invalid_signature_is_rejected(self):
        payload = {
            'steps': 5000,
            'date': '2026-03-16',
            'source': 'google_fit',
        }
        body, headers = self._signed_headers(payload, secret='wrong-secret')

        response = self.client.post(
            '/api/steps/sync/',
            data=body,
            content_type='application/json',
            **headers,
        )

        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)
        payload = json.loads(response.content.decode('utf-8'))
        self.assertEqual(payload.get('code'), 'INVALID_SIGNATURE')
