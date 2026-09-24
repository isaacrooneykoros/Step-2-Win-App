import type { ElementType } from 'react'
import {
  Activity, ArrowLeftRight, Award, Banknote, BarChart3, FileBarChart, FileText, Footprints,
  Gauge, HeadphonesIcon, LayoutDashboard, Settings, ShieldAlert, ShieldCheck, Trophy, Users,
} from 'lucide-react'

/** Keys the layout fills with live counts (queues that need an operator). */
export type NavBadgeKey = 'pendingWithdrawals' | 'openFraudFlags' | 'openSupport' | 'opsBreaches'

export interface NavItem {
  to: string
  label: string
  icon: ElementType
  badgeKey?: NavBadgeKey
  /** Extra words for the command palette search. */
  keywords?: string
}

export interface NavGroup {
  label: string
  items: NavItem[]
}

/** Single source for the sidebar and the command palette. Only routes that exist in App.tsx. */
export const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Overview',
    items: [
      { to: '/', label: 'Dashboard', icon: LayoutDashboard, keywords: 'home overview queue' },
      { to: '/analytics', label: 'Analytics', icon: BarChart3, keywords: 'charts trends' },
      { to: '/reports', label: 'Reports', icon: FileBarChart, keywords: 'revenue retention export' },
    ],
  },
  {
    label: 'Users & Activity',
    items: [
      { to: '/users', label: 'Users', icon: Users, keywords: 'accounts members ban staff' },
      { to: '/steps', label: 'Step logs', icon: Footprints, keywords: 'steps sync health records' },
      { to: '/activity', label: 'Audit log', icon: Activity, keywords: 'activity logs admin actions history' },
    ],
  },
  {
    label: 'Challenges',
    items: [
      { to: '/challenges', label: 'Challenges', icon: Trophy, keywords: 'approve cancel pool' },
      { to: '/badges', label: 'Badges', icon: Award, keywords: 'achievements gamification' },
    ],
  },
  {
    label: 'Finance',
    items: [
      { to: '/transactions', label: 'Transactions', icon: ArrowLeftRight, keywords: 'wallet ledger deposits payouts mpesa' },
      { to: '/withdrawals', label: 'Withdrawals', icon: Banknote, badgeKey: 'pendingWithdrawals', keywords: 'payout queue approve mpesa' },
    ],
  },
  {
    label: 'Trust & Safety',
    items: [
      { to: '/fraud', label: 'Anti-cheat', icon: ShieldAlert, badgeKey: 'openFraudFlags', keywords: 'fraud flags trust score' },
      { to: '/moderation', label: 'Moderation', icon: ShieldCheck, keywords: 'review suspicious' },
    ],
  },
  {
    label: 'Support',
    items: [
      { to: '/support', label: 'Support tickets', icon: HeadphonesIcon, badgeKey: 'openSupport', keywords: 'help tickets inbox' },
    ],
  },
  {
    label: 'Content',
    items: [
      { to: '/legal', label: 'Legal documents', icon: FileText, keywords: 'terms privacy policy publish' },
    ],
  },
  {
    label: 'System',
    items: [
      { to: '/monitoring/ops', label: 'Ops monitoring', icon: Gauge, badgeKey: 'opsBreaches', keywords: 'health callbacks stuck drift' },
      { to: '/settings', label: 'Settings', icon: Settings, keywords: 'profile configuration fees' },
    ],
  },
]

export const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((g) => g.items)

/** Title of the current route, for document.title. */
export function routeLabel(pathname: string): string {
  if (pathname === '/' || pathname === '/dashboard') return 'Dashboard'
  const match = NAV_ITEMS.filter((i) => i.to !== '/' && pathname.startsWith(i.to)).sort((a, b) => b.to.length - a.to.length)[0]
  if (pathname.startsWith('/anti-cheat')) return 'Anti-cheat'
  return match?.label ?? 'Admin'
}

/** Sidebar widths (px) — the layout offsets content by these. */
export const SIDEBAR_WIDTH = { expanded: 232, collapsed: 60 } as const
