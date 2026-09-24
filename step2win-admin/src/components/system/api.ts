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
  referral_program_enabled: boolean
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

export interface SettingsContext {
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
  profile: () => http<AdminProfile>('/api/admin/profile/'),
  saveProfile: (form: FormData) => http<AdminProfile>('/api/admin/profile/', { method: 'PATCH', body: form }),
}
