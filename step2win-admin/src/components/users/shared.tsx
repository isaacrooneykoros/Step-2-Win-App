import type { ReactNode } from 'react'
import { ArrowRight } from 'lucide-react'
import { cn } from '../../lib/cn'
import { formatDateTime, formatKES, formatRelative } from '../../lib/format'
import { StatusBadge, type BadgeTone } from '../StatusBadge'
import type { TrustStatus } from './types'
import { humanize, isRecent, TRUST_LABEL, TRUST_TONE } from './utils'
import { auditAction } from './auditActions'

/** Relative time with the exact timestamp in the tooltip and for screen readers. */
export function Timestamp({ value, className, exact }: { value: string | null | undefined; className?: string; exact?: boolean }) {
  if (!value) return <span className={cn('text-ink-muted', className)}>—</span>
  const abs = formatDateTime(value)
  return (
    <time dateTime={value} title={abs} className={cn('whitespace-nowrap', className)}>
      {exact ? (
        <>
          {abs}
          {isRecent(value) && <span className="text-ink-muted"> · {formatRelative(value)}</span>}
        </>
      ) : (
        formatRelative(value)
      )}
    </time>
  )
}

const METER_FILL: Record<BadgeTone, string> = {
  success: 'bg-success', warning: 'bg-warning', danger: 'bg-danger', info: 'bg-notice',
  brand: 'bg-brand', violet: 'bg-violet', neutral: 'bg-ink-muted',
}

/** Trust score 0–100 as number + short meter + status label. */
export function TrustMeter({ score, status, compact }: { score: number; status: TrustStatus; compact?: boolean }) {
  const tone = TRUST_TONE[status] ?? 'neutral'
  return (
    <span className="inline-flex items-center gap-2">
      <span className="num w-7 text-right text-sm font-medium text-ink-primary">{score}</span>
      {!compact && (
        <span className="h-1.5 w-12 overflow-hidden rounded-sm bg-surface-elevated" aria-hidden>
          <span className={cn('block h-full rounded-sm', METER_FILL[tone])} style={{ width: `${Math.max(2, Math.min(100, score))}%` }} />
        </span>
      )}
      <StatusBadge size="sm" tone={tone} label={TRUST_LABEL[status] ?? status} />
    </span>
  )
}

/** Initials square — neutral, no colour coding. */
export function Initials({ name, size = 28 }: { name: string; size?: number }) {
  const letters = name.slice(0, 2).toUpperCase()
  return (
    <span
      aria-hidden
      className="flex shrink-0 items-center justify-center rounded-md border border-surface-border bg-surface-elevated text-2xs font-semibold text-ink-secondary"
      style={{ width: size, height: size }}
    >
      {letters}
    </span>
  )
}

/** Username + secondary line, used as the first column of user tables. */
export function UserCell({ username, secondary }: { username: string; secondary?: ReactNode }) {
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      <Initials name={username} />
      <span className="min-w-0">
        <span className="block truncate font-medium text-ink-primary">{username}</span>
        {secondary && <span className="block truncate text-xs text-ink-muted">{secondary}</span>}
      </span>
    </span>
  )
}

/** Signed KSh amount; direction shown by sign text and colour. */
export function SignedKES({ value }: { value: string | number }) {
  const n = Number(value)
  if (!Number.isFinite(n)) return <span className="text-ink-muted">—</span>
  const txt = formatKES(Math.abs(n))
  if (n === 0) return <span className="mono">{txt}</span>
  return (
    <span className={cn('mono', n > 0 ? 'text-success' : 'text-danger')}>
      {n > 0 ? '+' : '−'}
      {txt}
    </span>
  )
}

/** Compact figure block used inside drawers. */
export function Figure({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'danger' | 'warning' }) {
  return (
    <div className="min-w-0 rounded-md border border-surface-border bg-surface-card px-3 py-2.5">
      <p className="truncate text-xs text-ink-muted">{label}</p>
      <p
        className={cn(
          'num mt-0.5 truncate text-base font-semibold',
          tone === 'danger' ? 'text-danger' : tone === 'warning' ? 'text-warning' : 'text-ink-primary',
        )}
      >
        {value}
      </p>
      {hint && <p className="mt-0.5 truncate text-2xs text-ink-muted">{hint}</p>}
    </div>
  )
}

export function SectionTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="mb-2 mt-5 flex items-center justify-between gap-3 first:mt-0">
      <h3 className="text-xs font-semibold uppercase tracking-[0.04em] text-ink-muted">{children}</h3>
      {aside}
    </div>
  )
}

/** Small linked text with an arrow ("Open in withdrawals"). */
export function InlineLink({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="inline-flex items-center gap-1 text-xs font-medium text-brand-text hover:underline">
      {children} <ArrowRight size={12} aria-hidden />
    </button>
  )
}

/** Before → after list for audit `changes` payloads; `reason` shown separately. */
export function ChangeList({ changes }: { changes: Record<string, unknown> | null | undefined }) {
  if (!changes || typeof changes !== 'object') return null
  const entries = Object.entries(changes).filter(([k]) => k !== 'reason')
  const reason = typeof changes.reason === 'string' ? changes.reason : null
  if (!entries.length && !reason) return null
  const show = (v: unknown) =>
    v === null || v === undefined || v === '' ? <span className="text-ink-muted">empty</span> : <span className="mono text-[12px]">{String(v)}</span>
  return (
    <div className="space-y-1.5 text-xs">
      {reason && (
        <p className="text-ink-secondary">
          <span className="text-ink-muted">Reason: </span>
          {reason}
        </p>
      )}
      {entries.length > 0 && (
        <dl className="divide-y divide-[var(--border)] rounded-md border border-surface-border">
          {entries.map(([key, val]) => {
            const diff = val && typeof val === 'object' && 'old' in (val as object) && 'new' in (val as object)
            const v = val as { old?: unknown; new?: unknown }
            return (
              <div key={key} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-2.5 py-1.5">
                <dt className="w-32 shrink-0 text-ink-muted">{humanize(key)}</dt>
                <dd className="flex min-w-0 flex-wrap items-center gap-1.5 text-ink-primary">
                  {diff ? (
                    <>
                      <span className="line-through decoration-ink-muted/60">{show(v.old)}</span>
                      <ArrowRight size={11} className="text-ink-muted" aria-label="changed to" />
                      {show(v.new)}
                    </>
                  ) : typeof val === 'object' ? (
                    <span className="mono break-all text-[12px]">{JSON.stringify(val)}</span>
                  ) : (
                    show(val)
                  )}
                </dd>
              </div>
            )
          })}
        </dl>
      )}
    </div>
  )
}

/** Result line after an action (success or failure). Announced politely; dismissible. */
export function ActionNotice({ tone, children, onDismiss }: { tone: 'success' | 'danger'; children: ReactNode; onDismiss: () => void }) {
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={cn(
        'flex items-start gap-2 rounded-md border px-3 py-2 text-sm',
        tone === 'success' ? 'border-success-line bg-success-soft text-success' : 'border-danger-line bg-danger-soft text-danger',
      )}
    >
      <span className="min-w-0 flex-1 font-medium">{children}</span>
      <button type="button" onClick={onDismiss} className="shrink-0 text-xs font-medium underline-offset-2 hover:underline">
        Dismiss
      </button>
    </div>
  )
}

/** Audit action as an icon + text badge. */
export function AuditActionBadge({ action }: { action: string }) {
  const a = auditAction(action)
  const Icon = a.icon
  return (
    <StatusBadge size="sm" tone={a.tone} label={<span className="inline-flex items-center gap-1"><Icon size={11} aria-hidden />{a.label}</span>} />
  )
}
