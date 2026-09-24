/**
 * Client for the read-only finance endpoints (/api/admin/finance/*) plus the
 * the existing withdrawal actions (approve / reject / payout status check).
 */
import { refreshAccessToken, useAuthStore } from '../../store/authStore'
import { API_BASE } from '../../config/network'
import { adminApi } from '../../services/adminApi'
import type {
  AnalyticsReport, FinanceReport, LedgerFilters, LedgerPage, WithdrawalDetail, WithdrawalFilters, WithdrawalPage,
} from './types'

export class ApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

/** Pull a readable message out of the backend's error shapes. */
function messageFrom(body: unknown, status: number): string {
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>
    const details = b.details as Record<string, unknown> | undefined
    for (const candidate of [details?.detail, b.detail, typeof b.error === 'string' ? b.error : undefined, b.message]) {
      if (typeof candidate === 'string' && candidate.trim()) return candidate
    }
  }
  if (status === 404) return 'Not found (404). The backend may not have this endpoint yet.'
  if (status >= 500) return `Server error (${status}).`
  return `Request failed (${status}).`
}

/** Single-flight refresh shared with every API helper (see store/authStore). */
function refreshAccess(): Promise<string | null> {
  return refreshAccessToken()
}

async function send(path: string, init?: { method?: string; body?: unknown }, retried = false): Promise<Response> {
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
    throw new ApiError(`Cannot reach the API at ${API_BASE}. Check the backend is running.`, 0)
  }
  if (res.status === 401 && !retried) {
    if (await refreshAccess()) return send(path, init, true)
    useAuthStore.getState().clearAuth()
    if (!window.location.pathname.startsWith('/login')) window.location.href = '/login'
    throw new ApiError('Session expired. Please sign in again.', 401)
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new ApiError(messageFrom(body, res.status), res.status)
  }
  return res
}

async function getJson<T>(path: string): Promise<T> {
  return (await send(path)).json() as Promise<T>
}

async function postJson<T>(path: string, body: unknown = {}): Promise<T> {
  return (await send(path, { method: 'POST', body })).json() as Promise<T>
}

function qs(params: Record<string, string | number | undefined | null>): string {
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') sp.append(k, String(v))
  }
  const s = sp.toString()
  return s ? `?${s}` : ''
}

function ledgerParams(f: LedgerFilters) {
  return {
    type: f.types.join(','), direction: f.direction === 'all' ? undefined : f.direction,
    user: f.user.trim(), q: f.q.trim(), from: f.from, to: f.to, ordering: f.ordering,
  }
}

export const financeApi = {
  withdrawals: (f: WithdrawalFilters) =>
    getJson<WithdrawalPage>(`/api/admin/finance/withdrawals/${qs({
      status: f.status, q: f.q?.trim(), method: f.method, from: f.from, to: f.to, limit: f.limit, offset: f.offset,
    })}`),
  withdrawal: (id: string) => getJson<WithdrawalDetail>(`/api/admin/finance/withdrawals/${id}/`),
  ledger: (f: LedgerFilters, limit: number, offset: number) =>
    getJson<LedgerPage>(`/api/admin/finance/ledger/${qs({ ...ledgerParams(f), limit, offset })}`),
  /** Downloads the filtered ledger as CSV (server-side, all pages). */
  exportLedger: async (f: LedgerFilters) => {
    const res = await send(`/api/admin/finance/ledger/export/${qs(ledgerParams(f))}`)
    const blob = await res.blob()
    const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? 'step2win-ledger.csv'
    downloadBlob(blob, name)
  },
  report: (p: { days?: number; from?: string; to?: string }) =>
    getJson<FinanceReport>(`/api/admin/finance/report/${qs(p)}`),
  analytics: (p: { days?: number; from?: string; to?: string }) =>
    getJson<AnalyticsReport>(`/api/admin/finance/analytics/${qs(p)}`),

  // Money actions — the existing backend endpoints (same ones adminApi calls),
  // called here so the HTTP status is available for honest result messages.
  approve: (id: string) =>
    postJson<{ message?: string; tracking_id?: string; status?: string }>(`/api/admin/withdrawals/${id}/approve/`),
  reject: (id: string, reason: string) =>
    postJson<{ message?: string }>(`/api/admin/withdrawals/${id}/reject/`, { reason }),
  checkStatus: (id: string) =>
    postJson<{ message?: string; result?: unknown }>(`/api/admin/withdrawals/${id}/retry/`),
  stats: () => adminApi.getWithdrawalStats(),
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Client-side CSV for report tables that the API already returned. */
export function downloadCsv(filename: string, header: string[], rows: Array<Array<string | number | null | undefined>>) {
  const cell = (v: string | number | null | undefined) => {
    let s = v === null || v === undefined ? '' : String(v)
    if (/^[=+\-@]/.test(s) && Number.isNaN(Number(s))) s = `'${s}`
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const text = [header, ...rows].map((r) => r.map(cell).join(',')).join('\n')
  downloadBlob(new Blob([text], { type: 'text/csv;charset=utf-8' }), filename)
}
