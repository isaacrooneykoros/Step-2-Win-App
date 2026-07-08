"""
Security utilities for session management, replay detection, and token handling.
"""

import hashlib
import secrets
import json
from datetime import datetime, timedelta
from typing import Optional, Tuple
from django.utils import timezone
from django.conf import settings


def create_session_token(length: int = 32) -> str:
    """Generate a high-entropy random session token."""
    return secrets.token_urlsafe(length)


def hash_session_token(token: str) -> str:
    """Hash a session token for secure storage."""
    return hashlib.sha256(token.encode()).hexdigest()


def verify_session_token(raw_token: str, stored_hash: str) -> bool:
    """Verify a raw token against its stored hash."""
    return hash_session_token(raw_token) == stored_hash


def compute_payload_hash(payload: dict) -> str:
    """
    Compute a stable SHA256 hash of normalized payload fields.

    Only includes fields that should be covered by the hash:
    - session_id
    - client_event_id
    - sequence_number
    - timestamp_client
    - steps_delta
    - steps_total
    - ml_motion_label
    - ml_walk_probability (rounded to 4 decimals)
    - ml_shake_probability (rounded to 4 decimals)
    - ml_model_version

    Do NOT include volatile fields that change server-side.
    """
    # Extract and normalize fields
    hashable_fields = {
        'session_id': payload.get('session_id'),
        'client_event_id': payload.get('client_event_id'),
        'sequence_number': payload.get('sequence_number'),
        'timestamp_client': payload.get('timestamp_client'),
        'steps_delta': payload.get('steps_delta'),
        'steps_total': payload.get('steps_total'),
        'ml_motion_label': payload.get('ml_motion_label'),
        'ml_walk_probability': round(float(payload.get('ml_walk_probability') or 0), 4),
        'ml_shake_probability': round(float(payload.get('ml_shake_probability') or 0), 4),
        'ml_model_version': payload.get('ml_model_version'),
    }

    # Remove None/null values for consistent hashing
    hashable_fields = {k: v for k, v in hashable_fields.items() if v is not None}

    # Sort and serialize to JSON for consistent ordering
    normalized_json = json.dumps(hashable_fields, sort_keys=True, separators=(',', ':'))

    # Compute SHA256
    return hashlib.sha256(normalized_json.encode()).hexdigest()


def detect_replay(user_id: int, session_id: Optional[str], client_event_id: str,
                  sequence_number: Optional[int], payload_hash: str) -> Tuple[bool, Optional[str]]:
    """
    Detect replay attacks based on multiple signals.

    Returns: (is_replay: bool, reason: str | None)
    """
    from .models import StepSyncEvent

    # Check 1: Duplicate client_event_id for same user (most direct replay indicator)
    if client_event_id:
        existing = StepSyncEvent.objects.filter(
            user_id=user_id,
            client_event_id=client_event_id
        ).first()

        if existing:
            # Already submitted this exact event
            return True, f"Duplicate client_event_id: {client_event_id}"

    # Check 2: Duplicate sequence_number in same session (sequence violation)
    if session_id and sequence_number:
        existing = StepSyncEvent.objects.filter(
            session_id=session_id,
            sequence_number=sequence_number
        ).first()

        if existing:
            return True, f"Duplicate sequence_number {sequence_number} in session {session_id}"

    # Check 3: Duplicate payload_hash for same user (exact replay of payload)
    if payload_hash:
        # Allow multiple exact payloads within a short time window (legitimate retries)
        # but flag if the same hash appears more than once over a longer period
        recent_count = StepSyncEvent.objects.filter(
            user_id=user_id,
            payload_hash=payload_hash,
            created_at__gte=timezone.now() - timedelta(seconds=30)
        ).count()

        if recent_count > 1:
            return True, f"Duplicate payload_hash within 30 seconds (retry attack)"

        # Flag if exact same payload appears after 5 minutes (likely replay)
        old_count = StepSyncEvent.objects.filter(
            user_id=user_id,
            payload_hash=payload_hash,
            created_at__lt=timezone.now() - timedelta(seconds=300)
        ).count()

        if old_count > 0:
            return True, f"Exact payload repeated after 5 minutes (replay detected)"

    return False, None


def is_session_expired(session) -> bool:
    """Check if a session has expired."""
    return session.expires_at <= timezone.now()


def is_session_valid(session) -> bool:
    """Check if a session is still valid for accepting syncs."""
    return (
        session.status == 'active' and
        not is_session_expired(session)
    )


def get_or_create_user_trust_profile(user):
    """Get or lazily create UserTrustProfile for a user."""
    from .models import UserTrustProfile

    profile, created = UserTrustProfile.objects.get_or_create(
        user=user,
        defaults={
            'trust_score': 50.0,
            'trust_tier': 'new',
        }
    )
    return profile


def update_trust_tier(profile) -> None:
    """Update trust_tier based on trust_score."""
    score = profile.trust_score

    if score <= 20:
        profile.trust_tier = 'restricted'
    elif score <= 40:
        profile.trust_tier = 'low'
    elif score <= 70:
        profile.trust_tier = 'standard'
    else:
        profile.trust_tier = 'trusted'

    profile.save(update_fields=['trust_tier', 'updated_at'])


def update_user_trust_after_session(user, session_risk_score: float, is_replay: bool = False) -> None:
    """
    Update user trust profile after a session is finalized.

    Trust adjustments:
    - Clean session (risk < 20): +0.5 to +1.0
    - Moderate session (risk 20-40): no change or -0.5
    - Suspicious session (risk 40-59): -2
    - High risk (risk 60-79): -5
    - Critical (risk >= 80): -10
    - Replay detected: -15
    """
    from .models import UserTrustProfile

    profile = get_or_create_user_trust_profile(user)

    # Base trust adjustment from session risk
    if is_replay:
        adjustment = -15.0
        profile.replay_attempts_count += 1
    elif session_risk_score < 20:
        adjustment = 1.0
        profile.verified_sessions_count += 1
    elif session_risk_score < 40:
        adjustment = 0.0
        profile.verified_sessions_count += 1
    elif session_risk_score < 60:
        adjustment = -2.0
        profile.suspicious_sessions_count += 1
    elif session_risk_score < 80:
        adjustment = -5.0
        profile.suspicious_sessions_count += 1
    else:
        adjustment = -10.0
        profile.suspicious_sessions_count += 1

    # Apply adjustment, clamped to [0, 100]
    profile.trust_score = max(0.0, min(100.0, profile.trust_score + adjustment))

    # Update timestamps
    if session_risk_score >= 40:
        profile.last_suspicious_at = timezone.now()
    else:
        profile.last_verified_at = timezone.now()

    profile.save(update_fields=[
        'trust_score', 'verified_sessions_count', 'suspicious_sessions_count',
        'replay_attempts_count', 'last_suspicious_at', 'last_verified_at', 'updated_at'
    ])

    # Update tier based on new score
    update_trust_tier(profile)


def get_trust_reward_modifier(user) -> float:
    """
    Get reward multiplier based on user's trust tier.

    - trusted: 1.00
    - standard: 0.95
    - new: 0.90
    - low: 0.75
    - restricted: 0.40
    """
    from .models import UserTrustProfile

    profile = get_or_create_user_trust_profile(user)

    modifiers = {
        'trusted': 1.00,
        'standard': 0.95,
        'new': 0.90,
        'low': 0.75,
        'restricted': 0.40,
    }

    return modifiers.get(profile.trust_tier, 0.95)


def get_active_policy():
    """
    Get the active AntiCheatPolicy, with safe default fallback.

    Returns AntiCheatPolicy.config as a dict.
    """
    from .models import AntiCheatPolicy

    policy = AntiCheatPolicy.objects.filter(is_active=True).first()

    if policy:
        return policy.config

    # Safe default config if no active policy exists
    return {
        'ml': {
            'high_shake_threshold': 0.80,
            'moderate_shake_threshold': 0.65,
            'high_walk_threshold': 0.70,
            'shake_risk_max': 30.0,
            'walk_credit_max': 8.0,
            'label_shake_penalty': 12.0,
            'legacy_unverified_penalty': 8.0,
        },
        'session': {
            'max_steps_per_minute': 180,
            'max_session_hours': 12,
            'min_windows_for_full_trust': 5,
            'high_interval_variability_ms': 180,
        },
        'trust': {
            'min_trust_score': 0,
            'max_trust_score': 100,
            'default_trust_score': 50,
        }
    }


def get_active_policy_version() -> str:
    """Get active policy version string."""
    from .models import AntiCheatPolicy

    policy = AntiCheatPolicy.objects.filter(is_active=True).first()
    return policy.version if policy else 'default-v1'
