import { AlertTriangle, X, Loader2 } from 'lucide-react'

interface ConfirmModalProps {
  open:       boolean
  onClose:    () => void
  onConfirm:  () => void
  loading?:   boolean
  title:      string
  message:    string
  confirmLabel?:  string
  cancelLabel?:   string
  variant?:   'danger' | 'warning' | 'info'
}

export function ConfirmModal({
  open, onClose, onConfirm, loading,
  title, message,
  confirmLabel = 'Confirm',
  cancelLabel  = 'Cancel',
  variant      = 'danger',
}: ConfirmModalProps) {
  if (!open) return null

  const colors = {
    danger:  { icon: '#F06060', bg: 'rgba(240,96,96,0.1)',   btn: '#DC2626', btnHover: '#B91C1C' },
    warning: { icon: '#F5A623', bg: 'rgba(245,166,35,0.1)',  btn: '#D97706', btnHover: '#B45309' },
    info:    { icon: '#4F9CF9', bg: 'rgba(79,156,249,0.1)',  btn: '#7C6FF7', btnHover: '#6D5FE8' },
  }
  const c = colors[variant]

  return (
    <div
      className="fixed inset-0 z-100 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)' }}
      onClick={onClose}>
      <div
        className="w-full max-w-md rounded-2xl p-6 fade-in"
        style={{ background: '#191C28', border: '1px solid #21263A',
                 boxShadow: '0 24px 64px rgba(0,0,0,0.6)' }}
        onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className="flex items-start justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center"
              style={{ background: c.bg }}>
              <AlertTriangle size={18} style={{ color: c.icon }} />
            </div>
            <h3 className="text-ink-primary font-bold text-base">{title}</h3>
          </div>
          <button onClick={onClose}
            className="w-7 h-7 rounded-lg flex items-center justify-center
                       hover:bg-surface-elevated transition-colors">
            <X size={14} color="#7B82A0" />
          </button>
        </div>

        <p className="text-ink-secondary text-sm mb-6 leading-relaxed">{message}</p>

        <div className="flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 py-2.5 rounded-xl text-ink-secondary text-sm
                       font-semibold transition-colors hover:bg-surface-elevated"
            style={{ border: '1px solid #21263A' }}>
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            disabled={loading}
            className="flex-1 py-2.5 rounded-xl text-white text-sm font-semibold
                       transition-colors flex items-center justify-center gap-2
                       disabled:opacity-60"
            style={{ background: c.btn }}>
            {loading && <Loader2 size={14} className="animate-spin" />}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
