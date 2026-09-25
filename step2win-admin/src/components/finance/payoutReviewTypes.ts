// Payout reviews: challenge payouts held at settlement (/api/admin/payout-reviews/).

export type PayoutReviewStatus = 'held' | 'released' | 'forfeited'

export interface PayoutHoldReason {
  code: 'trust_banned' | 'account_closed' | 'trust_status' | 'open_high_flags' | 'suspicious_days' | 'large_win_with_flags' | string
  label: string
  detail: Record<string, unknown>
}

export interface PayoutReviewRow {
  id: number
  status: PayoutReviewStatus
  amount: string
  created_at: string
  age_hours: number
  user: { id: number; username: string; email: string; is_active: boolean; trust_score: number; trust_status: string }
  user_deleted: boolean
  challenge: {
    id: number
    name: string
    status: string
    start_date: string
    end_date: string
    entry_fee: string
    total_pool: string
    payout_structure: string
    milestone: number
  }
  reasons: PayoutHoldReason[]
  forfeit_only: boolean
  decided_by: string | null
  decided_at: string | null
  note: string | null
  resolution: Record<string, unknown> | null
}

export interface PayoutReviewList {
  results: PayoutReviewRow[]
  counts: Record<PayoutReviewStatus, number>
  held_total: string
  status: string
}

export interface PayoutReviewDetail extends PayoutReviewRow {
  can_release: boolean
  release_blocked_reason: string | null
  result: { final_steps: number; final_rank: number | null; payout_method: string; qualified: boolean } | null
  evidence: {
    trust: {
      score: number
      status: string
      flags_total: number
      admin_lock: { status: string; ceiling: number; until: string | null } | null
      actions: Array<{ id: number; action: string; admin: string; description: string; reason?: string | null; created_at: string }>
    }
    flags_in_window: Array<{ id: number; type: string; severity: string; date: string; reviewed: boolean; actioned: boolean; created_at: string }>
    flags_open_in_window: number
    daily_steps: {
      days: Array<{ date: string; steps: number; recorded: boolean; suspicious: boolean; vs_baseline: number | null }>
      baseline_avg: number | null
      baseline_days: number
      baseline_window: string
    }
  }
  forfeit_preview: {
    to_platform: boolean
    recipients: Array<{ username: string | null; user_id: number; original_payout: string; share: string }>
  } | null
}

export interface PayoutDecisionResult {
  id: number
  status: PayoutReviewStatus
  already_decided?: boolean
  wallet_transaction_id?: number
  redistributed?: Array<{ user_id: number; share: string }>
  platform_revenue_id?: number | null
}
