import { http } from './http'
import type { AdminProfile } from '../../types/admin'

/** Stored platform settings (GET/POST /api/admin/settings/). Decimals arrive as strings. */
export interface SystemSettings {
  platform_fee_percentage: string
  minimum_withdrawal_amount: string
  withdrawal_processing_time: number
  min_challenge_entry_fee: string
  max_challenge_entry_fee: string
  min_challenge_milestone: number
  max_challenge_milestone: number
  challenge_milestones: number[]
  max_challenge_participants: number
  challenge_approval_required: boolean
  registrations_enabled: boolean
  challenges_enabled: boolean
  withdrawals_enabled: boolean
  xp_per_step: string
  daily_goal_bonus_xp: number
  admin_email: string
  support_email: string
  email_notifications_enabled: boolean
  maintenance_mode: boolean
  maintenance_message: string
  support_sla_urgent_hours: number
  support_sla_high_hours: number
  support_sla_medium_hours: number
  support_sla_low_hours: number
  support_auto_assign_mode: 'off' | 'round_robin' | 'category'
  support_agent_ids: number[]
  support_category_assignees: Record<string, number>
  support_escalation_enabled: boolean
  support_escalation_raise_priority: boolean
  payout_holds_enabled: boolean
  payout_hold_trust_score_max: number
  payout_hold_large_win_kes: string
  device_integrity_policy: 'shadow' | 'enforce'
  health_trusted_origins: string
  // Business switches moved from the environment. null = use the server value.
  rank_payouts_enabled: boolean | null
  step_money_requires_evidence: boolean | null
  step_evidence_cutover_date: string | null
  play_integrity_accept_basic: boolean | null
  min_deposit_kes: string | null
  max_deposit_kes: string | null
  max_withdrawal_kes: string | null
  max_daily_withdrawal_kes: string | null
  max_withdrawals_per_day: number | null
  max_withdrawals_per_hour: number | null
  min_seconds_between_withdrawals: number | null
  paid_challenge_min_trust_score: number | null
  paid_challenge_min_joined: number | null
  max_locked_balance_percent: number | null
  risk_ml_hold_threshold: number | null
  recon_max_stuck_processing: number | null
  recon_max_unprocessed_callbacks: number | null
  recon_max_negative_balance_users: number | null
  recon_max_callback_failure_rate_pct: number | null
  drift_lookback_hours: number | null
  drift_min_samples: number | null
  drift_per_sample_alert_pct: number | null
  drift_max_avg_abs_delta_pct: number | null
  drift_max_high_drift_ratio_pct: number | null
  drift_max_review_mismatch_ratio_pct: number | null
  updated_at: string | null
  updated_by: string | null
}

export type SettingKey = Exclude<keyof SystemSettings, 'updated_at' | 'updated_by'>

export interface SettingsHistoryEntry {
  id: number
  admin_username: string
  description: string
  changes: Record<string, { old: string | null; new: string | null }> | null
  created_at: string
}

export interface StaffAccount {
  id: number
  username: string
  email: string
  is_superuser: boolean
  is_active: boolean
  last_login: string | null
  date_joined: string
}

/** How a console rule resolves (apps/admin_api/business_rules.py). */
export interface RuleInfo {
  value: string | number | boolean | null
  source: 'console' | 'server'
  server_value: string | number | boolean | null
  server_setting: string
  /** cap = the server value is a ceiling; floor = a floor; null = plain fallback. */
  bound: 'cap' | 'floor' | null
  range: [number, number] | null
  floor?: number
}

export interface PrivacySettings {
  retention_enabled: boolean
  sync_payload_days: number
  legacy_waypoint_days: number
  risk_ml_days: number
  interval_verification_days: number
  password_reset_days: number
  login_log_days: number
  retention_batch_size: number
  walk_raw_points_days: number | null
  export_link_hours: number
  export_cooldown_hours: number
  require_consent_at_registration: boolean
  min_terms_version: number
  min_privacy_version: number
  server: { walk_raw_points_days: number; walk_raw_points_max_days: number; walk_raw_points_effective_days: number }
  updated_at: string | null
  updated_by: string | null
}

export interface SettingsContext {
  rules?: Partial<Record<SettingKey, RuleInfo>>
  enforced_by: Partial<Record<SettingKey, string>>
  impact: { active_challenges: number; pending_challenges: number }
  server_limits: {
    payments: Record<string, number | null>
    challenges: Record<string, number | null>
    anti_cheat: Record<string, number | boolean | string | null>
  }
  history: SettingsHistoryEntry[]
  staff: StaffAccount[]
}

export const systemApi = {
  settings: () => http<SystemSettings>('/api/admin/settings/'),
  save: (changes: Partial<Record<SettingKey, unknown>>) => http<SystemSettings>('/api/admin/settings/update/', { body: changes }),
  context: () => http<SettingsContext>('/api/admin/settings/context/'),
  privacy: () => http<PrivacySettings>('/api/privacy/admin/settings/'),
  savePrivacy: (changes: Partial<Record<keyof PrivacySettings, unknown>>) =>
    http<PrivacySettings>('/api/privacy/admin/settings/', { method: 'PATCH', body: changes }),
  profile: () => http<AdminProfile>('/api/admin/profile/'),
  saveProfile: (form: FormData) => http<AdminProfile>('/api/admin/profile/', { method: 'PATCH', body: form }),
}
