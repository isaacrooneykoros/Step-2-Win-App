import { useId, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { useFocusTrap } from '../lib/useFocusTrap'

interface SlideOverProps {
  open:     boolean
  onClose:  () => void
  title:    string
  subtitle?: string
  children: ReactNode
  width?:   number   // px, default 480 (capped to the viewport)
  /** Sticky footer for record actions (approve / reject / save). */
  footer?:  ReactNode
  /** Small element beside the title, e.g. a StatusBadge. */
  headerAside?: ReactNode
}

/**
 * Right-hand drawer for record details. Keeps the list in view so operators
 * can move row to row. Escape closes; focus is trapped and restored.
 */
export function SlideOver({
  open, onClose, title, subtitle, children, width = 480, footer, headerAside,
}: SlideOverProps) {
  const titleId = useId()
  const ref = useFocusTrap<HTMLDivElement>(open, onClose)

  if (!open) return null

  return createPortal(
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-[var(--scrim)]" aria-hidden onClick={onClose} />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="absolute right-0 top-0 flex h-full max-w-full flex-col border-l border-surface-border bg-surface-overlay shadow-pop"
        style={{ width }}
      >
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-surface-border px-5 py-3.5">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 id={titleId} className="truncate text-base font-semibold text-ink-primary">{title}</h2>
              {headerAside}
            </div>
            {subtitle && <p className="mt-0.5 text-xs text-ink-muted">{subtitle}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close panel"
            className="-mr-1.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-ink-muted hover:bg-surface-elevated hover:text-ink-primary"
          >
            <X size={16} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && (
          <div className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-surface-border px-5 py-3">{footer}</div>
        )}
      </div>
    </div>,
    document.body,
  )
}
