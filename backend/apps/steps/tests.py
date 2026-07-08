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
        self.user = get_user_model().objects.create_user(
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
        self.user = get_user_model().objects.create_user(
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
"""
Tests for production security hardening: sessions, replay protection, trust scoring.
"""

from django.test import TestCase, TransactionTestCase
from django.utils import timezone
from django.contrib.auth.models import User
from datetime import timedelta
import uuid

from apps.steps.models import (
    DeviceRegistration, StepSession, StepSyncEvent,
    AntiCheatPolicy, UserTrustProfile, SuspiciousSessionReview
)
from apps.steps.security import (
    create_session_token, hash_session_token, verify_session_token,
    compute_payload_hash, detect_replay, is_session_expired, is_session_valid,
    get_or_create_user_trust_profile, update_user_trust_after_session,
    get_trust_reward_modifier, get_active_policy, get_active_policy_version,
    update_trust_tier
)
from apps.steps.anti_cheat import score_session, finalize_step_session


class SecurityUtilsTestCase(TestCase):
    """Test security utility functions."""

    def test_create_and_verify_session_token(self):
        """Test session token creation and verification."""
        token = create_session_token()
        self.assertIsNotNone(token)
        self.assertGreater(len(token), 20)

        token_hash = hash_session_token(token)
        self.assertIsNotNone(token_hash)

        # Verify correct token
        self.assertTrue(verify_session_token(token, token_hash))

        # Verify incorrect token
        wrong_token = create_session_token()
        self.assertFalse(verify_session_token(wrong_token, token_hash))

    def test_compute_payload_hash(self):
        """Test payload hash computation normalization."""
        payload1 = {
            'session_id': 'test-session',
            'client_event_id': 'event-1',
            'sequence_number': 1,
            'timestamp_client': '2026-05-02T10:00:00Z',
            'steps_delta': 100,
            'steps_total': 5000,
            'ml_motion_label': 'walk',
            'ml_walk_probability': 0.85,
            'ml_shake_probability': 0.02,
            'ml_model_version': 'v1',
        }

        # Same payload should produce same hash
        hash1 = compute_payload_hash(payload1)
        hash2 = compute_payload_hash(payload1)
        self.assertEqual(hash1, hash2)

        # Different payload should produce different hash
        payload2 = payload1.copy()
        payload2['steps_delta'] = 150
        hash3 = compute_payload_hash(payload2)
        self.assertNotEqual(hash1, hash3)

        # Probabilities rounded to 4 decimals
        payload3 = payload1.copy()
        payload3['ml_walk_probability'] = 0.85001
        hash4 = compute_payload_hash(payload3)
        self.assertEqual(hash1, hash4)  # Should still match due to rounding


class DeviceRegistrationTestCase(TestCase):
    """Test device registration model."""

    def setUp(self):
        self.user = get_user_model().objects.create_user('testuser', 'test@example.com', 'pass')

    def test_create_device_registration(self):
        """Test creating a device registration."""
        device = DeviceRegistration.objects.create(
            user=self.user,
            device_id='android-device-123',
            platform='android',
            app_version='1.0.0',
            trust_level='new',
        )

        self.assertEqual(device.user, self.user)
        self.assertEqual(device.device_id, 'android-device-123')
        self.assertEqual(device.platform, 'android')
        self.assertTrue(device.is_active)
        self.assertIsNotNone(device.first_seen_at)
        self.assertIsNotNone(device.last_seen_at)

    def test_device_unique_constraint(self):
        """Test unique constraint on (user, device_id)."""
        DeviceRegistration.objects.create(
            user=self.user,
            device_id='device-1',
            platform='android',
        )

        # Attempting to create duplicate should fail
        with self.assertRaises(Exception):
            DeviceRegistration.objects.create(
                user=self.user,
                device_id='device-1',
                platform='android',
            )


class StepSessionTestCase(TransactionTestCase):
    """Test step session model and lifecycle."""

    def setUp(self):
        self.user = get_user_model().objects.create_user('testuser', 'test@example.com', 'pass')
        self.device = DeviceRegistration.objects.create(
            user=self.user,
            device_id='device-1',
            platform='android',
        )

    def test_create_session(self):
        """Test creating a step session."""
        token = create_session_token()
        token_hash = hash_session_token(token)

        session = StepSession.objects.create(
            user=self.user,
            device=self.device,
            session_token_hash=token_hash,
            server_nonce='nonce-123',
            status='active',
            expires_at=timezone.now() + timedelta(hours=12),
            policy_version='v1',
            ml_model_version='shakewalk-logreg-v1',
        )

        self.assertEqual(session.user, self.user)
        self.assertEqual(session.device, self.device)
        self.assertEqual(session.status, 'active')
        self.assertEqual(session.accepted_steps, 0)
        self.assertEqual(session.rejected_steps, 0)

    def test_session_expiration(self):
        """Test session expiration logic."""
        # Create expired session
        expired_session = StepSession.objects.create(
            user=self.user,
            device=self.device,
            session_token_hash=hash_session_token(create_session_token()),
            server_nonce='nonce',
            status='active',
            expires_at=timezone.now() - timedelta(hours=1),
        )

        self.assertTrue(is_session_expired(expired_session))
        self.assertFalse(is_session_valid(expired_session))

        # Create active session
        active_session = StepSession.objects.create(
            user=self.user,
            device=self.device,
            session_token_hash=hash_session_token(create_session_token()),
            server_nonce='nonce2',
            status='active',
            expires_at=timezone.now() + timedelta(hours=12),
        )

        self.assertFalse(is_session_expired(active_session))
        self.assertTrue(is_session_valid(active_session))


class ReplayDetectionTestCase(TransactionTestCase):
    """Test replay attack detection."""

    def setUp(self):
        self.user = get_user_model().objects.create_user('testuser', 'test@example.com', 'pass')
        self.device = DeviceRegistration.objects.create(
            user=self.user,
            device_id='device-1',
            platform='android',
        )
        self.session = StepSession.objects.create(
            user=self.user,
            device=self.device,
            session_token_hash=hash_session_token(create_session_token()),
            server_nonce='nonce',
            status='active',
            expires_at=timezone.now() + timedelta(hours=12),
        )

    def test_detect_duplicate_client_event_id(self):
        """Test detection of duplicate client_event_id."""
        event_id = str(uuid.uuid4())

        # Create first event
        StepSyncEvent.objects.create(
            user=self.user,
            session=self.session,
            client_event_id=event_id,
            sequence_number=1,
            payload_hash='hash1',
            steps_delta=100,
        )

        # Try to create duplicate
        is_replay, reason = detect_replay(
            self.user.id,
            str(self.session.id),
            event_id,
            2,
            'hash2'
        )

        self.assertTrue(is_replay)
        self.assertIn('Duplicate client_event_id', reason)

    def test_detect_duplicate_sequence_number(self):
        """Test detection of duplicate sequence_number in same session."""
        # Create first event with sequence 1
        StepSyncEvent.objects.create(
            user=self.user,
            session=self.session,
            client_event_id='event-1',
            sequence_number=1,
            payload_hash='hash1',
            steps_delta=100,
        )

        # Try to create another event with same sequence
        is_replay, reason = detect_replay(
            self.user.id,
            str(self.session.id),
            'event-2',
            1,
            'hash2'
        )

        self.assertTrue(is_replay)
        self.assertIn('Duplicate sequence_number', reason)


class UserTrustProfileTestCase(TestCase):
    """Test user trust profile model and logic."""

    def setUp(self):
        self.user = get_user_model().objects.create_user('testuser', 'test@example.com', 'pass')

    def test_get_or_create_trust_profile(self):
        """Test lazy creation of trust profile."""
        profile = get_or_create_user_trust_profile(self.user)

        self.assertIsNotNone(profile)
        self.assertEqual(profile.user, self.user)
        self.assertEqual(profile.trust_score, 50.0)
        self.assertEqual(profile.trust_tier, 'new')

    def test_trust_score_update_clean_session(self):
        """Test trust increases after clean session."""
        profile = get_or_create_user_trust_profile(self.user)
        initial_score = profile.trust_score

        update_user_trust_after_session(self.user, session_risk_score=10.0, is_replay=False)

        profile.refresh_from_db()
        self.assertGreater(profile.trust_score, initial_score)
        self.assertEqual(profile.verified_sessions_count, 1)

    def test_trust_score_update_replay(self):
        """Test trust decreases significantly after replay."""
        profile = get_or_create_user_trust_profile(self.user)
        initial_score = profile.trust_score

        update_user_trust_after_session(self.user, session_risk_score=80.0, is_replay=True)

        profile.refresh_from_db()
        self.assertLess(profile.trust_score, initial_score - 10)
        self.assertEqual(profile.replay_attempts_count, 1)

    def test_trust_tier_mapping(self):
        """Test trust tier updates based on score."""
        profile = get_or_create_user_trust_profile(self.user)

        # Low trust
        profile.trust_score = 30.0
        update_trust_tier(profile)
        modif = get_trust_reward_modifier(self.user)
        self.assertEqual(modif, 0.75)

        # Standard trust
        profile.trust_score = 60.0
        update_trust_tier(profile)
        modif = get_trust_reward_modifier(self.user)
        self.assertEqual(modif, 0.95)

        # Trusted
        profile.trust_score = 85.0
        update_trust_tier(profile)
        modif = get_trust_reward_modifier(self.user)
        self.assertEqual(modif, 1.00)


class AntiCheatPolicyTestCase(TestCase):
    """Test anti-cheat policy model."""

    def test_create_policy(self):
        """Test creating an anti-cheat policy."""
        config = {
            'ml': {'high_shake_threshold': 0.80},
            'session': {'max_steps_per_minute': 180},
            'trust': {'default_trust_score': 50},
        }

        policy = AntiCheatPolicy.objects.create(
            version='test-v1',
            is_active=True,
            config=config,
        )

        self.assertEqual(policy.version, 'test-v1')
        self.assertTrue(policy.is_active)
        self.assertEqual(policy.config['ml']['high_shake_threshold'], 0.80)

    def test_get_active_policy(self):
        """Test retrieving active policy."""
        config = {
            'ml': {'high_shake_threshold': 0.80},
            'session': {'max_steps_per_minute': 180},
        }

        AntiCheatPolicy.objects.create(
            version='active-v1',
            is_active=True,
            config=config,
        )

        active = get_active_policy()
        self.assertIsNotNone(active)
        self.assertEqual(active['ml']['high_shake_threshold'], 0.80)

        version = get_active_policy_version()
        self.assertEqual(version, 'active-v1')


class SessionScoringTestCase(TransactionTestCase):
    """Test session-level scoring logic."""

    def setUp(self):
        self.user = get_user_model().objects.create_user('testuser', 'test@example.com', 'pass')
        self.device = DeviceRegistration.objects.create(
            user=self.user,
            device_id='device-1',
            platform='android',
        )
        self.session = StepSession.objects.create(
            user=self.user,
            device=self.device,
            session_token_hash=hash_session_token(create_session_token()),
            server_nonce='nonce',
            status='active',
            expires_at=timezone.now() + timedelta(hours=12),
        )

    def test_score_clean_session(self):
        """Test scoring a clean session."""
        # Add accepted events
        for i in range(3):
            StepSyncEvent.objects.create(
                user=self.user,
                session=self.session,
                client_event_id=f'event-{i}',
                sequence_number=i+1,
                payload_hash=f'hash-{i}',
                steps_delta=100,
                ml_walk_probability=0.85,
                ml_shake_probability=0.05,
                ml_motion_label='walk',
                accepted=True,
                interval_risk_score=5.0,
            )

        metrics = score_session(self.session)

        self.assertEqual(metrics['total_events'], 3)
        self.assertEqual(metrics['accepted_events'], 3)
        self.assertEqual(metrics['rejected_events'], 0)
        self.assertEqual(metrics['replay_events'], 0)
        self.assertEqual(metrics['total_steps'], 300)
        self.assertLess(metrics['final_session_risk_score'], 20)

    def test_score_session_with_replay(self):
        """Test scoring a session with replay attempts."""
        # Add normal events
        for i in range(2):
            StepSyncEvent.objects.create(
                user=self.user,
                session=self.session,
                client_event_id=f'event-{i}',
                sequence_number=i+1,
                payload_hash=f'hash-{i}',
                steps_delta=100,
                ml_walk_probability=0.85,
                ml_shake_probability=0.05,
                ml_motion_label='walk',
                accepted=False,
                replay_detected=True,
                interval_risk_score=90.0,
            )

        metrics = score_session(self.session)

        self.assertEqual(metrics['replay_events'], 2)
        self.assertGreaterEqual(metrics['final_session_risk_score'], 50)
