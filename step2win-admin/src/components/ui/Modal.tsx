import { useId, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { cn } from '../../lib/cn'
import { useFocusTrap } from '../../lib/useFocusTrap'

export interface ModalProps {
  open: boolean
  onClose: () => void
  title: ReactNode
  description?: ReactNode
  children?: ReactNode
  /** Sticky action row. Put the primary action last (right). */
  footer?: ReactNode
  size?: 'sm' | 'md' | 'lg'
  /** Disable scrim-click / Escape closing while a request is in flight. */
  dismissible?: boolean
  initialFocus?: RefObject<HTMLElement | null>
  /** Role: use `alertdialog` for confirmations. */
  role?: 'dialog' | 'alertdialog'
  /** Optional element shown left of the title (e.g. a tone icon). */
  icon?: ReactNode
}

const WIDTH = { sm: 'max-w-md', md: 'max-w-lg', lg: 'max-w-2xl' }

/** Centered dialog with scrim, focus trap, Escape to close and focus restore. */
export function Modal({
  open, onClose, title, description, children, footer, size = 'md', dismissible = true, initialFocus, role = 'dialog', icon,
}: ModalProps) {
  const titleId = useId()
  const descId = useId()
  const ref = useFocusTrap<HTMLDivElement>(open, dismissible ? onClose : undefined, initialFocus)
  if (!open) return null

  return createPortal(
    <div className="fixed inset-0 z-100 flex items-end justify-center p-0 sm:items-center sm:p-4">
      <div className="absolute inset-0 bg-[var(--scrim)]" aria-hidden onClick={dismissible ? onClose : undefined} />
      <div
        ref={ref}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        className={cn(
          'fade-in relative flex max-h-[92vh] w-full flex-col rounded-t-lg border border-surface-border bg-surface-overlay shadow-pop sm:rounded-lg',
          WIDTH[size],
        )}
      >
        <div className="flex items-start gap-3 px-5 pb-3 pt-4">
          {icon && <div className="mt-0.5 shrink-0">{icon}</div>}
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-base font-semibold text-ink-primary">{title}</h2>
            {description && <p id={descId} className="mt-1 text-sm text-ink-secondary">{description}</p>}
          </div>
          {dismissible && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="-mr-1.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-ink-muted hover:bg-surface-elevated hover:text-ink-primary"
            >
              <X size={16} />
            </button>
          )}
        </div>
        {children && <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-4">{children}</div>}
        {footer && (
          <div className="flex flex-col-reverse gap-2 border-t border-surface-border px-5 py-3 sm:flex-row sm:justify-end">{footer}</div>
        )}
      </div>
    </div>,
    document.body,
  )
}
