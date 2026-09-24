/** Response shapes of /api/admin/finance/* (backend: apps/admin_api/finance_views.py). */

export type WithdrawalStatus =
  | 'pending_review' | 'approved' | 'processing' | 'completed' | 'rejected' | 'failed' | 'cancelled'

export type WithdrawalMethod = 'mpesa' | 'bank' | 'paybill'

export interface WithdrawalRow {
  id: string
  user_id: number
  username: string
  email: string
  phone: string
  amount_kes: string
  method: WithdrawalMethod
  destination: string
  phone_number: string
  bank_name: string
  account_number: string
  short_code: string
  status: WithdrawalStatus
  tracking_reference: string
  mpesa_reference: string
  fail_reason: string
  rejection_reason: string
  reviewed_by: string | null
  reviewed_at: string | null
  callback_received_at: string | null
  created_at: string
  updated_at: string
  age_hours: number
}

export interface WithdrawalPage {
  count: number
  total_amount_kes: string
  limit: number
  offset: number
  results: WithdrawalRow[]
}

export interface WithdrawalFilters {
  status: string
  q?: string
  method?: string
  from?: string
  to?: string
  limit: number
  offset: number
}

export interface AmountCount {
  count: number
  amount_kes: string
}

export interface WithdrawalDetail {
  withdrawal: WithdrawalRow
  user: {
    id: number
    username: string
    email: string
    phone_number: string
    is_active: boolean
    joined_at: string
    wallet_balance: string
    locked_balance: string
    total_earned: string
    challenges_joined: number
    challenges_won: number
  }
  trust: {
    score: number | null
    status: string | null
    flags_total: number | null
    tier: string | null
    suspicious_sessions: number | null
    replay_attempts: number | null
    open_flags: number
    open_high_or_critical: number
    recent_flags: Array<{ id: number; flag_type: string; severity: string; reviewed: boolean; created_at: string }>
  }
  history: {
    by_status: Partial<Record<WithdrawalStatus, AmountCount>>
    previous: WithdrawalRow[]
  }
  ledger: {
    totals_by_type: Record<string, AmountCount>
    entries: number
    last_balance_after: string | null
    last_entry_at: string | null
    first_deposit_at: string | null
  }
  payout_transaction: {
    id: string
    status: string
    tracking_reference: string
    mpesa_reference: string
    fail_reason: string
    created_at: string
    updated_at: string
  } | null
}

export type LedgerType = 'deposit' | 'withdrawal' | 'challenge_entry' | 'payout' | 'fee' | 'refund'

export interface LedgerRow {
  id: number
  user: number | null
  user_username: string | null
  type: LedgerType
  amount: string
  balance_before: string
  balance_after: string
  description: string
  reference_id: string | null
  metadata: Record<string, unknown> | null
  created_at: string
  arithmetic_ok: boolean
}

export interface LedgerPage {
  count: number
  limit: number
  offset: number
  totals: {
    credits: string
    debits: string
    net: string
    users: number
    by_type: Record<string, { count: number; amount: string }>
  }
  results: LedgerRow[]
}

export interface LedgerFilters {
  types: LedgerType[]
  direction: 'all' | 'credit' | 'debit'
  user: string
  q: string
  from: string
  to: string
  ordering: '-created_at' | 'created_at' | '-amount' | 'amount'
}

export interface PeriodMeta {
  from: string
  to: string
  days: number
  timezone: string
}

export interface ReconciliationCheck {
  key: string
  label: string
  description: string
  ok: boolean
  value: number | string
  unit: string
  rows?: Array<Record<string, string | number>>
  detail?: Record<string, string>
}

export interface FinanceReport {
  period: PeriodMeta
  revenue: {
    platform_fees_kes: string
    fee_records: number
    top_challenges: Array<{ challenge_id: number; challenge: string; amount_kes: string; total_pool?: string; collected_at: string }>
  }
  ledger: Record<LedgerType, AmountCount>
  gateway: Record<string, AmountCount>
  withdrawals: {
    requested_by_status: Record<WithdrawalStatus, AmountCount>
    paid_kes: string
    paid_count: number
  }
  net_cash_kes: string
  pools: {
    finalised_kes: string
    finalised_count: number
    cancelled_kes: string
    cancelled_count: number
    open_kes: string
    open_count: number
  }
  daily: Array<{
    date: string
    deposits: number
    withdrawals_requested: number
    withdrawals_paid: number
    entries: number
    payouts: number
    refunds: number
    fees: number
  }>
  reconciliation: ReconciliationCheck[]
  generated_at: string
}

export interface AnalyticsReport {
  period: PeriodMeta
  users: {
    total: number
    new: number
    active_in_period: number
    active_last_7d: number
    active_last_30d: number
    avg_daily_active: number
    stickiness_pct: number | null
  }
  steps: {
    total: number
    user_days: number
    avg_per_active_day: number
    distribution: Array<{ label: string; user_days: number }>
  }
  challenges: {
    created: number
    status: Record<string, number>
    joins: number
    unique_joiners: number
    avg_participants: number
    avg_entry_fee_kes: string | null
    finished_participants: number
    qualified_participants: number
    qualification_rate_pct: number | null
  }
  money: {
    depositors: number
    new_users_joined_challenge: number
    new_user_join_rate_pct: number | null
  }
  daily: Array<{
    date: string
    signups: number
    active_users: number
    active_30d: number
    steps: number
    avg_steps_per_active: number
    challenge_joins: number
    challenges_created: number
  }>
  cohorts: Array<{ week_start: string; size: number; retention_pct: Array<number | null> }>
  generated_at: string
}
