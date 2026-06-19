"""
Tests for production security hardening: sessions, replay protection, trust scoring.
"""

from django.test import TestCase, TransactionTestCase
from django.utils import timezone
from django.contrib.auth import get_user_model
User = get_user_model()
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
    get_trust_reward_modifier, get_active_policy, get_active_policy_version
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
        payload3['ml_walk_probability'] = 0.850012
        hash4 = compute_payload_hash(payload3)
        self.assertEqual(hash1, hash4)  # Should still match due to rounding


class DeviceRegistrationTestCase(TestCase):
    """Test device registration model."""
    
    def setUp(self):
        self.user = User.objects.create_user('testuser', 'test@example.com', 'pass')
    
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
        self.user = User.objects.create_user('testuser', 'test@example.com', 'pass')
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
        self.user = User.objects.create_user('testuser', 'test@example.com', 'pass')
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
        self.user = User.objects.create_user('testuser', 'test@example.com', 'pass')
    
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
        profile.save()
        modif = get_trust_reward_modifier(self.user)
        self.assertEqual(modif, 0.75)
        
        # Standard trust
        profile.trust_score = 60.0
        profile.save()
        modif = get_trust_reward_modifier(self.user)
        self.assertEqual(modif, 0.95)
        
        # Trusted
        profile.trust_score = 85.0
        profile.save()
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
        self.user = User.objects.create_user('testuser', 'test@example.com', 'pass')
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
