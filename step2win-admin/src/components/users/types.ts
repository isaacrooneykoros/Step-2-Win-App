export interface Paged<T> {
  count: number
  next: string | null
  previous: string | null
  results: T[]
}

export type TrustStatus = 'GOOD' | 'WARN' | 'REVIEW' | 'RESTRICT' | 'SUSPEND' | 'BAN'

export interface ConsoleUser {
  id: number
  username: string
  email: string
  phone_number: string | null
  wallet_balance: string
  available_balance: string
  locked_balance: string
  trust_score: number
  trust_status: TrustStatus
  open_flags: number
  last_seen_at: string | null
  total_steps: number
  challenges_won: number
  challenges_joined: number
  total_earned: string
  current_streak: number
  is_active: boolean
  is_staff: boolean
  is_banned: boolean
  device_platform: string | null
  date_joined: string
  last_login: string | null
  total_deposited: number | string
  xp_profile: { level: number; total_xp: number; xp_this_week: number } | null
  badges_count: number
  created_at: string
  updated_at: string
}

export interface UserStats {
  total_users: number
  active_users: number
  banned_users: number
  staff_users: number
  new_users_24h: number
  new_users_7d: number
  flagged_users: number
  low_trust_users: number
}

export interface AuditEntry {
  id: number
  admin_username: string
  action: string
  description: string
  changes: Record<string, unknown> | null
  created_at: string
}

export interface UserFlag {
  id: number
  flag_type: string
  severity: 'low' | 'medium' | 'high' | 'critical'
  date: string
  reviewed: boolean
  actioned: boolean
  admin_action: string | null
  admin_note: string | null
  details: Record<string, unknown>
  created_at: string
}

export interface UserOverview {
  user: ConsoleUser
  wallet: {
    wallet_balance: string
    available_balance: string
    locked_balance: string
    total_deposited: string
    total_withdrawn: string
    total_earned: string
  }
  trust: {
    score: number
    status: TrustStatus
    flags_total: number
    updated_at: string | null
    profile: null | {
      trust_score: number
      trust_tier: string
      verified_sessions_count: number
      suspicious_sessions_count: number
      replay_attempts_count: number
      total_accepted_steps: number
      total_rejected_steps: number
      last_suspicious_at: string | null
    }
  }
  activity: {
    daily_goal: number
    best_day_steps: number
    current_streak: number
    best_streak: number
    days: Array<{ date: string; steps: number; source: string | null; is_suspicious: boolean; synced_at: string | null }>
    syncs: Array<{
      id: string
      created_at: string
      steps_delta: number
      accepted: boolean
      replay_detected: boolean
      signature_valid: boolean
      interval_risk_score: number
      rejection_reason: string | null
    }>
  }
  devices: Array<{
    id: string
    platform: string
    app_version: string | null
    trust_level: string
    is_active: boolean
    first_seen_at: string
    last_seen_at: string
  }>
  sessions: Array<{
    id: string
    device_type: string
    device_name: string
    os_version: string
    app_version: string
    ip_address: string | null
    country: string
    is_active: boolean
    last_active_at: string
    created_at: string
  }>
  challenges: Array<{
    challenge_id: number
    name: string
    status: string
    entry_fee: string
    milestone: number
    start_date: string
    end_date: string
    steps: number
    qualified: boolean
    rank: number | null
    payout: string
    joined_at: string
  }>
  transactions: Array<{
    id: number
    type: string
    amount: string
    balance_after: string
    description: string
    reference_id: string | null
    created_at: string
  }>
  withdrawals: Array<{
    id: string
    status: string
    amount_kes: string
    method: string
    destination: string
    rejection_reason: string
    created_at: string
    reviewed_at: string | null
  }>
  flags: UserFlag[]
  tickets: Array<{
    id: number
    subject: string
    category: string
    status: string
    priority: string
    assigned_to_username: string | null
    created_at: string
    updated_at: string
  }>
  audit: AuditEntry[]
}

export interface StepReason {
  kind: 'flag' | 'activity'
  id: number
  type: string
  severity: string | null
  reviewed: boolean
}

export interface StepLog {
  id: number
  user_id: number
  username: string
  email: string
  date: string
  synced_at: string
  source: string
  steps: number
  distance_km: number | null
  calories_active: number | null
  active_minutes: number | null
  is_suspicious: boolean
  reasons: StepReason[]
}

export interface StepLogPage {
  total: number
  results: StepLog[]
  summary: {
    total_steps: number
    users_with_logs: number
    first_log_at: string | null
    last_log_at: string | null
    suspicious_count: number
    distribution: Array<{ label: string; min: number; max: number | null; count: number; suspicious: number }>
    daily: Array<{ date: string; steps: number; logs: number; users: number; suspicious: number }>
  }
}

export interface StepHourly {
  user_id: number
  date: string | null
  hours: Array<{ hour: number; label: string; steps: number; distance_km: number; calories: number }>
  summary: { total_steps: number; total_distance_km: number; total_calories: number }
}

export interface AuditLogRow {
  id: number
  admin_username: string
  action: string
  resource_type: string
  resource_id: number | null
  resource_name: string
  description: string
  changes: Record<string, unknown> | null
  ip_address: string | null
  created_at: string
}

export interface AuditLogPage {
  total: number
  results: AuditLogRow[]
  admins?: string[]
}

export interface ChallengeRow {
  id: number
  name: string
  description: string
  status: 'pending' | 'active' | 'completed' | 'cancelled'
  creator: number
  created_by_username: string
  entry_fee: string
  total_pool: string
  platform_fee: string
  net_pool: string
  max_participants: number
  current_entries: number
  start_date: string
  end_date: string
  milestone: number
  invite_code: string | null
  is_private: boolean
  is_public: boolean
  is_featured: boolean
  featured_until: string | null
  is_platform_challenge: boolean
  platform_bonus_kes: string
  win_condition: string
  payout_structure: string
  created_at: string
  updated_at: string
}

export interface ChallengeStats {
  total_challenges: number
  live_challenges: number
  completed_challenges: number
  pending_challenges: number
  cancelled_challenges: number
  live_pool: string
  pending_pool: string
  total_entries: number
  total_prize_pool: string
}

export interface ChallengeResults {
  challenge: ChallengeRow
  results: Array<{
    position: number
    user: string
    user_id: number
    steps: number
    qualified: boolean
    rank: number | null
    payout: string
    joined_at: string
  }>
  audit: AuditEntry[]
}

export interface BadgeDef {
  id: number
  slug: string
  name: string
  description: string
  icon: string
  badge_type: 'milestone' | 'achievement' | 'challenge' | 'streak' | 'rank' | string
  color: string
  criteria_type: string
  criteria_value: number | null
  users_earned: number
  created_at: string
}

export interface BadgeInput {
  slug: string
  name: string
  description: string
  icon: string
  badge_type: string
  criteria_type: string
  criteria_value: number | null
}
