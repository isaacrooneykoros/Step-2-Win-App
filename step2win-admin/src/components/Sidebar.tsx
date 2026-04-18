import { useState } from 'react'
import { NavLink } from 'react-router-dom'
import {
  LayoutDashboard, Users, Trophy, ArrowLeftRight,
  Banknote, Shield, FileBarChart, Settings, LogOut,
  ChevronLeft, ChevronRight, Activity, Footprints,
  FileText, BarChart2, HeadphonesIcon,
} from 'lucide-react'

const NAV_GROUPS = [
  {
    label: 'OVERVIEW',
    items: [
      { to: '/',           icon: LayoutDashboard, label: 'Dashboard'    },
      { to: '/analytics',  icon: BarChart2,        label: 'Analytics'   },
    ],
  },
  {
    label: 'MANAGEMENT',
    items: [
      { to: '/users',        icon: Users,             label: 'Users'          },
      { to: '/challenges',   icon: Trophy,            label: 'Challenges'     },
      { to: '/transactions', icon: ArrowLeftRight,    label: 'Transactions'   },
      { to: '/withdrawals',  icon: Banknote,          label: 'Withdrawals', badgeKey: 'pendingWithdrawals' },
      { to: '/activity',     icon: Activity,          label: 'Activity Logs'  },
    ],
  },
  {
    label: 'CONTENT',
    items: [
      { to: '/moderation',   icon: Shield,            label: 'Moderation',  badgeKey: 'flaggedUsers' },
      { to: '/legal',        icon: FileText,          label: 'Legal Docs'     },
    ],
  },
  {
    label: 'SYSTEM',
    items: [
      { to: '/reports',       icon: FileBarChart,      label: 'Reports'        },
      { to: '/monitoring/ops', icon: Activity,         label: 'Ops Monitoring' },
      { to: '/support',       icon: HeadphonesIcon,    label: 'Support'        },
      { to: '/badges',        icon: Trophy,            label: 'Badges'         },
      { to: '/fraud',         icon: Shield,            label: 'Anti-Cheat'     },
      { to: '/settings',      icon: Settings,          label: 'Settings'       },
    ],
  },
]

interface SidebarProps {
  badges?: Record<string, number>
  adminUser?: { username: string; email: string; profile_picture_url?: string | null } | null
  onLogout?: () => void
  onOpenProfile?: () => void
}

export default function Sidebar({ badges = {}, adminUser, onLogout, onOpenProfile }: SidebarProps) {
  // Initialize state from localStorage (lazy initialization)
  const [collapsed, setCollapsed] = useState(() => {
    const saved = localStorage.getItem('sidebar-collapsed')
    return saved === 'true'
  })

  const toggle = () => {
    setCollapsed(v => {
      localStorage.setItem('sidebar-collapsed', String(!v))
      return !v
    })
  }

  const w = collapsed ? 72 : 240

  return (
    <aside
      className="sidebar-transition fixed left-0 top-0 h-screen flex flex-col z-30 select-none"
      style={{
        width: w,
        background: '#0A0C12',
        borderRight: '1px solid #1C1F2E',
        overflow: 'hidden',
      }}>

      {/* ── Logo ── */}
      <div className="flex items-center px-4 py-5 shrink-0"
        style={{ borderBottom: '1px solid #1C1F2E', height: 64, minHeight: 64 }}>
        <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
          style={{ background: 'linear-gradient(135deg, #22C55E 0%, #16A34A 100%)',
                   boxShadow: '0 4px 12px rgba(34,197,94,0.28)' }}>
          <Footprints size={17} color="#fff" />
        </div>
        {!collapsed && (
          <div className="ml-3 overflow-hidden whitespace-nowrap fade-in">
            <p className="text-white font-bold text-sm leading-none">Step2Win</p>
            <p className="text-ink-muted text-xs mt-0.5">Admin Panel</p>
          </div>
        )}
      </div>

      {/* ── Nav ── */}
      <nav className="flex-1 overflow-y-auto py-3 px-2">
        {NAV_GROUPS.map(group => (
          <div key={group.label} className="mb-4">
            {!collapsed && (
              <p className="text-ink-muted text-[10px] font-semibold tracking-widest
                            px-3 mb-1.5 uppercase fade-in">
                {group.label}
              </p>
            )}
            {collapsed && (
              <div className="w-8 h-px mx-auto mb-2 mt-1"
                style={{ background: '#1C1F2E' }} />
            )}
            {group.items.map(({ to, icon: Icon, label, badgeKey }) => {
              const badge = badgeKey ? (badges[badgeKey] ?? 0) : 0
              return (
                <NavLink
                  key={to}
                  to={to}
                  title={collapsed ? label : undefined}
                  className={({ isActive }) =>
                    `flex items-center gap-3 rounded-xl mb-0.5 transition-all duration-150
                     group relative ${collapsed ? 'justify-center px-0 py-2.5' : 'px-3 py-2.5'}
                     ${isActive
                       ? 'text-white'
                       : 'text-ink-secondary hover:bg-sidebar-item hover:text-ink-primary'}`
                  }>
                  {({ isActive }) => (
                    <>
                      {isActive && (
                        <span
                          className="absolute inset-0 rounded-xl"
                          style={{ background: 'rgba(34,197,94,0.12)', border: '1px solid rgba(34,197,94,0.22)' }}
                        />
                      )}
                      <Icon
                        size={17}
                        className="shrink-0 relative"
                        style={{ color: isActive ? '#22C55E' : undefined }}
                      />
                      {!collapsed && (
                        <span className="flex-1 text-sm font-medium truncate fade-in relative">
                          {label}
                        </span>
                      )}
                      {!collapsed && badge > 0 && (
                        <span className="bg-red-500 text-white text-[10px] font-bold
                                         px-1.5 py-0.5 rounded-full min-w-4.5 text-center fade-in">
                          {badge > 99 ? '99+' : badge}
                        </span>
                      )}
                      {/* Collapsed badge dot */}
                      {collapsed && badge > 0 && (
                        <span className="absolute top-1.5 right-1.5 w-2 h-2
                                         rounded-full bg-red-500" />
                      )}
                    </>
                  )}
                </NavLink>
              )
            })}
          </div>
        ))}
      </nav>

      {/* ── Admin user ── */}
      <div className="shrink-0 px-2 pb-2 pt-2"
        style={{ borderTop: '1px solid #1C1F2E' }}>
        {!collapsed ? (
          <div className="fade-in">
            <button
              type="button"
              onClick={onOpenProfile}
              className="w-full flex items-center gap-3 px-3 py-2 rounded-xl mb-1 text-left"
              style={{ background: '#111318' }}>
              {adminUser?.profile_picture_url ? (
                <img
                  src={adminUser.profile_picture_url}
                  alt={adminUser.username ?? 'Admin'}
                  className="w-8 h-8 rounded-full object-cover shrink-0"
                />
              ) : (
                <div className="w-8 h-8 rounded-full flex items-center justify-center
                                shrink-0 text-xs font-bold text-white"
                  style={{ background: 'linear-gradient(135deg, #22C55E, #16A34A)' }}>
                  {adminUser?.username?.slice(0, 2).toUpperCase() ?? 'AD'}
                </div>
              )}
              <div className="flex-1 min-w-0">
                <p className="text-ink-primary text-xs font-semibold truncate">
                  {adminUser?.username ?? 'Admin'}
                </p>
                <p className="text-ink-muted text-[10px] truncate">
                  {adminUser?.email ?? 'admin@step2win.co.ke'}
                </p>
              </div>
            </button>
            <button
              onClick={onLogout}
              className="w-full flex items-center justify-center gap-2 py-2 rounded-xl
                         text-ink-secondary hover:text-red-400 hover:bg-red-500/10
                         text-xs font-medium transition-all duration-150">
              <LogOut size={14} />
              Sign out
            </button>
          </div>
        ) : (
          <button
            onClick={onLogout}
            title="Sign out"
            className="w-full flex justify-center py-2.5 rounded-xl
                       text-ink-muted hover:text-red-400 hover:bg-red-500/10
                       transition-all duration-150">
            <LogOut size={16} />
          </button>
        )}
      </div>

      {/* ── Collapse toggle ── */}
      <button
        onClick={toggle}
        className="absolute top-5 -right-3 w-6 h-6 rounded-full flex items-center
                   justify-center transition-colors z-50"
        style={{
          background: '#191C28',
          border: '1px solid #21263A',
          boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
        }}>
        {collapsed
          ? <ChevronRight size={12} color="#7B82A0" />
          : <ChevronLeft  size={12} color="#7B82A0" />}
      </button>
    </aside>
  )
}
