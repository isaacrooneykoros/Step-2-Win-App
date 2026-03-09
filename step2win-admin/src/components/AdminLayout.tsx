import { useState, useEffect } from 'react'
import { Outlet, useNavigate } from 'react-router-dom'
import Sidebar from './Sidebar'
import CommandPalette from './CommandPalette'
import { Search, Bell } from 'lucide-react'
import { adminApi } from '../services/adminApi'

// Keyboard shortcut: Cmd/Ctrl + K
function useCmdK(callback: () => void) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        callback()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [callback])
}

export function AdminLayout() {
  const [cmdOpen,    setCmdOpen]    = useState(false)
  const [sidebarW,   setSidebarW]   = useState(240)
  const [badges,     setBadges]     = useState<Record<string, number>>({})
  const navigate                    = useNavigate()

  useCmdK(() => setCmdOpen(true))

  // Watch sidebar collapse state to shift content
  useEffect(() => {
    const update = () => {
      const saved = localStorage.getItem('sidebar-collapsed')
      setSidebarW(saved === 'true' ? 72 : 240)
    }
    update()
    // Poll — simple approach, or use a context/event
    const interval = setInterval(update, 300)
    return () => clearInterval(interval)
  }, [])

  // Fetch pending withdrawals for badge
  useEffect(() => {
    adminApi
      .getWithdrawalStats()
      .then((stats) => {
        setBadges({ pendingWithdrawals: stats.pending_count || 0 })
      })
      .catch(() => {})
  }, [])

  const adminUser = adminApi.getCurrentAdmin()

  const handleLogout = () => {
    adminApi.adminLogout()
    navigate('/auth/login')
  }

  return (
    <div className="min-h-screen" style={{ background: '#0E1016' }}>

      {/* Sidebar */}
      <Sidebar
        badges={badges}
        adminUser={adminUser}
        onLogout={handleLogout}
      />

      {/* Command palette */}
      <CommandPalette open={cmdOpen} onClose={() => setCmdOpen(false)} />

      {/* Main content — shifts right by sidebar width */}
      <div
        className="sidebar-transition flex flex-col min-h-screen"
        style={{ marginLeft: sidebarW }}>

        {/* ── Global top bar ── */}
        <header
          className="sticky top-0 z-20 flex items-center justify-between px-6"
          style={{
            height: 64,
            background: 'rgba(10,12,18,0.92)',
            borderBottom: '1px solid #21263A',
            backdropFilter: 'blur(12px)',
          }}>

          {/* Search / Command bar */}
          <button
            onClick={() => setCmdOpen(true)}
            className="flex items-center gap-2 px-3 py-2 rounded-xl text-sm
                       text-ink-muted hover:text-ink-secondary transition-colors"
            style={{ background: '#0C0F17', border: '1px solid #1B2232', width: 250 }}>
            <Search size={13} />
            <span className="flex-1 text-left text-xs">Search anything...</span>
            <div className="flex items-center gap-0.5">
              <kbd className="text-[10px] px-1 py-0.5 rounded font-mono"
                style={{ background: '#21263A' }}>
                ⌘K
              </kbd>
            </div>
          </button>

          {/* Right: notifications + avatar */}
          <div className="flex items-center gap-3">
            <button
              className="relative w-9 h-9 rounded-xl flex items-center justify-center
                         transition-colors hover:bg-surface-elevated"
              style={{ border: '1px solid #21263A' }}>
              <Bell size={16} color="#7B82A0" />
              {/* Notification dot */}
              {badges.pendingWithdrawals > 0 && (
                <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full"
                  style={{ background: '#22C55E', boxShadow: '0 0 6px #22C55E' }} />
              )}
            </button>

            {/* Admin avatar */}
            <div className="flex items-center gap-2.5 pl-3"
              style={{ borderLeft: '1px solid #21263A' }}>
              <div className="w-8 h-8 rounded-full flex items-center justify-center
                              text-xs font-bold text-white"
                style={{ background: 'linear-gradient(135deg, #22C55E, #16A34A)', flexShrink: 0 }}>
                {adminUser?.username?.slice(0, 2).toUpperCase() ?? 'AD'}
              </div>
              <div className="hidden lg:block">
                <p className="text-ink-primary text-xs font-semibold leading-none">
                  {adminUser?.username ?? 'Admin'}
                </p>
                <p className="text-ink-muted text-[10px] mt-0.5">Administrator</p>
              </div>
            </div>
          </div>
        </header>

        {/* ── Page content ── */}
        <main className="flex-1 p-6">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
