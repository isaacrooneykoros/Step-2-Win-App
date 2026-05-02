

from __future__ import annotations

# ============================================================
# PRODUCTION SECURITY HARDENING: SESSION-LEVEL SCORING
# ============================================================


def score_session(session) -> dict[str, Any]:
    """
    Aggregate session-level risk by analyzing all StepSyncEvents.
    
    Returns comprehensive session risk metrics for finalization.
    """
    from .models import StepSyncEvent
    from .security import get_active_policy
    from django.db.models import Avg, Count, Max
    
    events = StepSyncEvent.objects.filter(session=session).order_by('created_at')
    policy = get_active_policy()
    
    # Aggregate metrics
    stats = events.aggregate(
        total_events=Count('id'),
        accepted_count=Count('id', filter=models.Q(accepted=True)),
        rejected_count=Count('id', filter=models.Q(accepted=False)),
        replay_count=Count('id', filter=models.Q(replay_detected=True)),
        total_steps=Sum('steps_delta', filter=models.Q(accepted=True)),
        avg_walk_prob=Avg('ml_walk_probability', filter=models.Q(ml_walk_probability__isnull=False)),
        avg_shake_prob=Avg('ml_shake_probability', filter=models.Q(ml_shake_probability__isnull=False)),
        max_shake_prob=Max('ml_shake_probability', filter=models.Q(ml_shake_probability__isnull=False)),
        avg_risk=Avg('interval_risk_score'),
        legacy_count=Count('id', filter=models.Q(ml_motion_label__isnull=True)),
    )
    
    total_events = stats['total_events'] or 0
    accepted_count = stats['accepted_count'] or 0
    rejected_count = stats['rejected_count'] or 0
    replay_count = stats['replay_count'] or 0
    total_steps = stats['total_steps'] or 0
    legacy_count = stats['legacy_count'] or 0
    
    # Session-level risk scoring
    session_risk = 0.0
    risk_hits = []
    
    # High replay attempts
    if replay_count > 0:
        replay_penalty = min(50.0, 15.0 + (replay_count * 5.0))
        session_risk += replay_penalty
        risk_hits.append({
            'rule': 'session_replay_detected',
            'severity': 'critical',
            'penalty': replay_penalty,
            'details': f'{replay_count} replay attempts detected',
        })
    
    # High rejection rate
    if total_events > 0:
        rejection_rate = rejected_count / total_events
        if rejection_rate > 0.5:
            rejection_penalty = min(30.0, rejection_rate * 50.0)
            session_risk += rejection_penalty
            risk_hits.append({
                'rule': 'session_high_rejection_rate',
                'severity': 'high',
                'penalty': rejection_penalty,
                'details': f'{rejection_rate*100:.1f}% of events rejected',
            })
    
    # High average shake probability
    avg_shake = stats['avg_shake_prob'] or 0.0
    if avg_shake > 0.60:
        shake_penalty = min(25.0, (avg_shake ** 2) * 30.0)
        session_risk += shake_penalty
        risk_hits.append({
            'rule': 'session_high_avg_shake',
            'severity': 'high',
            'penalty': shake_penalty,
            'details': f'Average shake probability {avg_shake:.2f}',
        })
    
    # Very high steps per minute (physical impossibility check)
    session_duration_minutes = (session.updated_at - session.started_at).total_seconds() / 60.0
    if session_duration_minutes > 0:
        spm = total_steps / max(1.0, session_duration_minutes)
        max_spm = policy.get('session', {}).get('max_steps_per_minute', 180)
        if spm > max_spm * 1.5:  # 50% over normal limit is suspicious
            impossible_penalty = min(35.0, (spm - max_spm) / max_spm * 20.0)
            session_risk += impossible_penalty
            risk_hits.append({
                'rule': 'session_impossible_pace',
                'severity': 'critical',
                'penalty': impossible_penalty,
                'details': f'Pace {spm:.1f} SPM exceeds physical limits',
            })
    
    # Many legacy events (unverified ML)
    if total_events > 0 and legacy_count / total_events > 0.7:
        legacy_penalty = 5.0
        session_risk += legacy_penalty
        risk_hits.append({
            'rule': 'session_mostly_legacy',
            'severity': 'low',
            'penalty': legacy_penalty,
            'details': f'{legacy_count}/{total_events} events missing ML data',
        })
    
    # Session too long (likely spoofing)
    max_session_hours = policy.get('session', {}).get('max_session_hours', 12)
    session_hours = (session.updated_at - session.started_at).total_seconds() / 3600.0
    if session_hours > max_session_hours * 1.5:
        duration_penalty = min(15.0, (session_hours - max_session_hours) / max_session_hours * 10.0)
        session_risk += duration_penalty
        risk_hits.append({
            'rule': 'session_too_long',
            'severity': 'medium',
            'penalty': duration_penalty,
            'details': f'Session {session_hours:.1f}h exceeds max {max_session_hours}h',
        })
    
    # Clamp final risk to [0, 100]
    session_risk = max(0.0, min(100.0, session_risk))
    
    return {
        'total_events': total_events,
        'accepted_events': accepted_count,
        'rejected_events': rejected_count,
        'replay_events': replay_count,
        'legacy_events': legacy_count,
        'total_steps': total_steps,
        'avg_walk_probability': stats['avg_walk_prob'],
        'avg_shake_probability': avg_shake,
        'max_shake_probability': stats['max_shake_prob'],
        'avg_interval_risk': stats['avg_risk'],
        'session_duration_hours': session_hours,
        'steps_per_minute': total_steps / max(1.0, session_duration_minutes),
        'final_session_risk_score': session_risk,
        'risk_hits': risk_hits,
    }


def finalize_step_session(session) -> dict[str, Any]:
    """
    Finalize a session: compute risk, determine rewards, update user trust.
    
    Returns a dict with finalization details for API response.
    """
    from .models import StepSyncEvent, SuspiciousSessionReview
    from .security import update_user_trust_after_session, get_trust_reward_modifier, get_or_create_user_trust_profile
    
    # Compute session-level risk
    session_metrics = score_session(session)
    final_risk = session_metrics['final_session_risk_score']
    
    # Determine reward multiplier based on risk
    if final_risk < 20:
        reward_multiplier = 1.0
    elif final_risk < 40:
        reward_multiplier = 0.85
    elif final_risk < 60:
        reward_multiplier = 0.50
    elif final_risk < 80:
        reward_multiplier = 0.20
    else:
        reward_multiplier = 0.0
    
    # Determine trust adjustment based on session quality
    is_replay = session_metrics['replay_events'] > 0
    trust_adjustment = 0.0
    
    # Update user trust profile
    update_user_trust_after_session(
        session.user,
        session_risk_score=final_risk,
        is_replay=is_replay
    )
    
    # Apply trust multiplier to rewards
    trust_modifier = get_trust_reward_modifier(session.user)
    final_reward_multiplier = reward_multiplier * trust_modifier
    
    # Update session record
    session.session_risk_score = final_risk
    session.trust_adjustment = trust_adjustment
    session.status = 'completed'
    session.ended_at = timezone.now()
    session.save(update_fields=['session_risk_score', 'trust_adjustment', 'status', 'ended_at', 'updated_at'])
    
    # Create review if risk is high
    if final_risk >= 60:
        SuspiciousSessionReview.objects.create(
            user=session.user,
            session=session,
            risk_score=final_risk,
            reason_summary=f'Session risk score {final_risk:.1f} exceeds review threshold',
            risk_hits=session_metrics['risk_hits'],
            status='pending',
        )
    
    return {
        'session_id': str(session.id),
        'status': 'completed',
        'session_risk_score': final_risk,
        'accepted_steps': session_metrics['accepted_events'],
        'rejected_steps': session_metrics['rejected_events'],
        'final_reward_multiplier': final_reward_multiplier,
        'reward_multiplier_breakdown': {
            'session_risk_multiplier': reward_multiplier,
            'trust_modifier': trust_modifier,
        },
        'trust_adjustment': trust_adjustment,
        'message': (
            'Activity synced successfully.' if final_risk < 20 else
            'Some activity could not be fully verified.' if final_risk < 60 else
            'This session requires review.'
        ),
    }
"""Step2Win Anti-Cheat v2.

Interval-first verification with trust-aware scoring and payout-risk signaling.
The legacy `run_anti_cheat` contract is preserved for compatibility while v2
rolls out through feature flags in `steps/views.py`.
"""

import statistics
from dataclasses import dataclass, field
from datetime import date as date_type
from datetime import datetime, time, timedelta
from enum import Enum
from typing import Any

from django.conf import settings
from django.db.models import Avg, Count, Sum
from django.utils import timezone

from .models import HealthRecord
import django.db.models as models

DAILY_STEP_CAP = 60_000
WEEKLY_HARD_CAP = 420_000


class RiskLevel(str, Enum):
    LOW = 'low'
    MEDIUM = 'medium'
    HIGH = 'high'
    CRITICAL = 'critical'


class RuleSeverity(str, Enum):
    LOW = 'low'
    MEDIUM = 'medium'
    HIGH = 'high'
    CRITICAL = 'critical'


class VerificationStatus(str, Enum):
    ACCEPT = 'accept'
    SOFT_CAP = 'soft_cap'
    REVIEW = 'review'
    REJECT = 'reject'


class ReviewState(str, Enum):
    NONE = 'none'
    PENDING = 'pending'
    REQUIRED = 'required'


class PayoutState(str, Enum):
    ELIGIBLE = 'eligible'
    PROVISIONAL = 'provisional'
    HOLD = 'hold'
    FROZEN = 'frozen'


@dataclass(frozen=True)
class StepIntervalInput:
    user_id: int
    source_platform: str
    source_device: str | None
    source_app: str | None
    interval_start: datetime
    interval_end: datetime
    raw_steps: int
    raw_distance_km: float | None = None
    raw_calories: float | None = None
    raw_active_minutes: float | None = None
    cadence_spm: float | None = None
    burst_steps_5s: int | None = None
    gait_state: str | None = None
    gait_confidence: float | None = None
    gait_dominant_freq_hz: float | None = None
    gait_autocorr: float | None = None
    gait_interval_std_ms: float | None = None
    gait_valid_peaks_2s: int | None = None
    gait_gyro_variance: float | None = None
    gait_jerk_rms: float | None = None
    carry_mode: str | None = None
    ml_motion_label: str | None = None
    ml_walk_probability: float | None = None
    ml_shake_probability: float | None = None
    ml_model_version: str | None = None
    submitted_at: datetime | None = None


@dataclass(frozen=True)
class NormalizedInterval:
    user_id: int
    interval_start: datetime
    interval_end: datetime
    bucket_seconds: int
    source_platform: str
    source_device: str | None
    source_app: str | None
    raw_steps: int
    normalized_steps: int
    distance_km: float | None
    calories: float | None
    active_minutes: float | None
    cadence_spm: float | None
    burst_steps_5s: int | None
    gait_state: str | None
    gait_confidence: float | None
    gait_dominant_freq_hz: float | None
    gait_autocorr: float | None
    gait_interval_std_ms: float | None
    gait_valid_peaks_2s: int | None
    gait_gyro_variance: float | None
    gait_jerk_rms: float | None
    carry_mode: str | None
    ml_motion_label: str | None
    ml_walk_probability: float | None
    ml_shake_probability: float | None
    ml_model_version: str | None
    source_confidence: float
    dedupe_key: str


@dataclass(frozen=True)
class RuleHit:
    rule_code: str
    severity: RuleSeverity
    risk_level: RiskLevel
    rule_score: float
    weight: float
    message: str
    evidence: dict[str, Any]


@dataclass(frozen=True)
class IntervalDecision:
    interval: NormalizedInterval
    risk_score: float
    confidence_score: float
    verified_steps: int
    status: VerificationStatus
    review_state: ReviewState
    payout_state: PayoutState
    rule_hits: list[RuleHit]
    explainability: dict[str, Any]


@dataclass(frozen=True)
class DailyDecision:
    user_id: int
    day: date_type
    raw_steps_total: int
    verified_steps_total: int
    suspicious_steps_total: int
    interval_count: int
    accepted_count: int
    review_count: int
    rejected_count: int
    risk_score: float
    review_state: ReviewState
    payout_state: PayoutState
    interval_decisions: list[IntervalDecision]
    audit_snapshot: dict[str, Any]


@dataclass(frozen=True)
class VerificationConfig:
    suspicious_steps_per_minute: float = 165.0
    impossible_steps_per_minute: float = 240.0
    suspicious_cadence_spm: float = 205.0
    impossible_cadence_spm: float = 245.0
    suspicious_burst_steps_5s: int = 18
    impossible_burst_steps_5s: int = 28
    daily_review_threshold_steps: int = 70_000
    daily_impossible_threshold_steps: int = 120_000
    weekly_review_threshold_steps: int = 320_000
    weekly_impossible_threshold_steps: int = 700_000
    baseline_z_soft: float = 2.8
    baseline_z_hard: float = 4.5
    late_sync_grace_hours: int = 24
    late_sync_weight_per_day: float = 0.20
    repeated_pattern_weight: float = 1.4
    hold_risk_threshold: float = 70.0
    review_risk_threshold: float = 45.0
    reject_risk_threshold: float = 90.0
    source_confidence: dict[str, float] = field(default_factory=lambda: {
        'watch_attested': 1.00,
        'watch_unattested': 0.92,
        'phone_sensor': 0.85,
        'google_fit': 0.78,
        'apple_health': 0.80,
        'manual': 0.20,
        'web': 0.70,
    })
    trust_risk_multiplier: dict[str, float] = field(default_factory=lambda: {
        'GOOD': 0.90,
        'WARN': 1.00,
        'REVIEW': 1.15,
        'RESTRICT': 1.35,
        'SUSPEND': 1.70,
        'BAN': 2.00,
    })
    trust_confidence_multiplier: dict[str, float] = field(default_factory=lambda: {
        'GOOD': 1.05,
        'WARN': 1.00,
        'REVIEW': 0.90,
        'RESTRICT': 0.75,
        'SUSPEND': 0.40,
        'BAN': 0.00,
    })

    @classmethod
    def from_settings(cls, django_settings=settings) -> 'VerificationConfig':
        return cls(
            suspicious_steps_per_minute=float(getattr(django_settings, 'ANTICHEAT_V2_SUSPICIOUS_STEPS_PER_MIN', 165.0)),
            impossible_steps_per_minute=float(getattr(django_settings, 'ANTICHEAT_V2_IMPOSSIBLE_STEPS_PER_MIN', 240.0)),
            suspicious_cadence_spm=float(getattr(django_settings, 'ANTICHEAT_V2_SUSPICIOUS_CADENCE_SPM', 205.0)),
            impossible_cadence_spm=float(getattr(django_settings, 'ANTICHEAT_V2_IMPOSSIBLE_CADENCE_SPM', 245.0)),
            suspicious_burst_steps_5s=int(getattr(django_settings, 'ANTICHEAT_V2_SUSPICIOUS_BURST_5S', 18)),
            impossible_burst_steps_5s=int(getattr(django_settings, 'ANTICHEAT_V2_IMPOSSIBLE_BURST_5S', 28)),
            hold_risk_threshold=float(getattr(django_settings, 'ANTICHEAT_V2_PAYOUT_HOLD_RISK', 70.0)),
            review_risk_threshold=float(getattr(django_settings, 'ANTICHEAT_V2_REVIEW_RISK', 45.0)),
            reject_risk_threshold=float(getattr(django_settings, 'ANTICHEAT_V2_REJECT_RISK', 90.0)),
        )


@dataclass(frozen=True)
class TrustContext:
    score: int
    status: str
    recent_flags_7d: int = 0


@dataclass(frozen=True)
class BaselineContext:
    history_days: int
    avg_7d: float
    avg_14d: float
    p99_30d: float
    max_verified_30d: int
    variability_cv_14d: float


@dataclass(frozen=True)
class PayoutRiskDecision:
    payout_state: PayoutState
    hold_reason: str | None
    hold_amount_ratio: float
    requires_manual_review: bool


class CheckResult:
    """Legacy compatibility shape consumed by sync_health view."""

    def __init__(self):
        self.flags: list[dict] = []
        self.approved_steps: int = 0
        self.trust_deduction: int = 0
        self.should_block: bool = False
        self.should_cap: bool = False

    @property
    def is_clean(self):
        return len(self.flags) == 0


def normalize_payload_to_intervals(
    *,
    user_id: int,
    payload: dict[str, Any],
    source_platform: str,
    source_device: str | None,
    source_app: str | None,
    day: date_type,
    submitted_at: datetime,
    config: VerificationConfig,
) -> list[NormalizedInterval]:
    """Normalize daily payload into interval-friendly structure.

    Current v1: one normalized interval per sync (minimal adapter).
    This keeps compatibility while enabling interval decision storage.
    """
    steps = max(0, int(payload.get('steps') or 0))
    active_minutes = payload.get('active_minutes')
    bucket_minutes = 1
    if isinstance(active_minutes, int) and active_minutes > 0:
        bucket_minutes = min(60, max(1, active_minutes))

    source_confidence = config.source_confidence.get(source_platform, 0.75)
    start_dt = timezone.make_aware(datetime.combine(day, time.min), timezone.get_current_timezone())
    end_dt = start_dt + timedelta(minutes=bucket_minutes)
    dedupe_key = f'{user_id}:{source_platform}:{start_dt.isoformat()}:{end_dt.isoformat()}:{steps}'

    return [
        NormalizedInterval(
            user_id=user_id,
            interval_start=start_dt,
            interval_end=end_dt,
            bucket_seconds=bucket_minutes * 60,
            source_platform=source_platform,
            source_device=source_device,
            source_app=source_app,
            raw_steps=steps,
            normalized_steps=steps,
            distance_km=payload.get('distance_km'),
            calories=payload.get('calories_active'),
            active_minutes=active_minutes,
            cadence_spm=payload.get('cadence_spm'),
            burst_steps_5s=payload.get('burst_steps_5s'),
            gait_state=payload.get('gait_state'),
            gait_confidence=payload.get('gait_confidence'),
            gait_dominant_freq_hz=payload.get('gait_dominant_freq_hz'),
            gait_autocorr=payload.get('gait_autocorr'),
            gait_interval_std_ms=payload.get('gait_interval_std_ms'),
            gait_valid_peaks_2s=payload.get('gait_valid_peaks_2s'),
            gait_gyro_variance=payload.get('gait_gyro_variance'),
            gait_jerk_rms=payload.get('gait_jerk_rms'),
            carry_mode=payload.get('carry_mode'),
            ml_motion_label=payload.get('ml_motion_label'),
            ml_walk_probability=payload.get('ml_walk_probability'),
            ml_shake_probability=payload.get('ml_shake_probability'),
            ml_model_version=payload.get('ml_model_version'),
            source_confidence=source_confidence,
            dedupe_key=dedupe_key,
        )
    ]


def deduplicate_intervals(intervals: list[NormalizedInterval]) -> list[NormalizedInterval]:
    """Drop exact duplicates by dedupe key; keep first (highest confidence upstream)."""
    seen: set[str] = set()
    deduped: list[NormalizedInterval] = []
    for interval in sorted(intervals, key=lambda x: (-x.source_confidence, x.interval_start)):
        if interval.dedupe_key in seen:
            continue
        seen.add(interval.dedupe_key)
        deduped.append(interval)
    return deduped


def compute_baseline_context(user, day: date_type) -> BaselineContext:
    """Baseline computed from non-suspicious historical records only."""
    qs_30 = list(
        HealthRecord.objects.filter(
            user=user,
            date__gte=day - timedelta(days=30),
            date__lt=day,
            is_suspicious=False,
        ).values_list('steps', flat=True)
    )
    history_days = len(qs_30)
    if history_days == 0:
        return BaselineContext(
            history_days=0,
            avg_7d=8_000.0,
            avg_14d=8_500.0,
            p99_30d=22_000.0,
            max_verified_30d=25_000,
            variability_cv_14d=0.30,
        )

    last_7 = qs_30[-7:] if history_days >= 7 else qs_30
    last_14 = qs_30[-14:] if history_days >= 14 else qs_30
    avg_7d = float(sum(last_7) / max(1, len(last_7)))
    avg_14d = float(sum(last_14) / max(1, len(last_14)))
    p99_30d = float(sorted(qs_30)[max(0, int(0.99 * (history_days - 1)))])
    max_verified_30d = int(max(qs_30))
    if len(last_14) >= 2 and statistics.mean(last_14) > 0:
        variability_cv = statistics.stdev(last_14) / statistics.mean(last_14)
    else:
        variability_cv = 0.35

    return BaselineContext(
        history_days=history_days,
        avg_7d=avg_7d,
        avg_14d=avg_14d,
        p99_30d=p99_30d,
        max_verified_30d=max_verified_30d,
        variability_cv_14d=float(variability_cv),
    )


def _mk_hit(rule_code: str, severity: RuleSeverity, score: float, weight: float, message: str, evidence: dict[str, Any]) -> RuleHit:
    return RuleHit(
        rule_code=rule_code,
        severity=severity,
        risk_level=RiskLevel(severity.value),
        rule_score=score,
        weight=weight,
        message=message,
        evidence=evidence,
    )


def score_interval(
    interval: NormalizedInterval,
    *,
    trust: TrustContext,
    baseline: BaselineContext,
    config: VerificationConfig,
    day: date_type,
    now: datetime,
) -> tuple[float, list[RuleHit], dict[str, Any]]:
    hits: list[RuleHit] = []

    # Rule: impossible daily total is critical; high totals alone are only review signals.
    if interval.normalized_steps > config.daily_impossible_threshold_steps:
        hits.append(_mk_hit(
            'daily_total_impossible', RuleSeverity.CRITICAL, 1.0, 60.0,
            'Submitted daily total exceeds impossible threshold.',
            {'steps': interval.normalized_steps, 'threshold': config.daily_impossible_threshold_steps},
        ))
    elif interval.normalized_steps > config.daily_review_threshold_steps:
        hits.append(_mk_hit(
            'daily_total_review', RuleSeverity.MEDIUM, 0.4, 8.0,
            'High daily total requires corroborating behavior checks.',
            {'steps': interval.normalized_steps, 'threshold': config.daily_review_threshold_steps},
        ))

    minutes = max(1.0, float(interval.active_minutes or interval.bucket_seconds / 60.0))
    spm = interval.normalized_steps / minutes
    if spm > config.impossible_steps_per_minute:
        hits.append(_mk_hit(
            'steps_per_min_impossible', RuleSeverity.CRITICAL, 1.0, 40.0,
            'Steps-per-minute exceeds humanly plausible limits.',
            {'spm': round(spm, 1), 'threshold': config.impossible_steps_per_minute},
        ))
    elif spm > config.suspicious_steps_per_minute:
        hits.append(_mk_hit(
            'steps_per_min_suspicious', RuleSeverity.HIGH, 0.8, 20.0,
            'Steps-per-minute unusually high for sustained movement.',
            {'spm': round(spm, 1), 'threshold': config.suspicious_steps_per_minute},
        ))

    if interval.cadence_spm is not None:
        if interval.cadence_spm > config.impossible_cadence_spm:
            hits.append(_mk_hit(
                'cadence_impossible', RuleSeverity.CRITICAL, 1.0, 35.0,
                'Cadence exceeds plausible gait limits.',
                {'cadence_spm': interval.cadence_spm, 'threshold': config.impossible_cadence_spm},
            ))
        elif interval.cadence_spm > config.suspicious_cadence_spm:
            hits.append(_mk_hit(
                'cadence_suspicious', RuleSeverity.MEDIUM, 0.6, 10.0,
                'Cadence is suspiciously high and should be reviewed.',
                {'cadence_spm': interval.cadence_spm, 'threshold': config.suspicious_cadence_spm},
            ))

    if interval.burst_steps_5s is not None:
        if interval.burst_steps_5s > config.impossible_burst_steps_5s:
            hits.append(_mk_hit(
                'burst_impossible', RuleSeverity.HIGH, 0.8, 16.0,
                'Short-window burst exceeds plausible acceleration.',
                {'burst_steps_5s': interval.burst_steps_5s, 'threshold': config.impossible_burst_steps_5s},
            ))
        elif interval.burst_steps_5s > config.suspicious_burst_steps_5s:
            hits.append(_mk_hit(
                'burst_suspicious', RuleSeverity.MEDIUM, 0.5, 8.0,
                'Short-window burst is unusually high.',
                {'burst_steps_5s': interval.burst_steps_5s, 'threshold': config.suspicious_burst_steps_5s},
            ))

    if interval.gait_confidence is not None:
        if interval.gait_confidence < 20:
            hits.append(_mk_hit(
                'gait_confidence_very_low', RuleSeverity.HIGH, 0.9, 16.0,
                'Motion confidence is too low for reliable walking gait.',
                {'gait_confidence': interval.gait_confidence},
            ))
        elif interval.gait_confidence < 40:
            hits.append(_mk_hit(
                'gait_confidence_low', RuleSeverity.MEDIUM, 0.5, 8.0,
                'Weak gait confidence suggests non-walking motion.',
                {'gait_confidence': interval.gait_confidence},
            ))

    if interval.gait_state == 'suspicious_motion':
        hits.append(_mk_hit(
            'gait_state_suspicious', RuleSeverity.HIGH, 0.8, 14.0,
            'Sensor state machine flagged suspicious motion.',
            {'gait_state': interval.gait_state},
        ))

    if interval.gait_dominant_freq_hz is not None:
        if not (0.8 <= interval.gait_dominant_freq_hz <= 3.0):
            hits.append(_mk_hit(
                'gait_frequency_out_of_band', RuleSeverity.MEDIUM, 0.5, 7.0,
                'Dominant motion frequency falls outside walking band.',
                {'dominant_freq_hz': interval.gait_dominant_freq_hz},
            ))

    if interval.gait_autocorr is not None and interval.gait_autocorr < 0.35:
        hits.append(_mk_hit(
            'gait_periodicity_low', RuleSeverity.MEDIUM, 0.6, 9.0,
            'Poor periodicity indicates non-rhythmic movement.',
            {'gait_autocorr': interval.gait_autocorr},
        ))

    if interval.gait_interval_std_ms is not None:
        if interval.gait_interval_std_ms > 320:
            hits.append(_mk_hit(
                'gait_interval_variability_high', RuleSeverity.HIGH, 0.8, 12.0,
                'Step interval variability is too high for normal gait.',
                {'interval_std_ms': interval.gait_interval_std_ms},
            ))
        elif interval.gait_interval_std_ms > 180:
            hits.append(_mk_hit(
                'gait_interval_variability_moderate', RuleSeverity.MEDIUM, 0.5, 7.0,
                'Step interval consistency is weaker than expected.',
                {'interval_std_ms': interval.gait_interval_std_ms},
            ))

    if interval.gait_valid_peaks_2s is not None and interval.gait_valid_peaks_2s < 3 and interval.normalized_steps > 0:
        hits.append(_mk_hit(
            'gait_peak_run_short', RuleSeverity.MEDIUM, 0.5, 8.0,
            'Too few consecutive gait-like peaks were detected.',
            {'gait_valid_peaks_2s': interval.gait_valid_peaks_2s},
        ))

    if interval.gait_jerk_rms is not None and interval.gait_jerk_rms > 18:
        hits.append(_mk_hit(
            'gait_jerk_high', RuleSeverity.HIGH, 0.7, 10.0,
            'Excessive jerk suggests abrupt shaking rather than walking.',
            {'gait_jerk_rms': interval.gait_jerk_rms},
        ))

    if interval.gait_gyro_variance is not None and interval.gait_gyro_variance > 4.0:
        hits.append(_mk_hit(
            'gait_rotation_chaotic', RuleSeverity.MEDIUM, 0.6, 8.0,
            'Rotation variance is too chaotic for steady gait.',
            {'gait_gyro_variance': interval.gait_gyro_variance},
        ))

    if interval.carry_mode == 'in_hand' and interval.cadence_spm is not None and interval.cadence_spm > 185:
        hits.append(_mk_hit(
            'in_hand_high_cadence', RuleSeverity.MEDIUM, 0.4, 6.0,
            'High cadence while in hand requires stronger gait evidence.',
            {'carry_mode': interval.carry_mode, 'cadence_spm': interval.cadence_spm},
        ))

    if interval.ml_shake_probability is not None:
        if interval.ml_shake_probability >= 0.80:
            hits.append(_mk_hit(
                'ml_shake_high_probability', RuleSeverity.HIGH, 0.9, 18.0,
                'ML classifier indicates high shake probability.',
                {
                    'ml_shake_probability': interval.ml_shake_probability,
                    'ml_motion_label': interval.ml_motion_label,
                    'ml_model_version': interval.ml_model_version,
                },
            ))
        elif interval.ml_shake_probability >= 0.65:
            hits.append(_mk_hit(
                'ml_shake_moderate_probability', RuleSeverity.MEDIUM, 0.6, 9.0,
                'ML classifier indicates moderate shake probability.',
                {
                    'ml_shake_probability': interval.ml_shake_probability,
                    'ml_motion_label': interval.ml_motion_label,
                    'ml_model_version': interval.ml_model_version,
                },
            ))

    if interval.ml_walk_probability is not None and interval.ml_walk_probability >= 0.70:
        hits.append(_mk_hit(
            'ml_walk_high_probability', RuleSeverity.LOW, -0.35, 7.0,
            'ML classifier indicates high walk probability.',
            {
                'ml_walk_probability': interval.ml_walk_probability,
                'ml_motion_label': interval.ml_motion_label,
                'ml_model_version': interval.ml_model_version,
            },
        ))

    if interval.ml_motion_label == 'shake' and interval.ml_walk_probability is not None and interval.ml_walk_probability < 0.40:
        hits.append(_mk_hit(
            'ml_label_shake', RuleSeverity.HIGH, 0.7, 12.0,
            'ML classifier labeled this interval as shake-dominant.',
            {
                'ml_motion_label': interval.ml_motion_label,
                'ml_walk_probability': interval.ml_walk_probability,
                'ml_shake_probability': interval.ml_shake_probability,
                'ml_model_version': interval.ml_model_version,
            },
        ))

    # Personal baseline deviation from clean history.
    baseline_anchor = max(1.0, baseline.avg_14d)
    ratio = interval.normalized_steps / baseline_anchor
    if baseline.history_days >= 5 and ratio > 10.0:
        hits.append(_mk_hit(
            'baseline_spike_hard', RuleSeverity.HIGH, 0.7, 14.0,
            'Submitted steps are far above personal clean baseline.',
            {'ratio': round(ratio, 2), 'avg_14d': round(baseline.avg_14d)},
        ))
    elif baseline.history_days >= 5 and ratio > 5.0:
        hits.append(_mk_hit(
            'baseline_spike_soft', RuleSeverity.MEDIUM, 0.5, 8.0,
            'Submitted steps are significantly above personal clean baseline.',
            {'ratio': round(ratio, 2), 'avg_14d': round(baseline.avg_14d)},
        ))

    days_late = (now.date() - day).days
    if days_late > 1:
        late_score = min(1.0, config.late_sync_weight_per_day * max(0, days_late - 1))
        hits.append(_mk_hit(
            'late_sync', RuleSeverity.MEDIUM, late_score, 6.0,
            'Late backfilled sync increases fraud risk.',
            {'days_late': days_late},
        ))

    if baseline.variability_cv_14d < 0.05 and baseline.history_days >= 7:
        hits.append(_mk_hit(
            'repeated_pattern', RuleSeverity.MEDIUM, 0.5, 6.0 * config.repeated_pattern_weight,
            'Historically low variance pattern can indicate scripted behavior.',
            {'cv_14d': round(baseline.variability_cv_14d, 4)},
        ))

    weighted_sum = sum(hit.rule_score * hit.weight for hit in hits)
    risk_multiplier = config.trust_risk_multiplier.get(trust.status, 1.0)
    risk_score = max(0.0, min(100.0, weighted_sum * risk_multiplier))

    evidence = {
        'rule_hits': len(hits),
        'steps_per_minute': round(spm, 2),
        'baseline_ratio': round(ratio, 2),
        'source_confidence': interval.source_confidence,
        'trust_status': trust.status,
        'gait_state': interval.gait_state,
        'gait_confidence': interval.gait_confidence,
        'gait_dominant_freq_hz': interval.gait_dominant_freq_hz,
        'gait_autocorr': interval.gait_autocorr,
        'gait_interval_std_ms': interval.gait_interval_std_ms,
        'gait_valid_peaks_2s': interval.gait_valid_peaks_2s,
        'gait_gyro_variance': interval.gait_gyro_variance,
        'gait_jerk_rms': interval.gait_jerk_rms,
        'carry_mode': interval.carry_mode,
        'ml_motion_label': interval.ml_motion_label,
        'ml_walk_probability': interval.ml_walk_probability,
        'ml_shake_probability': interval.ml_shake_probability,
        'ml_model_version': interval.ml_model_version,
    }
    return risk_score, hits, evidence


def verify_interval(
    interval: NormalizedInterval,
    *,
    risk_score: float,
    rule_hits: list[RuleHit],
    trust: TrustContext,
    config: VerificationConfig,
) -> IntervalDecision:
    base_conf = 0.95
    source_mult = interval.source_confidence
    trust_mult = config.trust_confidence_multiplier.get(trust.status, 1.0)
    pattern_mult = max(0.35, 1.0 - (risk_score / 180.0))
    confidence = max(0.0, min(1.0, base_conf * source_mult * trust_mult * pattern_mult))

    has_critical = any(hit.severity == RuleSeverity.CRITICAL for hit in rule_hits)
    if has_critical or risk_score >= config.reject_risk_threshold:
        status = VerificationStatus.REJECT
        review_state = ReviewState.REQUIRED
        payout_state = PayoutState.FROZEN
        status_mult = 0.0
    elif risk_score >= config.hold_risk_threshold:
        status = VerificationStatus.REVIEW
        review_state = ReviewState.REQUIRED
        payout_state = PayoutState.HOLD
        status_mult = 0.60
    elif risk_score >= config.review_risk_threshold:
        status = VerificationStatus.SOFT_CAP
        review_state = ReviewState.PENDING
        payout_state = PayoutState.PROVISIONAL
        status_mult = 0.85
    else:
        status = VerificationStatus.ACCEPT
        review_state = ReviewState.NONE
        payout_state = PayoutState.ELIGIBLE
        status_mult = 1.0

    verified_steps = int(round(interval.normalized_steps * confidence * status_mult))
    verified_steps = max(0, min(interval.normalized_steps, verified_steps))

    return IntervalDecision(
        interval=interval,
        risk_score=risk_score,
        confidence_score=confidence,
        verified_steps=verified_steps,
        status=status,
        review_state=review_state,
        payout_state=payout_state,
        rule_hits=rule_hits,
        explainability={
            'base_confidence': base_conf,
            'source_multiplier': source_mult,
            'trust_multiplier': trust_mult,
            'pattern_multiplier': pattern_mult,
            'status_multiplier': status_mult,
        },
    )


def aggregate_daily_decision(*, user_id: int, day: date_type, interval_decisions: list[IntervalDecision]) -> DailyDecision:
    raw_total = sum(d.interval.normalized_steps for d in interval_decisions)
    verified_total = sum(d.verified_steps for d in interval_decisions)
    suspicious_total = sum(
        max(0, d.interval.normalized_steps - d.verified_steps)
        for d in interval_decisions
    )
    accepted = sum(1 for d in interval_decisions if d.status == VerificationStatus.ACCEPT)
    review = sum(1 for d in interval_decisions if d.status == VerificationStatus.REVIEW)
    rejected = sum(1 for d in interval_decisions if d.status == VerificationStatus.REJECT)
    risk_score = max((d.risk_score for d in interval_decisions), default=0.0)

    if rejected:
        review_state = ReviewState.REQUIRED
        payout_state = PayoutState.FROZEN
    elif review:
        review_state = ReviewState.PENDING
        payout_state = PayoutState.HOLD
    else:
        review_state = ReviewState.NONE
        payout_state = PayoutState.ELIGIBLE

    return DailyDecision(
        user_id=user_id,
        day=day,
        raw_steps_total=raw_total,
        verified_steps_total=verified_total,
        suspicious_steps_total=suspicious_total,
        interval_count=len(interval_decisions),
        accepted_count=accepted,
        review_count=review,
        rejected_count=rejected,
        risk_score=risk_score,
        review_state=review_state,
        payout_state=payout_state,
        interval_decisions=interval_decisions,
        audit_snapshot={
            'verified_ratio': round(verified_total / max(1, raw_total), 4),
            'accepted_ratio': round(accepted / max(1, len(interval_decisions)), 4),
        },
    )


def compute_trust_delta(*, trust: TrustContext, daily: DailyDecision) -> int:
    if daily.review_state == ReviewState.REQUIRED and daily.risk_score >= 70:
        return -12
    if daily.review_state == ReviewState.PENDING:
        return -4
    if daily.risk_score < 20 and daily.verified_steps_total > 0:
        return +1
    return 0


def compute_payout_risk(*, trust: TrustContext, daily: DailyDecision) -> PayoutRiskDecision:
    if trust.status in {'SUSPEND', 'BAN'}:
        return PayoutRiskDecision(
            payout_state=PayoutState.FROZEN,
            hold_reason='trust_status_block',
            hold_amount_ratio=1.0,
            requires_manual_review=True,
        )
    if daily.payout_state in {PayoutState.HOLD, PayoutState.FROZEN}:
        hold_ratio = min(1.0, max(0.25, daily.risk_score / 100.0))
        return PayoutRiskDecision(
            payout_state=daily.payout_state,
            hold_reason='risk_threshold',
            hold_amount_ratio=hold_ratio,
            requires_manual_review=True,
        )
    return PayoutRiskDecision(
        payout_state=PayoutState.ELIGIBLE,
        hold_reason=None,
        hold_amount_ratio=0.0,
        requires_manual_review=False,
    )


def evaluate_daily_submission(
    *,
    user,
    payload: dict[str, Any],
    day: date_type,
    submitted_at: datetime,
    trust_score: int,
    trust_status: str,
    source_platform: str,
    source_device: str | None,
    source_app: str | None,
    config: VerificationConfig | None = None,
) -> DailyDecision:
    config = config or VerificationConfig()
    trust_ctx = TrustContext(score=trust_score, status=trust_status)
    baseline = compute_baseline_context(user, day)

    normalized = normalize_payload_to_intervals(
        user_id=user.id,
        payload=payload,
        source_platform=source_platform,
        source_device=source_device,
        source_app=source_app,
        day=day,
        submitted_at=submitted_at,
        config=config,
    )
    deduped = deduplicate_intervals(normalized)

    decisions: list[IntervalDecision] = []
    for interval in deduped:
        risk_score, hits, _ = score_interval(
            interval,
            trust=trust_ctx,
            baseline=baseline,
            config=config,
            day=day,
            now=submitted_at,
        )
        decisions.append(verify_interval(
            interval,
            risk_score=risk_score,
            rule_hits=hits,
            trust=trust_ctx,
            config=config,
        ))

    return aggregate_daily_decision(user_id=user.id, day=day, interval_decisions=decisions)


def decision_to_check_result(daily: DailyDecision) -> CheckResult:
    """Map v2 structured decision to legacy sync_health contract."""
    result = CheckResult()
    result.approved_steps = daily.verified_steps_total

    flags: list[dict[str, Any]] = []
    for interval_decision in daily.interval_decisions:
        for hit in interval_decision.rule_hits:
            flags.append({
                'flag_type': hit.rule_code,
                'severity': hit.severity.value,
                'details': hit.evidence | {'message': hit.message},
            })
    result.flags = flags

    sev_weight = {'low': 0, 'medium': 3, 'high': 8, 'critical': 15}
    result.trust_deduction = sum(sev_weight.get(flag['severity'], 3) for flag in flags)
    result.should_block = daily.review_state == ReviewState.REQUIRED and daily.payout_state == PayoutState.FROZEN
    result.should_cap = any(d.status in {VerificationStatus.SOFT_CAP, VerificationStatus.REVIEW} for d in daily.interval_decisions)
    return result


def run_anti_cheat(
    user,
    steps: int,
    date,
    distance_km=None,
    calories=None,
    active_minutes=None,
    cadence_spm=None,
    burst_steps_5s=None,
    gait_state=None,
    gait_confidence=None,
    gait_dominant_freq_hz=None,
    gait_autocorr=None,
    gait_interval_std_ms=None,
    gait_valid_peaks_2s=None,
    gait_gyro_variance=None,
    gait_jerk_rms=None,
    carry_mode=None,
    ml_motion_label=None,
    ml_walk_probability=None,
    ml_shake_probability=None,
    ml_model_version=None,
    submitted_at=None,
) -> CheckResult:
    """Backward-compatible adapter for existing call sites and tests."""
    submitted_at = submitted_at or timezone.now()
    payload = {
        'steps': steps,
        'distance_km': distance_km,
        'calories_active': calories,
        'active_minutes': active_minutes,
        'cadence_spm': cadence_spm,
        'burst_steps_5s': burst_steps_5s,
        'gait_state': gait_state,
        'gait_confidence': gait_confidence,
        'gait_dominant_freq_hz': gait_dominant_freq_hz,
        'gait_autocorr': gait_autocorr,
        'gait_interval_std_ms': gait_interval_std_ms,
        'gait_valid_peaks_2s': gait_valid_peaks_2s,
        'gait_gyro_variance': gait_gyro_variance,
        'gait_jerk_rms': gait_jerk_rms,
        'carry_mode': carry_mode,
        'ml_motion_label': ml_motion_label,
        'ml_walk_probability': ml_walk_probability,
        'ml_shake_probability': ml_shake_probability,
        'ml_model_version': ml_model_version,
    }

    trust = getattr(user, 'trust_score', None)
    trust_score = trust.score if trust else 100
    trust_status = trust.status if trust else 'GOOD'

    daily = evaluate_daily_submission(
        user=user,
        payload=payload,
        day=date,
        submitted_at=submitted_at,
        trust_score=trust_score,
        trust_status=trust_status,
        source_platform='device_sensor',
        source_device=getattr(user, 'device_platform', None),
        source_app='legacy_sync',
        config=VerificationConfig.from_settings(settings),
    )
    return decision_to_check_result(daily)
