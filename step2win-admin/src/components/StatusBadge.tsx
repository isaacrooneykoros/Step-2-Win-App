import type { ReactNode } from 'react'
import { cn } from '../lib/cn'
import { statusTone, type BadgeTone } from '../lib/status'

export type { BadgeTone } from '../lib/status'

type BadgeVariant =
  | 'active' | 'inactive' | 'banned' | 'pending'
  | 'completed' | 'failed' | 'cancelled' | 'success'
  | 'warning' | 'info' | 'admin' | 'user'
  | 'flagged' | 'resolved' | 'reviewing'
  | 'public' | 'private'

const TONE_CLASS: Record<BadgeTone, { box: string; dot: string }> = {
  success: { box: 'bg-success-soft text-success', dot: 'bg-success' },
  warning: { box: 'bg-warning-soft text-warning', dot: 'bg-warning' },
  danger:  { box: 'bg-danger-soft text-danger',   dot: 'bg-danger' },
  info:    { box: 'bg-notice-soft text-notice',   dot: 'bg-notice' },
  brand:   { box: 'bg-brand-soft text-brand-text', dot: 'bg-brand' },
  violet:  { box: 'bg-violet-soft text-violet',   dot: 'bg-violet' },
  neutral: { box: 'bg-neutral-soft text-ink-secondary', dot: 'bg-ink-muted' },
}

interface StatusBadgeProps {
  /** Legacy fixed variants. Prefer `status` (any backend value) or `tone`. */
  variant?: BadgeVariant
  /** Raw backend status (e.g. "pending_review", "in_progress"); tone and label are derived. */
  status?:  string | null
  /** Force a tone. */
  tone?:    BadgeTone
  label?:   ReactNode  // override display label
  showDot?: boolean    // leading dot (default: only for live states)
  size?:    'sm' | 'md'
  className?: string
}

function humanize(value: string): string {
  const s = value.replace(/[_-]+/g, ' ').trim()
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()
}

/**
 * Status label. Always text (colour is secondary). Tones: success, warning,
 * danger, info, brand, violet, neutral.
 */
export function StatusBadge({
  variant, status, tone, label, showDot, size = 'md', className,
}: StatusBadgeProps) {
  const key = (status ?? variant ?? 'unknown').toString()
  const resolved = tone ?? statusTone(key)
  const t = TONE_CLASS[resolved]
  const display = label ?? humanize(key)
  const dot = showDot ?? ['active', 'live', 'processing', 'in_progress'].includes(key.toLowerCase())
  const pad = size === 'sm' ? 'h-5 px-1.5 text-2xs' : 'h-6 px-2 text-xs'

  return (
    <span className={cn('inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded font-medium', pad, t.box, className)}>
      {dot && <span aria-hidden className={cn('h-1.5 w-1.5 shrink-0 rounded-full', t.dot)} />}
      {display}
    </span>
  )
}
