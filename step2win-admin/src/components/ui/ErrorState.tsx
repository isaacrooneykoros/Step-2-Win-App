import type { ReactNode } from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import { cn } from '../../lib/cn'
import { Button } from './Button'
import { errorMessage } from '../../lib/errors'

export interface ErrorStateProps {
  title?: ReactNode
  /** An Error, a message string, or anything thrown by a query. */
  error?: unknown
  onRetry?: () => void
  retrying?: boolean
  size?: 'compact' | 'default'
  /** `inline` renders a one-line banner instead of a centered block. */
  variant?: 'block' | 'inline'
  className?: string
}

/** What failed, the server's reason when available, and a retry. */
export function ErrorState({
  title = 'Could not load this data', error, onRetry, retrying, size = 'default', variant = 'block', className,
}: ErrorStateProps) {
  const detail = errorMessage(error)
  if (variant === 'inline') {
    return (
      <div role="alert" className={cn('flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-danger-line bg-danger-soft px-3 py-2 text-sm', className)}>
        <AlertTriangle size={15} className="shrink-0 text-danger" aria-hidden />
        <span className="font-medium text-danger">{title}</span>
        {detail && <span className="text-ink-secondary">{detail}</span>}
        {onRetry && (
          <Button size="sm" variant="secondary" className="ml-auto" onClick={onRetry} loading={retrying} leftIcon={<RefreshCw size={13} />}>
            Retry
          </Button>
        )}
      </div>
    )
  }
  return (
    <div role="alert" className={cn('flex flex-col items-center justify-center text-center', size === 'compact' ? 'px-4 py-8' : 'px-6 py-14', className)}>
      <span className="mb-3 flex h-9 w-9 items-center justify-center rounded-md border border-danger-line bg-danger-soft text-danger">
        <AlertTriangle size={17} aria-hidden />
      </span>
      <p className="text-sm font-medium text-ink-primary">{title}</p>
      {detail && <p className="mt-1 max-w-md text-xs text-ink-muted">{detail}</p>}
      {onRetry && (
        <Button size="sm" variant="secondary" className="mt-4" onClick={onRetry} loading={retrying} leftIcon={<RefreshCw size={13} />}>
          Try again
        </Button>
      )}
    </div>
  )
}
