"""
Phase 2 Step System Security Tests

Tests for:
- Session token creation and verification
- Replay attack detection
- Payload hash computation
- Anti-cheat rule evaluation
- Trust score management
"""
from datetime import date, timedelta
from decimal import Decimal
from unittest.mock import patch

from django.test import TestCase
from django.utils import timezone
from django.contrib.auth import get_user_model

from apps.steps.security import (
    create_session_token,
    hash_session_token,
    verify_session_token,
    compute_payload_hash,
    detect_replay,
)
from apps.steps.models import (
    HealthRecord,
    TrustScore,
    StepSession,
    StepSyncEvent,
    DeviceRegistration,
)
from apps.steps.anti_cheat import (
    run_anti_cheat,
    DAILY_STEP_CAP,
    VerificationConfig,
    evaluate_daily_submission,
)


User = get_user_model()


class SessionTokenSecurityTests(TestCase):
    """Test session token creation and verification."""

    def test_session_token_generation_entropy(self):
        """Session tokens should be high-entropy and unique."""
        tokens = [create_session_token() for _ in range(100)]
        # All tokens should be unique
        self.assertEqual(len(set(tokens)), 100)
        # Tokens should be at least 32 characters (URL-safe base64)
        for token in tokens:
            self.assertGreaterEqual(len(token), 32)

    def test_session_token_hashing(self):
        """Token hashing should be deterministic."""
        token = create_session_token()
        hash1 = hash_session_token(token)
        hash2 = hash_session_token(token)
        self.assertEqual(hash1, hash2)
        # Hash should be 64 chars (SHA256 hex)
        self.assertEqual(len(hash1), 64)

    def test_session_token_verification_valid(self):
        """Valid tokens should verify correctly."""
        token = create_session_token()
        stored_hash = hash_session_token(token)
        self.assertTrue(verify_session_token(token, stored_hash))

    def test_session_token_verification_invalid(self):
        """Invalid tokens should not verify."""
        token = create_session_token()
        stored_hash = hash_session_token(token)
        wrong_token = create_session_token()
        self.assertFalse(verify_session_token(wrong_token, stored_hash))

    def test_session_token_verification_modified_hash(self):
        """Modified hashes should not verify."""
        token = create_session_token()
        stored_hash = hash_session_token(token)
        # Modify one character (always to a different one: the hash may already start with "a")
        modified_hash = ("b" if stored_hash[0] == "a" else "a") + stored_hash[1:]
        self.assertFalse(verify_session_token(token, modified_hash))


class PayloadHashTests(TestCase):
    """Test payload hash computation for replay detection."""

    def test_payload_hash_deterministic(self):
        """Same payload should produce same hash."""
        payload = {
            "session_id": "test-session-123",
            "client_event_id": "event-1",
            "sequence_number": 1,
            "steps_delta": 100,
            "steps_total": 1000,
        }
        hash1 = compute_payload_hash(payload)
        hash2 = compute_payload_hash(payload)
        self.assertEqual(hash1, hash2)

    def test_payload_hash_order_independent(self):
        """Hash should be independent of key order."""
        payload1 = {"a": 1, "b": 2, "c": 3}
        payload2 = {"c": 3, "a": 1, "b": 2}
        self.assertEqual(
            compute_payload_hash(payload1),
            compute_payload_hash(payload2)
        )

    def test_payload_hash_different_values(self):
        """Different values should produce different hashes."""
        payload1 = {"steps_delta": 100}
        payload2 = {"steps_delta": 101}
        self.assertNotEqual(
            compute_payload_hash(payload1),
            compute_payload_hash(payload2)
        )

    def test_payload_hash_ignores_none(self):
        """None values should be excluded from hash."""
        payload1 = {"steps_delta": 100}
        payload2 = {"steps_delta": 100, "ml_motion_label": None}
        self.assertEqual(
            compute_payload_hash(payload1),
            compute_payload_hash(payload2)
        )


class ReplayDetectionTests(TestCase):
    """Test replay attack detection."""

    def setUp(self):
        self.user = User.objects.create_user(
            username="replaytest",
            email="replay@example.com",
            phone_number="254712345500",
            password="testpass123",
        )
        # Create device and session
        self.device = DeviceRegistration.objects.create(
            user=self.user,
            device_id="test-device-123",
            platform="android",
            trust_level="standard",
        )
        session_token = create_session_token()
        self.session = StepSession.objects.create(
            user=self.user,
            device=self.device,
            session_token_hash=hash_session_token(session_token),
            server_nonce="test-nonce",
            expires_at=timezone.now() + timedelta(hours=12),
        )

    def test_first_event_not_replay(self):
        """First event should not be detected as replay."""
        is_replay, reason = detect_replay(
            self.user.id,
            str(self.session.id),
            "unique-event-1",
            1,
            "unique-hash-1",
        )
        self.assertFalse(is_replay)
        self.assertIsNone(reason)

    def test_duplicate_client_event_id_is_replay(self):
        """Duplicate client_event_id should be detected as replay."""
        # Create first event
        StepSyncEvent.objects.create(
            user=self.user,
            session=self.session,
            client_event_id="event-123",
            sequence_number=1,
            payload_hash="hash-1",
        )

        # Attempt to submit same event ID
        is_replay, reason = detect_replay(
            self.user.id,
            str(self.session.id),
            "event-123",
            2,
            "hash-2",
        )
        self.assertTrue(is_replay)
        self.assertIn("Duplicate client_event_id", reason)

    def test_duplicate_sequence_number_is_replay(self):
        """Duplicate sequence_number in same session is replay."""
        # Create first event
        StepSyncEvent.objects.create(
            user=self.user,
            session=self.session,
            client_event_id="event-1",
            sequence_number=5,
            payload_hash="hash-1",
        )

        # Attempt with same sequence number
        is_replay, reason = detect_replay(
            self.user.id,
            str(self.session.id),
            "event-2",
            5,
            "hash-2",
        )
        self.assertTrue(is_replay)
        self.assertIn("Duplicate sequence_number", reason)

    def test_duplicate_payload_hash_quick_retry_allowed(self):
        """Quick retries with same payload are allowed (once)."""
        # Create first event
        StepSyncEvent.objects.create(
            user=self.user,
            session=self.session,
            client_event_id="event-1",
            sequence_number=1,
            payload_hash="same-hash",
            created_at=timezone.now(),
        )

        # Single retry is OK
        is_replay, reason = detect_replay(
            self.user.id,
            str(self.session.id),
            "event-2",
            2,
            "same-hash",
        )
        # With just one prior event, this should pass
        self.assertFalse(is_replay)

    def test_old_payload_hash_is_replay(self):
        """Replaying old payload (>5 min) is detected."""
        # Create old event
        old_time = timezone.now() - timedelta(minutes=10)
        event = StepSyncEvent.objects.create(
            user=self.user,
            session=self.session,
            client_event_id="old-event",
            sequence_number=1,
            payload_hash="old-hash",
        )
        # Manually update created_at to bypass auto_now_add
        StepSyncEvent.objects.filter(pk=event.pk).update(created_at=old_time)

        # Attempt to replay old payload
        is_replay, reason = detect_replay(
            self.user.id,
            str(self.session.id),
            "new-event",
            2,
            "old-hash",
        )
        self.assertTrue(is_replay)
        self.assertIn("replay detected", reason)


class TrustScoreTests(TestCase):
    """Test trust score management."""

    def setUp(self):
        self.user = User.objects.create_user(
            username="trusttest",
            email="trust@example.com",
            phone_number="254712345600",
            password="testpass123",
        )
        self.trust = TrustScore.objects.create(user=self.user, score=100)

    def test_initial_trust_status_good(self):
        """New users start with GOOD status."""
        self.assertEqual(self.trust.status, "GOOD")

    def test_trust_deduction(self):
        """Trust deduction should work correctly."""
        self.trust.deduct(30)
        self.assertEqual(self.trust.score, 70)
        self.assertEqual(self.trust.flags_total, 1)

    def test_trust_deduction_floor(self):
        """Trust score should not go below 0."""
        self.trust.deduct(150)
        self.assertEqual(self.trust.score, 0)
        self.assertEqual(self.trust.status, "BAN")

    def test_trust_recovery(self):
        """Trust recovery should work correctly."""
        self.trust.score = 80
        self.trust.save()
        self.trust.recover(5)
        self.assertEqual(self.trust.score, 85)

    def test_trust_recovery_ceiling(self):
        """Trust score should not exceed 100."""
        self.trust.recover(50)
        self.assertEqual(self.trust.score, 100)

    def test_trust_status_transitions(self):
        """Trust status should change based on score."""
        test_cases = [
            (85, "GOOD"),
            (65, "WARN"),
            (45, "REVIEW"),
            (25, "RESTRICT"),
            (10, "SUSPEND"),
            (0, "BAN"),
        ]
        for score, expected_status in test_cases:
            self.trust.score = score
            self.trust.save()
            self.assertEqual(
                self.trust.status, expected_status,
                f"Score {score} should be {expected_status}"
            )


class AntiCheatRulesTests(TestCase):
    """Test anti-cheat rule evaluation."""

    def setUp(self):
        self.user = User.objects.create_user(
            username="anticheattest",
            email="anticheat@example.com",
            phone_number="254712345700",
            password="testpass123",
        )
        self.trust = TrustScore.objects.create(user=self.user, score=100)
        self.today = date.today()

    def test_normal_steps_accepted(self):
        """Normal step counts should be accepted cleanly."""
        result = run_anti_cheat(
            user=self.user,
            steps=8000,
            date=self.today,
            active_minutes=60,
        )
        self.assertFalse(result.should_block)
        self.assertGreater(result.approved_steps, 0)

    def test_impossible_daily_total_flagged(self):
        """Impossible daily totals (>120k) should be flagged."""
        result = run_anti_cheat(
            user=self.user,
            steps=130000,
            date=self.today,
            active_minutes=1440,
        )
        self.assertTrue(
            result.should_block or result.approved_steps < 130000,
            "Impossible steps should be blocked or capped"
        )

    def test_high_shake_probability_flagged(self):
        """High shake probability should be flagged."""
        result = run_anti_cheat(
            user=self.user,
            steps=10000,
            date=self.today,
            ml_shake_probability=0.90,
            ml_walk_probability=0.10,
            ml_motion_label="shake",
        )
        self.assertGreater(len(result.flags), 0)
        shake_flags = [f for f in result.flags if "shake" in f["flag_type"]]
        self.assertGreater(len(shake_flags), 0)

    def test_high_walk_probability_credits(self):
        """High walk probability should not be flagged."""
        result = run_anti_cheat(
            user=self.user,
            steps=10000,
            date=self.today,
            ml_walk_probability=0.85,
            ml_shake_probability=0.05,
            ml_motion_label="walk",
        )
        # High walk probability should result in clean or low-flag result
        shake_flags = [
            f for f in result.flags
            if "shake" in f["flag_type"] and f["severity"] in ("high", "critical")
        ]
        self.assertEqual(len(shake_flags), 0)

    def test_suspicious_cadence_flagged(self):
        """Cadence above 205 SPM should be flagged as suspicious."""
        result = run_anti_cheat(
            user=self.user,
            steps=15000,
            date=self.today,
            cadence_spm=220,
            active_minutes=60,
        )
        cadence_flags = [f for f in result.flags if "cadence" in f["flag_type"]]
        self.assertGreater(len(cadence_flags), 0)

    def test_impossible_cadence_critical(self):
        """Cadence above 245 SPM is physically impossible."""
        result = run_anti_cheat(
            user=self.user,
            steps=20000,
            date=self.today,
            cadence_spm=260,
            active_minutes=60,
        )
        critical_flags = [
            f for f in result.flags
            if "cadence" in f["flag_type"] and f["severity"] == "critical"
        ]
        self.assertGreater(len(critical_flags), 0)

    def test_low_gait_confidence_flagged(self):
        """Low gait confidence (<20) should be flagged."""
        result = run_anti_cheat(
            user=self.user,
            steps=10000,
            date=self.today,
            gait_confidence=15,
        )
        gait_flags = [f for f in result.flags if "gait" in f["flag_type"]]
        self.assertGreater(len(gait_flags), 0)

    def test_suspicious_gait_state_flagged(self):
        """Suspicious gait state should be flagged."""
        result = run_anti_cheat(
            user=self.user,
            steps=10000,
            date=self.today,
            gait_state="suspicious_motion",
        )
        gait_state_flags = [
            f for f in result.flags if "gait_state" in f["flag_type"]
        ]
        self.assertGreater(len(gait_state_flags), 0)

    def test_daily_cap_enforcement(self):
        """Steps above daily cap should be capped."""
        result = run_anti_cheat(
            user=self.user,
            steps=DAILY_STEP_CAP + 10000,
            date=self.today,
        )
        # Should either cap or flag
        self.assertTrue(
            result.approved_steps <= DAILY_STEP_CAP or len(result.flags) > 0,
            "Steps above cap should be handled"
        )


class BaselineDeviationTests(TestCase):
    """Test baseline deviation detection."""

    def setUp(self):
        self.user = User.objects.create_user(
            username="baselinetest",
            email="baseline@example.com",
            phone_number="254712345800",
            password="testpass123",
        )
        self.trust = TrustScore.objects.create(user=self.user, score=100)
        self.today = date.today()

        # Create baseline history (7 days of ~5000 steps)
        for i in range(1, 8):
            HealthRecord.objects.create(
                user=self.user,
                date=self.today - timedelta(days=i),
                steps=5000 + (i * 100),
                is_suspicious=False,
            )

    def test_normal_deviation_accepted(self):
        """Steps within normal range of baseline accepted."""
        result = run_anti_cheat(
            user=self.user,
            steps=7000,
            date=self.today,
            active_minutes=60,
        )
        baseline_flags = [f for f in result.flags if "baseline" in f["flag_type"]]
        critical_baseline = [
            f for f in baseline_flags if f["severity"] in ("high", "critical")
        ]
        self.assertEqual(len(critical_baseline), 0)

    def test_spike_above_baseline_flagged(self):
        """Large spike above baseline should be flagged."""
        result = run_anti_cheat(
            user=self.user,
            steps=55000,  # 10x+ baseline
            date=self.today,
            active_minutes=600,
        )
        baseline_flags = [f for f in result.flags if "baseline" in f["flag_type"]]
        self.assertGreater(len(baseline_flags), 0)


class StepSyncIntegrationTests(TestCase):
    """Integration tests for step sync flow."""

    def setUp(self):
        self.user = User.objects.create_user(
            username="synctest",
            email="sync@example.com",
            phone_number="254712345900",
            password="testpass123",
            wallet_balance=Decimal("100.00"),
        )
        self.trust = TrustScore.objects.create(user=self.user, score=100)

    def test_full_sync_flow_valid_session(self):
        """Test complete sync flow with valid session."""
        # Create device
        device = DeviceRegistration.objects.create(
            user=self.user,
            device_id="integration-device",
            platform="android",
        )

        # Create session
        session_token = create_session_token()
        session = StepSession.objects.create(
            user=self.user,
            device=device,
            session_token_hash=hash_session_token(session_token),
            server_nonce="integration-nonce",
            expires_at=timezone.now() + timedelta(hours=12),
        )

        # Verify session token works
        self.assertTrue(
            verify_session_token(session_token, session.session_token_hash)
        )

        # Verify replay detection for first event
        is_replay, _ = detect_replay(
            self.user.id,
            str(session.id),
            "first-event",
            1,
            "first-hash",
        )
        self.assertFalse(is_replay)

        # Create first event
        StepSyncEvent.objects.create(
            user=self.user,
            session=session,
            client_event_id="first-event",
            sequence_number=1,
            payload_hash="first-hash",
            steps_delta=1000,
            accepted=True,
        )

        # Verify replay detection for duplicate
        is_replay, _ = detect_replay(
            self.user.id,
            str(session.id),
            "first-event",
            2,
            "different-hash",
        )
        self.assertTrue(is_replay)
