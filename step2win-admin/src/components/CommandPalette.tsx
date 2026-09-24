import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { CornerDownLeft, Monitor, Moon, Search, Sun } from 'lucide-react'
import type { ElementType } from 'react'
import { NAV_GROUPS } from '../lib/nav'
import { useThemeStore, type ThemePreference } from '../lib/theme'
import { useFocusTrap } from '../lib/useFocusTrap'
import { cn } from '../lib/cn'

interface Props {
  open: boolean
  onClose: () => void
}

interface PaletteItem {
  id: string
  label: string
  group: string
  icon: ElementType
  keywords?: string
  run: () => void
}

/**
 * Ctrl/Cmd+K palette: jump to any page or switch theme. Arrow keys move,
 * Enter runs, Escape closes. Only real, working commands are listed.
 */
export default function CommandPalette({ open, onClose }: Props) {
  if (!open) return null
  return <PaletteDialog onClose={onClose} />
}

function PaletteDialog({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const navigate = useNavigate()
  const setTheme = useThemeStore((s) => s.setPreference)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const listId = useId()
  const ref = useFocusTrap<HTMLDivElement>(true, onClose, inputRef)

  const items = useMemo<PaletteItem[]>(() => {
    const pages = NAV_GROUPS.flatMap((g) =>
      g.items.map((i) => ({
        id: `page:${i.to}`,
        label: i.label,
        group: g.label,
        icon: i.icon,
        keywords: i.keywords,
        run: () => navigate(i.to),
      })),
    )
    const theme = (pref: ThemePreference, label: string, icon: ElementType): PaletteItem => ({
      id: `theme:${pref}`, label, group: 'Preferences', icon, keywords: 'theme appearance mode', run: () => setTheme(pref),
    })
    return [
      ...pages,
      theme('light', 'Use light theme', Sun),
      theme('dark', 'Use dark theme', Moon),
      theme('system', 'Match system theme', Monitor),
    ]
  }, [navigate, setTheme])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return items
    return items.filter((i) => `${i.label} ${i.group} ${i.keywords ?? ''}`.toLowerCase().includes(q))
  }, [items, query])

  const safeSelected = Math.min(selected, Math.max(0, filtered.length - 1))

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${safeSelected}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [safeSelected])

  const runItem = (item: PaletteItem | undefined) => {
    if (!item) return
    item.run()
    onClose()
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelected((s) => Math.min(Math.min(s, filtered.length - 1) + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelected((s) => Math.max(Math.min(s, filtered.length - 1) - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      runItem(filtered[safeSelected])
    }
  }

  let lastGroup = ''

  return createPortal(
    <div className="fixed inset-0 z-200 flex items-start justify-center px-4 pt-[12vh]">
      <div className="absolute inset-0 bg-[var(--scrim)]" aria-hidden onClick={onClose} />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="fade-in relative w-full max-w-lg overflow-hidden rounded-lg border border-surface-border bg-surface-overlay shadow-pop"
      >
        <div className="flex items-center gap-2.5 border-b border-surface-border px-3.5">
          <Search size={16} className="shrink-0 text-ink-muted" aria-hidden />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setSelected(0) }}
            onKeyDown={onKeyDown}
            placeholder="Go to page or run a command…"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={filtered[safeSelected] ? `${listId}-${safeSelected}` : undefined}
            aria-autocomplete="list"
            className="h-12 flex-1 bg-transparent text-sm text-ink-primary outline-none placeholder:text-ink-muted focus-visible:outline-none"
          />
          <kbd className="rounded border border-surface-border bg-surface-sunken px-1.5 py-0.5 font-mono text-2xs text-ink-muted">Esc</kbd>
        </div>

        <div ref={listRef} id={listId} role="listbox" aria-label="Results" className="max-h-80 overflow-y-auto py-1.5">
          {filtered.length === 0 && (
            <p className="px-4 py-8 text-center text-sm text-ink-muted">
              No pages or commands match “<span className="text-ink-primary">{query}</span>”
            </p>
          )}
          {filtered.map((item, idx) => {
            const showGroup = item.group !== lastGroup
            lastGroup = item.group
            const Icon = item.icon
            const isSelected = idx === safeSelected
            return (
              <div key={item.id}>
                {showGroup && (
                  <p className="px-3.5 pb-1 pt-2 text-2xs font-medium uppercase tracking-[0.06em] text-ink-muted" aria-hidden>
                    {item.group}
                  </p>
                )}
                <div
                  id={`${listId}-${idx}`}
                  data-index={idx}
                  role="option"
                  aria-selected={isSelected}
                  onMouseMove={() => setSelected(idx)}
                  onClick={() => runItem(item)}
                  className={cn(
                    'mx-1.5 flex h-9 cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-sm',
                    isSelected ? 'bg-surface-elevated text-ink-primary' : 'text-ink-secondary',
                  )}
                >
                  <Icon size={15} className={isSelected ? 'text-brand-text' : 'text-ink-muted'} aria-hidden />
                  <span className="flex-1 truncate">{item.label}</span>
                  {isSelected && <CornerDownLeft size={13} className="text-ink-muted" aria-hidden />}
                </div>
              </div>
            )
          })}
        </div>

        <div className="flex items-center gap-4 border-t border-surface-border px-3.5 py-2 text-2xs text-ink-muted">
          <span><kbd className="font-mono">↑ ↓</kbd> move</span>
          <span><kbd className="font-mono">Enter</kbd> open</span>
          <span><kbd className="font-mono">Esc</kbd> close</span>
        </div>
      </div>
    </div>,
    document.body,
  )
}
