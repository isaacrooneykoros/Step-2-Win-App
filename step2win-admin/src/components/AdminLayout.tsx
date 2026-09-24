import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Banknote, Bell, FileText, Menu, MessageSquare, Search } from 'lucide-react'
import Sidebar from './Sidebar'
import CommandPalette from './CommandPalette'
import { ThemeToggle } from './ThemeToggle'
import { IconButton } from './ui/Button'
import { adminApi } from '../services/adminApi'
import type { AdminNotificationItem } from '../types/admin'
import { routeLabel, SIDEBAR_WIDTH } from '../lib/nav'
import { formatRelative } from '../lib/format'
import { cn } from '../lib/cn'

/** Queue counts refresh every minute. Query keys are shared with the dashboard, so requests are cached once. */
const LAYOUT_REFRESH_MS = 60_000

const SECTION_META: Record<AdminNotificationItem['type'], { label: string; icon: typeof Bell; to: string }> = {
  support_ticket: { label: 'Support', icon: MessageSquare, to: '/support' },
  withdrawal: { label: 'Withdrawals', icon: Banknote, to: '/withdrawals' },
  audit_log: { label: 'Audit events', icon: FileText, to: '/activity' },
}

const SEVERITY_DOT: Record<NonNullable<AdminNotificationItem['severity']>, string> = {
  high: 'bg-danger',
  medium: 'bg-warning',
  low: 'bg-ink-muted',
}

function useIsDesktop() {
  const query = '(min-width: 1024px)'
  const [desktop, setDesktop] = useState(() => (typeof window === 'undefined' ? true : window.matchMedia(query).matches))
  useEffect(() => {
    const mq = window.matchMedia(query)
    const onChange = () => setDesktop(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return desktop
}

/**
 * App shell: grouped sidebar (rail on desktop, drawer on mobile), top bar with
 * command palette, theme toggle, notifications and account.
 */
export function AdminLayout() {
  const [cmdOpen, setCmdOpen] = useState(false)
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('sidebar-collapsed') === 'true')
  const [mobileNav, setMobileNav] = useState(false)
  const [notificationsOpen, setNotificationsOpen] = useState(false)
  const navigate = useNavigate()
  const location = useLocation()
  const isDesktop = useIsDesktop()
  const popoverRef = useRef<HTMLDivElement>(null)
  const bellRef = useRef<HTMLButtonElement>(null)

  // Ctrl/Cmd + K
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setCmdOpen(true)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // Document title follows the route.
  useEffect(() => {
    document.title = `${routeLabel(location.pathname)} · Step2Win Admin`
  }, [location.pathname])

  // Close the notifications popover on outside click / Escape.
  useEffect(() => {
    if (!notificationsOpen) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (!popoverRef.current?.contains(t) && !bellRef.current?.contains(t)) setNotificationsOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setNotificationsOpen(false)
        bellRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [notificationsOpen])

  const { data: withdrawalStats } = useQuery({
    queryKey: ['admin', 'withdrawal-stats'],
    queryFn: () => adminApi.getWithdrawalStats(),
    refetchInterval: LAYOUT_REFRESH_MS,
  })
  const { data: notifications } = useQuery({
    queryKey: ['admin', 'notifications'],
    queryFn: () => adminApi.getNotifications(),
    refetchInterval: LAYOUT_REFRESH_MS,
  })
  const { data: fraud } = useQuery({
    queryKey: ['admin', 'fraud-overview'],
    queryFn: () => adminApi.getFraudOverview(),
    refetchInterval: LAYOUT_REFRESH_MS,
  })
  const { data: ops } = useQuery({
    queryKey: ['admin', 'ops-monitoring'],
    queryFn: () => adminApi.getOpsMonitoring(),
    refetchInterval: LAYOUT_REFRESH_MS,
  })
  const { data: profile } = useQuery({
    queryKey: ['admin', 'profile'],
    queryFn: () => adminApi.getMyProfile(),
    staleTime: 5 * 60_000,
  })

  const badges: Record<string, number> = {
    pendingWithdrawals: withdrawalStats?.pending_count ?? 0,
    openFraudFlags: fraud?.open_flags ?? 0,
    openSupport: notifications?.summary.open_support_tickets ?? 0,
    opsBreaches: (ops?.breaches?.length ?? 0) + (ops?.anti_cheat_drift?.breaches?.length ?? 0),
  }
  const items = notifications?.items ?? []
  const unread = notifications?.summary.total ?? 0

  const adminUser = profile ?? adminApi.getCurrentAdmin()

  const handleLogout = () => {
    adminApi.adminLogout()
    navigate('/login')
  }

  const openProfile = () => navigate('/settings#profile')

  const toggleCollapsed = useCallback(() => {
    setCollapsed((v) => {
      localStorage.setItem('sidebar-collapsed', String(!v))
      return !v
    })
  }, [])

  const offset = isDesktop ? (collapsed ? SIDEBAR_WIDTH.collapsed : SIDEBAR_WIDTH.expanded) : 0

  return (
    <div className="min-h-screen bg-surface-base">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-200 focus:rounded-md focus:bg-surface-card focus:px-3 focus:py-2 focus:text-sm focus:shadow-pop"
      >
        Skip to content
      </a>

      <Sidebar
        badges={badges}
        adminUser={adminUser}
        onLogout={handleLogout}
        onOpenProfile={openProfile}
        collapsed={collapsed}
        onToggleCollapsed={toggleCollapsed}
        mobileOpen={!isDesktop && mobileNav}
        onCloseMobile={() => setMobileNav(false)}
      />

      <CommandPalette open={cmdOpen} onClose={() => setCmdOpen(false)} />

      <div className="sidebar-transition flex min-h-screen flex-col" style={{ marginLeft: offset }}>
        <header className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b border-surface-border bg-surface-card px-3 sm:px-5">
          {!isDesktop && (
            <IconButton label="Open navigation" onClick={() => setMobileNav(true)}>
              <Menu size={18} />
            </IconButton>
          )}

          <button
            type="button"
            onClick={() => setCmdOpen(true)}
            className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-md border border-surface-border bg-surface-base px-3 text-left text-sm text-ink-muted transition-colors hover:border-surface-strong sm:max-w-80"
            aria-label="Open command palette (Ctrl+K)"
          >
            <Search size={14} className="shrink-0" aria-hidden />
            <span className="flex-1 truncate">Go to…</span>
            <kbd className="hidden rounded border border-surface-border bg-surface-card px-1.5 font-mono text-2xs text-ink-muted sm:inline">Ctrl K</kbd>
          </button>

          <div className="ml-auto flex items-center gap-1">
            <ThemeToggle />

            <div className="relative">
              <IconButton
                ref={bellRef}
                label={unread > 0 ? `Notifications, ${unread} new` : 'Notifications'}
                onClick={() => setNotificationsOpen((v) => !v)}
                aria-expanded={notificationsOpen}
                aria-haspopup="dialog"
              >
                <Bell size={16} />
                {unread > 0 && (
                  <span aria-hidden className="num absolute right-0.5 top-0.5 min-w-4 rounded-full bg-danger-fill px-1 text-center text-[10px] font-semibold leading-4 text-white">
                    {unread > 9 ? '9+' : unread}
                  </span>
                )}
              </IconButton>

              {notificationsOpen && (
                <div
                  ref={popoverRef}
                  role="dialog"
                  aria-label="Notifications"
                  className="fade-in absolute right-0 top-11 z-30 w-[22rem] max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-lg border border-surface-border bg-surface-overlay shadow-pop"
                >
                  <div className="flex items-center justify-between border-b border-surface-border px-4 py-2.5">
                    <p className="text-sm font-semibold text-ink-primary">Notifications</p>
                    <p className="num text-xs text-ink-muted">{items.length} recent</p>
                  </div>
                  <div className="max-h-[26rem] overflow-y-auto">
                    {items.length === 0 ? (
                      <p className="px-4 py-8 text-center text-sm text-ink-muted">No new notifications</p>
                    ) : (
                      (['withdrawal', 'support_ticket', 'audit_log'] as const).map((type) => {
                        const group = items.filter((i) => i.type === type)
                        if (group.length === 0) return null
                        const meta = SECTION_META[type]
                        const Icon = meta.icon
                        return (
                          <section key={type} className="border-b border-surface-border last:border-b-0">
                            <div className="flex items-center justify-between px-4 pb-1 pt-2.5">
                              <p className="flex items-center gap-1.5 text-2xs font-medium uppercase tracking-[0.06em] text-ink-muted">
                                <Icon size={12} aria-hidden /> {meta.label}
                                <span className="num">({group.length})</span>
                              </p>
                              <Link
                                to={meta.to}
                                onClick={() => setNotificationsOpen(false)}
                                className="text-xs font-medium text-brand-text hover:underline"
                              >
                                Open
                              </Link>
                            </div>
                            <ul>
                              {group.slice(0, 4).map((item, index) => (
                                <li key={`${item.type}-${item.created_at}-${index}`}>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setNotificationsOpen(false)
                                      navigate(item.action_url || meta.to)
                                    }}
                                    className="flex w-full items-start gap-2.5 px-4 py-2 text-left hover:bg-surface-elevated"
                                  >
                                    <span
                                      aria-hidden
                                      className={cn('mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full', SEVERITY_DOT[item.severity ?? 'low'])}
                                    />
                                    <span className="min-w-0 flex-1">
                                      <span className="block truncate text-sm font-medium text-ink-primary">{item.title}</span>
                                      <span className="line-clamp-2 block text-xs text-ink-secondary">{item.message}</span>
                                    </span>
                                    <span className="shrink-0 text-2xs text-ink-muted">{formatRelative(item.created_at)}</span>
                                  </button>
                                </li>
                              ))}
                            </ul>
                          </section>
                        )
                      })
                    )}
                  </div>
                </div>
              )}
            </div>

            <button
              type="button"
              onClick={openProfile}
              className="ml-1 flex items-center gap-2 rounded-md py-1 pl-1 pr-2 text-left hover:bg-surface-elevated"
              aria-label={`Account: ${adminUser?.username ?? 'Admin'}`}
            >
              {profile?.profile_picture_url ? (
                <img src={profile.profile_picture_url} alt="" className="h-7 w-7 shrink-0 rounded-full object-cover" />
              ) : (
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-soft text-2xs font-semibold text-brand-text">
                  {adminUser?.username?.slice(0, 2).toUpperCase() ?? 'AD'}
                </span>
              )}
              <span className="hidden text-left leading-tight md:block">
                <span className="block text-xs font-medium text-ink-primary">{adminUser?.username ?? 'Admin'}</span>
                <span className="block text-2xs text-ink-muted">
                  {(adminUser as { is_superuser?: boolean } | null)?.is_superuser ? 'Superuser' : 'Staff'}
                </span>
              </span>
            </button>
          </div>
        </header>

        <main id="main" tabIndex={-1} className="mx-auto w-full max-w-[1600px] flex-1 px-3 py-5 focus:outline-none sm:px-5 lg:px-6">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
