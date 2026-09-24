import { useState, type ElementType, type ReactNode } from 'react'
import { AlertCircle, AlertTriangle, CheckCircle2, Info, ShieldAlert, X, XCircle } from 'lucide-react'
import { ConfirmModal } from '../ConfirmModal'
import { Textarea } from '../ui/Input'
import { cn } from '../../lib/cn'
import { formatDateTime, formatRelative } from '../../lib/format'
import type { Severity, TrustStatus } from './api'
import { formatAge, SEVERITY_MEANING, TRUST_STATUS_INFO, trustTone } from './rules'

const SEV: Record<Severity, { icon: ElementType; cls: string; label: string }> = {
  critical: { icon: ShieldAlert, cls: 'bg-danger-soft text-danger', label: 'Critical' },
  high: { icon: AlertTriangle, cls: 'bg-danger-soft text-danger', label: 'High' },
  medium: { icon: AlertCircle, cls: 'bg-warning-soft text-warning', label: 'Medium' },
  low: { icon: Info, cls: 'bg-neutral-soft text-ink-secondary', label: 'Low' },
}

/** Severity: icon + text + tone (never colour alone). */
export function SeverityBadge({ severity, size = 'md', withMeaning }: { severity: Severity | null | undefined; size?: 'sm' | 'md'; withMeaning?: boolean }) {
  if (!severity) return <span className="text-ink-muted">—</span>
  const s = SEV[severity] ?? SEV.low
  const Icon = s.icon
  return (
    <span
      className={cn('inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded font-medium', size === 'sm' ? 'h-5 px-1.5 text-2xs' : 'h-6 px-2 text-xs', s.cls)}
      title={SEVERITY_MEANING[severity]}
    >
      <Icon size={size === 'sm' ? 11 : 12} aria-hidden strokeWidth={2.25} />
      {s.label}
      {withMeaning && <span className="font-normal opacity-90">· {SEVERITY_MEANING[severity]}</span>}
    </span>
  )
}

const TONE_TEXT = { success: 'text-success', warning: 'text-warning', danger: 'text-danger', neutral: 'text-ink-secondary' }
const TONE_BOX = { success: 'bg-success-soft text-success', warning: 'bg-warning-soft text-warning', danger: 'bg-danger-soft text-danger', neutral: 'bg-neutral-soft text-ink-secondary' }

/** "72 · Warned" — score is tabular, status in words. */
export function TrustScore({ score, status, compact }: { score: number | null | undefined; status: TrustStatus | string | null | undefined; compact?: boolean }) {
  if (score === null || score === undefined) return <span className="text-ink-muted">—</span>
  const tone = trustTone(status)
  const label = TRUST_STATUS_INFO[status ?? '']?.label ?? status ?? ''
  return (
    <span className="inline-flex items-baseline gap-1.5 whitespace-nowrap">
      <span className={cn('num font-semibold', TONE_TEXT[tone])}>{score}</span>
      {!compact && <span className="text-xs text-ink-muted">/100</span>}
      <span className={cn('rounded px-1.5 py-px text-2xs font-medium', TONE_BOX[tone])}>{label}</span>
    </span>
  )
}

/** Relative time with the absolute time available (title + screen reader). */
export function When({ value, stacked }: { value: string | null | undefined; stacked?: boolean }) {
  if (!value) return <span className="text-ink-muted">—</span>
  const abs = formatDateTime(value)
  if (stacked) {
    return (
      <span className="block leading-tight">
        <span className="block text-ink-primary">{formatRelative(value)}</span>
        <span className="block text-xs text-ink-muted">{abs}</span>
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

/** Queue age: 24h+ danger, 12h+ warning. */
export function Age({ hours }: { hours: number }) {
  const cls = hours >= 24 ? 'font-semibold text-danger' : hours >= 12 ? 'font-medium text-warning' : 'text-ink-secondary'
  return <span className={cn('num whitespace-nowrap text-sm', cls)}>{formatAge(hours)}</span>
}

/** Probability 0–1 as a thin meter with the number beside it. */
export function ProbabilityMeter({ label, value, kind }: { label: string; value: number | null | undefined; kind: 'walk' | 'shake' }) {
  const v = value === null || value === undefined ? null : Math.max(0, Math.min(1, value))
  const bad = kind === 'shake' ? (v ?? 0) >= 0.6 : v !== null && v < 0.4
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="text-ink-muted">{label}</span>
        <span className={cn('num font-semibold', bad ? 'text-danger' : 'text-ink-primary')}>{v === null ? '—' : v.toFixed(2)}</span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-elevated" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={1} aria-valuenow={v ?? undefined}>
        {v !== null && <div className={cn('h-full rounded-full', bad ? 'bg-danger' : 'bg-ink-muted')} style={{ width: `${v * 100}%` }} />}
      </div>
    </div>
  )
}

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

export function Figure({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'danger' | 'warning' | 'success' }) {
  return (
    <div className="min-w-0">
      <p className="truncate text-xs text-ink-muted">{label}</p>
      <p className={cn('num mt-0.5 truncate text-base font-semibold', tone ? TONE_TEXT[tone] : 'text-ink-primary')}>{value}</p>
      {hint && <p className="mt-0.5 truncate text-xs text-ink-muted">{hint}</p>}
    </div>
  )
}

export interface ResultMessage { tone: 'success' | 'danger' | 'info'; title: string; body?: string }

export function ResultBanner({ result, onDismiss }: { result: ResultMessage; onDismiss: () => void }) {
  const Icon = result.tone === 'success' ? CheckCircle2 : result.tone === 'danger' ? XCircle : Info
  return (
    <div
      role={result.tone === 'danger' ? 'alert' : 'status'}
      className={cn(
        'flex items-start gap-3 rounded-lg border px-4 py-3',
        result.tone === 'success' && 'border-success-line bg-success-soft',
        result.tone === 'danger' && 'border-danger-line bg-danger-soft',
        result.tone === 'info' && 'border-surface-border bg-notice-soft',
      )}
    >
      <Icon size={17} aria-hidden className={cn('mt-0.5 shrink-0', result.tone === 'success' ? 'text-success' : result.tone === 'danger' ? 'text-danger' : 'text-notice')} />
      <div className="min-w-0 flex-1 text-sm">
        <p className="font-semibold text-ink-primary">{result.title}</p>
        {result.body && <p className="mt-0.5 break-words text-ink-secondary">{result.body}</p>}
      </div>
      <button type="button" onClick={onDismiss} aria-label="Dismiss message" className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-ink-muted hover:bg-surface-card hover:text-ink-primary">
        <X size={14} />
      </button>
    </div>
  )
}

export interface DecisionSpec {
  title: string
  confirmLabel: string
  variant: 'danger' | 'warning' | 'info'
  message: ReactNode
  details: Array<{ label: string; value: ReactNode }>
  consequence?: ReactNode
  /** Offer the optional message-to-user field. */
  allowMessage?: boolean
  confirmText?: string
  presets?: string[]
}

/**
 * ConfirmModal with a required reason (audit log) and an optional message to
 * the user. Mount with a `key` per target so typed text never carries over.
 */
export function DecisionModal({
  spec, open, loading, onClose, onConfirm,
}: {
  spec: DecisionSpec | null
  open: boolean
  loading: boolean
  onClose: () => void
  onConfirm: (reason: string, message: string) => void
}) {
  const [reason, setReason] = useState('')
  const [message, setMessage] = useState('')
  const [sendMessage, setSendMessage] = useState(false)
  const ok = reason.trim().length >= 5
  if (!spec) return null
  return (
    <ConfirmModal
      open={open}
      onClose={onClose}
      onConfirm={() => ok && onConfirm(reason.trim(), sendMessage ? message.trim() : '')}
      loading={loading}
      variant={spec.variant}
      title={spec.title}
      confirmLabel={spec.confirmLabel}
      confirmDisabled={!ok || (sendMessage && message.trim().length < 5)}
      message={spec.message}
      details={spec.details}
      consequence={spec.consequence}
      confirmText={spec.confirmText}
    >
      <Textarea
        label="Reason (internal, saved to the audit log)"
        required
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        disabled={loading}
        maxLength={500}
        rows={2}
        hint={ok ? `${reason.trim().length}/500` : 'At least 5 characters.'}
      />
      {spec.presets && spec.presets.length > 0 && (
        <div className="flex flex-wrap gap-1.5" aria-label="Common reasons">
          {spec.presets.map((p) => (
            <button
              key={p}
              type="button"
              disabled={loading}
              onClick={() => setReason(p)}
              className="rounded border border-surface-border bg-surface-elevated px-2 py-1 text-left text-xs text-ink-secondary hover:border-surface-strong hover:text-ink-primary disabled:opacity-50"
            >
              {p}
            </button>
          ))}
        </div>
      )}
      {spec.allowMessage && (
        <div className="space-y-2 rounded-md border border-surface-border p-3">
          <label className="flex items-start gap-2 text-sm text-ink-primary">
            <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[var(--brand)]" checked={sendMessage} onChange={(e) => setSendMessage(e.target.checked)} disabled={loading} />
            <span>
              Send a message to the user
              <span className="block text-xs text-ink-muted">Delivered to the user’s Support inbox in the app as a resolved notice.</span>
            </span>
          </label>
          {sendMessage && (
            <Textarea
              label="Message to user"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              disabled={loading}
              maxLength={1000}
              rows={3}
              hint={`${message.trim().length}/1000 · plain words, no internal rule names`}
            />
          )}
        </div>
      )}
    </ConfirmModal>
  )
}
