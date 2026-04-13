"""
Step2Win Anti-Cheat Engine
Runs on every step sync. Returns flags and an approved step count.
Never auto-bans — flags for review with progressive trust score deduction.
"""

import statistics
from datetime import timedelta

from django.db.models import Avg, Count, Sum
from django.utils import timezone

from .models import HealthRecord

DAILY_STEP_CAP = 60_000
MAX_STEPS_PER_MINUTE = 175
CADENCE_SOFT_CAP_SPM = 200
CADENCE_HARD_CAP_SPM = 230
BURST_5S_SOFT_CAP = 18
BURST_5S_HARD_CAP = 25
WEEKLY_HARD_CAP = 420_000

SPIKE_MULTIPLIER = 5.0
MIN_HISTORY_DAYS = 5
PATTERN_CV_THRESHOLD = 0.03

DISTANCE_KM_PER_STEP_MIN = 0.0005
DISTANCE_KM_PER_STEP_MAX = 0.0018
CALORIE_PER_1000_STEPS_MIN = 25
CALORIE_PER_1000_STEPS_MAX = 100

BACKDATING_DAYS_ALLOWED = 1
LATE_NIGHT_HOUR_START = 1
LATE_NIGHT_HOUR_END = 5
LATE_NIGHT_BULK_THRESHOLD = 20_000


class CheckResult:
    def __init__(self):
        self.flags: list[dict] = []
        self.approved_steps: int = 0
        self.trust_deduction: int = 0
        self.should_block: bool = False
        self.should_cap: bool = False

    def flag(self, flag_type: str, severity: str, details: dict):
        self.flags.append({'flag_type': flag_type, 'severity': severity, 'details': details})
        self.trust_deduction += {'low': 0, 'medium': 3, 'high': 8, 'critical': 15}.get(severity, 3)
        if severity == 'critical':
            self.should_block = True
        elif severity == 'high':
            self.should_cap = True

    @property
    def is_clean(self):
        return len(self.flags) == 0


def run_anti_cheat(
    user,
    steps: int,
    date,
    distance_km=None,
    calories=None,
    active_minutes=None,
    cadence_spm=None,
    burst_steps_5s=None,
    submitted_at=None,
) -> CheckResult:
    result = CheckResult()
    result.approved_steps = steps
    submitted_at = submitted_at or timezone.now()
    today = timezone.now().date()

    _check_daily_cap(result, steps)
    _check_impossible_rate(result, steps, active_minutes)
    _check_cadence_window(result, cadence_spm)
    _check_burst_window(result, burst_steps_5s)
    _check_backdating(result, date, today)
    _check_weekly_cap(result, user, steps, date)

    _check_personal_spike(result, user, steps, date)
    _check_uniform_pattern(result, user, date)
    _check_overnight_bulk(result, steps, submitted_at)
    _check_round_numbers(result, user, date)

    if distance_km is not None:
        _check_distance_ratio(result, steps, distance_km)
    if calories is not None:
        _check_calorie_ratio(result, steps, calories)
    if active_minutes is not None and distance_km is not None:
        _check_speed(result, distance_km, active_minutes)

    if not result.should_block and result.should_cap:
        result.approved_steps = min(steps, DAILY_STEP_CAP)

    return result


def _check_daily_cap(result, steps):
    if steps > DAILY_STEP_CAP:
        result.flag('daily_cap', 'critical' if steps > 100_000 else 'high', {
            'submitted': steps,
            'cap': DAILY_STEP_CAP,
            'note': f'{steps:,} exceeds human daily maximum of {DAILY_STEP_CAP:,}',
        })
        result.approved_steps = DAILY_STEP_CAP


def _check_impossible_rate(result, steps, active_minutes):
    if not active_minutes or active_minutes <= 0:
        return
    rate = steps / active_minutes
    if rate > MAX_STEPS_PER_MINUTE:
        result.flag('impossible_rate', 'critical' if rate > 500 else 'high', {
            'steps': steps,
            'active_minutes': active_minutes,
            'rate_per_min': round(rate, 1),
            'max_human': MAX_STEPS_PER_MINUTE,
            'note': (
                f'{rate:.0f} steps/min is impossible. '
                f'Human max is {MAX_STEPS_PER_MINUTE} steps/min. '
                'Mechanical manipulation suspected.'
            ),
        })


def _check_cadence_window(result, cadence_spm):
    if cadence_spm is None:
        return
    cadence_spm = float(cadence_spm)
    if cadence_spm > CADENCE_HARD_CAP_SPM:
        result.flag('cadence_hard_cap', 'high', {
            'cadence_spm': round(cadence_spm, 1),
            'hard_cap_spm': CADENCE_HARD_CAP_SPM,
            'note': 'Cadence exceeds realistic sustained walking/running limits.',
        })
    elif cadence_spm > CADENCE_SOFT_CAP_SPM:
        result.flag('cadence_soft_cap', 'medium', {
            'cadence_spm': round(cadence_spm, 1),
            'soft_cap_spm': CADENCE_SOFT_CAP_SPM,
            'note': 'Cadence unusually high for human gait.',
        })


def _check_burst_window(result, burst_steps_5s):
    if burst_steps_5s is None:
        return
    burst_steps_5s = int(burst_steps_5s)
    if burst_steps_5s > BURST_5S_HARD_CAP:
        result.flag('burst_hard_cap', 'high', {
            'burst_steps_5s': burst_steps_5s,
            'hard_cap': BURST_5S_HARD_CAP,
            'note': '5-second burst exceeds plausible human step acceleration.',
        })
    elif burst_steps_5s > BURST_5S_SOFT_CAP:
        result.flag('burst_soft_cap', 'medium', {
            'burst_steps_5s': burst_steps_5s,
            'soft_cap': BURST_5S_SOFT_CAP,
            'note': '5-second burst is suspiciously high.',
        })


def _check_backdating(result, date, today):
    days_old = (today - date).days
    if days_old > BACKDATING_DAYS_ALLOWED:
        result.flag('backdating', 'high', {
            'submission_date': str(date),
            'today': str(today),
            'days_old': days_old,
            'note': f'{days_old} days old. Only today/yesterday accepted.',
        })


def _check_weekly_cap(result, user, steps, date):
    week_start = date - timedelta(days=6)
    existing = HealthRecord.objects.filter(user=user, date__gte=week_start, date__lt=date).aggregate(t=Sum('steps'))['t'] or 0
    if existing + steps > WEEKLY_HARD_CAP:
        result.flag('weekly_cap', 'medium', {
            'projected_total': existing + steps,
            'cap': WEEKLY_HARD_CAP,
            'note': f'Projected weekly total > human maximum {WEEKLY_HARD_CAP:,}',
        })


def _check_personal_spike(result, user, steps, date):
    agg = HealthRecord.objects.filter(
        user=user,
        date__gte=date - timedelta(days=30),
        date__lt=date,
        is_suspicious=False,
    ).aggregate(avg=Avg('steps'), count=Count('id'))

    count = agg['count'] or 0
    avg = float(agg['avg'] or 0)
    if count < MIN_HISTORY_DAYS or avg < 500:
        return

    ratio = steps / avg
    if ratio > SPIKE_MULTIPLIER:
        result.flag('personal_spike', 'critical' if ratio > 15 else 'high' if ratio > 10 else 'medium', {
            'today': steps,
            'personal_avg': round(avg),
            'ratio': round(ratio, 1),
            'note': f'{steps:,} = {ratio:.1f}× personal {round(avg):,}/day average',
        })


def _check_uniform_pattern(result, user, date):
    records = list(HealthRecord.objects.filter(user=user, date__gte=date - timedelta(days=7), date__lte=date).values_list('steps', flat=True))
    if len(records) < 5 or max(records) < 5_000:
        return
    try:
        avg = statistics.mean(records)
        stddev = statistics.stdev(records)
        if avg > 0:
            cv = stddev / avg
            if cv < PATTERN_CV_THRESHOLD:
                result.flag('uniform_pattern', 'medium', {
                    'avg': round(avg),
                    'cv_pct': round(cv * 100, 2),
                    'note': f'Steps vary by only {cv*100:.1f}% — human range is 20–40%',
                })
    except statistics.StatisticsError:
        pass


def _check_overnight_bulk(result, steps, submitted_at):
    hour = submitted_at.hour
    if LATE_NIGHT_HOUR_START <= hour < LATE_NIGHT_HOUR_END and steps > LATE_NIGHT_BULK_THRESHOLD:
        result.flag('overnight_bulk', 'high', {
            'steps': steps,
            'hour': hour,
            'note': f'{steps:,} steps submitted at {hour}:00 AM — API injection pattern',
        })


def _check_round_numbers(result, user, date):
    records = list(HealthRecord.objects.filter(user=user, date__gte=date - timedelta(days=14), date__lte=date).values_list('steps', flat=True))
    if len(records) < 5:
        return
    round_count = sum(1 for s in records if s % 1000 == 0 and s > 0)
    if round_count / len(records) > 0.7:
        result.flag('round_numbers', 'medium', {
            'round_count': round_count,
            'total': len(records),
            'note': f'{round_count}/{len(records)} submissions are exact thousands — manual entry suspected',
        })


def _check_distance_ratio(result, steps, distance_km):
    if steps <= 0 or distance_km <= 0:
        return
    km_per_step = distance_km / steps
    if km_per_step < DISTANCE_KM_PER_STEP_MIN:
        result.flag('distance_too_low', 'high', {
            'steps': steps,
            'distance_km': distance_km,
            'stride_cm': round(km_per_step * 100000, 1),
            'note': f'Stride of {km_per_step*100:.1f}cm — device shaking suspected',
        })
    elif km_per_step > DISTANCE_KM_PER_STEP_MAX:
        result.flag('distance_too_high', 'high', {
            'steps': steps,
            'distance_km': distance_km,
            'stride_cm': round(km_per_step * 100000, 1),
            'note': f'Stride of {km_per_step*100:.0f}cm — GPS spoofing suspected',
        })


def _check_calorie_ratio(result, steps, calories):
    if steps <= 0 or calories <= 0:
        return
    kcal_per_1000 = (calories / steps) * 1000
    if kcal_per_1000 < CALORIE_PER_1000_STEPS_MIN:
        result.flag('calorie_too_low', 'medium', {
            'kcal_per_1000': round(kcal_per_1000, 1),
            'note': f'Only {kcal_per_1000:.1f} kcal/1000 steps — too low for real movement',
        })
    if kcal_per_1000 > CALORIE_PER_1000_STEPS_MAX:
        result.flag('calorie_too_high', 'medium', {
            'kcal_per_1000': round(kcal_per_1000, 1),
            'note': f'{kcal_per_1000:.1f} kcal/1000 steps is unusually high',
        })


def _check_speed(result, distance_km, active_minutes):
    if active_minutes <= 0 or distance_km <= 0:
        return
    speed_kmh = (distance_km / active_minutes) * 60
    if speed_kmh > 15:
        result.flag('impossible_speed', 'high' if speed_kmh > 30 else 'medium', {
            'speed_kmh': round(speed_kmh, 1),
            'note': f'{speed_kmh:.1f} km/h exceeds walking max — GPS or vehicle suspected',
        })
