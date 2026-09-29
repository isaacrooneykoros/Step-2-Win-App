/**
 * Client for the social moderation endpoints (/api/admin/social/*): reports queue,
 * team moderation and social settings. Backend: backend/apps/social/admin_views.py.
 */
import { refreshAccessToken, useAuthStore } from '../../store/authStore'
import { API_BASE } from '../../config/network'

export class SocialApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

async function send<T>(path: string, init?: { method?: string; body?: unknown }, retried = false): Promise<T> {
  const token = useAuthStore.getState().accessToken
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {}
  if (init?.body !== undefined) headers['Content-Type'] = 'application/json'
  let res: Response
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method: init?.method ?? 'GET',
      headers,
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    })
  } catch {
    throw new SocialApiError(`Cannot reach the API at ${API_BASE}. Check the backend is running.`, 0)
  }
  if (res.status === 401 && !retried) {
    if (await refreshAccessToken()) return send<T>(path, init, true)
    useAuthStore.getState().clearAuth()
    if (!window.location.pathname.startsWith('/login')) window.location.href = '/login'
    throw new SocialApiError('Session expired. Please sign in again.', 401)
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string; detail?: string } | null
    const message = body?.error || body?.detail || (res.status === 404 ? 'Not found (404). The backend may not have this endpoint yet.' : `Request failed (${res.status}).`)
    throw new SocialApiError(message, res.status)
  }
  return res.json() as Promise<T>
}

export interface SocialUserRef {
  id: number
  username: string
  is_active: boolean
  deleted: boolean
}

export interface SocialTeam {
  id: number
  name: string
  description: string
  visibility: 'public' | 'invite_only'
  member_count: number
  is_disabled: boolean
  disabled_reason: string
  owner: SocialUserRef | null
  created_at: string
  open_reports?: number
  week_steps?: number
}

export type ReportStatus = 'open' | 'actioned' | 'dismissed'

export interface SocialReport {
  id: number
  target_type: 'user' | 'team'
  target_user: SocialUserRef | null
  target_team: SocialTeam | null
  reporter: SocialUserRef | null
  reason: string
  reason_label: string
  details: string
  status: ReportStatus
  reviewed_by: string | null
  reviewed_at: string | null
  resolution_note: string
  created_at: string
  target_open_reports: number
}

export interface SocialSettings {
  social_enabled: boolean
  feed_enabled: boolean
  teams_enabled: boolean
  max_team_members: number
  max_teams_per_user: number
  max_friends: number
  friend_requests_per_day: number
  updated_at: string | null
}

export interface SocialOverview {
  friendships: number
  teams: number
  disabled_teams: number
  open_reports: number
  ranked_this_week: number
  feed_items_7d: number
  week_start: string
}

function qs(params: Record<string, string | undefined>): string {
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v) sp.append(k, v)
  const s = sp.toString()
  return s ? `?${s}` : ''
}

export const socialAdminApi = {
  overview: () => send<SocialOverview>('/api/admin/social/overview/'),
  settings: () => send<SocialSettings>('/api/admin/social/settings/'),
  updateSettings: (patch: Partial<SocialSettings>) => send<SocialSettings>('/api/admin/social/settings/', { method: 'PATCH', body: patch }),
  reports: (status: ReportStatus, targetType?: 'user' | 'team') =>
    send<{ results: SocialReport[]; counts: Partial<Record<ReportStatus, number>> }>(`/api/admin/social/reports/${qs({ status, target_type: targetType })}`),
  resolve: (id: number, status: 'actioned' | 'dismissed', note: string) =>
    send<SocialReport>(`/api/admin/social/reports/${id}/resolve/`, { method: 'POST', body: { status, note } }),
  teams: (q: string, filter?: 'reported' | 'disabled') =>
    send<{ results: SocialTeam[] }>(`/api/admin/social/teams/${qs({ q: q.trim(), filter })}`),
  moderateTeam: (id: number, body: { action: 'rename' | 'disable' | 'enable'; name?: string; reason?: string }) =>
    send<SocialTeam>(`/api/admin/social/teams/${id}/moderate/`, { method: 'POST', body }),
}
