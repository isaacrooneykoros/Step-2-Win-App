import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { Search, LayoutDashboard, Users, Trophy, Banknote,
         FileText, Settings, ArrowRight, Zap, BarChart2, Shield,
         ArrowLeftRight, Activity, HeadphonesIcon, FileBarChart } from 'lucide-react'

const PAGES = [
  { label: 'Dashboard',         to: '/',              icon: LayoutDashboard, group: 'Pages'   },
  { label: 'Analytics',         to: '/analytics',     icon: BarChart2,       group: 'Pages'   },
  { label: 'Users',             to: '/users',         icon: Users,           group: 'Pages'   },
  { label: 'Challenges',        to: '/challenges',    icon: Trophy,          group: 'Pages'   },
  { label: 'Transactions',      to: '/transactions',  icon: ArrowLeftRight,  group: 'Pages'   },
  { label: 'Withdrawals',       to: '/withdrawals',   icon: Banknote,        group: 'Pages'   },
  { label: 'Moderation',        to: '/moderation',    icon: Shield,          group: 'Pages'   },
  { label: 'Anti-Cheat',        to: '/fraud',         icon: Shield,          group: 'Pages'   },
  { label: 'Activity Logs',     to: '/activity',      icon: Activity,        group: 'Pages'   },
  { label: 'Reports',           to: '/reports',       icon: FileBarChart,    group: 'Pages'   },
  { label: 'Support',           to: '/support',       icon: HeadphonesIcon,  group: 'Pages'   },
  { label: 'Badges',            to: '/badges',        icon: Trophy,          group: 'Pages'   },
  { label: 'Legal Documents',   to: '/legal',         icon: FileText,        group: 'Pages'   },
  { label: 'Settings',          to: '/settings',      icon: Settings,        group: 'Pages'   },
]

const ACTIONS = [
  { label: 'Approve all withdrawals', icon: Zap, group: 'Actions', action: 'approve-all' },
  { label: 'Export users CSV',        icon: Zap, group: 'Actions', action: 'export-users' },
  { label: 'Publish Privacy Policy',  icon: Zap, group: 'Actions', action: 'publish-privacy' },
]

interface Props {
  open: boolean
  onClose: () => void
}

export default function CommandPalette({ open, onClose }: Props) {
  const [query, setQuery]       = useState('')
  const [selected, setSelected] = useState(0)
  const navigate                = useNavigate()
  const inputRef                = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      // Reset state when opening
      setTimeout(() => {
        setQuery('')
        setSelected(0)
        inputRef.current?.focus()
      }, 0)
    }
  }, [open])

  const allItems = [...PAGES, ...ACTIONS]
  const filtered = query.trim()
    ? allItems.filter(i => i.label.toLowerCase().includes(query.toLowerCase()))
    : allItems

  // Group filtered results
  const groups = filtered.reduce((acc, item) => {
    if (!acc[item.group]) acc[item.group] = []
    acc[item.group].push(item)
    return acc
  }, {} as Record<string, typeof allItems>)

  const flatFiltered = Object.values(groups).flat()

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!open) return
      if (e.key === 'Escape') { onClose(); return }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelected(s => Math.min(s + 1, flatFiltered.length - 1))
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelected(s => Math.max(s - 1, 0))
      }
      if (e.key === 'Enter' && flatFiltered[selected]) {
        const item = flatFiltered[selected]
        if ('to' in item && item.to) { navigate(item.to); onClose() }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, selected, flatFiltered, navigate, onClose])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-200 flex items-start justify-center pt-24"
      style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)' }}
      onClick={onClose}>
      <div
        className="w-full max-w-xl rounded-2xl overflow-hidden fade-in"
        style={{
          background: '#191C28',
          border: '1px solid #21263A',
          boxShadow: '0 24px 80px rgba(0,0,0,0.6)',
        }}
        onClick={e => e.stopPropagation()}>

        {/* Search input */}
        <div className="flex items-center gap-3 px-4 py-4"
          style={{ borderBottom: '1px solid #21263A' }}>
          <Search size={16} color="#7B82A0" className="shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={e => { setQuery(e.target.value); setSelected(0) }}
            placeholder="Search pages, users, actions..."
            className="flex-1 bg-transparent text-ink-primary text-sm outline-none
                       placeholder-ink-muted"
          />
          <kbd className="text-[10px] text-ink-muted px-1.5 py-0.5 rounded"
            style={{ background: '#21263A', border: '1px solid #2E3450' }}>
            ESC
          </kbd>
        </div>

        {/* Results */}
        <div className="max-h-80 overflow-y-auto py-2">
          {Object.entries(groups).map(([groupName, items]) => {
            return (
              <div key={groupName}>
                <p className="text-ink-muted text-[10px] font-semibold uppercase
                               tracking-widest px-4 py-1.5">
                  {groupName}
                </p>
                {items.map((item) => {
                  const idx = flatFiltered.indexOf(item)
                  const isSelected = idx === selected
                  const Icon = item.icon
                  return (
                    <button
                      key={item.label}
                      onMouseEnter={() => setSelected(idx)}
                      onClick={() => {
                        if ('to' in item && item.to) { navigate(item.to); onClose() }
                      }}
                      className="w-full flex items-center gap-3 px-4 py-2.5
                                 transition-colors text-left"
                      style={{ background: isSelected ? '#21263A' : 'transparent' }}>
                      <div className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0"
                        style={{ background: isSelected ? '#22C55E' : '#21263A' }}>
                        <Icon size={13} color={isSelected ? '#fff' : '#7B82A0'} />
                      </div>
                      <span className={`text-sm font-medium ${
                        isSelected ? 'text-white' : 'text-ink-secondary'
                      }`}>
                        {item.label}
                      </span>
                      {isSelected && (
                        <ArrowRight size={13} color="#22C55E" className="ml-auto" />
                      )}
                    </button>
                  )
                })}
              </div>
            )
          })}
          {flatFiltered.length === 0 && (
            <div className="px-4 py-8 text-center">
              <p className="text-ink-muted text-sm">
                No results for "<span className="text-ink-secondary">{query}</span>"
              </p>
            </div>
          )}
        </div>

        {/* Footer hint */}
        <div className="flex items-center gap-4 px-4 py-2.5"
          style={{ borderTop: '1px solid #21263A' }}>
          {[
            ['↑↓', 'Navigate'],
            ['↵',  'Select'],
            ['Esc','Close'],
          ].map(([key, hint]) => (
            <div key={key} className="flex items-center gap-1.5">
              <kbd className="text-[10px] text-ink-muted px-1.5 py-0.5 rounded font-mono"
                style={{ background: '#21263A', border: '1px solid #2E3450' }}>
                {key}
              </kbd>
              <span className="text-ink-muted text-[10px]">{hint}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
