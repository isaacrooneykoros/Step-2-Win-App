import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { BadgeTone } from '../../lib/status'
import { consoleApi } from './api'
import type { TrustStatus } from './types'

/** "rate_spike" -> "Rate spike" */
export function humanize(value: string | null | undefined): string {
  if (!value) return '—'
  const s = value.replace(/[_-]+/g, ' ').trim()
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()
}

export const TRUST_TONE: Record<TrustStatus, BadgeTone> = {
  GOOD: 'success',
  WARN: 'warning',
  REVIEW: 'warning',
  RESTRICT: 'danger',
  SUSPEND: 'danger',
  BAN: 'danger',
}

export const TRUST_LABEL: Record<TrustStatus, string> = {
  GOOD: 'Good',
  WARN: 'Warn',
  REVIEW: 'Review',
  RESTRICT: 'Restricted',
  SUSPEND: 'Suspended',
  BAN: 'Banned',
}

export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

/** Signed-in admin's role. Superuser-only actions are hidden for plain staff. */
export function useAdminRole() {
  const q = useQuery({ queryKey: ['admin', 'me-role'], queryFn: consoleApi.me, staleTime: 5 * 60_000 })
  return { isSuperuser: Boolean(q.data?.is_superuser), username: q.data?.username, id: q.data?.id, loading: q.isLoading }
}

/** Build and download a CSV file in the browser. */
export function downloadCsv(filename: string, header: string[], rows: Array<Array<string | number | boolean | null | undefined>>) {
  const esc = (v: string | number | boolean | null | undefined) => {
    const s = v === null || v === undefined ? '' : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const csv = [header, ...rows].map((r) => r.map(esc).join(',')).join('\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

/** yyyy-mm-dd for <input type="date"> in local time. */
export function isoDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function daysAgo(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return isoDay(d)
}

/** "2026-09-23" -> "23 Sep" / "Wed, 23 Sep 2026". */
export function formatDay(value: string | null | undefined, long = false): string {
  if (!value) return '—'
  const d = new Date(`${value.slice(0, 10)}T00:00:00`)
  if (Number.isNaN(d.getTime())) return value
  return d.toLocaleDateString('en-GB', long ? { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' } : { day: '2-digit', month: 'short' })
}

/** True when the timestamp is within the last `days` days. */
export function isRecent(value: string, days = 7): boolean {
  return Date.now() - new Date(value).getTime() < days * 86_400_000
}

export const MILESTONES = [10000, 15000, 20000, 25000, 30000, 40000, 50000, 65000, 80000, 100000, 125000, 150000, 200000, 250000, 300000]

export type ChallengeAction = 'approve' | 'reject' | 'cancel' | 'feature' | 'unfeature' | 'delete' | 'edit'

export function challengeStatusLabel(status: string) {
  return status === 'active' ? 'Live' : status === 'pending' ? 'Awaiting approval' : humanize(status)
}
