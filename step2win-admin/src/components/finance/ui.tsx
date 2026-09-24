/* eslint-disable react-refresh/only-export-components */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Check, Copy } from 'lucide-react'
import { cn } from '../../lib/cn'
import { formatAgeHours, formatDateTime, formatKES, formatRelative } from '../../lib/format'
import { StatusBadge } from '../StatusBadge'
import { SegmentedControl } from '../ui/Tabs'
import { Input } from '../ui/Input'
import type { LedgerType, WithdrawalRow, WithdrawalStatus } from './types'

// ── Labels ──────────────────────────────────────────────────────────────────

export const LEDGER_TYPE_LABEL: Record<LedgerType, string> = {
  deposit: 'Deposit',
  withdrawal: 'Withdrawal',
  challenge_entry: 'Challenge entry',
  payout: 'Challenge payout',
  fee: 'Platform fee',
  refund: 'Refund',
}

export const WITHDRAWAL_STATUS_LABEL: Record<WithdrawalStatus, string> = {
  pending_review: 'Pending review',
  approved: 'Approved',
  processing: 'Processing',
  completed: 'Paid',
  rejected: 'Rejected',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

export const METHOD_LABEL: Record<string, string> = { mpesa: 'M-Pesa', bank: 'Bank', paybill: 'Paybill / Till' }

export function WithdrawalStatusBadge({ status, size = 'sm' }: { status: WithdrawalStatus; size?: 'sm' | 'md' }) {
  const tone = status === 'completed' ? 'success' : status === 'cancelled' ? 'neutral' : undefined
  return <StatusBadge status={status} tone={tone} label={WITHDRAWAL_STATUS_LABEL[status] ?? status} size={size} />
}

// ── Money / identifiers ─────────────────────────────────────────────────────

/** 254712345678 -> "2547•••678". Keeps enough to recognise, hides the rest. */
export function maskPhone(phone: string | null | undefined): string {
  if (!phone) return '—'
  const p = phone.replace(/\s+/g, '')
  if (p.length < 8) return p
  return `${p.slice(0, 4)}•••${p.slice(-3)}`
}

export function maskAccount(value: string | null | undefined): string {
  if (!value) return ''
  return value.length <= 4 ? value : `••••${value.slice(-4)}`
}

/** Masked, human destination for lists and confirmations. */
export function maskedDestination(w: Pick<WithdrawalRow, 'method' | 'phone_number' | 'bank_name' | 'account_number' | 'short_code' | 'destination'>): string {
  if (w.method === 'mpesa') return maskPhone(w.phone_number)
  if (w.method === 'bank') return `${w.bank_name || 'Bank'} ${maskAccount(w.account_number)}`.trim()
  if (w.method === 'paybill') return `${w.short_code}${w.account_number ? ` · ${maskAccount(w.account_number)}` : ''}`
  return w.destination
}

/** Full destination (for the detail drawer, behind a reveal). */
export function fullDestination(w: Pick<WithdrawalRow, 'method' | 'phone_number' | 'bank_name' | 'account_number' | 'short_code' | 'destination'>): string {
  if (w.method === 'mpesa') return w.phone_number || w.destination
  return w.destination
}

export function toNum(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

/** Exact amount in mono. */
export function Money({ value, className, muted }: { value: unknown; className?: string; muted?: boolean }) {
  if (value === null || value === undefined || value === '') return <span className="text-ink-muted">—</span>
  return <span className={cn('mono whitespace-nowrap', muted ? 'text-ink-secondary' : 'text-ink-primary', className)}>{formatKES(toNum(value))}</span>
}

/** Credit/debit with the sign as text; colour only reinforces it. */
export function SignedMoney({ value, className }: { value: unknown; className?: string }) {
  const n = toNum(value)
  const sign = n > 0 ? '+' : n < 0 ? '−' : ''
  return (
    <span className={cn('mono whitespace-nowrap font-medium', n > 0 ? 'text-success' : n < 0 ? 'text-danger' : 'text-ink-secondary', className)}>
      {sign}
      {formatKES(Math.abs(n))}
    </span>
  )
}

export function CopyButton({ value, label = 'Copy', className }: { value: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const copy = async (e: React.MouseEvent) => {
    e.stopPropagation()
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => setCopied(false), 1500)
    } catch {
      setCopied(false)
    }
  }
  return (
    <button
      type="button"
      onClick={copy}
      aria-label={copied ? 'Copied' : `${label} ${value}`}
      title={copied ? 'Copied' : label}
      className={cn(
        'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-ink-muted hover:bg-surface-elevated hover:text-ink-primary',
        className,
      )}
    >
      {copied ? <Check size={13} className="text-success" aria-hidden /> : <Copy size={12} aria-hidden />}
    </button>
  )
}

/** Mono reference with a copy button; truncates long UUIDs in tables. */
export function Reference({ value, truncate = true }: { value: string | null | undefined; truncate?: boolean }) {
  if (!value) return <span className="text-ink-muted">—</span>
  return (
    <span className="inline-flex max-w-full items-center gap-0.5">
      <span className={cn('mono text-xs text-ink-secondary', truncate && 'max-w-[12rem] truncate')} title={value}>
        {value}
      </span>
      <CopyButton value={value} label="Copy reference" />
    </span>
  )
}

/** Relative time with the exact timestamp on hover and for screen readers. */
export function When({ value, stacked }: { value: string | null | undefined; stacked?: boolean }) {
  if (!value) return <span className="text-ink-muted">—</span>
  const abs = formatDateTime(value)
  if (stacked) {
    return (
      <span className="block leading-tight">
        <span className="block text-ink-primary">{abs}</span>
        <span className="block text-xs text-ink-muted">{formatRelative(value)}</span>
      </span>
    )
  }
  return (
    <time dateTime={value} title={abs} className="whitespace-nowrap">
      {formatRelative(value)}
      <span className="sr-only"> ({abs})</span>
    </time>
  )
}

// ── Queue age / SLA ─────────────────────────────────────────────────────────

/** Review SLA: 24h. Warning from 12h. */
export const SLA_HOURS = 24
export const SLA_WARN_HOURS = 12

export function slaTone(hours: number): 'danger' | 'warning' | 'neutral' {
  if (hours >= SLA_HOURS) return 'danger'
  if (hours >= SLA_WARN_HOURS) return 'warning'
  return 'neutral'
}

export function AgeIndicator({ hours }: { hours: number }) {
  const tone = slaTone(hours)
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span className={cn('num text-sm', tone === 'danger' ? 'font-semibold text-danger' : tone === 'warning' ? 'font-medium text-warning' : 'text-ink-secondary')}>
        {formatAgeHours(hours)}
      </span>
      {tone !== 'neutral' && (
        <span className="hidden sm:inline-flex">
          <StatusBadge size="sm" tone={tone} label={tone === 'danger' ? 'Over SLA' : 'Due soon'} />
        </span>
      )}
      {tone !== 'neutral' && <span className="sr-only sm:hidden">{tone === 'danger' ? 'Over SLA' : 'Due soon'}</span>}
    </span>
  )
}

// ── Layout helpers ──────────────────────────────────────────────────────────

export function Section({ title, aside, children, className }: { title: string; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn('space-y-2', className)}>
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-2xs font-semibold uppercase tracking-wider text-ink-muted">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  )
}

/** Compact figure used inside panels (label over value). */
export function Figure({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'danger' | 'warning' | 'success' }) {
  return (
    <div className="min-w-0">
      <p className="truncate text-xs text-ink-muted">{label}</p>
      <p
        className={cn(
          'num mt-0.5 truncate text-base font-semibold',
          tone === 'danger' ? 'text-danger' : tone === 'warning' ? 'text-warning' : tone === 'success' ? 'text-success' : 'text-ink-primary',
        )}
      >
        {value}
      </p>
      {hint && <p className="mt-0.5 truncate text-xs text-ink-muted">{hint}</p>}
    </div>
  )
}

// ── Period picker ───────────────────────────────────────────────────────────

export interface Period {
  preset: '7' | '30' | '90' | '365' | 'custom'
  from: string
  to: string
}

export const PERIOD_PRESETS = [
  { value: '7' as const, label: '7D' },
  { value: '30' as const, label: '30D' },
  { value: '90' as const, label: '90D' },
  { value: '365' as const, label: '12M' },
  { value: 'custom' as const, label: 'Custom' },
]

export function isoDay(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function periodParams(p: Period): { days?: number; from?: string; to?: string } {
  if (p.preset === 'custom' && p.from && p.to) return { from: p.from, to: p.to }
  return { days: p.preset === 'custom' ? 30 : Number(p.preset) }
}

export function PeriodPicker({ value, onChange }: { value: Period; onChange: (p: Period) => void }) {
  const today = isoDay(new Date())
  return (
    <div className="flex flex-wrap items-center gap-2">
      <SegmentedControl
        label="Reporting period"
        items={PERIOD_PRESETS}
        value={value.preset}
        onChange={(preset) => {
          if (preset === 'custom') {
            const from = value.from || isoDay(new Date(Date.now() - 29 * 86400000))
            onChange({ preset, from, to: value.to || today })
          } else onChange({ ...value, preset })
        }}
      />
      {value.preset === 'custom' && (
        <span className="flex items-center gap-1.5">
          <Input
            type="date"
            size="sm"
            aria-label="From date"
            value={value.from}
            max={value.to || today}
            onChange={(e) => onChange({ ...value, from: e.target.value })}
            className="w-[8.75rem]"
          />
          <span className="text-xs text-ink-muted">to</span>
          <Input
            type="date"
            size="sm"
            aria-label="To date"
            value={value.to}
            min={value.from}
            max={today}
            onChange={(e) => onChange({ ...value, to: e.target.value })}
            className="w-[8.75rem]"
          />
        </span>
      )}
    </div>
  )
}

/** "1 Sep – 30 Sep 2026" from API period meta. */
export function formatPeriod(from: string, to: string): string {
  const f = new Date(`${from}T00:00:00`)
  const t = new Date(`${to}T00:00:00`)
  const sameYear = f.getFullYear() === t.getFullYear()
  const fs = f.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) })
  const ts = t.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
  return `${fs} – ${ts}`
}

/** Short axis label for ISO dates: "23 Sep". */
export function shortDay(iso: string | number | undefined): string {
  if (iso === undefined) return ''
  const d = new Date(`${iso}T00:00:00`)
  if (Number.isNaN(d.getTime())) return String(iso)
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

export function longDay(iso: string | number | undefined): string {
  if (iso === undefined) return ''
  const d = new Date(`${iso}T00:00:00`)
  if (Number.isNaN(d.getTime())) return String(iso)
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
}
