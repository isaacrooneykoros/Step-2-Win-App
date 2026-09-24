import type { HTMLAttributes, ReactNode } from 'react'
import { cn } from '../../lib/cn'

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /** `none` for tables/lists that run edge to edge. */
  padding?: 'none' | 'sm' | 'md'
}

/** Plain surface: card background, hairline border, no decoration. */
export function Card({ padding = 'md', className, children, ...props }: CardProps) {
  return (
    <div
      className={cn(
        'rounded-lg border border-surface-border bg-surface-card shadow-card',
        padding === 'sm' && 'p-3',
        padding === 'md' && 'p-4',
        className,
      )}
      {...props}
    >
      {children}
    </div>
  )
}

export interface PanelProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  title?: ReactNode
  description?: ReactNode
  /** Right side of the header: links, small buttons, segmented controls. */
  actions?: ReactNode
  /** Footer row (e.g. "View all" link or pagination). */
  footer?: ReactNode
  /** Body padding. Use `none` for tables and lists. */
  padding?: 'none' | 'sm' | 'md'
  /** Heading level for the title (default h2). */
  as?: 'h2' | 'h3'
}

/**
 * Card with a header row. Use for dashboard modules, chart containers and
 * grouped tables. Only card things that belong together.
 */
export function Panel({ title, description, actions, footer, padding = 'md', as: Heading = 'h2', className, children, ...props }: PanelProps) {
  return (
    <section
      className={cn('flex min-w-0 flex-col rounded-lg border border-surface-border bg-surface-card shadow-card', className)}
      {...props}
    >
      {(title || actions) && (
        <header className="flex min-h-12 flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-surface-border px-4 py-2.5">
          <div className="min-w-0">
            {title && <Heading className="text-sm font-semibold text-ink-primary">{title}</Heading>}
            {description && <p className="mt-0.5 text-xs text-ink-muted">{description}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={cn('min-w-0 flex-1', padding === 'sm' && 'p-3', padding === 'md' && 'p-4')}>{children}</div>
      {footer && <footer className="border-t border-surface-border px-4 py-2.5">{footer}</footer>}
    </section>
  )
}
