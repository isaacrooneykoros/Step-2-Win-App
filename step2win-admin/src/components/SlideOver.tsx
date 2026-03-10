import { X } from 'lucide-react'
import { useEffect } from 'react'

interface SlideOverProps {
  open:     boolean
  onClose:  () => void
  title:    string
  subtitle?: string
  children: React.ReactNode
  width?:   number   // px, default 480
}

export function SlideOver({
  open, onClose, title, subtitle, children, width = 480
}: SlideOverProps) {
  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  return (
    <>
      {/* Backdrop */}
      <div
        className={`fixed inset-0 z-40 transition-opacity duration-300 ${
          open ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
        }`}
        style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(2px)' }}
        onClick={onClose}
      />

      {/* Drawer */}
      <div
        className="fixed right-0 top-0 h-full z-50 flex flex-col transition-transform
                   duration-300 overflow-hidden"
        style={{
          width,
          background:  '#13161F',
          borderLeft:  '1px solid #21263A',
          boxShadow:   '-8px 0 32px rgba(0,0,0,0.4)',
          transform:   open ? 'translateX(0)' : `translateX(${width}px)`,
        }}>

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5 shrink-0"
          style={{ borderBottom: '1px solid #21263A' }}>
          <div>
            <h2 className="text-ink-primary font-bold text-base">{title}</h2>
            {subtitle && (
              <p className="text-ink-muted text-xs mt-0.5">{subtitle}</p>
            )}
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-xl flex items-center justify-center
                       hover:bg-surface-elevated transition-colors"
            style={{ border: '1px solid #21263A' }}>
            <X size={15} color="#7B82A0" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {children}
        </div>
      </div>
    </>
  )
}
