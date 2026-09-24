/**
 * Client + types for the trust & safety endpoints (backend/apps/admin_api/trust_views.py)
 * and the existing ops monitoring endpoint.
 */
import { refreshAccessToken, useAuthStore } from '../../store/authStore'
import { API_BASE } from '../../config/network'
import type { OpsMonitoringResponse } from '../../types/admin'
import { ApiError } from '../finance/api'

export { ApiError }

export type Severity = 'critical' | 'high' | 'medium' | 'low'
export type CaseKind = 'flag' | 'session'
export type TrustStatus = 'GOOD' | 'WARN' | 'REVIEW' | 'RESTRICT' | 'SUSPEND' | 'BAN'
export type FlagAction = 'dismiss' | 'warn' | 'restrict' | 'suspend' | 'ban'
export type SessionDecision = 'approved' | 'rejected' | 'escalated'
export type ModerationAction = 'warn' | 'restrict' | 'suspend' | 'ban' | 'unrestrict' | 'unsuspend' | 'unban'

export interface UserBrief {
  id: number
  username: string
  email: string
  is_active: boolean
  trust_score: number
  trust_status: TrustStatus
  has_trust_record: boolean
}

export interface TrustCase {
  key: string
  kind: CaseKind
  id: string
  user: UserBrief
  type: string
  severity: Severity
  status: 'open' | 'actioned' | 'dismissed' | 'approved' | 'rejected' | 'reviewed' | 'escalated'
  review_status?: string
  event_date: string | null
  created_at: string
  age_hours: number
  summary: string
  rule_codes: string[]
  risk_score: number | null
  last_action: string | null
  reviewed_at: string | null
  reviewed_by: string | null
  admin_note: string | null
}

export interface CasePage {
  count: number
  results: TrustCase[]
  by_severity: Record<Severity, number>
  types: Array<{ type: string; count: number }>
}

export interface TrustSummary {
  open_total: number
  open_flags: number
  open_sessions: number
  open_by_severity: Record<Severity, number>
  oldest_open_age_hours: number | null
  flags_today: number
  decided_7d: { actioned: number; dismissed: number; sessions: number }
  enforcement: { restricted: number; suspended: number; banned: number; disabled_accounts: number }
  daily: Array<{ date: string } & Record<Severity, number>>
  days: number
}

export interface RuleHit {
  rule_code: string | null
  severity: string | null
  message: string | null
  penalty?: number | null
  evidence: Record<string, unknown> | null
}

export interface DeviceInfo {
  platform: string
  app_version: string | null
  trust_level: string
  is_active: boolean
  device_ref: string
  first_seen_at: string
  last_seen_at: string
  sessions: number
}

export interface SyncEvent {
  sequence: number
  client_time: string | null
  server_time: string
  steps_delta: number
  walk_probability: number | null
  shake_probability: number | null
  motion_label: string | null
  interval_risk_score: number
  accepted: boolean
  rejection_reason: string | null
  signature_valid: boolean
  replay_detected: boolean
}

export interface SessionInfo {
  id: string
  status: string
  started_at: string
  ended_at: string | null
  duration_minutes: number
  total_steps: number
  accepted_steps: number
  rejected_steps: number
  avg_walk_probability: number | null
  avg_shake_probability: number | null
  session_risk_score: number
  trust_adjustment: number
  policy_version: string | null
  ml_model_version: string | null
  last_sequence_number: number
  device: DeviceInfo | null
  events?: SyncEvent[]
  events_total?: number
}

export interface IntervalInfo {
  start: string
  end: string
  source_platform: string
  source_app: string
  raw_steps: number
  verified_steps: number
  risk_score: number
  confidence_score: number
  status: string
  review_state: string
  payout_state: string
  rule_hits: RuleHit[]
}

export interface AuditEntry {
  id: number
  action: string
  admin: string
  user_id: number | null
  username: string
  description: string
  reason: string | null
  message_to_user: string | null
  trust_score: { old: number; new: number } | null
  trust_status: { old: string; new: string } | null
  flag_id: number | null
  decision: { old: string; new: string } | null
  created_at: string
}

export interface CaseDetail {
  case: TrustCase
  rule_hits: RuleHit[]
  evidence: Record<string, unknown> | null
  user: UserBrief & { date_joined: string | null; device_platform: string | null; is_staff: boolean }
  trust: { score: number; status: TrustStatus; flags_total: number; updated_at: string | null; has_record: boolean }
  trust_profile: {
    trust_score: number; tier: string; verified_sessions: number; suspicious_sessions: number; replay_attempts: number
    accepted_steps: number; rejected_steps: number; last_suspicious_at: string | null; last_verified_at: string | null
  } | null
  day: {
    date: string
    health_record: { steps: number; source: string; is_suspicious: boolean; distance_km: number | null; synced_at: string } | null
    verification: {
      raw_steps: number; verified_steps: number; suspicious_steps: number; interval_count: number; accepted: number
      review: number; rejected: number; risk_score: number; review_state: string; payout_state: string
      trust_before: number; trust_after: number
    } | null
    intervals: IntervalInfo[]
  } | null
  session: SessionInfo | null
  related_sessions: SessionInfo[]
  devices: DeviceInfo[]
  trust_history: Array<{
    date: string; trust_before: number; trust_after: number; risk_score: number; raw_steps: number
    verified_steps: number; suspicious_steps: number; review_state: string; payout_state: string
  }>
  user_flags: TrustCase[]
  actions: AuditEntry[]
  open_cases_for_user: number
}

export interface ModerationUser extends UserBrief {
  open_flags: number
  open_sessions: number
  top_severity: Severity | null
  last_flag_at: string | null
  date_joined: string | null
  last_action: AuditEntry | null
}

export interface ActionResult {
  status: string
  action?: string
  decision?: string
  trust_score?: { before: number; after: number }
  trust_status?: { before: TrustStatus; after: TrustStatus }
  notice_ticket_id: number | null
}

export interface OpsHistory {
  days: number
  daily: Array<{
    date: string; callbacks: number; callbacks_unprocessed: number; withdrawals_requested: number
    withdrawals_failed: number; payments_failed: number; fraud_flags: number
  }>
}

// ── transport ──────────────────────────────────────────────────────────────

function messageFrom(body: unknown, status: number): string {
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>
    const details = b.details as Record<string, unknown> | undefined
    for (const c of [details?.detail, b.detail, b.error, b.message]) {
      if (typeof c === 'string' && c.trim()) return c
    }
  }
  if (status === 404) return 'Not found (404).'
  if (status === 429) return 'Too many requests. Wait a moment and try again.'
  if (status >= 500) return `Server error (${status}).`
  return `Request failed (${status}).`
}

/** Single-flight refresh shared with every API helper (see store/authStore). */
function refreshAccess(): Promise<string | null> {
  return refreshAccessToken()
}

async function call<T>(path: string, body?: unknown, retried = false): Promise<T> {
  const token = useAuthStore.getState().accessToken
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {}
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  let res: Response
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method: body !== undefined ? 'POST' : 'GET', headers, body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  } catch {
    throw new ApiError(`Cannot reach the API at ${API_BASE}. Check the backend is running.`, 0)
  }
  if (res.status === 401 && !retried) {
    if (await refreshAccess()) return call<T>(path, body, true)
    useAuthStore.getState().clearAuth()
    if (!window.location.pathname.startsWith('/login')) window.location.href = '/login'
    throw new ApiError('Session expired. Please sign in again.', 401)
  }
  if (!res.ok) {
    const b = await res.json().catch(() => null)
    throw new ApiError(messageFrom(b, res.status), res.status)
  }
  return res.json() as Promise<T>
}

function qs(params: Record<string, string | number | undefined | null>): string {
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') sp.append(k, String(v))
  const s = sp.toString()
  return s ? `?${s}` : ''
}

export interface CaseFilters {
  kind?: string
  status?: string
  severity?: string
  type?: string
  q?: string
  from?: string
  to?: string
  user_id?: number
  limit?: number
  offset?: number
}

interface DecisionBody { reason: string; message_to_user?: string }

export const trustApi = {
  summary: (days = 30) => call<TrustSummary>(`/api/admin/trust/summary/${qs({ days })}`),
  cases: (f: CaseFilters) => call<CasePage>(`/api/admin/trust/cases/${qs({ ...f })}`),
  caseDetail: (kind: CaseKind, id: string) => call<CaseDetail>(`/api/admin/trust/cases/${kind}/${id}/`),
  flagAction: (id: string, action: FlagAction, body: DecisionBody) =>
    call<ActionResult>(`/api/admin/trust/flags/${id}/action/`, { action, ...body }),
  sessionDecision: (id: string, decision: SessionDecision, body: DecisionBody) =>
    call<ActionResult>(`/api/admin/trust/sessions/${id}/decision/`, { decision, ...body }),
  moderationUsers: (view: 'queue' | 'enforced', q?: string) =>
    call<{ count: number; results: ModerationUser[] }>(`/api/admin/trust/moderation/users/${qs({ view, q, limit: 200 })}`),
  moderationHistory: (f: { q?: string; action?: string; from?: string; to?: string; user_id?: number; limit?: number; offset?: number }) =>
    call<{ count: number; results: AuditEntry[] }>(`/api/admin/trust/moderation/history/${qs({ ...f })}`),
  moderate: (userId: number, action: ModerationAction, body: DecisionBody) =>
    call<ActionResult>(`/api/admin/trust/users/${userId}/moderate/`, { action, ...body }),
  /** Account sign-in (is_active) — existing Users endpoints; reason goes to the audit log. */
  disableAccount: (userId: number, reason: string) => call<{ status: string }>(`/api/admin/users/${userId}/ban_user/`, { reason }),
  enableAccount: (userId: number, reason: string) => call<{ status: string }>(`/api/admin/users/${userId}/unban_user/`, { reason }),
  ops: () => call<OpsMonitoringResponse>('/api/admin/monitoring/ops/'),
  opsHistory: (days = 14) => call<OpsHistory>(`/api/admin/monitoring/ops/history/${qs({ days })}`),
}
