from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import timedelta
from typing import Any

import requests
from django.conf import settings
from django.utils import timezone

from apps.steps.models import DailyVerificationSummary, HealthRecord

logger = logging.getLogger(__name__)


@dataclass
class AntiCheatDriftThresholds:
    lookback_hours: int = 24
    min_samples: int = 50
    per_sample_alert_pct: float = 35.0
    max_avg_abs_delta_pct: float = 20.0
    max_high_drift_ratio_pct: float = 25.0
    max_review_mismatch_ratio_pct: float = 10.0


def _safe_alert(payload: dict[str, Any]) -> None:
    webhook = (getattr(settings, 'OPS_ALERT_WEBHOOK_URL', '') or '').strip()
    if not webhook:
        return
    try:
        requests.post(webhook, json=payload, timeout=4)
    except Exception as exc:
        logger.warning('Failed to send anti-cheat drift alert webhook: %s', exc)


def _pct(value: int, total: int) -> float:
    if total <= 0:
        return 0.0
    return round((value / total) * 100.0, 2)


def _delta_pct(legacy_steps: int, shadow_steps: int) -> float:
    baseline = max(1, legacy_steps)
    return abs(shadow_steps - legacy_steps) / baseline * 100.0


def run_anticheat_shadow_drift_monitor(
    *,
    thresholds: AntiCheatDriftThresholds | None = None,
    send_alerts: bool = True,
) -> dict[str, Any]:
    thresholds = thresholds or AntiCheatDriftThresholds()
    now = timezone.now()
    since = now - timedelta(hours=max(1, int(thresholds.lookback_hours)))

    shadow_rows = list(
        DailyVerificationSummary.objects.filter(
            mode='shadow',
            created_at__gte=since,
        )
        .select_related('user')
        .order_by('-created_at')
    )

    date_keys = {(row.user_id, row.date) for row in shadow_rows}
    health_rows = HealthRecord.objects.filter(
        user_id__in={user_id for user_id, _ in date_keys} if date_keys else [],
        date__in={day for _, day in date_keys} if date_keys else [],
    )
    health_map = {
        (row.user_id, row.date): {
            'steps': int(row.steps),
            'is_suspicious': bool(row.is_suspicious),
        }
        for row in health_rows
    }

    sample_count = len(shadow_rows)
    matched_samples = 0
    missing_legacy_records = 0
    high_drift_samples = 0
    review_mismatch_samples = 0
    legacy_total = 0
    shadow_total = 0
    abs_delta_total = 0
    top_drift_examples: list[dict[str, Any]] = []

    for row in shadow_rows:
        key = (row.user_id, row.date)
        if key not in health_map:
            missing_legacy_records += 1
            continue

        matched_samples += 1
        legacy_record = health_map[key]
        legacy_steps = max(0, int(legacy_record['steps']))
        shadow_steps = max(0, int(row.verified_steps_total))
        delta_steps = shadow_steps - legacy_steps
        drift_pct = _delta_pct(legacy_steps, shadow_steps)

        legacy_total += legacy_steps
        shadow_total += shadow_steps
        abs_delta_total += abs(delta_steps)

        if drift_pct >= thresholds.per_sample_alert_pct:
            high_drift_samples += 1

        legacy_suspicious = bool(legacy_record['is_suspicious'])
        shadow_review = row.review_state in {'pending', 'required'}
        if legacy_suspicious != shadow_review:
            review_mismatch_samples += 1

        top_drift_examples.append({
            'user_id': row.user_id,
            'date': str(row.date),
            'legacy_steps': legacy_steps,
            'shadow_verified_steps': shadow_steps,
            'delta_steps': delta_steps,
            'abs_delta_pct': round(drift_pct, 2),
            'shadow_review_state': row.review_state,
        })

    top_drift_examples = sorted(top_drift_examples, key=lambda item: item['abs_delta_pct'], reverse=True)[:10]

    avg_abs_delta_pct = 0.0
    if matched_samples > 0:
        # Aggregate-based percent avoids over-weighting tiny baseline rows.
        avg_abs_delta_pct = round((abs_delta_total / max(1, legacy_total)) * 100.0, 2)

    high_drift_ratio_pct = _pct(high_drift_samples, matched_samples)
    review_mismatch_ratio_pct = _pct(review_mismatch_samples, matched_samples)

    breaches: list[str] = []
    enough_samples = sample_count >= thresholds.min_samples and matched_samples >= thresholds.min_samples
    if enough_samples:
        if avg_abs_delta_pct > thresholds.max_avg_abs_delta_pct:
            breaches.append(f'avg_abs_delta_pct={avg_abs_delta_pct:.2f} > {thresholds.max_avg_abs_delta_pct}')
        if high_drift_ratio_pct > thresholds.max_high_drift_ratio_pct:
            breaches.append(f'high_drift_ratio_pct={high_drift_ratio_pct:.2f} > {thresholds.max_high_drift_ratio_pct}')
        if review_mismatch_ratio_pct > thresholds.max_review_mismatch_ratio_pct:
            breaches.append(f'review_mismatch_ratio_pct={review_mismatch_ratio_pct:.2f} > {thresholds.max_review_mismatch_ratio_pct}')

    result = {
        'timestamp': now.isoformat(),
        'window': {
            'since': since.isoformat(),
            'hours': thresholds.lookback_hours,
            'enough_samples': enough_samples,
        },
        'metrics': {
            'sample_count': sample_count,
            'matched_samples': matched_samples,
            'missing_legacy_records': missing_legacy_records,
            'legacy_steps_total': legacy_total,
            'shadow_verified_steps_total': shadow_total,
            'avg_abs_delta_pct': avg_abs_delta_pct,
            'high_drift_samples': high_drift_samples,
            'high_drift_ratio_pct': high_drift_ratio_pct,
            'review_mismatch_samples': review_mismatch_samples,
            'review_mismatch_ratio_pct': review_mismatch_ratio_pct,
            'top_drift_examples': top_drift_examples,
        },
        'thresholds': {
            'lookback_hours': thresholds.lookback_hours,
            'min_samples': thresholds.min_samples,
            'per_sample_alert_pct': thresholds.per_sample_alert_pct,
            'max_avg_abs_delta_pct': thresholds.max_avg_abs_delta_pct,
            'max_high_drift_ratio_pct': thresholds.max_high_drift_ratio_pct,
            'max_review_mismatch_ratio_pct': thresholds.max_review_mismatch_ratio_pct,
        },
        'breaches': breaches,
        'ok': len(breaches) == 0,
    }

    if breaches:
        logger.error('Anti-cheat shadow drift breaches: %s', '; '.join(breaches))
        if send_alerts:
            _safe_alert({
                'event': 'anticheat_shadow_drift_breach',
                'timestamp': result['timestamp'],
                'breaches': breaches,
                'metrics': result['metrics'],
                'thresholds': result['thresholds'],
            })
    else:
        logger.info('Anti-cheat shadow drift monitor OK')

    return result
