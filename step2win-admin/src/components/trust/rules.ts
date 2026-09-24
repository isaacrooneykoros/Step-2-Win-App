import type { TrustCase } from './api'

/**
 * Plain-language names and explanations for anti-cheat rule codes emitted by
 * backend/apps/steps (anti_cheat.py v2 rules, session risk rules, sync_health
 * checks). Unknown codes fall back to a humanised code; the backend's own
 * message is shown alongside when present.
 */
export interface RuleInfo {
  label: string
  /** What the rule saw, in words an operator can act on. */
  explain: string
}

const RULES: Record<string, RuleInfo> = {
  // Daily totals
  daily_total_impossible: { label: 'Impossible daily total', explain: 'The day’s total is above the level no person can walk. Steps above the limit were rejected.' },
  daily_total_review: { label: 'Very high daily total', explain: 'The day’s total is high enough to need corroboration from pace, gait and history before it counts in full.' },
  daily_cap_exceeded: { label: 'Daily cap exceeded', explain: 'More steps than the platform’s daily cap were submitted for one day.' },
  baseline_spike_hard: { label: 'Far above usual activity', explain: 'The day is several times this user’s normal daily steps.' },
  baseline_spike_soft: { label: 'Above usual activity', explain: 'The day is noticeably higher than this user’s normal daily steps.' },
  // Pace
  steps_per_min_impossible: { label: 'Impossible pace', explain: 'Steps per minute are faster than a person can physically walk or run for the interval.' },
  steps_per_min_suspicious: { label: 'Unusually fast pace', explain: 'Steps per minute stayed above the sustained walking range.' },
  impossible_rate: { label: 'Impossible step rate', explain: 'Step rate exceeded what is physically possible.' },
  step_rate_spike: { label: 'Step rate spike', explain: 'A sudden jump in step rate compared with the previous sync.' },
  step_velocity_spike: { label: 'Too many steps since last sync', explain: 'More steps arrived than could be walked in the time since the previous sync.' },
  cadence_impossible: { label: 'Impossible cadence', explain: 'Step cadence is outside the human walking and running range.' },
  cadence_suspicious: { label: 'Unusual cadence', explain: 'Step cadence is at the edge of the human range.' },
  burst_impossible: { label: 'Impossible burst', explain: 'A short burst contains more steps than can be taken in that time.' },
  burst_suspicious: { label: 'Suspicious burst', explain: 'Short bursts of very high step counts.' },
  // Gait / motion
  gait_confidence_very_low: { label: 'Gait not detected', explain: 'The motion signal does not look like walking.' },
  gait_confidence_low: { label: 'Weak gait signal', explain: 'The gait detector had low confidence that this was walking.' },
  gait_state_suspicious: { label: 'Suspicious gait state', explain: 'Motion state looks mechanical rather than human walking.' },
  gait_frequency_out_of_band: { label: 'Step rhythm out of range', explain: 'The dominant step frequency is outside the walking band.' },
  gait_periodicity_low: { label: 'Irregular rhythm', explain: 'Steps lack the regular rhythm of walking.' },
  gait_interval_variability_high: { label: 'Very uneven step timing', explain: 'Time between steps varies far more than in real walking.' },
  gait_interval_variability_moderate: { label: 'Uneven step timing', explain: 'Time between steps varies more than usual.' },
  gait_peak_run_short: { label: 'Short step runs', explain: 'Steps come in very short runs rather than continuous walking.' },
  gait_jerk_high: { label: 'Shaking motion', explain: 'Sharp acceleration changes typical of a phone being shaken.' },
  gait_rotation_chaotic: { label: 'Chaotic rotation', explain: 'Device rotation is erratic, unlike a phone carried while walking.' },
  in_hand_high_cadence: { label: 'Fast cadence in hand', explain: 'Very high cadence while the phone was held in the hand.' },
  shake_pattern: { label: 'Shake pattern', explain: 'Motion looks like the device was shaken to generate steps.' },
  // ML
  ml_shake_high_probability: { label: 'Model: likely shaking', explain: 'The motion model rates this interval as probably shaking, not walking.' },
  ml_shake_moderate_probability: { label: 'Model: possible shaking', explain: 'The motion model gives a moderate chance of shaking.' },
  ml_walk_high_probability: { label: 'Model: likely walking', explain: 'The motion model rates this as real walking (supporting evidence).' },
  ml_label_shake: { label: 'Model labelled shake', explain: 'The on-device model labelled these events as shaking.' },
  // Sync integrity
  late_sync: { label: 'Late sync', explain: 'Steps were uploaded long after they were recorded.' },
  repeated_pattern: { label: 'Repeated pattern', explain: 'The same step counts repeat across intervals, which is typical of scripted input.' },
  non_monotonic_steps: { label: 'Step total went down', explain: 'A sync reported fewer steps than already recorded for the same day. The sync was refused.' },
  replay_payload: { label: 'Replayed payload', explain: 'A previously sent sync payload was sent again.' },
  route_step_mismatch_low_distance: { label: 'Route too short for steps', explain: 'GPS route distance is too short for the number of steps.' },
  route_step_mismatch_high_distance: { label: 'Route too long for steps', explain: 'GPS route distance is too long for the number of steps (possible vehicle travel).' },
  // Session risk
  session_risk: { label: 'High-risk step session', explain: 'A step session scored above the review threshold (60).' },
  session_replay_detected: { label: 'Replay in session', explain: 'Events in this session were replays of earlier events.' },
  session_high_rejection_rate: { label: 'Most events rejected', explain: 'More than half of the session’s events were rejected by checks.' },
  session_high_avg_shake: { label: 'Session looks like shaking', explain: 'Average shake probability across the session is above 0.60.' },
  session_impossible_pace: { label: 'Session pace impossible', explain: 'Steps per minute over the session exceed physical limits.' },
  session_mostly_legacy: { label: 'Mostly unverified events', explain: 'Most events came without motion-model data.' },
  session_too_long: { label: 'Session too long', explain: 'The session ran far longer than the allowed maximum.' },
}

export function humanizeCode(code: string): string {
  const s = code.replace(/[_-]+/g, ' ').trim()
  return s.charAt(0).toUpperCase() + s.slice(1)
}

export function ruleInfo(code: string | null | undefined): RuleInfo {
  if (!code) return { label: 'Unknown rule', explain: '' }
  return RULES[code] ?? { label: humanizeCode(code), explain: '' }
}

/** Evidence keys → readable labels. Unknown keys are humanised. */
const EVIDENCE_LABEL: Record<string, string> = {
  steps: 'Steps', threshold: 'Threshold', steps_per_min: 'Steps per minute', cadence_spm: 'Cadence (spm)',
  max_cadence_spm: 'Max cadence (spm)', shake_probability: 'Shake probability', walk_probability: 'Walk probability',
  baseline_avg: 'Usual daily steps', ratio: 'Ratio to usual', jerk_p95: 'Jerk (p95)', max_expected: 'Max expected',
  submitted_steps: 'Submitted steps', previous_steps: 'Previously recorded', delay_hours: 'Delay (hours)',
  max_delay_hours: 'Allowed delay (hours)', repeat_count: 'Repeats', window_intervals: 'Intervals checked',
  route_km: 'Route (km)', ratio_km_per_step: 'km per step', gait_confidence: 'Gait confidence',
  min_confidence: 'Min confidence', delta_steps: 'Step increase', elapsed_seconds: 'Seconds since last sync',
  max_allowed_delta: 'Max allowed increase', window_minutes: 'Window (minutes)',
}

export function evidenceLabel(key: string): string {
  return EVIDENCE_LABEL[key] ?? humanizeCode(key)
}

export const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low'] as const

export const SEVERITY_MEANING: Record<string, string> = {
  critical: 'Submission rejected',
  high: 'Steps capped automatically',
  medium: 'Needs admin review',
  low: 'Logged only',
}

export const TRUST_STATUS_INFO: Record<string, { label: string; effect: string }> = {
  GOOD: { label: 'Good', effect: 'No limits.' },
  WARN: { label: 'Warned', effect: 'No limits; watched more closely.' },
  REVIEW: { label: 'Under review', effect: 'Verification is slightly stricter.' },
  RESTRICT: { label: 'Restricted', effect: 'Verification is stricter and confidence is reduced.' },
  SUSPEND: { label: 'Suspended', effect: 'Step sync is refused (“Challenge participation paused”). Payouts are frozen.' },
  BAN: { label: 'Banned', effect: 'Step sync is refused (“Account suspended”). Payouts are frozen.' },
}

export const CASE_STATUS_LABEL: Record<string, string> = {
  open: 'Open', actioned: 'Confirmed', dismissed: 'Dismissed', approved: 'Approved', rejected: 'Rejected',
  reviewed: 'Reviewed', escalated: 'Escalated',
}

export function caseTitle(c: TrustCase): string {
  return c.kind === 'session' ? 'High-risk step session' : ruleInfo(c.type).label
}

/** One-line plain-language reason for list rows. */
export function caseReason(c: TrustCase): string {
  if (c.kind === 'session') {
    const labels = c.rule_codes.map((r) => ruleInfo(r).label)
    return `Risk ${c.risk_score ?? '—'}/100${labels.length ? ` · ${labels.join(', ')}` : ''}`
  }
  return c.summary || ruleInfo(c.type).explain || humanizeCode(c.type)
}

export function trustTone(status: string | null | undefined): 'success' | 'warning' | 'danger' | 'neutral' {
  switch (status) {
    case 'GOOD': return 'success'
    case 'WARN': case 'REVIEW': return 'warning'
    case 'RESTRICT': case 'SUSPEND': case 'BAN': return 'danger'
    default: return 'neutral'
  }
}


/** Hours as a queue age: 0.4 -> 24m, 5 -> 5h, 71.8 -> 2d 23h (never "2d 24h"). */
export function formatAge(hours: number | null | undefined): string {
  if (hours === null || hours === undefined || !Number.isFinite(hours)) return '—'
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m`
  if (hours < 48) return `${Math.floor(hours)}h`
  const d = Math.floor(hours / 24)
  const h = Math.floor(hours - d * 24)
  return h ? `${d}d ${h}h` : `${d}d`
}

