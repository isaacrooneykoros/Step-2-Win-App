/**
 * Small typed fetch client for the Support, Settings and Legal pages.
 * Same session handling as the other console clients: bearer access token,
 * one single-flight refresh on 401 (store/authStore), then back to /login.
 * Errors are `ApiError` with the server message and per-field messages.
 */
import { refreshAccessToken, useAuthStore } from '../../store/authStore'
import { API_BASE } from '../../config/network'
import { ApiError } from '../users/api'

export { ApiError }

function firstText(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null
  if (Array.isArray(value)) {
    for (const v of value) {
      const m = firstText(v)
      if (m) return m
    }
  }
  return null
}

function parseError(text: string, status: number): ApiError {
  let body: unknown = null
  try { body = JSON.parse(text) } catch { /* not JSON */ }
  if (!body || typeof body !== 'object') {
    return new ApiError(status >= 500 ? `Server error (${status}).` : text.slice(0, 200) || `Request failed (${status}).`, status)
  }
  const rec = body as Record<string, unknown>
  const inner = rec.details && typeof rec.details === 'object' ? (rec.details as Record<string, unknown>) : rec
  const fields: Record<string, string> = {}
  for (const [k, v] of Object.entries(inner)) {
    if (['detail', 'error', 'message', 'status', 'non_field_errors'].includes(k)) continue
    const m = firstText(v)
    if (m) fields[k] = m
  }
  const fieldKeys = Object.keys(fields)
  const message =
    firstText(inner.detail) ?? firstText(inner.error) ?? firstText(inner.non_field_errors) ??
    (typeof rec.error === 'string' ? rec.error : null) ??
    (fieldKeys.length ? `${fieldKeys[0].replace(/_/g, ' ')}: ${fields[fieldKeys[0]]}` : null) ??
    firstText(rec.message) ?? `Request failed (${status}).`
  return new ApiError(message, status, fields)
}

export async function http<T>(path: string, init: { method?: string; body?: unknown } = {}, retried = false): Promise<T> {
  const token = useAuthStore.getState().accessToken
  const isForm = typeof FormData !== 'undefined' && init.body instanceof FormData
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {}
  if (init.body !== undefined && !isForm) headers['Content-Type'] = 'application/json'
  let res: Response
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
      headers,
      body: init.body === undefined ? undefined : isForm ? (init.body as FormData) : JSON.stringify(init.body),
    })
  } catch {
    throw new ApiError(`Cannot reach the API at ${API_BASE}. Check the backend is running.`, 0)
  }
  if (res.status === 401 && !retried) {
    if (await refreshAccessToken()) return http<T>(path, init, true)
    useAuthStore.getState().clearAuth()
    if (!window.location.pathname.startsWith('/login')) window.location.href = '/login'
    throw new ApiError('Session expired. Please sign in again.', 401)
  }
  if (!res.ok) throw parseError(await res.text(), res.status)
  if (res.status === 204) return {} as T
  return res.json() as Promise<T>
}

export function qs(params: Record<string, string | number | undefined | null>): string {
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') sp.append(k, String(v))
  }
  const s = sp.toString()
  return s ? `?${s}` : ''
}
