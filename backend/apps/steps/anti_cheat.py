from __future__ import annotations

# ============================================================
# PRODUCTION SECURITY HARDENING: SESSION-LEVEL SCORING
# ============================================================


def score_session(session) -> dict[str, Any]:
    """
    Aggregate session-level risk by analyzing all StepSyncEvents.

    Returns comprehensive session risk metrics for finalization.
    """
    from django.db.models import Avg, Count, Max

    from .models import StepSyncEvent
    from .security import get_active_policy

    events = StepSyncEvent.objects.filter(session=session).order_by("created_at")
    policy = get_active_policy()

    # Aggregate metrics
    stats = events.aggregate(
        total_events=Count("id"),
        accepted_count=Count("id", filter=models.Q(accepted=True)),
        rejected_count=Count("id", filter=models.Q(accepted=False)),
        replay_count=Count("id", filter=models.Q(replay_detected=True)),
        total_steps=Sum("steps_delta", filter=models.Q(accepted=True)),
        avg_walk_prob=Avg(
            "ml_walk_probability", filter=models.Q(ml_walk_probability__isnull=False)
        ),
        avg_shake_prob=Avg(
            "ml_shake_probability", filter=models.Q(ml_shake_probability__isnull=False)
        ),
        max_shake_prob=Max(
            "ml_shake_probability", filter=models.Q(ml_shake_probability__isnull=False)
        ),
        avg_risk=Avg("interval_risk_score"),
        legacy_count=Count("id", filter=models.Q(ml_motion_label__isnull=True)),
    )

    total_events = stats["total_events"] or 0
    accepted_count = stats["accepted_count"] or 0
    rejected_count = stats["rejected_count"] or 0
    replay_count = stats["replay_count"] or 0
    total_steps = stats["total_steps"] or 0
    legacy_count = stats["legacy_count"] or 0

    # Session-level risk scoring
    session_risk = 0.0
    risk_hits = []

    # High replay attempts
    if replay_count > 0:
        replay_penalty = min(50.0, 15.0 + (replay_count * 5.0))
        session_risk += replay_penalty
        risk_hits.append(
            {
                "rule": "session_replay_detected",
                "severity": "critical",
                "penalty": replay_penalty,
                "details": f"{replay_count} replay attempts detected",
            }
        )

    # High rejection rate
    if total_events > 0:
        rejection_rate = rejected_count / total_events
        if rejection_rate > 0.5:
            rejection_penalty = min(30.0, rejection_rate * 50.0)
            session_risk += rejection_penalty
            risk_hits.append(
                {
                    "rule": "session_high_rejection_rate",
                    "severity": "high",
                    "penalty": rejection_penalty,
                    "details": f"{rejection_rate*100:.1f}% of events rejected",
                }
            )

    # High average shake probability
    avg_shake = stats["avg_shake_prob"] or 0.0
    if avg_shake > 0.60:
        shake_penalty = min(25.0, (avg_shake**2) * 30.0)
        session_risk += shake_penalty
        risk_hits.append(
            {
                "rule": "session_high_avg_shake",
                "severity": "high",
                "penalty": shake_penalty,
                "details": f"Average shake probability {avg_shake:.2f}",
            }
        )

    # Very high steps per minute (physical impossibility check)
    session_duration_minutes = (
        session.updated_at - session.started_at
    ).total_seconds() / 60.0
    if session_duration_minutes > 0:
        spm = total_steps / max(1.0, session_duration_minutes)
        max_spm = policy.get("session", {}).get("max_steps_per_minute", 180)
        if spm > max_spm * 1.5:  # 50% over normal limit is suspicious
            impossible_penalty = min(35.0, (spm - max_spm) / max_spm * 20.0)
            session_risk += impossible_penalty
            risk_hits.append(
                {
                    "rule": "session_impossible_pace",
                    "severity": "critical",
                    "penalty": impossible_penalty,
                    "details": f"Pace {spm:.1f} SPM exceeds physical limits",
                }
            )

    # Many legacy events (unverified ML). iOS exposes no raw motion stream, so iPhone
    # sessions never carry ML labels; don't penalise them for that alone (all other
    # session and interval rules still apply).
    device = getattr(session, "device", None)
    is_ios_session = bool(device and (getattr(device, "platform", "") or "").lower() == "ios")
    if total_events > 0 and legacy_count / total_events > 0.7 and not is_ios_session:
        legacy_penalty = 5.0
        session_risk += legacy_penalty
        risk_hits.append(
            {
                "rule": "session_mostly_legacy",
                "severity": "low",
                "penalty": legacy_penalty,
                "details": f"{legacy_count}/{total_events} events missing ML data",
            }
        )

    # Session too long (likely spoofing)
    max_session_hours = policy.get("session", {}).get("max_session_hours", 12)
    session_hours = (session.updated_at - session.started_at).total_seconds() / 3600.0
    if session_hours > max_session_hours * 1.5:
        duration_penalty = min(
            15.0, (session_hours - max_session_hours) / max_session_hours * 10.0
        )
        session_risk += duration_penalty
        risk_hits.append(
            {
                "rule": "session_too_long",
                "severity": "medium",
                "penalty": duration_penalty,
                "details": f"Session {session_hours:.1f}h exceeds max {max_session_hours}h",
            }
        )

    # Clamp final risk to [0, 100]
    session_risk = max(0.0, min(100.0, session_risk))

    return {
        "total_events": total_events,
        "accepted_events": accepted_count,
        "rejected_events": rejected_count,
        "replay_events": replay_count,
        "legacy_events": legacy_count,
        "total_steps": total_steps,
        "avg_walk_probability": stats["avg_walk_prob"],
        "avg_shake_probability": avg_shake,
        "max_shake_probability": stats["max_shake_prob"],
        "avg_interval_risk": stats["avg_risk"],
        "session_duration_hours": session_hours,
        "steps_per_minute": total_steps / max(1.0, session_duration_minutes),
        "final_session_risk_score": session_risk,
        "risk_hits": risk_hits,
    }


def finalize_step_session(session) -> dict[str, Any]:
    """
    Finalize a session: compute risk, determine rewards, update user trust.

    Returns a dict with finalization details for API response.
    """
    from .models import StepSyncEvent, SuspiciousSessionReview
    from .security import (get_or_create_user_trust_profile,
                           get_trust_reward_modifier,
                           update_user_trust_after_session)

    # Compute session-level risk
    session_metrics = score_session(session)
    final_risk = session_metrics["final_session_risk_score"]

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
    is_replay = session_metrics["replay_events"] > 0
    trust_adjustment = 0.0

    # Update user trust profile
    update_user_trust_after_session(
        session.user, session_risk_score=final_risk, is_replay=is_replay
    )

    # Apply trust multiplier to rewards
    trust_modifier = get_trust_reward_modifier(session.user)
    final_reward_multiplier = reward_multiplier * trust_modifier

    # Update session record
    session.session_risk_score = final_risk
    session.trust_adjustment = trust_adjustment
    session.status = "completed"
    session.ended_at = timezone.now()
    session.save(
        update_fields=[
            "session_risk_score",
            "trust_adjustment",
            "status",
            "ended_at",
            "updated_at",
        ]
    )

    # Create review if risk is high
    if final_risk >= 60:
        SuspiciousSessionReview.objects.create(
            user=session.user,
            session=session,
            risk_score=final_risk,
            reason_summary=f"Session risk score {final_risk:.1f} exceeds review threshold",
            risk_hits=session_metrics["risk_hits"],
            status="pending",
        )

    return {
        "session_id": str(session.id),
        "status": "completed",
        "session_risk_score": final_risk,
        "accepted_steps": session_metrics["accepted_events"],
        "rejected_steps": session_metrics["rejected_events"],
        "final_reward_multiplier": final_reward_multiplier,
        "reward_multiplier_breakdown": {
            "session_risk_multiplier": reward_multiplier,
            "trust_modifier": trust_modifier,
        },
        "trust_adjustment": trust_adjustment,
        "message": (
            "Activity synced successfully."
            if final_risk < 20
            else (
                "Some activity could not be fully verified."
                if final_risk < 60
                else "This session requires review."
            )
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
from datetime import timezone as dt_timezone
from enum import Enum
from typing import Any

import django.db.models as models
from django.conf import settings
from django.db.models import Avg, Count, Sum
from django.utils import timezone

from .models import HealthRecord

DAILY_STEP_CAP = 60_000
WEEKLY_HARD_CAP = 420_000

# Bumped when the day-level bookkeeping in HealthRecord.anticheat changes meaning.
# Rows without it were written by the pre-Phase-0 engine (see views.sync_health).
ANTICHEAT_DAY_VERSION = 1

# ── Velocity (steps vs elapsed time) ─────────────────────────────────────────
# A sprint is ~3.5 steps/s; the Android ledger clamps at 4 steps/s. Up to this rate
# (plus headroom for batching and clock skew) a delta is credited; beyond it the
# excess is kept as *unverified* (deferred, not counted) until time catches up.
VELOCITY_PLAUSIBLE_STEPS_PER_S = 4.0
VELOCITY_PLAUSIBLE_HEADROOM = 600
DAY_BOUND_HEADROOM = 2_000
# Clearly impossible (twice a sprint, sustained, plus a big allowance): 400 + HIGH flag.
VELOCITY_IMPOSSIBLE_STEPS_PER_S = 8.0
VELOCITY_IMPOSSIBLE_HEADROOM = 5_000
# The server does not know the phone's time zone. The plausible first-sync bound
# assumes the market's offset (EAT, UTC+3) plus a tolerance; the impossible bound
# assumes the most generous offset on Earth (UTC+14).
DEFAULT_DEVICE_UTC_OFFSET_HOURS = 3.0
DEVICE_OFFSET_TOLERANCE_HOURS = 2.0
MAX_DEVICE_UTC_OFFSET_HOURS = 14.0

# ── Gait gating ───────────────────────────────────────────────────────────────
# The uploaded gait is a snapshot of the last ~3 s, not a summary of the credited
# steps. "No walking seen" rules only mean something when this sync credits a
# non-trivial number of steps AND the window actually covered movement.
GAIT_MIN_DELTA_STEPS = 100

# Rules that positively indicate shaking / non-walking step generation. They stay
# effective whenever steps are credited (any delta > 0), even for a resting snapshot.
SHAKE_POSITIVE_RULES = frozenset(
    {"ml_shake_high_probability", "ml_label_shake", "gait_state_suspicious"}
)
# Rules that only say "the snapshot did not look like walking". Neutral at rest.
GAIT_ABSENCE_RULES = frozenset(
    {
        "gait_confidence_very_low",
        "gait_confidence_low",
        "gait_frequency_out_of_band",
        "gait_periodicity_low",
        "gait_interval_variability_high",
        "gait_interval_variability_moderate",
        "gait_peak_run_short",
    }
)

# Below this risk, MEDIUM/LOW hits don't reduce credit (single weak signals).
RISK_FREE_ALLOWANCE = 10.0

# Trust deductions from sync evidence (per sync, then capped per user per server day).
TRUST_DEDUCT_HIGH = 8
TRUST_DEDUCT_CRITICAL = 15
# Sync evidence alone never pushes an account into SUSPEND (score <= 20); that is an
# admin decision. 21 is the lowest RESTRICT score.
TRUST_SYNC_FLOOR = 21


class RiskLevel(str, Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


class RuleSeverity(str, Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


class VerificationStatus(str, Enum):
    ACCEPT = "accept"
    SOFT_CAP = "soft_cap"
    REVIEW = "review"
    REJECT = "reject"


class ReviewState(str, Enum):
    NONE = "none"
    PENDING = "pending"
    REQUIRED = "required"


class PayoutState(str, Enum):
    ELIGIBLE = "eligible"
    PROVISIONAL = "provisional"
    HOLD = "hold"
    FROZEN = "frozen"


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
    # Steps this sync would credit (plausible delta). None = legacy caller: the
    # whole total is evaluated as one interval, as before.
    delta_steps: int | None = None
    # True only when the client states the burst number was computed from live,
    # per-step timestamps (burst_source == "live_timed").
    burst_live: bool = False

    @property
    def credit_steps(self) -> int:
        return self.normalized_steps if self.delta_steps is None else self.delta_steps


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
    # Keyed by the *server-derived* source (see resolve_source_key), never by the
    # free `source` field the client sends.
    source_confidence: dict[str, float] = field(
        default_factory=lambda: {
            # Registered Android/iOS device, step session verified: the phone's own
            # step counter. Credited in full when nothing else is wrong.
            "phone_sensor_session": 1.00,
            # Phone without a step session (legacy HMAC-signed path).
            "phone_unsessioned": 0.90,
            # Unknown caller of the legacy run_anti_cheat adapter.
            "device_sensor": 0.90,
            "watch_attested": 1.00,
            "watch_unattested": 0.92,
            "phone_sensor": 0.85,
            "google_fit": 0.78,
            "apple_health": 0.80,
            "manual": 0.20,
            "web": 0.70,
        }
    )
    # The client's `source` label can only LOWER confidence (min with the above).
    client_source_cap: dict[str, float] = field(
        default_factory=lambda: {
            "device_sensor": 1.00,
            "apple_health": 1.00,
            "google_fit": 0.90,
            "manual": 0.20,
        }
    )
    trust_risk_multiplier: dict[str, float] = field(
        default_factory=lambda: {
            "GOOD": 0.90,
            "WARN": 1.00,
            "REVIEW": 1.15,
            "RESTRICT": 1.35,
            "SUSPEND": 1.70,
            "BAN": 2.00,
        }
    )
    trust_confidence_multiplier: dict[str, float] = field(
        default_factory=lambda: {
            "GOOD": 1.00,
            "WARN": 1.00,
            "REVIEW": 0.90,
            "RESTRICT": 0.75,
            "SUSPEND": 0.40,
            "BAN": 0.00,
        }
    )

    @classmethod
    def from_settings(cls, django_settings=settings) -> "VerificationConfig":
        return cls(
            suspicious_steps_per_minute=float(
                getattr(django_settings, "ANTICHEAT_V2_SUSPICIOUS_STEPS_PER_MIN", 165.0)
            ),
            impossible_steps_per_minute=float(
                getattr(django_settings, "ANTICHEAT_V2_IMPOSSIBLE_STEPS_PER_MIN", 240.0)
            ),
            suspicious_cadence_spm=float(
                getattr(django_settings, "ANTICHEAT_V2_SUSPICIOUS_CADENCE_SPM", 205.0)
            ),
            impossible_cadence_spm=float(
                getattr(django_settings, "ANTICHEAT_V2_IMPOSSIBLE_CADENCE_SPM", 245.0)
            ),
            suspicious_burst_steps_5s=int(
                getattr(django_settings, "ANTICHEAT_V2_SUSPICIOUS_BURST_5S", 18)
            ),
            impossible_burst_steps_5s=int(
                getattr(django_settings, "ANTICHEAT_V2_IMPOSSIBLE_BURST_5S", 28)
            ),
            hold_risk_threshold=float(
                getattr(django_settings, "ANTICHEAT_V2_PAYOUT_HOLD_RISK", 70.0)
            ),
            review_risk_threshold=float(
                getattr(django_settings, "ANTICHEAT_V2_REVIEW_RISK", 45.0)
            ),
            reject_risk_threshold=float(
                getattr(django_settings, "ANTICHEAT_V2_REJECT_RISK", 90.0)
            ),
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
        # MEDIUM+ rule hits as FraudFlag kwargs. LOW (credit/informational) hits are
        # never here. Which of them are persisted is decided by the view: HIGH and
        # CRITICAL always, MEDIUM only as supporting evidence of a suspicious day.
        self.flags: list[dict] = []
        # Credited steps for the evaluated steps (the delta when one was given).
        self.approved_steps: int = 0
        # Per-sync trust deduction (HIGH/CRITICAL evidence only). The view caps it
        # per user per day and never lets sync evidence alone reach SUSPEND.
        self.trust_deduction: int = 0
        self.should_block: bool = False
        self.should_cap: bool = False
        # Strong evidence => the day is excluded from challenge money (sticky).
        self.strong_evidence: bool = False
        self.strong_reasons: list[str] = []
        self.has_critical: bool = False
        self.risk_score: float = 0.0
        self.credit_multiplier: float = 1.0
        # Neutral observations (at-rest snapshot, batched burst, late sync, ...).
        self.notes: list[str] = []

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
    steps = max(0, int(payload.get("steps") or 0))
    active_minutes = payload.get("active_minutes")
    bucket_minutes = 1
    if isinstance(active_minutes, int) and active_minutes > 0:
        bucket_minutes = min(60, max(1, active_minutes))

    source_confidence = config.source_confidence.get(source_platform, 0.75)
    client_source = payload.get("client_source")
    if client_source:
        source_confidence = min(
            source_confidence, config.client_source_cap.get(client_source, 0.75)
        )
    delta_steps = payload.get("steps_delta_credit")
    if delta_steps is not None:
        delta_steps = max(0, min(steps, int(delta_steps)))
    start_dt = timezone.make_aware(
        datetime.combine(day, time.min), timezone.get_current_timezone()
    )
    end_dt = start_dt + timedelta(minutes=bucket_minutes)
    dedupe_key = f"{user_id}:{source_platform}:{start_dt.isoformat()}:{end_dt.isoformat()}:{steps}"

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
            distance_km=payload.get("distance_km"),
            calories=payload.get("calories_active"),
            active_minutes=active_minutes,
            cadence_spm=payload.get("cadence_spm"),
            burst_steps_5s=payload.get("burst_steps_5s"),
            gait_state=payload.get("gait_state"),
            gait_confidence=payload.get("gait_confidence"),
            gait_dominant_freq_hz=payload.get("gait_dominant_freq_hz"),
            gait_autocorr=payload.get("gait_autocorr"),
            gait_interval_std_ms=payload.get("gait_interval_std_ms"),
            gait_valid_peaks_2s=payload.get("gait_valid_peaks_2s"),
            gait_gyro_variance=payload.get("gait_gyro_variance"),
            gait_jerk_rms=payload.get("gait_jerk_rms"),
            carry_mode=payload.get("carry_mode"),
            ml_motion_label=payload.get("ml_motion_label"),
            ml_walk_probability=payload.get("ml_walk_probability"),
            ml_shake_probability=payload.get("ml_shake_probability"),
            ml_model_version=payload.get("ml_model_version"),
            source_confidence=source_confidence,
            dedupe_key=dedupe_key,
            delta_steps=delta_steps,
            burst_live=payload.get("burst_source") == "live_timed",
        )
    ]


def deduplicate_intervals(
    intervals: list[NormalizedInterval],
) -> list[NormalizedInterval]:
    """Drop exact duplicates by dedupe key; keep first (highest confidence upstream)."""
    seen: set[str] = set()
    deduped: list[NormalizedInterval] = []
    for interval in sorted(
        intervals, key=lambda x: (-x.source_confidence, x.interval_start)
    ):
        if interval.dedupe_key in seen:
            continue
        seen.add(interval.dedupe_key)
        deduped.append(interval)
    return deduped


BASELINE_MIN_HISTORY_DAYS = 7


def compute_baseline_context(user, day: date_type) -> BaselineContext:
    """Baseline computed from non-suspicious historical records only.

    Uses the RAW daily totals the phone reported (last_raw_steps) so it compares like
    with like against the raw submitted total; rows written before raw totals were
    stored fall back to `steps`. Most recent days first.
    """
    rows = list(
        HealthRecord.objects.filter(
            user=user,
            date__gte=day - timedelta(days=30),
            date__lt=day,
            is_suspicious=False,
        )
        .order_by("-date")
        .values_list("last_raw_steps", "steps")
    )
    qs_30 = [int(raw) if raw else int(steps) for raw, steps in rows]
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

    # qs_30 is newest-first: the first N entries are the most recent N days.
    last_7 = qs_30[:7]
    last_14 = qs_30[:14]
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


def _mk_hit(
    rule_code: str,
    severity: RuleSeverity,
    score: float,
    weight: float,
    message: str,
    evidence: dict[str, Any],
) -> RuleHit:
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
        hits.append(
            _mk_hit(
                "daily_total_impossible",
                RuleSeverity.CRITICAL,
                1.0,
                60.0,
                "Submitted daily total exceeds impossible threshold.",
                {
                    "steps": interval.normalized_steps,
                    "threshold": config.daily_impossible_threshold_steps,
                },
            )
        )
    elif interval.normalized_steps > config.daily_review_threshold_steps:
        hits.append(
            _mk_hit(
                "daily_total_review",
                RuleSeverity.MEDIUM,
                0.4,
                8.0,
                "High daily total requires corroborating behavior checks.",
                {
                    "steps": interval.normalized_steps,
                    "threshold": config.daily_review_threshold_steps,
                },
            )
        )

    minutes = max(1.0, float(interval.active_minutes or interval.bucket_seconds / 60.0))
    spm = interval.normalized_steps / minutes
    if spm > config.impossible_steps_per_minute:
        hits.append(
            _mk_hit(
                "steps_per_min_impossible",
                RuleSeverity.CRITICAL,
                1.0,
                40.0,
                "Steps-per-minute exceeds humanly plausible limits.",
                {"spm": round(spm, 1), "threshold": config.impossible_steps_per_minute},
            )
        )
    elif spm > config.suspicious_steps_per_minute:
        hits.append(
            _mk_hit(
                "steps_per_min_suspicious",
                RuleSeverity.HIGH,
                0.8,
                20.0,
                "Steps-per-minute unusually high for sustained movement.",
                {"spm": round(spm, 1), "threshold": config.suspicious_steps_per_minute},
            )
        )

    if interval.cadence_spm is not None:
        if interval.cadence_spm > config.impossible_cadence_spm:
            hits.append(
                _mk_hit(
                    "cadence_impossible",
                    RuleSeverity.CRITICAL,
                    1.0,
                    35.0,
                    "Cadence exceeds plausible gait limits.",
                    {
                        "cadence_spm": interval.cadence_spm,
                        "threshold": config.impossible_cadence_spm,
                    },
                )
            )
        elif interval.cadence_spm > config.suspicious_cadence_spm:
            hits.append(
                _mk_hit(
                    "cadence_suspicious",
                    RuleSeverity.MEDIUM,
                    0.6,
                    10.0,
                    "Cadence is suspiciously high and should be reviewed.",
                    {
                        "cadence_spm": interval.cadence_spm,
                        "threshold": config.suspicious_cadence_spm,
                    },
                )
            )

    credit = interval.credit_steps
    has_gait = any(
        value is not None
        for value in (
            interval.gait_state,
            interval.gait_confidence,
            interval.gait_dominant_freq_hz,
            interval.gait_autocorr,
            interval.gait_interval_std_ms,
            interval.gait_valid_peaks_2s,
        )
    )
    # "App opened while sitting": the analyzer's window saw no movement and no step
    # events arrived in the last minute. Such a snapshot says nothing about the steps
    # being credited (they were walked earlier): no gait evidence either way.
    at_rest = interval.gait_state == "idle" and not (
        interval.cadence_spm is not None and interval.cadence_spm > 0
    )
    gait_absence_applies = credit >= GAIT_MIN_DELTA_STEPS and not at_rest
    shake_applies = credit > 0
    notes: list[str] = []
    if has_gait and at_rest and credit > 0:
        notes.append("gait_snapshot_at_rest")
    if has_gait and not at_rest and 0 < credit < GAIT_MIN_DELTA_STEPS:
        notes.append("gait_delta_trivial")
    if not has_gait:
        notes.append("gait_not_measured")

    # Bursts: Android stamps every step of a batched hardware-counter event with the
    # arrival time, so a normal batch looks like a burst. Only live, per-step timed
    # bursts are evidence (client sends burst_source="live_timed").
    if interval.burst_steps_5s is not None and not interval.burst_live:
        if interval.burst_steps_5s > config.suspicious_burst_steps_5s:
            notes.append("burst_untimed_ignored")
    if interval.burst_steps_5s is not None and interval.burst_live and shake_applies:
        if interval.burst_steps_5s > config.impossible_burst_steps_5s:
            hits.append(
                _mk_hit(
                    "burst_impossible",
                    RuleSeverity.HIGH,
                    0.8,
                    16.0,
                    "Short-window burst exceeds plausible acceleration.",
                    {
                        "burst_steps_5s": interval.burst_steps_5s,
                        "threshold": config.impossible_burst_steps_5s,
                    },
                )
            )
        elif interval.burst_steps_5s > config.suspicious_burst_steps_5s:
            hits.append(
                _mk_hit(
                    "burst_suspicious",
                    RuleSeverity.MEDIUM,
                    0.5,
                    8.0,
                    "Short-window burst is unusually high.",
                    {
                        "burst_steps_5s": interval.burst_steps_5s,
                        "threshold": config.suspicious_burst_steps_5s,
                    },
                )
            )

    if interval.gait_confidence is not None and gait_absence_applies:
        if interval.gait_confidence < 20:
            hits.append(
                _mk_hit(
                    "gait_confidence_very_low",
                    RuleSeverity.HIGH,
                    0.9,
                    16.0,
                    "Motion confidence is too low for reliable walking gait.",
                    {"gait_confidence": interval.gait_confidence, "delta_steps": credit},
                )
            )
        elif interval.gait_confidence < 40:
            hits.append(
                _mk_hit(
                    "gait_confidence_low",
                    RuleSeverity.MEDIUM,
                    0.5,
                    8.0,
                    "Weak gait confidence suggests non-walking motion.",
                    {"gait_confidence": interval.gait_confidence, "delta_steps": credit},
                )
            )

    if interval.gait_state == "suspicious_motion" and shake_applies:
        hits.append(
            _mk_hit(
                "gait_state_suspicious",
                RuleSeverity.HIGH,
                0.8,
                14.0,
                "Sensor state machine flagged suspicious motion.",
                {"gait_state": interval.gait_state, "delta_steps": credit},
            )
        )

    if interval.gait_dominant_freq_hz is not None and gait_absence_applies:
        if not (0.8 <= interval.gait_dominant_freq_hz <= 3.0):
            hits.append(
                _mk_hit(
                    "gait_frequency_out_of_band",
                    RuleSeverity.MEDIUM,
                    0.5,
                    7.0,
                    "Dominant motion frequency falls outside walking band.",
                    {"dominant_freq_hz": interval.gait_dominant_freq_hz},
                )
            )

    if (
        interval.gait_autocorr is not None
        and interval.gait_autocorr < 0.35
        and gait_absence_applies
    ):
        hits.append(
            _mk_hit(
                "gait_periodicity_low",
                RuleSeverity.MEDIUM,
                0.6,
                9.0,
                "Poor periodicity indicates non-rhythmic movement.",
                {"gait_autocorr": interval.gait_autocorr},
            )
        )

    if interval.gait_interval_std_ms is not None and gait_absence_applies:
        if interval.gait_interval_std_ms > 320:
            hits.append(
                _mk_hit(
                    "gait_interval_variability_high",
                    RuleSeverity.HIGH,
                    0.8,
                    12.0,
                    "Step interval variability is too high for normal gait.",
                    {"interval_std_ms": interval.gait_interval_std_ms},
                )
            )
        elif interval.gait_interval_std_ms > 180:
            hits.append(
                _mk_hit(
                    "gait_interval_variability_moderate",
                    RuleSeverity.MEDIUM,
                    0.5,
                    7.0,
                    "Step interval consistency is weaker than expected.",
                    {"interval_std_ms": interval.gait_interval_std_ms},
                )
            )

    if (
        interval.gait_valid_peaks_2s is not None
        and interval.gait_valid_peaks_2s < 3
        and gait_absence_applies
    ):
        hits.append(
            _mk_hit(
                "gait_peak_run_short",
                RuleSeverity.MEDIUM,
                0.5,
                8.0,
                "Too few consecutive gait-like peaks were detected.",
                {"gait_valid_peaks_2s": interval.gait_valid_peaks_2s},
            )
        )

    if (
        interval.gait_jerk_rms is not None
        and interval.gait_jerk_rms > 18
        and shake_applies
    ):
        hits.append(
            _mk_hit(
                "gait_jerk_high",
                RuleSeverity.HIGH,
                0.7,
                10.0,
                "Excessive jerk suggests abrupt shaking rather than walking.",
                {"gait_jerk_rms": interval.gait_jerk_rms},
            )
        )

    if (
        interval.gait_gyro_variance is not None
        and interval.gait_gyro_variance > 4.0
        and shake_applies
    ):
        hits.append(
            _mk_hit(
                "gait_rotation_chaotic",
                RuleSeverity.MEDIUM,
                0.6,
                8.0,
                "Rotation variance is too chaotic for steady gait.",
                {"gait_gyro_variance": interval.gait_gyro_variance},
            )
        )

    if (
        interval.carry_mode == "in_hand"
        and interval.cadence_spm is not None
        and interval.cadence_spm > 185
        and shake_applies
    ):
        hits.append(
            _mk_hit(
                "in_hand_high_cadence",
                RuleSeverity.MEDIUM,
                0.4,
                6.0,
                "High cadence while in hand requires stronger gait evidence.",
                {
                    "carry_mode": interval.carry_mode,
                    "cadence_spm": interval.cadence_spm,
                },
            )
        )

    if interval.ml_shake_probability is not None and shake_applies:
        if interval.ml_shake_probability >= 0.80:
            hits.append(
                _mk_hit(
                    "ml_shake_high_probability",
                    RuleSeverity.HIGH,
                    0.9,
                    18.0,
                    "ML classifier indicates high shake probability.",
                    {
                        "ml_shake_probability": interval.ml_shake_probability,
                        "ml_motion_label": interval.ml_motion_label,
                        "ml_model_version": interval.ml_model_version,
                        "delta_steps": credit,
                    },
                )
            )
        elif interval.ml_shake_probability >= 0.65:
            hits.append(
                _mk_hit(
                    "ml_shake_moderate_probability",
                    RuleSeverity.MEDIUM,
                    0.6,
                    9.0,
                    "ML classifier indicates moderate shake probability.",
                    {
                        "ml_shake_probability": interval.ml_shake_probability,
                        "ml_motion_label": interval.ml_motion_label,
                        "ml_model_version": interval.ml_model_version,
                    },
                )
            )

    # Credit rule (negative score). LOW: never a FraudFlag, never suspicion.
    if (
        interval.ml_walk_probability is not None
        and interval.ml_walk_probability >= 0.70
    ):
        hits.append(
            _mk_hit(
                "ml_walk_high_probability",
                RuleSeverity.LOW,
                -0.35,
                7.0,
                "ML classifier indicates high walk probability.",
                {
                    "ml_walk_probability": interval.ml_walk_probability,
                    "ml_motion_label": interval.ml_motion_label,
                    "ml_model_version": interval.ml_model_version,
                },
            )
        )

    if (
        interval.ml_motion_label == "shake"
        and interval.ml_walk_probability is not None
        and interval.ml_walk_probability < 0.40
        and shake_applies
    ):
        hits.append(
            _mk_hit(
                "ml_label_shake",
                RuleSeverity.HIGH,
                0.7,
                12.0,
                "ML classifier labeled this interval as shake-dominant.",
                {
                    "ml_motion_label": interval.ml_motion_label,
                    "ml_walk_probability": interval.ml_walk_probability,
                    "ml_shake_probability": interval.ml_shake_probability,
                    "ml_model_version": interval.ml_model_version,
                    "delta_steps": credit,
                },
            )
        )

    # Personal baseline deviation from clean history (raw vs raw, most recent days).
    # A big day (hike, event, a 25-30k day for a 5k/day walker) is plausible: MEDIUM
    # at most, so it only adds risk and never excludes a day on its own.
    baseline_anchor = max(1.0, baseline.avg_14d)
    ratio = interval.normalized_steps / baseline_anchor
    if baseline.history_days >= BASELINE_MIN_HISTORY_DAYS and ratio > 10.0:
        hits.append(
            _mk_hit(
                "baseline_spike_hard",
                RuleSeverity.MEDIUM,
                0.7,
                12.0,
                "Submitted steps are far above personal clean baseline.",
                {"ratio": round(ratio, 2), "avg_14d": round(baseline.avg_14d)},
            )
        )
    elif baseline.history_days >= BASELINE_MIN_HISTORY_DAYS and ratio > 5.0:
        hits.append(
            _mk_hit(
                "baseline_spike_soft",
                RuleSeverity.MEDIUM,
                0.5,
                8.0,
                "Submitted steps are significantly above personal clean baseline.",
                {"ratio": round(ratio, 2), "avg_14d": round(baseline.avg_14d)},
            )
        )

    # Offline catch-up (rural users, data bundles) is normal. LOW/informational: it
    # only adds a little risk when other evidence exists, and never excludes a day.
    days_late = (now.date() - day).days
    if days_late > 1:
        late_score = min(1.0, config.late_sync_weight_per_day * max(0, days_late - 1))
        hits.append(
            _mk_hit(
                "late_sync",
                RuleSeverity.LOW,
                late_score,
                6.0,
                "Late backfilled sync (informational; weighs only with other evidence).",
                {"days_late": days_late},
            )
        )

    if baseline.variability_cv_14d < 0.05 and baseline.history_days >= 7:
        hits.append(
            _mk_hit(
                "repeated_pattern",
                RuleSeverity.MEDIUM,
                0.5,
                6.0 * config.repeated_pattern_weight,
                "Historically low variance pattern can indicate scripted behavior.",
                {"cv_14d": round(baseline.variability_cv_14d, 4)},
            )
        )

    has_other_evidence = any(
        hit.severity != RuleSeverity.LOW and hit.rule_code != "late_sync" for hit in hits
    )
    weighted_sum = sum(
        hit.rule_score * hit.weight
        for hit in hits
        if hit.rule_code != "late_sync" or has_other_evidence
    )
    risk_multiplier = config.trust_risk_multiplier.get(trust.status, 1.0)
    risk_score = max(0.0, min(100.0, weighted_sum * risk_multiplier))

    evidence = {
        "rule_hits": len(hits),
        "steps_per_minute": round(spm, 2),
        "baseline_ratio": round(ratio, 2),
        "source_confidence": interval.source_confidence,
        "trust_status": trust.status,
        "delta_steps": credit,
        "gait_measured": has_gait,
        "gait_at_rest": at_rest,
        "gait_absence_rules_applied": gait_absence_applies,
        "burst_live": interval.burst_live,
        "notes": notes,
        "gait_state": interval.gait_state,
        "gait_confidence": interval.gait_confidence,
        "gait_dominant_freq_hz": interval.gait_dominant_freq_hz,
        "gait_autocorr": interval.gait_autocorr,
        "gait_interval_std_ms": interval.gait_interval_std_ms,
        "gait_valid_peaks_2s": interval.gait_valid_peaks_2s,
        "gait_gyro_variance": interval.gait_gyro_variance,
        "gait_jerk_rms": interval.gait_jerk_rms,
        "carry_mode": interval.carry_mode,
        "ml_motion_label": interval.ml_motion_label,
        "ml_walk_probability": interval.ml_walk_probability,
        "ml_shake_probability": interval.ml_shake_probability,
        "ml_model_version": interval.ml_model_version,
    }
    return risk_score, hits, evidence


def verify_interval(
    interval: NormalizedInterval,
    *,
    risk_score: float,
    rule_hits: list[RuleHit],
    trust: TrustContext,
    config: VerificationConfig,
    evidence: dict[str, Any] | None = None,
) -> IntervalDecision:
    # A clean sync from a trustworthy source credits exactly what the phone counted
    # (no blanket base discount). Real risk still lowers credit through the pattern
    # multiplier once it exceeds a small allowance (a single weak signal is free).
    base_conf = 1.0
    source_mult = interval.source_confidence
    trust_mult = config.trust_confidence_multiplier.get(trust.status, 1.0)
    pattern_mult = max(
        0.35, 1.0 - (max(0.0, risk_score - RISK_FREE_ALLOWANCE) / 180.0)
    )
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

    credit = interval.credit_steps
    verified_steps = int(round(credit * confidence * status_mult))
    verified_steps = max(0, min(credit, verified_steps))

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
            "base_confidence": base_conf,
            "source_multiplier": source_mult,
            "trust_multiplier": trust_mult,
            "pattern_multiplier": pattern_mult,
            "status_multiplier": status_mult,
            "credit_steps": credit,
            "evidence": {
                key: value
                for key, value in (evidence or {}).items()
                if key
                in (
                    "delta_steps",
                    "gait_measured",
                    "gait_at_rest",
                    "gait_absence_rules_applied",
                    "burst_live",
                    "notes",
                )
            },
        },
    )


def aggregate_daily_decision(
    *, user_id: int, day: date_type, interval_decisions: list[IntervalDecision]
) -> DailyDecision:
    raw_total = sum(d.interval.normalized_steps for d in interval_decisions)
    verified_total = sum(d.verified_steps for d in interval_decisions)
    suspicious_total = sum(
        max(0, d.interval.credit_steps - d.verified_steps) for d in interval_decisions
    )
    accepted = sum(
        1 for d in interval_decisions if d.status == VerificationStatus.ACCEPT
    )
    review = sum(1 for d in interval_decisions if d.status == VerificationStatus.REVIEW)
    rejected = sum(
        1 for d in interval_decisions if d.status == VerificationStatus.REJECT
    )
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
            "verified_ratio": round(verified_total / max(1, raw_total), 4),
            "accepted_ratio": round(accepted / max(1, len(interval_decisions)), 4),
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


def compute_payout_risk(
    *, trust: TrustContext, daily: DailyDecision
) -> PayoutRiskDecision:
    if trust.status in {"SUSPEND", "BAN"}:
        return PayoutRiskDecision(
            payout_state=PayoutState.FROZEN,
            hold_reason="trust_status_block",
            hold_amount_ratio=1.0,
            requires_manual_review=True,
        )
    if daily.payout_state in {PayoutState.HOLD, PayoutState.FROZEN}:
        hold_ratio = min(1.0, max(0.25, daily.risk_score / 100.0))
        return PayoutRiskDecision(
            payout_state=daily.payout_state,
            hold_reason="risk_threshold",
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
        risk_score, hits, evidence = score_interval(
            interval,
            trust=trust_ctx,
            baseline=baseline,
            config=config,
            day=day,
            now=submitted_at,
        )
        decisions.append(
            verify_interval(
                interval,
                risk_score=risk_score,
                rule_hits=hits,
                trust=trust_ctx,
                config=config,
                evidence=evidence,
            )
        )

    return aggregate_daily_decision(
        user_id=user.id, day=day, interval_decisions=decisions
    )


def decision_to_check_result(
    daily: DailyDecision, config: VerificationConfig | None = None
) -> CheckResult:
    """Map v2 structured decision to legacy sync_health contract."""
    result = CheckResult()
    result.approved_steps = daily.verified_steps_total

    config = config or VerificationConfig()
    flags: list[dict[str, Any]] = []
    high_rules: set[str] = set()
    has_critical = False
    critical_rules: list[str] = []
    for interval_decision in daily.interval_decisions:
        for hit in interval_decision.rule_hits:
            # LOW = credit / informational rules: never a FraudFlag, never suspicion.
            if hit.severity == RuleSeverity.LOW:
                continue
            if hit.severity == RuleSeverity.CRITICAL:
                has_critical = True
                critical_rules.append(hit.rule_code)
            elif hit.severity == RuleSeverity.HIGH:
                high_rules.add(hit.rule_code)
            flags.append(
                {
                    "flag_type": hit.rule_code,
                    "severity": hit.severity.value,
                    "details": hit.evidence | {"message": hit.message},
                }
            )
        for note in (interval_decision.explainability.get("evidence") or {}).get(
            "notes", []
        ):
            if note not in result.notes:
                result.notes.append(note)
    result.flags = flags
    result.has_critical = has_critical
    result.risk_score = daily.risk_score

    # Strong evidence (excludes the day from challenge money):
    #  - any CRITICAL hit, or
    #  - risk at/above the review threshold (MEDIUM hits only get here by stacking), or
    #  - a HIGH hit that positively indicates shaking while steps are credited, or
    #  - two or more distinct HIGH rules corroborating each other.
    # A single "absence of walking" HIGH hit or any number of MEDIUM hits alone only
    # add risk (and lower that sync's credit once risk is material).
    reasons: list[str] = []
    if has_critical:
        reasons.extend(f"critical:{code}" for code in critical_rules)
    if daily.risk_score >= config.review_risk_threshold:
        reasons.append(f"risk>={config.review_risk_threshold:g}")
    shake_hits = sorted(high_rules & SHAKE_POSITIVE_RULES)
    if shake_hits:
        reasons.extend(f"shake:{code}" for code in shake_hits)
    if len(high_rules) >= 2:
        reasons.append("corroborated_high:" + ",".join(sorted(high_rules)))
    result.strong_evidence = bool(reasons)
    result.strong_reasons = reasons

    # Trust: only HIGH/CRITICAL evidence costs trust, at most one HIGH-equivalent per
    # sync (the view caps it again per user per day and floors it above SUSPEND).
    if has_critical:
        result.trust_deduction = TRUST_DEDUCT_CRITICAL
    elif high_rules and result.strong_evidence:
        result.trust_deduction = TRUST_DEDUCT_HIGH
    else:
        result.trust_deduction = 0

    verified_credit = sum(d.interval.credit_steps for d in daily.interval_decisions)
    result.credit_multiplier = (
        daily.verified_steps_total / verified_credit if verified_credit else 1.0
    )
    result.should_block = (
        daily.review_state == ReviewState.REQUIRED
        and daily.payout_state == PayoutState.FROZEN
    )
    result.should_cap = any(
        d.status in {VerificationStatus.SOFT_CAP, VerificationStatus.REVIEW}
        for d in daily.interval_decisions
    )
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
    source_platform="device_sensor",
    client_source=None,
    steps_delta=None,
    burst_source=None,
) -> CheckResult:
    """Backward-compatible adapter for existing call sites and tests.

    `steps_delta` = steps this sync would credit (None: evaluate the whole total).
    `source_platform` must be server-derived (resolve_source_key).
    """
    submitted_at = submitted_at or timezone.now()
    payload = {
        "steps": steps,
        "steps_delta_credit": steps_delta,
        "client_source": client_source,
        "burst_source": burst_source,
        "distance_km": distance_km,
        "calories_active": calories,
        "active_minutes": active_minutes,
        "cadence_spm": cadence_spm,
        "burst_steps_5s": burst_steps_5s,
        "gait_state": gait_state,
        "gait_confidence": gait_confidence,
        "gait_dominant_freq_hz": gait_dominant_freq_hz,
        "gait_autocorr": gait_autocorr,
        "gait_interval_std_ms": gait_interval_std_ms,
        "gait_valid_peaks_2s": gait_valid_peaks_2s,
        "gait_gyro_variance": gait_gyro_variance,
        "gait_jerk_rms": gait_jerk_rms,
        "carry_mode": carry_mode,
        "ml_motion_label": ml_motion_label,
        "ml_walk_probability": ml_walk_probability,
        "ml_shake_probability": ml_shake_probability,
        "ml_model_version": ml_model_version,
    }

    trust = getattr(user, "trust_score", None)
    trust_score = trust.score if trust else 100
    trust_status = trust.status if trust else "GOOD"

    daily = evaluate_daily_submission(
        user=user,
        payload=payload,
        day=date,
        submitted_at=submitted_at,
        trust_score=trust_score,
        trust_status=trust_status,
        source_platform=source_platform,
        source_device=getattr(user, "device_platform", None),
        source_app="legacy_sync",
        config=VerificationConfig.from_settings(settings),
    )
    return decision_to_check_result(daily, VerificationConfig.from_settings(settings))


# ============================================================
# Phase 0 helpers used by steps.views.sync_health
# ============================================================


def resolve_source_key(*, session=None, user=None) -> str:
    """Source key from what the SERVER knows, never from the client's `source` field.

    A verified step session bound to a registered Android/iOS device means the numbers
    come from the phone's own step counter through the app.
    """
    device = getattr(session, "device", None) if session is not None else None
    platform = (getattr(device, "platform", "") or "").lower()
    if session is not None and platform in {"android", "ios"}:
        return "phone_sensor_session"
    if session is not None and platform == "web":
        return "web"
    user_platform = (getattr(user, "device_platform", "") or "").lower()
    if user_platform in {"android", "ios"}:
        return "phone_unsessioned"
    return "web"


def _local_midnight_utc(day: date_type, offset_hours: float) -> datetime:
    midnight = datetime.combine(day, time.min).replace(tzinfo=dt_timezone.utc)
    return midnight - timedelta(hours=offset_hours)


def seconds_since_local_midnight(
    day: date_type, now: datetime, offset_hours: float
) -> float:
    """Seconds of `day` (device-local) elapsed at `now`, clamped to [0, 24h]."""
    elapsed = (now - _local_midnight_utc(day, offset_hours)).total_seconds()
    return max(0.0, min(86_400.0, elapsed))


@dataclass(frozen=True)
class VelocityAssessment:
    """How much of a submitted raw day total is plausible for the elapsed time."""

    plausible_raw: int  # raw total now considered creditable (never decreases)
    unverified: int  # submitted - plausible_raw (deferred, not counted)
    credit_delta: int  # plausible_raw - previous plausible_raw
    impossible: bool  # clearly impossible jump: reject (400 + HIGH flag)
    details: dict[str, Any]


def assess_velocity(
    *,
    day: date_type,
    now: datetime,
    submitted: int,
    prev_raw: int,
    prev_unverified: int,
    last_synced_at: datetime | None,
    last_client_ts: datetime | None,
    client_ts: datetime | None,
    check_pair_velocity: bool = True,
    default_offset_hours: float | None = None,
    offset_tolerance_hours: float | None = None,
) -> VelocityAssessment:
    """Raw-vs-raw velocity check with a first-sync-of-the-day bound.

    - Per-sync: the delta since the previous RAW total may grow at a plausible walking
      rate (VELOCITY_PLAUSIBLE_STEPS_PER_S) over the elapsed time (max of server and
      client clocks, so a delayed upload isn't punished) plus batching headroom.
    - Per-day: the raw total may not exceed that rate over the time elapsed since the
      device's local midnight (with time-zone tolerance). Covers the first sync.
    - The part above the plausible amount is kept as unverified (deferred): it becomes
      creditable later as time passes. Only clearly impossible jumps are rejected.
    """
    offset = (
        DEFAULT_DEVICE_UTC_OFFSET_HOURS
        if default_offset_hours is None
        else float(default_offset_hours)
    )
    # Phase 1b: when the phone reports its UTC offset, the caller passes it with a
    # small tolerance; otherwise the market default (EAT) + 2 h is assumed.
    tolerance = (
        DEVICE_OFFSET_TOLERANCE_HOURS
        if offset_tolerance_hours is None
        else float(offset_tolerance_hours)
    )
    since_midnight = seconds_since_local_midnight(day, now, offset + tolerance)
    since_midnight_generous = seconds_since_local_midnight(
        day, now, MAX_DEVICE_UTC_OFFSET_HOURS
    )
    day_bound = int(since_midnight * VELOCITY_PLAUSIBLE_STEPS_PER_S) + DAY_BOUND_HEADROOM
    day_impossible = (
        int(since_midnight_generous * VELOCITY_IMPOSSIBLE_STEPS_PER_S)
        + VELOCITY_IMPOSSIBLE_HEADROOM
    )

    prev_raw = max(0, int(prev_raw))
    prev_plausible = max(0, prev_raw - max(0, int(prev_unverified)))
    details: dict[str, Any] = {
        "submitted_steps": submitted,
        "previous_raw_steps": prev_raw,
        "previous_plausible_steps": prev_plausible,
        "seconds_since_local_midnight": round(since_midnight),
        "day_bound": day_bound,
        "day_impossible_bound": day_impossible,
    }

    elapsed = None
    if last_synced_at is not None:
        server_elapsed = max(0.0, (now - last_synced_at).total_seconds())
        client_elapsed = 0.0
        if client_ts is not None and last_client_ts is not None:
            capped_ts = min(client_ts, now + timedelta(minutes=5))
            client_elapsed = max(0.0, (capped_ts - last_client_ts).total_seconds())
        elapsed = max(1.0, server_elapsed, client_elapsed)
        details["elapsed_seconds"] = round(elapsed, 1)

    impossible = submitted > day_impossible
    pair_bound = None
    if elapsed is not None and check_pair_velocity:
        pair_bound = (
            prev_plausible
            + int(elapsed * VELOCITY_PLAUSIBLE_STEPS_PER_S)
            + VELOCITY_PLAUSIBLE_HEADROOM
        )
        pair_impossible = (
            int(elapsed * VELOCITY_IMPOSSIBLE_STEPS_PER_S) + VELOCITY_IMPOSSIBLE_HEADROOM
        )
        details["max_plausible_total"] = pair_bound
        details["max_allowed_delta"] = pair_impossible
        if submitted - prev_raw > pair_impossible:
            impossible = True

    plausible = min(submitted, day_bound)
    if pair_bound is not None:
        plausible = min(plausible, pair_bound)
    plausible = max(plausible, min(prev_plausible, submitted))
    unverified = max(0, submitted - plausible)
    details["plausible_steps"] = plausible
    details["unverified_steps"] = unverified
    return VelocityAssessment(
        plausible_raw=plausible,
        unverified=unverified,
        credit_delta=max(0, plausible - prev_plausible),
        impossible=impossible,
        details=details,
    )


def cap_trust_deduction(
    *, requested: int, has_critical: bool, already_today: int, current_score: int
) -> int:
    """Per user per server day: at most one HIGH-equivalent (or one CRITICAL-equivalent
    when a CRITICAL hit is involved), and never below TRUST_SYNC_FLOOR (no automatic
    SUSPEND from sync evidence)."""
    if requested <= 0:
        return 0
    day_cap = TRUST_DEDUCT_CRITICAL if has_critical else TRUST_DEDUCT_HIGH
    allowed = max(0, min(requested, day_cap - max(0, already_today)))
    allowed = min(allowed, max(0, int(current_score) - TRUST_SYNC_FLOOR))
    return allowed
