import type { SettingKey, SystemSettings } from './api'

export type FieldKind =
  | 'percent' | 'money' | 'int' | 'decimal' | 'bool' | 'email' | 'text' | 'milestones'
  | 'select' | 'staff' | 'categoryMap'
  /** Console switch with a server fallback: Server default / On / Off (null / true / false). */
  | 'triBool'
  /** Number that may be blank = use the server value (see settings context `rules`). */
  | 'optNumber'
  /** YYYY-MM-DD or blank = server value. */
  | 'date'
export type SectionId = 'access' | 'money' | 'challenges' | 'anticheat' | 'support' | 'gamification' | 'notifications' | 'monitoring'

export interface FieldDef {
  key: SettingKey
  label: string
  kind: FieldKind
  section: SectionId
  hint?: string
  /** Shown as a caution callout, e.g. "turn on only after the new app ships". */
  warning?: string
  /** For 'optNumber': how to parse and format. */
  numKind?: 'int' | 'money' | 'decimal'
  /** Unit suffix shown in the input. */
  unit?: string
  /** Changes that move money or lock users out get a stronger confirmation. */
  risky?: boolean
  min?: number
  max?: number
  /** Options for kind 'select'. */
  options?: Array<{ value: string; label: string }>
}

export interface SectionDef {
  id: SectionId
  title: string
  description: string
  /** Rarely used: rendered inside the collapsed "Advanced" area. */
  advanced?: boolean
}

/** Ordered by how often staff reach for them. */
export const SECTIONS: SectionDef[] = [
  { id: 'money', title: 'Money', description: 'The platform fee, deposit and withdrawal limits, and the review time customers are told. Blank limits use the server value; the server’s hard limits can never be loosened here.' },
  { id: 'challenges', title: 'Challenges', description: 'Rules for new challenges: milestones, entry fees, size, approval, payout rules and who may create paid challenges.' },
  { id: 'anticheat', title: 'Anti-cheat and verification', description: 'Payout review holds, device integrity, which steps count toward money, and trusted health apps.' },
  { id: 'access', title: 'Customer access', description: 'Maintenance mode and the switches that pause whole features for customers. Takes effect within seconds.' },
  { id: 'support', title: 'Support desk', description: 'Response targets, who gets new tickets, and what happens when a ticket waits too long.' },
  { id: 'gamification', title: 'XP and rewards', description: 'How experience points are earned from synced steps.', advanced: true },
  { id: 'notifications', title: 'Contacts and email', description: 'Where operational email goes, and whether it is sent.', advanced: true },
  { id: 'monitoring', title: 'Monitoring thresholds', description: 'When the reconciliation and anti-cheat drift jobs raise an alert in Ops monitoring. Blank = the server value.', advanced: true },
]

const OLD_APPS =
  'Apps already on people’s phones can’t send walking evidence. Turn this on only after the updated app has shipped and most customers have installed it, or their new steps stop counting toward challenges.'

export const TICKET_CATEGORIES: Array<{ value: string; label: string }> = [
  { value: 'payment', label: 'Payment' },
  { value: 'account', label: 'Account' },
  { value: 'challenge', label: 'Challenge' },
  { value: 'technical', label: 'Technical' },
  { value: 'general', label: 'General' },
  { value: 'other', label: 'Other' },
]

export const FIELDS: FieldDef[] = [
  { key: 'maintenance_mode', label: 'Maintenance mode', kind: 'bool', section: 'access', risky: true,
    hint: 'Customers see a full-screen message instead of the app. This console, health checks and M-Pesa callbacks keep working.' },
  { key: 'maintenance_message', label: 'Maintenance message', kind: 'text', section: 'access',
    hint: 'Shown to customers while maintenance mode is on. Say what is happening and when you expect to be back.' },
  { key: 'withdrawals_enabled', label: 'Withdrawals', kind: 'bool', section: 'access', risky: true,
    hint: 'Off pauses new withdrawal requests. Requests already made are still reviewed and paid.' },
  { key: 'challenges_enabled', label: 'Creating challenges', kind: 'bool', section: 'access', risky: true,
    hint: 'Off pauses new challenges and rematches. Joining and running challenges continue.' },
  { key: 'registrations_enabled', label: 'New sign-ups', kind: 'bool', section: 'access', risky: true,
    hint: 'Off refuses new accounts (email and Google). Existing customers can still sign in.' },

  { key: 'platform_fee_percentage', label: 'Platform fee', kind: 'percent', section: 'money', unit: '%', min: 0, max: 50, risky: true,
    hint: 'Taken from the total pool when a challenge settles.' },
  { key: 'challenge_milestones', label: 'Milestone options', kind: 'milestones', section: 'challenges', risky: true,
    hint: 'Step targets a creator can pick. Each must sit between the lowest and highest milestone.' },
  { key: 'min_challenge_milestone', label: 'Lowest milestone', kind: 'int', section: 'challenges', unit: 'steps', min: 1000, max: 1_000_000, risky: true },
  { key: 'max_challenge_milestone', label: 'Highest milestone', kind: 'int', section: 'challenges', unit: 'steps', min: 1000, max: 1_000_000, risky: true },
  { key: 'max_challenge_participants', label: 'Max participants', kind: 'int', section: 'challenges', unit: 'people', min: 2, max: 1000, risky: true,
    hint: 'Largest size a creator can pick for a new challenge. Existing challenges keep their size.' },
  { key: 'min_challenge_entry_fee', label: 'Lowest entry fee', kind: 'money', section: 'challenges', unit: 'KSh', min: 1, max: 10_000, risky: true,
    hint: 'Whole shillings. Applies to new public and private challenges.' },
  { key: 'max_challenge_entry_fee', label: 'Highest entry fee', kind: 'money', section: 'challenges', unit: 'KSh', min: 1, max: 10_000, risky: true,
    hint: 'Whole shillings, at most KSh 10,000. The app’s quick-pick amounts stay inside this range.' },
  { key: 'challenge_approval_required', label: 'New public challenges need approval', kind: 'bool', section: 'challenges',
    hint: 'On: new public challenges and rematches wait under Challenges > Awaiting approval, hidden from the lobby. Rejecting refunds the entries. Private challenges never wait.' },

  { key: 'minimum_withdrawal_amount', label: 'Minimum withdrawal', kind: 'money', section: 'money', unit: 'KSh', min: 0, max: 70_000, risky: true,
    hint: 'Requests below this are refused. Never lower than the server floor shown under Advanced > Server limits.' },
  { key: 'withdrawal_processing_time', label: 'Review time customers are told', kind: 'int', section: 'money', unit: 'hours', min: 1, max: 720,
    hint: 'Shown on the withdraw form and in the message after a request is sent.' },

  { key: 'payout_holds_enabled', label: 'Hold risky payouts for review', kind: 'bool', section: 'anticheat', risky: true,
    hint: 'On: a winner with low trust, open high flags, suspicious days, or a large win with open flags in the challenge window is held instead of paid. Banned and closed accounts are always held.' },
  { key: 'payout_hold_trust_score_max', label: 'Hold at trust score', kind: 'int', section: 'anticheat', unit: 'or below', min: 0, max: 100, risky: true,
    hint: '60 holds REVIEW, RESTRICT and SUSPEND accounts. Lower it to hold fewer payouts.' },
  { key: 'payout_hold_large_win_kes', label: 'Large win', kind: 'money', section: 'anticheat', unit: 'KSh', min: 1, max: 1_000_000, risky: true,
    hint: 'Payouts at or above this are held when the winner has any open medium or higher flag in the challenge window.' },
  { key: 'device_integrity_policy', label: 'Device integrity (Play Integrity)', kind: 'select', section: 'anticheat', risky: true,
    options: [
      { value: 'shadow', label: 'Shadow: record verdicts only' },
      { value: 'enforce', label: 'Enforce: failed devices count for goals only' },
    ],
    hint: 'Enforce only after the Play Integrity service account is configured and the shadow verdicts look right. Enforced, steps from sessions that fail the check stop counting toward challenges; goals and streaks are unaffected.' },
  { key: 'health_trusted_origins', label: 'Trusted health apps (Health Connect / Apple Health)', kind: 'text', section: 'anticheat', risky: true, max: 4000,
    hint: 'One app per line: its package or bundle id, a trailing * for a prefix, then "wearable" if the app only records watches or bands, then # and a label. Watch and band steps from these apps count toward challenges; phone-app steps only confirm. Steps typed in by hand never count. Leave empty to use the built-in list.' },

  // Money limits (blank = server value; never looser than the server's hard limit)
  { key: 'min_deposit_kes', label: 'Smallest deposit', kind: 'optNumber', numKind: 'money', section: 'money', unit: 'KSh', min: 1, max: 1_000_000, risky: true,
    hint: 'Deposits below this are refused. Can’t go below the server floor.' },
  { key: 'max_deposit_kes', label: 'Largest deposit', kind: 'optNumber', numKind: 'money', section: 'money', unit: 'KSh', min: 1, max: 1_000_000, risky: true,
    hint: 'Deposits above this are refused. Can’t go above the server ceiling.' },
  { key: 'max_withdrawal_kes', label: 'Largest single withdrawal', kind: 'optNumber', numKind: 'money', section: 'money', unit: 'KSh', min: 1, max: 1_000_000, risky: true,
    hint: 'One request can’t be larger than this.' },
  { key: 'max_daily_withdrawal_kes', label: 'Withdrawals per customer per day', kind: 'optNumber', numKind: 'money', section: 'money', unit: 'KSh', min: 1, max: 10_000_000, risky: true,
    hint: 'Total a customer can request in one day.' },
  { key: 'max_withdrawals_per_day', label: 'Withdrawal requests per day', kind: 'optNumber', numKind: 'int', section: 'money', unit: 'requests', min: 1, max: 100, risky: true,
    hint: 'Per customer, in any 24 hours. Failed and rejected requests don’t count.' },
  { key: 'max_withdrawals_per_hour', label: 'Withdrawal requests per hour', kind: 'optNumber', numKind: 'int', section: 'money', unit: 'requests', min: 1, max: 100, risky: true },
  { key: 'min_seconds_between_withdrawals', label: 'Gap between withdrawal requests', kind: 'optNumber', numKind: 'int', section: 'money', unit: 'seconds', min: 0, max: 86_400, risky: true,
    hint: 'Can be made longer than the server value, never shorter.' },

  // Challenges
  { key: 'rank_payouts_enabled', label: 'Winner-takes-all and top-3 challenges', kind: 'triBool', section: 'challenges', risky: true,
    hint: 'Rank payouts reward whoever posts the biggest number, the strongest reason to cheat. Existing challenges keep their rule either way.',
    warning: 'Turn on only after payout holds and verified steps are enforced in production.' },
  { key: 'paid_challenge_min_trust_score', label: 'Trust score to create paid challenges', kind: 'optNumber', numKind: 'int', section: 'challenges', unit: 'or more', min: 0, max: 100, risky: true,
    hint: 'Creators below this can still create free challenges. The server sets a floor this can’t go below.' },
  { key: 'paid_challenge_min_joined', label: 'Challenges joined before creating a paid one', kind: 'optNumber', numKind: 'int', section: 'challenges', unit: 'challenges', min: 0, max: 50, risky: true },
  { key: 'max_locked_balance_percent', label: 'Most of a wallet that entries can lock', kind: 'optNumber', numKind: 'int', section: 'challenges', unit: '%', min: 10, max: 100, risky: true,
    hint: 'Stops a customer putting all their money into entries at once.' },

  // Anti-cheat and verification
  { key: 'step_money_requires_evidence', label: 'Only evidence-backed steps count toward challenge money', kind: 'triBool', section: 'anticheat', risky: true,
    hint: 'Goals, streaks and XP always use every credited step. This only changes what counts toward challenge standings and payouts.',
    warning: OLD_APPS },
  { key: 'step_evidence_cutover_date', label: 'Evidence cut-over date', kind: 'date', section: 'anticheat', risky: true,
    hint: 'Days before this date keep full challenge credit. Set it to the day the updated app was released. Blank = the server value.' },
  { key: 'play_integrity_accept_basic', label: 'Accept basic-integrity phones', kind: 'triBool', section: 'anticheat', risky: true,
    hint: 'On: phones that only pass Play Integrity’s basic check (many uncertified budget phones and custom ROMs) count as verified. Off: they need device integrity.' },
  { key: 'risk_ml_hold_threshold', label: 'Risk model threshold (shadow)', kind: 'optNumber', numKind: 'decimal', section: 'anticheat', min: 0.05, max: 0.99,
    hint: 'Used only to report how the shadow model would perform (precision and recall at this score). Nothing is held automatically.' },

  // Monitoring thresholds (advanced)
  { key: 'recon_max_stuck_processing', label: 'Stuck payouts before an alert', kind: 'optNumber', numKind: 'int', section: 'monitoring', min: 0, max: 10_000 },
  { key: 'recon_max_unprocessed_callbacks', label: 'Unprocessed M-Pesa callbacks before an alert', kind: 'optNumber', numKind: 'int', section: 'monitoring', min: 0, max: 10_000 },
  { key: 'recon_max_negative_balance_users', label: 'Negative balances before an alert', kind: 'optNumber', numKind: 'int', section: 'monitoring', min: 0, max: 10_000 },
  { key: 'recon_max_callback_failure_rate_pct', label: 'Callback failure rate before an alert', kind: 'optNumber', numKind: 'decimal', section: 'monitoring', unit: '%', min: 0, max: 100 },
  { key: 'drift_lookback_hours', label: 'Drift monitor window', kind: 'optNumber', numKind: 'int', section: 'monitoring', unit: 'hours', min: 1, max: 336 },
  { key: 'drift_min_samples', label: 'Drift monitor minimum samples', kind: 'optNumber', numKind: 'int', section: 'monitoring', min: 1, max: 100_000 },
  { key: 'drift_per_sample_alert_pct', label: 'Per-sample drift alert', kind: 'optNumber', numKind: 'decimal', section: 'monitoring', unit: '%', min: 0, max: 1000 },
  { key: 'drift_max_avg_abs_delta_pct', label: 'Average drift alert', kind: 'optNumber', numKind: 'decimal', section: 'monitoring', unit: '%', min: 0, max: 1000 },
  { key: 'drift_max_high_drift_ratio_pct', label: 'High-drift share alert', kind: 'optNumber', numKind: 'decimal', section: 'monitoring', unit: '%', min: 0, max: 100 },
  { key: 'drift_max_review_mismatch_ratio_pct', label: 'Review mismatch alert', kind: 'optNumber', numKind: 'decimal', section: 'monitoring', unit: '%', min: 0, max: 100 },

  { key: 'support_sla_urgent_hours', label: 'Reply target: urgent', kind: 'int', section: 'support', unit: 'hours', min: 1, max: 720 },
  { key: 'support_sla_high_hours', label: 'Reply target: high', kind: 'int', section: 'support', unit: 'hours', min: 1, max: 720 },
  { key: 'support_sla_medium_hours', label: 'Reply target: medium', kind: 'int', section: 'support', unit: 'hours', min: 1, max: 720 },
  { key: 'support_sla_low_hours', label: 'Reply target: low', kind: 'int', section: 'support', unit: 'hours', min: 1, max: 720 },
  { key: 'support_auto_assign_mode', label: 'Assign new tickets', kind: 'select', section: 'support',
    options: [
      { value: 'off', label: 'Off: tickets arrive unassigned' },
      { value: 'round_robin', label: 'Round robin across support agents' },
      { value: 'category', label: 'By category, then round robin' },
    ],
    hint: 'Applies when a customer opens a ticket. Staff can always reassign.' },
  { key: 'support_agent_ids', label: 'Support agents', kind: 'staff', section: 'support',
    hint: 'Staff who take new tickets in turn.' },
  { key: 'support_category_assignees', label: 'Owner by category', kind: 'categoryMap', section: 'support',
    hint: 'Used when assigning by category. Categories without an owner go to the agents in turn.' },
  { key: 'support_escalation_enabled', label: 'Escalate overdue tickets', kind: 'bool', section: 'support',
    hint: 'Every 15 minutes, tickets waiting past their target are flagged Escalated and listed under Support > Overdue.' },
  { key: 'support_escalation_raise_priority', label: 'Raise priority on escalation', kind: 'bool', section: 'support',
    hint: 'Moves an escalated ticket up one priority level (low → medium → high → urgent), once per wait.' },

  { key: 'xp_per_step', label: 'XP per step', kind: 'decimal', section: 'gamification', unit: 'XP', min: 0, max: 100,
    hint: 'Earned for each accepted step as steps sync (rounded down per day). Flagged days earn nothing.' },
  { key: 'daily_goal_bonus_xp', label: 'Daily goal bonus', kind: 'int', section: 'gamification', unit: 'XP', min: 0, max: 100_000,
    hint: 'Once per day, when the customer’s steps first reach their daily goal. 0 turns it off.' },

  { key: 'admin_email', label: 'Admin email', kind: 'email', section: 'notifications' },
  { key: 'support_email', label: 'Support email', kind: 'email', section: 'notifications' },
  { key: 'email_notifications_enabled', label: 'Send email notifications', kind: 'bool', section: 'notifications',
    hint: 'Off stops notification emails (today: the M-Pesa funding alert to the admin and support addresses). Emails a customer asks for, like a password reset, always send.' },
]

export const FIELD_BY_KEY = Object.fromEntries(FIELDS.map((f) => [f.key, f])) as Record<SettingKey, FieldDef>

export type CategoryMap = Record<string, number>
export type FormValue = string | boolean | number[] | CategoryMap
export type FormState = Record<SettingKey, FormValue>

export function toForm(s: SystemSettings): FormState {
  const out = {} as FormState
  for (const f of FIELDS) {
    const v = s[f.key]
    if (f.kind === 'bool') out[f.key] = Boolean(v)
    else if (f.kind === 'triBool') out[f.key] = v === true ? 'on' : v === false ? 'off' : 'inherit'
    else if (f.kind === 'milestones' || f.kind === 'staff') out[f.key] = [...((v as number[]) ?? [])].sort((a, b) => a - b)
    else if (f.kind === 'categoryMap') out[f.key] = { ...((v as CategoryMap) ?? {}) }
    else out[f.key] = v === null || v === undefined ? '' : String(v)
  }
  return out
}

const numeric = (k: FieldKind) => k === 'percent' || k === 'money' || k === 'int' || k === 'decimal'

export function sameValue(f: FieldDef, a: FormValue, b: FormValue): boolean {
  if (f.kind === 'milestones' || f.kind === 'staff') {
    const x = a as number[]
    const y = b as number[]
    return x.length === y.length && x.every((v, i) => v === y[i])
  }
  if (f.kind === 'categoryMap') {
    const x = a as CategoryMap
    const y = b as CategoryMap
    const keys = new Set([...Object.keys(x), ...Object.keys(y)])
    return [...keys].every((k) => (x[k] ?? null) === (y[k] ?? null))
  }
  if (numeric(f.kind) || f.kind === 'optNumber') {
    const emptyA = String(a).trim() === ''
    const emptyB = String(b).trim() === ''
    return emptyA === emptyB && (emptyA || Number(a) === Number(b))
  }
  if (typeof a === 'string' && typeof b === 'string') return a.trim() === b.trim()
  return a === b
}

/** Payload value for the API. */
export function toPayload(f: FieldDef, v: FormValue): unknown {
  if (f.kind === 'triBool') return v === 'on' ? true : v === 'off' ? false : null
  if (f.kind === 'date') return String(v).trim() || null
  if (f.kind === 'optNumber') {
    const s = String(v).trim()
    if (!s) return null
    if (f.numKind === 'int') return Number.parseInt(s, 10)
    if (f.numKind === 'money') return Number(s).toFixed(2)
    return Number(s)
  }
  if (f.kind === 'int') return Number.parseInt(String(v), 10)
  if (f.kind === 'percent' || f.kind === 'money' || f.kind === 'decimal') return Number(v).toFixed(2)
  if (typeof v === 'string') return v.trim()
  return v
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const SLA_KEYS: SettingKey[] = ['support_sla_urgent_hours', 'support_sla_high_hours', 'support_sla_medium_hours', 'support_sla_low_hours']

export function validate(form: FormState): Partial<Record<SettingKey, string>> {
  const errors: Partial<Record<SettingKey, string>> = {}
  for (const f of FIELDS) {
    const v = form[f.key]
    if (numeric(f.kind)) {
      const s = String(v).trim()
      const n = Number(s)
      if (s === '' || !Number.isFinite(n)) { errors[f.key] = 'Enter a number.'; continue }
      if (f.kind === 'int' && !Number.isInteger(n)) { errors[f.key] = 'Use a whole number.'; continue }
      if ((f.kind === 'money' || f.kind === 'percent' || f.kind === 'decimal') && !/^\d+(\.\d{1,2})?$/.test(s)) {
        errors[f.key] = 'Use at most 2 decimal places, no sign.'; continue
      }
      if (f.min !== undefined && n < f.min) { errors[f.key] = `Must be at least ${f.min.toLocaleString('en-KE')}.`; continue }
      if (f.max !== undefined && n > f.max) { errors[f.key] = `Must be at most ${f.max.toLocaleString('en-KE')}.`; continue }
    }
    if (f.kind === 'email' && !EMAIL.test(String(v).trim())) errors[f.key] = 'Enter a valid email address.'
    if (f.kind === 'optNumber') {
      const s = String(v).trim()
      if (!s) continue
      const n = Number(s)
      if (!Number.isFinite(n)) { errors[f.key] = 'Enter a number, or leave blank for the server value.'; continue }
      if (f.numKind === 'int' && !Number.isInteger(n)) { errors[f.key] = 'Use a whole number.'; continue }
      if (f.numKind === 'money' && !/^\d+(\.\d{1,2})?$/.test(s)) { errors[f.key] = 'Use at most 2 decimal places, no sign.'; continue }
      if (f.min !== undefined && n < f.min) { errors[f.key] = `Must be at least ${f.min.toLocaleString('en-KE')}.`; continue }
      if (f.max !== undefined && n > f.max) { errors[f.key] = `Must be at most ${f.max.toLocaleString('en-KE')}.`; continue }
    }
    if (f.kind === 'date') {
      const s = String(v).trim()
      if (s && !/^\d{4}-\d{2}-\d{2}$/.test(s)) errors[f.key] = 'Use a date (YYYY-MM-DD), or leave blank.'
    }
  }
  const optNum = (k: SettingKey) => (String(form[k] ?? '').trim() === '' ? null : Number(form[k]))
  const minDep = optNum('min_deposit_kes')
  const maxDep = optNum('max_deposit_kes')
  if (minDep !== null && maxDep !== null && !errors.max_deposit_kes && minDep > maxDep) {
    errors.max_deposit_kes = 'Must be at least the smallest deposit.'
  }
  const maxWd = optNum('max_withdrawal_kes')
  if (maxWd !== null && !errors.max_withdrawal_kes && Number(form.minimum_withdrawal_amount) > maxWd) {
    errors.max_withdrawal_kes = 'Must be at least the minimum withdrawal.'
  }
  const minM = Number(form.min_challenge_milestone)
  const maxM = Number(form.max_challenge_milestone)
  if (!errors.min_challenge_milestone && !errors.max_challenge_milestone && minM > maxM) {
    errors.max_challenge_milestone = 'Must be at least the lowest milestone.'
  }
  const ms = form.challenge_milestones as number[]
  if (!ms.length) errors.challenge_milestones = 'Keep at least one milestone.'
  else if (!errors.min_challenge_milestone && !errors.max_challenge_milestone) {
    const out = ms.filter((m) => m < minM || m > maxM)
    if (out.length) errors.challenge_milestones = `${out.map((m) => m.toLocaleString('en-KE')).join(', ')} ${out.length === 1 ? 'is' : 'are'} outside ${minM.toLocaleString('en-KE')}–${maxM.toLocaleString('en-KE')}.`
  }
  for (const k of ['min_challenge_entry_fee', 'max_challenge_entry_fee'] as const) {
    if (!errors[k] && !Number.isInteger(Number(form[k]))) errors[k] = 'Use whole shillings.'
  }
  if (!errors.min_challenge_entry_fee && !errors.max_challenge_entry_fee && Number(form.min_challenge_entry_fee) >= Number(form.max_challenge_entry_fee)) {
    errors.max_challenge_entry_fee = 'Must be more than the lowest entry fee.'
  }
  if (form.maintenance_mode === true && !String(form.maintenance_message).trim()) {
    errors.maintenance_message = 'Tell customers why the app is unavailable.'
  }
  // Tighter priorities need tighter (or equal) targets.
  for (let i = 1; i < SLA_KEYS.length; i++) {
    const prev = SLA_KEYS[i - 1]
    const key = SLA_KEYS[i]
    if (!errors[prev] && !errors[key] && Number(form[key]) < Number(form[prev])) {
      errors[key] = `Must be at least the ${FIELD_BY_KEY[prev].label.replace('Reply target: ', '')} target (${form[prev]}h).`
    }
  }
  const mode = form.support_auto_assign_mode
  const agents = form.support_agent_ids as number[]
  const owners = Object.values(form.support_category_assignees as CategoryMap).filter(Boolean)
  if (mode === 'round_robin' && agents.length === 0) errors.support_agent_ids = 'Pick at least one agent, or turn assignment off.'
  if (mode === 'category' && agents.length === 0 && owners.length === 0) {
    errors.support_category_assignees = 'Give at least one category an owner, or pick agents.'
  }
  return errors
}

/** Human value for before → after lists. `staffName` resolves user ids. */
export function display(f: FieldDef, v: FormValue | null | undefined, staffName: (id: number) => string = (id) => `#${id}`): string {
  if (f.kind === 'triBool') return v === 'on' ? 'On' : v === 'off' ? 'Off' : 'Server default'
  if ((f.kind === 'optNumber' || f.kind === 'date') && (v === null || v === undefined || v === '')) return 'Server value'
  if (f.kind === 'optNumber') {
    const n = Number(v)
    if (f.numKind === 'money') return `KSh ${n.toLocaleString('en-KE', { maximumFractionDigits: 2 })}`
    return `${n.toLocaleString('en-KE', { maximumFractionDigits: 2 })}${f.unit ? ` ${f.unit}` : ''}`
  }
  if (v === null || v === undefined || v === '') return '—'
  if (f.kind === 'bool') return v ? 'On' : 'Off'
  if (f.kind === 'milestones') return (v as number[]).map((m) => m.toLocaleString('en-KE')).join(', ')
  if (f.kind === 'staff') return (v as number[]).length ? (v as number[]).map(staffName).join(', ') : 'Nobody'
  if (f.kind === 'categoryMap') {
    const entries = Object.entries(v as CategoryMap).filter(([, id]) => id)
    if (!entries.length) return 'No owners'
    return entries.map(([c, id]) => `${TICKET_CATEGORIES.find((x) => x.value === c)?.label ?? c}: ${staffName(id)}`).join(', ')
  }
  if (f.kind === 'select') return f.options?.find((o) => o.value === v)?.label ?? String(v)
  if (f.kind === 'percent') return `${Number(v).toFixed(2)}%`
  if (f.kind === 'money') return `KSh ${Number(v).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  if (f.kind === 'int') return `${Number(v).toLocaleString('en-KE')}${f.unit ? ` ${f.unit}` : ''}`
  if (f.kind === 'decimal') return `${Number(v)}${f.unit ? ` ${f.unit}` : ''}`
  return String(v)
}

/** Audit-log values are Python str() of the stored value; turn them back into form values. */
export function parseHistoryValue(f: FieldDef, raw: string): FormValue | null {
  if (f.kind === 'triBool') return raw === 'True' ? 'on' : raw === 'False' ? 'off' : 'inherit'
  if (f.kind === 'optNumber' || f.kind === 'date') return raw === 'None' ? '' : raw
  if (f.kind === 'bool') return raw === 'True' ? true : raw === 'False' ? false : null
  if (f.kind === 'milestones' || f.kind === 'staff') return (raw.match(/\d+/g) ?? []).map(Number)
  if (f.kind === 'categoryMap') {
    const out: CategoryMap = {}
    for (const m of raw.matchAll(/'(\w+)':\s*(\d+)/g)) out[m[1]] = Number(m[2])
    return out
  }
  return raw
}
