import type { SettingKey, SystemSettings } from './api'

export type FieldKind =
  | 'percent' | 'money' | 'int' | 'decimal' | 'bool' | 'email' | 'text' | 'milestones'
  | 'select' | 'staff' | 'categoryMap'
export type SectionId = 'access' | 'challenges' | 'withdrawals' | 'support' | 'gamification' | 'notifications'

export interface FieldDef {
  key: SettingKey
  label: string
  kind: FieldKind
  section: SectionId
  hint?: string
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
  { id: 'access', title: 'Customer access', description: 'Maintenance mode and the switches that pause whole features for customers. Takes effect within seconds.' },
  { id: 'challenges', title: 'Challenges and fees', description: 'The platform fee and the rules for new challenges.' },
  { id: 'withdrawals', title: 'Withdrawals', description: 'The smallest amount customers can cash out and the review time they are told.' },
  { id: 'support', title: 'Support desk', description: 'Response targets, who gets new tickets, and what happens when a ticket waits too long.' },
  { id: 'gamification', title: 'XP and rewards', description: 'How experience points are earned.', advanced: true },
  { id: 'notifications', title: 'Contacts, email and referrals', description: 'Where operational email goes.', advanced: true },
]

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

  { key: 'platform_fee_percentage', label: 'Platform fee', kind: 'percent', section: 'challenges', unit: '%', min: 0, max: 50, risky: true,
    hint: 'Taken from the total pool when a challenge settles.' },
  { key: 'challenge_milestones', label: 'Milestone options', kind: 'milestones', section: 'challenges', risky: true,
    hint: 'Step targets a creator can pick. Each must sit between the lowest and highest milestone.' },
  { key: 'min_challenge_milestone', label: 'Lowest milestone', kind: 'int', section: 'challenges', unit: 'steps', min: 1000, max: 1_000_000, risky: true },
  { key: 'max_challenge_milestone', label: 'Highest milestone', kind: 'int', section: 'challenges', unit: 'steps', min: 1000, max: 1_000_000, risky: true },
  { key: 'max_challenge_participants', label: 'Max participants', kind: 'int', section: 'challenges', unit: 'people', min: 2, max: 1000, risky: true },
  { key: 'min_challenge_entry_fee', label: 'Lowest entry fee', kind: 'money', section: 'challenges', unit: 'KSh', min: 0, max: 100_000, risky: true },
  { key: 'max_challenge_entry_fee', label: 'Highest entry fee', kind: 'money', section: 'challenges', unit: 'KSh', min: 0, max: 100_000, risky: true },
  { key: 'challenge_approval_required', label: 'New challenges need admin approval', kind: 'bool', section: 'challenges' },

  { key: 'minimum_withdrawal_amount', label: 'Minimum withdrawal', kind: 'money', section: 'withdrawals', unit: 'KSh', min: 0, max: 70_000, risky: true,
    hint: 'Requests below this are refused. Never lower than the server floor shown under Advanced > Server limits.' },
  { key: 'withdrawal_processing_time', label: 'Review time customers are told', kind: 'int', section: 'withdrawals', unit: 'hours', min: 1, max: 720 },

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

  { key: 'xp_per_step', label: 'XP per step', kind: 'decimal', section: 'gamification', unit: 'XP', min: 0, max: 100 },
  { key: 'daily_goal_bonus_xp', label: 'Daily goal bonus', kind: 'int', section: 'gamification', unit: 'XP', min: 0, max: 100_000 },

  { key: 'admin_email', label: 'Admin email', kind: 'email', section: 'notifications' },
  { key: 'support_email', label: 'Support email', kind: 'email', section: 'notifications' },
  { key: 'email_notifications_enabled', label: 'Send email notifications', kind: 'bool', section: 'notifications' },
  { key: 'referral_program_enabled', label: 'Referral programme', kind: 'bool', section: 'notifications' },
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
  if (numeric(f.kind)) {
    const emptyA = String(a).trim() === ''
    const emptyB = String(b).trim() === ''
    return emptyA === emptyB && (emptyA || Number(a) === Number(b))
  }
  if (typeof a === 'string' && typeof b === 'string') return a.trim() === b.trim()
  return a === b
}

/** Payload value for the API. */
export function toPayload(f: FieldDef, v: FormValue): unknown {
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
  if (!errors.min_challenge_entry_fee && !errors.max_challenge_entry_fee && Number(form.min_challenge_entry_fee) > Number(form.max_challenge_entry_fee)) {
    errors.max_challenge_entry_fee = 'Must be at least the lowest entry fee.'
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
  if (f.kind === 'bool') return raw === 'True' ? true : raw === 'False' ? false : null
  if (f.kind === 'milestones' || f.kind === 'staff') return (raw.match(/\d+/g) ?? []).map(Number)
  if (f.kind === 'categoryMap') {
    const out: CategoryMap = {}
    for (const m of raw.matchAll(/'(\w+)':\s*(\d+)/g)) out[m[1]] = Number(m[2])
    return out
  }
  return raw
}
