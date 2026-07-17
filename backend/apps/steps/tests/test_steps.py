import hashlib
import hmac
import json
import time
import uuid
from datetime import timedelta

from django.contrib.auth import get_user_model
from django.test import TestCase
from django.test import override_settings
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APITestCase
from rest_framework_simplejwt.tokens import RefreshToken

from apps.steps.drift_monitor import AntiCheatDriftThresholds, run_anticheat_shadow_drift_monitor
from apps.steps.models import DailyVerificationSummary, HealthRecord


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


class AntiCheatShadowDriftMonitorTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            username='drift_user',
            email='drift_user@example.com',
            password='TestPass123!',
            device_id='drift-device-id',
            device_platform='android',
        )

    def _make_pair(self, *, days_ago: int, legacy_steps: int, shadow_steps: int):
        day = timezone.now().date() - timedelta(days=days_ago)
        HealthRecord.objects.create(
            user=self.user,
            date=day,
            source='google_fit',
            steps=legacy_steps,
            is_suspicious=False,
        )
        DailyVerificationSummary.objects.create(
            user=self.user,
            date=day,
            raw_steps_total=legacy_steps,
            verified_steps_total=shadow_steps,
            suspicious_steps_total=max(0, legacy_steps - shadow_steps),
            interval_count=1,
            accepted_count=1,
            review_count=0,
            rejected_count=0,
            risk_score=10.0,
            review_state='none',
            payout_state='eligible',
            trust_score_before=100,
            trust_score_after=100,
            mode='shadow',
            verification_version='v2',
            audit_snapshot={},
        )

    def test_monitor_ok_when_drift_within_thresholds(self):
        self._make_pair(days_ago=0, legacy_steps=10000, shadow_steps=9800)
        self._make_pair(days_ago=1, legacy_steps=8000, shadow_steps=7900)

        result = run_anticheat_shadow_drift_monitor(
            thresholds=AntiCheatDriftThresholds(
                lookback_hours=48,
                min_samples=2,
                per_sample_alert_pct=30.0,
                max_avg_abs_delta_pct=10.0,
                max_high_drift_ratio_pct=50.0,
                max_review_mismatch_ratio_pct=50.0,
            ),
            send_alerts=False,
        )

        self.assertTrue(result['ok'])
        self.assertEqual(result['metrics']['sample_count'], 2)
        self.assertEqual(result['metrics']['matched_samples'], 2)
        self.assertEqual(result['breaches'], [])

    def test_monitor_breaches_on_high_average_drift(self):
        self._make_pair(days_ago=0, legacy_steps=10000, shadow_steps=5000)
        self._make_pair(days_ago=1, legacy_steps=9000, shadow_steps=4500)

        result = run_anticheat_shadow_drift_monitor(
            thresholds=AntiCheatDriftThresholds(
                lookback_hours=48,
                min_samples=2,
                per_sample_alert_pct=30.0,
                max_avg_abs_delta_pct=20.0,
                max_high_drift_ratio_pct=25.0,
                max_review_mismatch_ratio_pct=50.0,
            ),
            send_alerts=False,
        )

        self.assertFalse(result['ok'])
        self.assertTrue(any('avg_abs_delta_pct=' in breach for breach in result['breaches']))
