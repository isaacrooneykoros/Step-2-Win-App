/** Payload types for staff roles, money controls and user tools (admin console part A). */

export interface WalletCorrection {
  id: number
  kind: 'adjustment' | 'reversal'
  status: 'pending' | 'applied' | 'rejected' | 'failed'
  user_id: number
  username: string
  amount: string
  reason: string
  reference: string
  target_transaction_id: number | null
  needs_second_approval: boolean
  requested_by: string | null
  requested_by_id: number | null
  requested_at: string
  decided_by: string | null
  decided_at: string | null
  decision_note: string
  transaction_id: number | null
  error: string
}

export interface DepositRow {
  id: string
  user_id: number
  username: string
  amount_kes: string
  status: string
  phone_number: string
  order_id: string
  collection_id: string
  mpesa_reference: string
  fail_reason: string
  created_at: string
  updated_at: string
  callback_received_at: string | null
  age_hours: number
}

export interface DepositPage {
  count: number
  results: DepositRow[]
  counts: { pending: number; stuck: number; failed: number; completed: number }
}

export interface ChangeEntry {
  id: number
  action: string
  changes: Record<string, unknown> | null
  actor: string | null
  timestamp: string
}

export interface DepositDetail {
  deposit: DepositRow
  callbacks: Array<{ id: number; type: string; processed: boolean; created_at: string; payload: unknown }>
  wallet_transaction: { id: number; amount: string; balance_after: string; created_at: string } | null
  history: ChangeEntry[]
  audit: Array<{ id: number; admin_username: string; action: string; description: string; created_at: string }>
}

export interface StepCorrectionRow {
  id: number
  date: string
  kind: 'set' | 'void' | 'clear'
  steps: number | null
  previous_steps: number
  previous_eligible_steps: number | null
  reason: string
  created_by: string | null
  created_at: string
}

export interface StepCorrectionResult {
  correction_id: number
  date: string
  kind: string
  steps: { old: number; new: number }
  eligible_steps: { old: number | null; new: number | null }
  is_suspicious: boolean
}

export interface UserRecords {
  consents: Array<{ id: number; purpose: string; granted: boolean; version: string; source: string; app_version: string; created_at: string }>
  legal_acks: Array<{ id: number; document: string; document_type: string; version_seen: number; current_version: number; acknowledged_at: string }>
  change_history: ChangeEntry[]
  lockout: { locked: boolean; failures: number; limit: number }
  step_corrections: StepCorrectionRow[]
  badges: Array<{ badge_id: number; name: string; icon: string; earned_at: string }>
  xp: { total_xp: number; level: number }
  xp_events: Array<{ id: number; event_type: string; amount: number; description: string; created_at: string }>
}

export interface StaffRow {
  id: number
  username: string
  email: string
  is_active: boolean
  is_owner: boolean
  roles: string[]
  legacy_roles: boolean
  last_login: string | null
  date_joined: string | null
  roles_updated_at: string | null
}

export interface StaffInviteRow {
  id: number
  email: string
  roles: string[]
  status: 'pending' | 'accepted' | 'revoked' | 'expired'
  code_hint: string
  created_by: string | null
  created_at: string
  expires_at: string
  accepted_at: string | null
  accepted_username: string | null
}

export interface RoleInfo {
  value: string
  label: string
  description: string
  permissions: string[]
}

export interface StaffOverview {
  staff: StaffRow[]
  invites: StaffInviteRow[]
  catalog: { roles: RoleInfo[]; permissions: Array<{ value: string; description: string }> }
}

/** A fresh idempotency key for one money request (reused on retry of the same form). */
export function newIdempotencyKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
}
