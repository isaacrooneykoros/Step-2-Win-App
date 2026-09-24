import type { ReactNode } from 'react'
import { X } from 'lucide-react'
import { cn } from '../../lib/cn'

interface ToolbarProps {
  /** Left: search and filters. */
  children: ReactNode
  /** Right: bulk actions, export, view switches. */
  actions?: ReactNode
  className?: string
}

/**
 * One row above a table/chart group holding search + filters (left) and
 * actions (right). Wraps on narrow screens. Filters live here, never inside
 * individual chart cards.
 */
export function Toolbar({ children, actions, className }: ToolbarProps) {
  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{children}</div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

/** Alias: FilterBar reads better where the row only holds filters. */
export const FilterBar = Toolbar

interface FilterChipProps {
  label: ReactNode
  onRemove: () => void
}

/** An applied filter that can be removed (e.g. "Status: Pending ×"). */
export function FilterChip({ label, onRemove }: FilterChipProps) {
  return (
    <span className="inline-flex h-7 items-center gap-1 rounded-md border border-surface-border bg-surface-elevated pl-2 pr-1 text-xs text-ink-secondary">
      {label}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove filter ${typeof label === 'string' ? label : ''}`.trim()}
        className="flex h-5 w-5 items-center justify-center rounded text-ink-muted hover:bg-surface-card hover:text-ink-primary"
      >
        <X size={12} />
      </button>
    </span>
  )
}
