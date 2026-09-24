import { useState } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { ChevronsLeft, ChevronsRight, LogOut, X } from 'lucide-react'
import { NAV_GROUPS, SIDEBAR_WIDTH } from '../lib/nav'
import { cn } from '../lib/cn'
import { BrandMark } from './BrandMark'

interface SidebarProps {
  badges?: Record<string, number>
  adminUser?: { username: string; email: string; profile_picture_url?: string | null } | null
  onLogout?: () => void
  onOpenProfile?: () => void
  /** Controlled rail state (desktop). Uncontrolled when omitted (persists to localStorage). */
  collapsed?: boolean
  onToggleCollapsed?: () => void
  /** Mobile drawer state (below lg). */
  mobileOpen?: boolean
  onCloseMobile?: () => void
}

const STORAGE_KEY = 'sidebar-collapsed'

function isActivePath(pathname: string, to: string) {
  if (to === '/') return pathname === '/' || pathname === '/dashboard'
  if (to === '/fraud') return pathname.startsWith('/fraud') || pathname.startsWith('/anti-cheat')
  return pathname === to || pathname.startsWith(`${to}/`)
}

/**
 * Grouped navigation. Desktop: fixed column that collapses to an icon rail.
 * Below lg: off-canvas drawer. Counts appear only for queues that need action.
 */
export default function Sidebar({
  badges = {}, adminUser, onLogout, onOpenProfile,
  collapsed: collapsedProp, onToggleCollapsed, mobileOpen = false, onCloseMobile,
}: SidebarProps) {
  const [collapsedLocal, setCollapsedLocal] = useState(() => localStorage.getItem(STORAGE_KEY) === 'true')
  const collapsed = collapsedProp ?? collapsedLocal
  const { pathname } = useLocation()

  const toggle = () => {
    if (onToggleCollapsed) return onToggleCollapsed()
    setCollapsedLocal((v) => {
      localStorage.setItem(STORAGE_KEY, String(!v))
      return !v
    })
  }

  // In the mobile drawer the rail never collapses.
  const rail = collapsed && !mobileOpen

  return (
    <>
      {mobileOpen && (
        <div className="fixed inset-0 z-30 bg-[var(--scrim)] lg:hidden" aria-hidden onClick={onCloseMobile} />
      )}
      <aside
        aria-label="Main navigation"
        className={cn(
          'sidebar-transition fixed left-0 top-0 z-40 flex h-dvh flex-col border-r border-sidebar-border bg-sidebar-bg',
          'transition-transform duration-200 lg:translate-x-0',
          mobileOpen ? 'translate-x-0 shadow-pop' : '-translate-x-full',
        )}
        style={{ width: rail ? SIDEBAR_WIDTH.collapsed : SIDEBAR_WIDTH.expanded }}
      >
        {/* Brand */}
        <div className={cn('flex h-14 shrink-0 items-center border-b border-sidebar-border', rail ? 'justify-center px-0' : 'gap-2.5 px-4')}>
          <BrandMark size={26} />
          {!rail && (
            <div className="min-w-0 leading-tight">
              <p className="text-sm font-semibold tracking-[-0.01em] text-ink-primary">Step2Win</p>
              <p className="text-2xs text-ink-muted">Operations console</p>
            </div>
          )}
          {mobileOpen && (
            <button
              type="button"
              onClick={onCloseMobile}
              aria-label="Close navigation"
              className="ml-auto flex h-8 w-8 items-center justify-center rounded-md text-ink-secondary hover:bg-sidebar-item lg:hidden"
            >
              <X size={16} />
            </button>
          )}
        </div>

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto overflow-x-hidden px-2 py-2.5">
          {NAV_GROUPS.map((group, gi) => (
            <div key={group.label} className={gi > 0 ? 'mt-3' : ''}>
              {rail ? (
                gi > 0 && <div className="mx-auto mb-2 h-px w-6 bg-sidebar-border" aria-hidden />
              ) : (
                <p className="mb-0.5 px-2.5 text-2xs font-medium uppercase tracking-[0.06em] text-ink-muted">{group.label}</p>
              )}
              <ul className="space-y-px">
                {group.items.map(({ to, icon: Icon, label, badgeKey }) => {
                  const badge = badgeKey ? badges[badgeKey] ?? 0 : 0
                  const active = isActivePath(pathname, to)
                  return (
                    <li key={to}>
                      <NavLink
                        to={to}
                        end={to === '/'}
                        onClick={onCloseMobile}
                        title={rail ? (badge > 0 ? `${label} (${badge})` : label) : undefined}
                        aria-current={active ? 'page' : undefined}
                        className={cn(
                          'relative flex h-8 items-center rounded-md text-[13px] font-medium transition-colors',
                          rail ? 'justify-center' : 'gap-2.5 px-2.5',
                          active
                            ? 'bg-sidebar-active text-brand-text'
                            : 'text-sidebar-text hover:bg-sidebar-item hover:text-ink-primary',
                        )}
                      >
                        {active && !rail && <span aria-hidden className="absolute -left-2 top-1.5 h-5 w-0.5 rounded-r bg-brand" />}
                        <Icon size={16} className="shrink-0" aria-hidden />
                        {!rail && <span className="flex-1 truncate">{label}</span>}
                        {!rail && badge > 0 && (
                          <span className="num rounded bg-warning-soft px-1.5 text-2xs font-semibold leading-[18px] text-warning">
                            {badge > 99 ? '99+' : badge}
                            <span className="sr-only"> need attention</span>
                          </span>
                        )}
                        {rail && badge > 0 && (
                          <span aria-hidden className="absolute right-2.5 top-1.5 h-1.5 w-1.5 rounded-full bg-warning" />
                        )}
                      </NavLink>
                    </li>
                  )
                })}
              </ul>
            </div>
          ))}
        </nav>

        {/* Account */}
        <div className="shrink-0 border-t border-sidebar-border p-2">
          {!rail ? (
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={onOpenProfile}
                className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-sidebar-item"
              >
                <Avatar user={adminUser} />
                <div className="min-w-0">
                  <p className="truncate text-xs font-medium text-ink-primary">{adminUser?.username ?? 'Admin'}</p>
                  <p className="truncate text-2xs text-ink-muted">{adminUser?.email ?? ''}</p>
                </div>
              </button>
              <button
                type="button"
                onClick={onLogout}
                aria-label="Sign out"
                title="Sign out"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-ink-secondary hover:bg-danger-soft hover:text-danger"
              >
                <LogOut size={15} />
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={onLogout}
              aria-label="Sign out"
              title="Sign out"
              className="flex h-8 w-full items-center justify-center rounded-md text-ink-secondary hover:bg-danger-soft hover:text-danger"
            >
              <LogOut size={15} />
            </button>
          )}
          <button
            type="button"
            onClick={toggle}
            aria-label={rail ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-expanded={!rail}
            className={cn(
              'mt-1 hidden h-8 w-full items-center rounded-md text-xs text-ink-muted hover:bg-sidebar-item hover:text-ink-primary lg:flex',
              rail ? 'justify-center' : 'gap-2 px-2.5',
            )}
          >
            {rail ? <ChevronsRight size={15} /> : <><ChevronsLeft size={15} /> Collapse</>}
          </button>
        </div>
      </aside>
    </>
  )
}

function Avatar({ user }: { user?: SidebarProps['adminUser'] }) {
  if (user?.profile_picture_url) {
    return <img src={user.profile_picture_url} alt="" className="h-7 w-7 shrink-0 rounded-full object-cover" />
  }
  return (
    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-soft text-2xs font-semibold text-brand-text">
      {user?.username?.slice(0, 2).toUpperCase() ?? 'AD'}
    </span>
  )
}
