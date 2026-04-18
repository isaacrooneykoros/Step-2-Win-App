import { useState, useEffect } from 'react'
import { Outlet, useNavigate } from 'react-router-dom'
import Sidebar from './Sidebar'
import CommandPalette from './CommandPalette'
import { Search, Bell, ChevronDown, MessageSquare, Banknote, FileText, ArrowRight } from 'lucide-react'
import { adminApi } from '../services/adminApi'
import type { AdminNotificationItem, AdminProfile } from '../types/admin'

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

function groupNotifications(items: AdminNotificationItem[]) {
  return {
    support_ticket: items.filter((item) => item.type === 'support_ticket'),
    withdrawal: items.filter((item) => item.type === 'withdrawal'),
    audit_log: items.filter((item) => item.type === 'audit_log'),
  }
}

function sectionTone(type: AdminNotificationItem['type']) {
  switch (type) {
    case 'support_ticket':
      return { accent: '#4F9CF9', background: 'rgba(79,156,249,0.12)', border: 'rgba(79,156,249,0.22)' }
    case 'withdrawal':
      return { accent: '#F5A623', background: 'rgba(245,166,35,0.12)', border: 'rgba(245,166,35,0.22)' }
    default:
      return { accent: '#22C55E', background: 'rgba(34,197,94,0.12)', border: 'rgba(34,197,94,0.22)' }
  }
}

function sectionMeta(type: AdminNotificationItem['type']) {
  switch (type) {
    case 'support_ticket':
      return { label: 'Support', icon: MessageSquare, actionUrl: '/support' }
    case 'withdrawal':
      return { label: 'Withdrawals', icon: Banknote, actionUrl: '/withdrawals' }
    default:
      return { label: 'Audit events', icon: FileText, actionUrl: '/activity' }
  }
}

export function AdminLayout() {
  const [cmdOpen,    setCmdOpen]    = useState(false)
  const [sidebarW,   setSidebarW]   = useState(240)
  const [badges,     setBadges]     = useState<Record<string, number>>({})
  const [profile,    setProfile]    = useState<AdminProfile | null>(null)
  const [notifications, setNotifications] = useState<AdminNotificationItem[]>([])
  const [notificationsOpen, setNotificationsOpen] = useState(false)
  const [collapsedSections, setCollapsedSections] = useState<Record<AdminNotificationItem['type'], boolean>>({
    support_ticket: false,
    withdrawal: false,
    audit_log: false,
  })
  const navigate                    = useNavigate()
  const groupedNotifications = groupNotifications(notifications)

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
    adminApi.getWithdrawalStats().then((stats) => {
      setBadges({ pendingWithdrawals: stats.pending_count || 0 })
    }).catch(() => {})

    adminApi.getMyProfile().then(setProfile).catch(() => {})
    adminApi.getNotifications().then((payload) => {
      setNotifications(payload.items || [])
      setBadges((current) => ({
        ...current,
        notifications: payload.summary.total || 0,
      }))
    }).catch(() => {})
  }, [])

  const adminUser = profile ?? adminApi.getCurrentAdmin()

  const handleLogout = () => {
    adminApi.adminLogout()
    navigate('/login')
  }

  const openProfile = () => {
    navigate('/settings#profile')
  }

  const toggleSection = (type: AdminNotificationItem['type']) => {
    setCollapsedSections((current) => ({
      ...current,
      [type]: !current[type],
    }))
  }

  return (
    <div className="min-h-screen" style={{ background: '#0E1016' }}>

      {/* Sidebar */}
      <Sidebar
        badges={badges}
        adminUser={adminUser}
        onLogout={handleLogout}
        onOpenProfile={openProfile}
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
          <div className="flex items-center gap-3 relative">
            <button
              type="button"
              onClick={() => setNotificationsOpen((value) => !value)}
              className="relative w-9 h-9 rounded-xl flex items-center justify-center
                         transition-colors hover:bg-surface-elevated"
              style={{ border: '1px solid #21263A' }}>
              <Bell size={16} color="#7B82A0" />
              {/* Notification dot */}
              {(badges.notifications || badges.pendingWithdrawals || 0) > 0 && (
                <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full"
                  style={{ background: '#22C55E', boxShadow: '0 0 6px #22C55E' }} />
              )}
            </button>

            {notificationsOpen && (
              <div className="absolute right-12 top-12 z-30 w-96 max-w-[calc(100vw-2rem)] rounded-2xl border border-[#21263A] bg-[#0C0F17] shadow-2xl overflow-hidden">
                <div className="flex items-center justify-between px-4 py-3 border-b border-[#1B2232]">
                  <div>
                    <p className="text-white text-sm font-semibold">Notifications</p>
                    <p className="text-ink-muted text-xs">{notifications.length} recent items</p>
                  </div>
                  <button className="text-xs text-info hover:underline" onClick={() => navigate('/support')}>
                    View all
                  </button>
                </div>
                <div className="max-h-128 overflow-auto">
                  {notifications.length > 0 ? (
                    <div className="p-3 space-y-3">
                      {(['support_ticket', 'withdrawal', 'audit_log'] as const).map((type) => {
                        const items = groupedNotifications[type]
                        const meta = sectionMeta(type)
                        const tone = sectionTone(type)
                        const Icon = meta.icon

                        return (
                          <section
                            key={type}
                            className="rounded-2xl border overflow-hidden"
                            style={{ background: tone.background, borderColor: tone.border }}>
                            <div className="flex items-center justify-between px-4 py-3 border-b"
                              style={{ borderColor: tone.border }}>
                              <button
                                type="button"
                                onClick={() => toggleSection(type)}
                                className="flex items-center gap-2 text-left min-w-0 flex-1">
                                <span className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0"
                                  style={{ background: 'rgba(255,255,255,0.08)' }}>
                                  <Icon size={15} color={tone.accent} />
                                </span>
                                <div className="min-w-0 flex-1">
                                  <p className="text-white text-sm font-semibold leading-none flex items-center gap-2">
                                    {meta.label}
                                    <span className="text-[10px] px-2 py-0.5 rounded-full"
                                      style={{ background: 'rgba(255,255,255,0.08)', color: '#D8DEE9' }}>
                                      {items.length}
                                    </span>
                                  </p>
                                  <p className="text-ink-muted text-[11px] mt-1">
                                    {collapsedSections[type] ? 'Collapsed' : 'Tap to collapse this section'}
                                  </p>
                                </div>
                              </button>
                              <div className="flex items-center gap-2">
                                {!collapsedSections[type] && (
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setNotificationsOpen(false)
                                      navigate(meta.actionUrl)
                                    }}
                                    className="inline-flex items-center gap-1 text-xs font-medium text-white/80 hover:text-white">
                                    Open
                                    <ArrowRight size={12} />
                                  </button>
                                )}
                                <button
                                  type="button"
                                  onClick={() => toggleSection(type)}
                                  className="w-8 h-8 rounded-lg flex items-center justify-center hover:bg-white/5 transition-colors"
                                  aria-label={collapsedSections[type] ? `Expand ${meta.label}` : `Collapse ${meta.label}`}>
                                  <ChevronDown
                                    size={14}
                                    color={tone.accent}
                                    className={`transition-transform duration-200 ${collapsedSections[type] ? '-rotate-90' : 'rotate-0'}`}
                                  />
                                </button>
                              </div>
                            </div>

                            {!collapsedSections[type] && (
                              <div>
                                {items.length > 0 ? items.slice(0, 3).map((item, index) => (
                                  <button
                                    key={`${item.type}-${item.created_at}-${index}`}
                                    onClick={() => {
                                      setNotificationsOpen(false)
                                      if (item.action_url) navigate(item.action_url)
                                    }}
                                    className="w-full text-left px-4 py-3 hover:bg-white/5 border-b border-white/5 last:border-b-0">
                                    <div className="flex items-start gap-3">
                                      <span className="mt-1 w-2.5 h-2.5 rounded-full shrink-0"
                                        style={{ background: item.severity === 'high' ? '#F06060' : item.severity === 'medium' ? '#F5A623' : '#22C55E' }} />
                                      <div className="min-w-0 flex-1">
                                        <p className="text-white text-sm font-medium truncate">{item.title}</p>
                                        <p className="text-ink-muted text-xs mt-1 line-clamp-2">{item.message}</p>
                                      </div>
                                    </div>
                                  </button>
                                )) : (
                                  <div className="px-4 py-5 text-center text-ink-muted text-sm">
                                    No {meta.label.toLowerCase()} right now
                                  </div>
                                )}
                              </div>
                            )}
                          </section>
                        )
                      })}
                    </div>
                  ) : (
                    <div className="px-4 py-8 text-center text-ink-muted text-sm">No new notifications</div>
                  )}
                </div>
              </div>
            )}

            {/* Admin avatar */}
            <button
              type="button"
              onClick={openProfile}
              className="flex items-center gap-2.5 pl-3 text-left"
              style={{ borderLeft: '1px solid #21263A' }}>
              {profile?.profile_picture_url ? (
                <img
                  src={profile.profile_picture_url}
                  alt={profile.username}
                  className="w-8 h-8 rounded-full object-cover shrink-0"
                />
              ) : (
                <div className="w-8 h-8 rounded-full flex items-center justify-center
                                text-xs font-bold text-white"
                  style={{ background: 'linear-gradient(135deg, #22C55E, #16A34A)', flexShrink: 0 }}>
                  {adminUser?.username?.slice(0, 2).toUpperCase() ?? 'AD'}
                </div>
              )}
              <div className="hidden lg:block">
                <p className="text-ink-primary text-xs font-semibold leading-none">
                  {adminUser?.username ?? 'Admin'}
                </p>
                <p className="text-ink-muted text-[10px] mt-0.5">Administrator</p>
              </div>
              <ChevronDown size={12} color="#7B82A0" className="hidden lg:block ml-1" />
            </button>
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
