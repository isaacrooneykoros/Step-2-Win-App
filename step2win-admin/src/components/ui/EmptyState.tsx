import type { ElementType, ReactNode } from 'react'
import { Inbox } from 'lucide-react'
import { cn } from '../../lib/cn'

export interface EmptyStateProps {
  title: ReactNode
  description?: ReactNode
  icon?: ElementType
  action?: ReactNode
  /** `compact` for inside tables/panels. */
  size?: 'compact' | 'default'
  className?: string
}

/**
 * Explains why there is nothing here and, when possible, what to do next.
 * Never celebratory ("All caught up!" + emoji) — state the fact plainly.
 */
export function EmptyState({ title, description, icon: Icon = Inbox, action, size = 'default', className }: EmptyStateProps) {
  return (
    <div className={cn('flex flex-col items-center justify-center text-center', size === 'compact' ? 'px-4 py-8' : 'px-6 py-14', className)}>
      <span className="mb-3 flex h-9 w-9 items-center justify-center rounded-md border border-surface-border bg-surface-base text-ink-muted">
        <Icon size={17} aria-hidden />
      </span>
      <p className="text-sm font-medium text-ink-primary">{title}</p>
      {description && <p className="mt-1 max-w-sm text-xs text-ink-muted">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}
