import type { ReactNode } from 'react'
import { cn } from '../lib/cn'

interface DetailRowProps {
  label:    string
  value:    ReactNode
  /** Monospace for IDs, references, phone numbers and exact amounts. */
  mono?:    boolean
  /** Label above value instead of side by side (long values, narrow drawers). */
  stacked?: boolean
  className?: string
}

/** Label/value row for detail drawers. Missing values render as an em dash. */
export function DetailRow({ label, value, mono, stacked, className }: DetailRowProps) {
  const empty = value === null || value === undefined || value === ''
  return (
    <div
      className={cn(
        'border-b border-surface-border py-2.5 last:border-b-0',
        stacked ? 'space-y-1' : 'flex items-baseline justify-between gap-4',
        className,
      )}
    >
      <span className={cn('shrink-0 text-xs text-ink-muted', stacked ? 'block' : 'w-36')}>{label}</span>
      <span className={cn('min-w-0 break-words text-sm text-ink-primary', stacked ? 'block' : 'flex-1 text-right', mono && 'mono text-[13px]')}>
        {empty ? <span className="text-ink-muted">—</span> : value}
      </span>
    </div>
  )
}
