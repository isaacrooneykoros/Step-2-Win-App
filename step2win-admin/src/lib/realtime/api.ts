import api from '../../services/api/client'

export interface RealtimePulse {
  generated_at: string
  step_syncs_last_hour: number | null
  users_synced_last_hour: number | null
  signups_last_24h: number | null
  logins_last_hour: number | null
  realtime: { layer: string; admins_connected: number }
}

export const PULSE_KEY = ['admin', 'realtime', 'pulse'] as const

export const realtimeApi = {
  pulse: async (): Promise<RealtimePulse> => (await api.get<RealtimePulse>('/api/admin/realtime/pulse/')).data,
}
