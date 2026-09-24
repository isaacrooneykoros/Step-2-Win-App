/**
 * API client for the Users, Step logs, Audit log, Challenges and Badges pages.
 * Uses the same session as `services/adminApi` (in-memory access token +
 * refresh token rotation) but returns typed payloads and keeps field errors.
 */
import { refreshAccessToken, useAuthStore } from '../../store/authStore'
import { API_BASE } from '../../config/network'
import type {
  AuditLogPage, BadgeDef, BadgeInput, ChallengeResults, ChallengeRow, ChallengeStats, ConsoleUser, Paged,
  StepHourly, StepLogPage, UserOverview, UserStats,
} from './types'

/** Error with the server message plus per-field messages when the API returned them. */
export class ApiError extends Error {
  status: number
  fields: Record<string, string>
  constructor(message: string, status: number, fields: Record<string, string> = {}) {
    super(message)
    this.status = status
    this.fields = fields
  }
}

function first(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null
  if (Array.isArray(value)) {
    for (const v of value) {
      const m = first(v)
      if (m) return m
    }
  }
  return null
}

function parseError(text: string, status: number): ApiError {
  let body: unknown = null
  try { body = JSON.parse(text) } catch { /* not JSON */ }
  if (!body || typeof body !== 'object') {
    return new ApiError(status >= 500 ? `Server error (${status})` : text.slice(0, 200) || `Request failed (${status})`, status)
  }
  const rec = body as Record<string, unknown>
  // DRF custom handler wraps errors as { error: true, message, details }.
  const inner = rec.details && typeof rec.details === 'object' ? (rec.details as Record<string, unknown>) : rec
  const fields: Record<string, string> = {}
  for (const [k, v] of Object.entries(inner)) {
    if (['detail', 'error', 'message', 'status', 'non_field_errors'].includes(k)) continue
    const m = first(v)
    if (m) fields[k] = m
  }
  const message =
    first(inner.detail) ?? first(inner.error) ?? first(inner.non_field_errors) ??
    (typeof rec.error === 'string' ? rec.error : null) ??
    (Object.keys(fields).length ? `${Object.keys(fields)[0].replace(/_/g, ' ')}: ${Object.values(fields)[0]}` : null) ??
    first(rec.message) ?? `Request failed (${status})`
  return new ApiError(message, status, fields)
}

/** Single-flight refresh shared with every API helper (see store/authStore). */
function refreshAccess(): Promise<string | null> {
  return refreshAccessToken()
}

async function request<T>(path: string, init: RequestInit = {}, retried = false): Promise<T> {
  const token = useAuthStore.getState().accessToken
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers as Record<string, string> | undefined),
    },
  })
  if (res.status === 401 && !retried) {
    if (await refreshAccess()) return request<T>(path, init, true)
    useAuthStore.getState().clearAuth()
    if (!window.location.pathname.startsWith('/login')) window.location.href = '/login'
    throw new ApiError('Session expired. Please sign in again.', 401)
  }
  if (!res.ok) throw parseError(await res.text(), res.status)
  if (res.status === 204) return {} as T
  return res.json() as Promise<T>
}

type Params = Record<string, string | number | boolean | undefined | null>
function qs(params: Params): string {
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue
    sp.append(k, String(v))
  }
  const s = sp.toString()
  return s ? `?${s}` : ''
}

const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) })

export const consoleApi = {
  // Users
  listUsers: (p: { page: number; page_size: number; search?: string; status?: string; trust?: string; ordering?: string }) =>
    request<Paged<ConsoleUser>>(`/api/admin/users/${qs(p)}`),
  userStats: () => request<UserStats>('/api/admin/users/user_stats/'),
  userOverview: (id: number) => request<UserOverview>(`/api/admin/users/${id}/overview/`),
  banUser: (id: number, reason: string) => post<{ status: string }>(`/api/admin/users/${id}/ban_user/`, { reason }),
  unbanUser: (id: number, reason: string) => post<{ status: string }>(`/api/admin/users/${id}/unban_user/`, { reason }),
  makeStaff: (id: number, reason: string) => post<{ status: string }>(`/api/admin/users/${id}/make_staff/`, { reason }),
  removeStaff: (id: number, reason: string) => post<{ status: string }>(`/api/admin/users/${id}/remove_staff/`, { reason }),
  resetPassword: (id: number, newPassword: string, reason: string) =>
    post<{ status: string }>(`/api/admin/users/${id}/reset_password/`, { new_password: newPassword, reason }),
  resetSteps: (id: number, reason: string) => post<{ status: string }>(`/api/admin/users/${id}/reset_steps/`, { reason }),
  updateUser: (id: number, data: { username?: string; email?: string; phone_number?: string }) =>
    request<ConsoleUser>(`/api/admin/users/${id}/update_user/`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteUser: (id: number, reason: string) =>
    request<{ status: string }>(`/api/admin/users/${id}/delete_user/`, { method: 'DELETE', body: JSON.stringify({ reason }) }),
  actionFlag: (flagId: number, action: string, adminNote: string) =>
    post<{ status: string }>(`/api/admin/fraud/${flagId}/action/`, { action, admin_note: adminNote || undefined }),

  // Steps
  stepLogs: (p: Params) => request<StepLogPage>(`/api/admin/steps/logs/${qs(p)}`),
  stepHourly: (userId: number, date: string) => request<StepHourly>(`/api/admin/steps/hourly/${qs({ user_id: userId, date })}`),

  // Audit
  auditLogs: (p: Params) => request<AuditLogPage>(`/api/admin/audit-logs/${qs(p)}`),

  // Challenges
  listChallenges: (p: { page: number; page_size: number; status?: string; search?: string; ordering?: string }) =>
    request<Paged<ChallengeRow>>(`/api/admin/challenges/${qs(p)}`),
  challengeStats: () => request<ChallengeStats>('/api/admin/challenges/challenge_stats/'),
  challengeResults: (id: number) => request<ChallengeResults>(`/api/admin/challenges/${id}/results/`),
  approveChallenge: (id: number) => post<{ status: string }>(`/api/admin/challenges/${id}/approve_challenge/`),
  rejectChallenge: (id: number, reason: string) => post<{ status: string }>(`/api/admin/challenges/${id}/reject_challenge/`, { reason }),
  cancelChallenge: (id: number, reason: string) => post<{ status: string }>(`/api/admin/challenges/${id}/cancel_challenge/`, { reason }),
  setFeatured: (id: number, featured: boolean) => post<ChallengeRow>(`/api/admin/challenges/${id}/set_featured/`, { featured }),
  updateChallenge: (id: number, data: { name?: string; milestone?: number; max_participants?: number; end_date?: string }) =>
    request<ChallengeRow>(`/api/admin/challenges/${id}/update_challenge/`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteChallenge: (id: number) => request<{ status: string }>(`/api/admin/challenges/${id}/delete_challenge/`, { method: 'DELETE' }),

  // Badges
  listBadges: () => request<Paged<BadgeDef>>('/api/admin/badges/?page_size=200'),
  createBadge: (data: BadgeInput) => post<BadgeDef>('/api/admin/badges/', data),
  updateBadge: (id: number, data: Partial<BadgeInput>) =>
    request<BadgeDef>(`/api/admin/badges/${id}/`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteBadge: (id: number) => request<void>(`/api/admin/badges/${id}/`, { method: 'DELETE' }),
  awardBadge: (id: number, userId: number) =>
    post<{ status: string; user: string; badge: string; created: boolean }>(`/api/admin/badges/${id}/award_to_user/`, { user_id: userId }),

  // Current admin (for permission gating)
  me: () => request<{ id: number; username: string; is_staff: boolean; is_superuser?: boolean }>('/api/admin/profile/'),
}
