/**
 * Staff roles in the console. The server enforces every permission (403); this only
 * hides what the signed-in staff member cannot use. Permission names match
 * backend/apps/admin_api/roles.py.
 */
import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { API_BASE } from '../config/network'
import { refreshAccessToken, useAuthStore } from '../store/authStore'
import { NAV_GROUPS, type NavGroup } from './nav'

export type StaffPermission =
  | 'console.view' | 'users.edit' | 'users.ban' | 'users.export' | 'users.devices' | 'users.xp'
  | 'steps.correct' | 'finance.view' | 'finance.withdrawals' | 'finance.deposits' | 'finance.adjust'
  | 'finance.approve_adjustment' | 'finance.payout_review' | 'support.view' | 'support.reply'
  | 'trust.view' | 'trust.act' | 'challenges.manage' | 'challenges.platform' | 'challenges.disqualify'
  | 'content.badges' | 'content.legal' | 'content.announcements' | 'settings.system'
  | 'owner.staff' | 'owner.delete_users' | 'owner.finance_controls' | 'owner.anticheat_policy' | 'owner.risk_models'

export interface MyPermissions {
  user_id: number
  username: string
  is_owner: boolean
  is_superuser: boolean
  roles: string[]
  legacy_roles: boolean
  permissions: StaffPermission[]
}

/** Permission a route needs to appear in the sidebar / command palette. */
export const ROUTE_PERMS: Record<string, StaffPermission> = {
  '/transactions': 'finance.view',
  '/deposits': 'finance.view',
  '/withdrawals': 'finance.view',
  '/payout-reviews': 'finance.view',
  '/fraud': 'trust.view',
  '/moderation': 'trust.view',
  '/social': 'trust.view',
  '/support': 'support.view',
  '/staff': 'owner.staff',
}

async function fetchMine(retried = false): Promise<MyPermissions> {
  const token = useAuthStore.getState().accessToken
  const res = await fetch(`${API_BASE}/api/admin/me/permissions/`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (res.status === 401 && !retried && (await refreshAccessToken())) return fetchMine(true)
  if (!res.ok) throw new Error(`Could not load your permissions (${res.status})`)
  return res.json() as Promise<MyPermissions>
}

export function usePermissions() {
  const token = useAuthStore((s) => s.accessToken)
  const q = useQuery({ queryKey: ['admin', 'me-permissions'], queryFn: () => fetchMine(), enabled: !!token, staleTime: 60_000 })
  const set = useMemo(() => new Set(q.data?.permissions ?? []), [q.data])
  return {
    data: q.data,
    loading: q.isLoading,
    isOwner: Boolean(q.data?.is_owner),
    /** True while loading, so nothing flickers away; the server still refuses. */
    can: (perm: StaffPermission) => (q.data ? q.data.is_owner || set.has(perm) : false),
  }
}

/** Navigation groups the signed-in staff member may open. */
export function useVisibleNavGroups(): NavGroup[] {
  const { can, data } = usePermissions()
  return useMemo(
    () =>
      NAV_GROUPS.map((g) => ({
        ...g,
        items: g.items.filter((i) => !ROUTE_PERMS[i.to] || (data ? can(ROUTE_PERMS[i.to]) : i.to !== '/staff')),
      })).filter((g) => g.items.length > 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data],
  )
}
