import { useRef, useState, type ReactNode } from 'react'
import { AlertTriangle, Info, ShieldAlert } from 'lucide-react'
import { Modal } from './ui/Modal'
import { Button } from './ui/Button'
import { Input } from './ui/Input'
import { cn } from '../lib/cn'

interface ConfirmModalProps {
  open:       boolean
  onClose:    () => void
  onConfirm:  () => void
  loading?:   boolean
  title:      string
  /** What will happen, in plain words. */
  message:    ReactNode
  confirmLabel?:  string
  cancelLabel?:   string
  /** `danger` = irreversible / money / access; `warning` = reversible but impactful; `info` = routine. */
  variant?:   'danger' | 'warning' | 'info'
  /** Key facts about the target, shown as a compact list (e.g. User, Amount, Reference). */
  details?:   Array<{ label: string; value: ReactNode }>
  /** Extra consequence line, e.g. "This cannot be undone." Shown emphasised. */
  consequence?: ReactNode
  /** Require typing this exact text to enable the confirm button (for the most destructive actions). */
  confirmText?: string
  /** Extra content (e.g. a reason textarea). */
  children?:  ReactNode
  /** Disable confirm (e.g. until a required reason is entered). */
  confirmDisabled?: boolean
}

const TONE = {
  danger:  { icon: ShieldAlert,   box: 'bg-danger-soft text-danger',   button: 'danger' as const },
  warning: { icon: AlertTriangle, box: 'bg-warning-soft text-warning', button: 'primary' as const },
  info:    { icon: Info,          box: 'bg-info-soft text-info',       button: 'primary' as const },
}

/**
 * Confirmation for consequential actions. States the consequence, lists the
 * affected record, locks while the request runs, and can require typed
 * confirmation. Cancel receives initial focus so Enter never confirms by accident.
 */
export function ConfirmModal({
  open, onClose, onConfirm, loading,
  title, message,
  confirmLabel = 'Confirm',
  cancelLabel  = 'Cancel',
  variant      = 'danger',
  details, consequence, confirmText, children, confirmDisabled,
}: ConfirmModalProps) {
  const cancelRef = useRef<HTMLButtonElement>(null)
  const [typed, setTyped] = useState('')
  const tone = TONE[variant]
  const Icon = tone.icon
  const typedOk = !confirmText || typed.trim() === confirmText

  const close = () => {
    if (loading) return
    setTyped('')
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={close}
      dismissible={!loading}
      role="alertdialog"
      size="sm"
      initialFocus={cancelRef}
      title={title}
      icon={
        <span className={cn('flex h-8 w-8 items-center justify-center rounded-md', tone.box)}>
          <Icon size={16} aria-hidden />
        </span>
      }
      footer={
        <>
          <Button ref={cancelRef} variant="secondary" onClick={close} disabled={loading}>
            {cancelLabel}
          </Button>
          <Button
            variant={tone.button}
            onClick={onConfirm}
            loading={loading}
            disabled={!typedOk || confirmDisabled}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <div className="leading-relaxed text-ink-secondary">{message}</div>
        {details && details.length > 0 && (
          <dl className="divide-y divide-[var(--border)] rounded-md border border-surface-border">
            {details.map((d) => (
              <div key={d.label} className="flex items-baseline justify-between gap-4 px-3 py-2">
                <dt className="text-xs text-ink-muted">{d.label}</dt>
                <dd className="min-w-0 truncate text-right font-medium text-ink-primary">{d.value}</dd>
              </div>
            ))}
          </dl>
        )}
        {consequence && (
          <p className={cn('text-sm font-medium', variant === 'danger' ? 'text-danger' : 'text-ink-primary')}>{consequence}</p>
        )}
        {children}
        {confirmText && (
          <Input
            label={<>Type <span className="mono font-semibold text-ink-primary">{confirmText}</span> to confirm</>}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        )}
      </div>
    </Modal>
  )
}
