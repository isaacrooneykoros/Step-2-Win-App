import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Users, UserCheck, UserX,
  Edit2, Ban, Trash2, Eye, RotateCcw,
} from 'lucide-react'
import { StatCard }      from '../components/StatCard'
import { PageHeader }    from '../components/PageHeader'
import { AdminTable }    from '../components/AdminTable'
import { StatusBadge }   from '../components/StatusBadge'
import { ConfirmModal }  from '../components/ConfirmModal'
import { SlideOver }     from '../components/SlideOver'
import { DetailRow }     from '../components/DetailRow'
import api from '../services/api/client'
import { format } from 'date-fns'

interface User {
  id: number
  username: string
  email: string
  phone_number: string | null
  wallet_balance: number
  total_earned: number
  total_deposited: number
  total_steps: number
  challenges_joined: number
  challenges_won: number
  current_streak: number
  is_active: boolean
  is_banned: boolean
  is_staff: boolean
  date_joined: string
  last_login: string | null
}

interface UsersData {
  results: User[]
  total: number
}

interface UserStats {
  total: number
  active_today: number
  new_week: number
  banned: number
  growth_pct: number
  new_growth_pct: number
  active_spark: number[]
}

interface ActionBtnProps {
  icon: React.ElementType
  color: string
  title: string
  onClick: () => void
}

function toTypedPromise<T>(request: {
  then: (callback: (data: unknown) => unknown) => unknown
  catch: (callback: (error: Error) => unknown) => unknown
}): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.then((data: unknown) => resolve(data as T))
    request.catch((error: Error) => reject(error))
  })
}

export function UsersPage() {
  const qc = useQueryClient()

  // ── Table state ──────────────────────────────────────────────────────
  const [search,   setSearch]   = useState('')
  const [page,     setPage]     = useState(1)
  const [status,   setStatus]   = useState('all')
  const [role,     setRole]     = useState('all')
  const [sortKey,  setSortKey]  = useState('date_joined')
  const [sortDir,  setSortDir]  = useState<'asc'|'desc'>('desc')

  // ── Drawer + modal state ─────────────────────────────────────────────
  const [selected,    setSelected]    = useState<User | null>(null)
  const [drawerOpen,  setDrawerOpen]  = useState(false)
  const [confirmBan,  setConfirmBan]  = useState<User | null>(null)
  const [confirmDel,  setConfirmDel]  = useState<User | null>(null)

  // ── Data ─────────────────────────────────────────────────────────────
  const { data, isLoading } = useQuery<UsersData>({
    queryKey: ['admin', 'users', { search, page, status, role, sortKey, sortDir }],
    queryFn: (): Promise<UsersData> => toTypedPromise<UsersData>(api.get('/api/admin/users/', {
      params: { search, page, status, role, sort: sortKey, dir: sortDir }
    })),
  })

  const { data: stats } = useQuery<UserStats>({
    queryKey: ['admin', 'user-stats'],
    queryFn: (): Promise<UserStats> => toTypedPromise<UserStats>(api.get('/api/admin/users/stats/')),
  })

  const banMut = useMutation({
    mutationFn: (user: User) => api.post(`/api/admin/users/${user.id}/ban/`).then((r: unknown) => r && typeof r === 'object' && 'then' in r ? (r as Promise<unknown>).then((data: unknown) => data) : r),
    onSuccess:  () => { qc.invalidateQueries({ queryKey: ['admin', 'users'] }); setConfirmBan(null) },
  })

  const unbanMut = useMutation({
    mutationFn: (id: number) => api.post(`/api/admin/users/${id}/unban/`).then((r: unknown) => r && typeof r === 'object' && 'then' in r ? (r as Promise<unknown>).then((data: unknown) => data) : r),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['admin', 'users'] }),
  })

  const deleteMut = useMutation({
    mutationFn: (user: User) => api.delete(`/api/admin/users/${user.id}/`).then((r: unknown) => r && typeof r === 'object' && 'then' in r ? (r as Promise<unknown>).then((data: unknown) => data) : r),
    onSuccess:  () => { qc.invalidateQueries({ queryKey: ['admin', 'users'] }); setConfirmDel(null) },
  })

  const handleSort = (key: string) => {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir('desc') }
  }

  const openDrawer = (user: User) => { setSelected(user); setDrawerOpen(true) }

  // ── Table columns ────────────────────────────────────────────────────
  const columns = [
    {
      key: 'username', label: 'User', sortable: true,
      render: (u: User) => (
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-full flex items-center justify-center
                          text-xs font-bold text-white shrink-0"
            style={{ background: 'linear-gradient(135deg, #7C6FF7, #4F9CF9)' }}>
            {u.username?.slice(0, 2).toUpperCase()}
          </div>
          <div>
            <p className="text-ink-primary text-sm font-semibold">{u.username}</p>
            <p className="text-ink-muted text-xs">{u.email}</p>
          </div>
        </div>
      ),
    },
    {
      key: 'phone', label: 'Phone',
      render: (u: User) => (
        <span className="text-ink-secondary text-sm font-mono">{u.phone_number || '—'}</span>
      ),
    },
    {
      key: 'wallet_balance', label: 'Wallet', sortable: true,
      render: (u: User) => (
        <span className="text-ink-primary text-sm font-mono font-semibold">
          KSh {Number(u.wallet_balance ?? 0).toLocaleString()}
        </span>
      ),
    },
    {
      key: 'total_steps', label: 'Steps', sortable: true,
      render: (u: User) => (
        <span className="text-ink-secondary text-sm font-mono">
          {Number(u.total_steps ?? 0).toLocaleString()}
        </span>
      ),
    },
    {
      key: 'total_earned', label: 'Earned', sortable: true,
      render: (u: User) => (
        <span className="text-ink-secondary text-sm font-mono">
          KSh {Number(u.total_earned ?? 0).toLocaleString()}
        </span>
      ),
    },
    {
      key: 'role', label: 'Role',
      render: (u: User) => (
        <StatusBadge variant={u.is_staff ? 'admin' : 'user'} />
      ),
    },
    {
      key: 'status', label: 'Status',
      render: (u: User) => (
        <StatusBadge variant={u.is_active ? (u.is_banned ? 'banned' : 'active') : 'inactive'} />
      ),
    },
    {
      key: 'actions', label: 'Actions',
      render: (u: User) => (
        <div className="flex items-center gap-1">
          {/* View */}
          <ActionBtn icon={Eye} color="#4F9CF9" title="View details"
            onClick={() => openDrawer(u)} />
          {/* Edit */}
          <ActionBtn icon={Edit2} color="#7C6FF7" title="Edit user"
            onClick={() => openDrawer(u)} />
          {/* Reset steps */}
          <ActionBtn icon={RotateCcw} color="#F5A623" title="Reset steps"
            onClick={() => {}} />
          {/* Ban / Unban */}
          {u.is_banned
            ? <ActionBtn icon={RotateCcw} color="#22D3A0" title="Unban user"
                onClick={() => unbanMut.mutate(u.id)} />
            : <ActionBtn icon={Ban} color="#F06060" title="Ban user"
                onClick={() => setConfirmBan(u)} />
          }
          {/* Delete */}
          <ActionBtn icon={Trash2} color="#F06060" title="Delete user"
            onClick={() => setConfirmDel(u)} />
        </div>
      ),
    },
  ]

  return (
    <div className="space-y-6 fade-in">
      <PageHeader
        title="User Management"
        subtitle={`${data?.total ?? 0} total users`}
        actions={
          <div className="flex items-center gap-2">
            {/* Status filter */}
            <select
              value={status} onChange={e => { setStatus(e.target.value); setPage(1) }}
              className="px-3 py-2 rounded-xl text-xs text-ink-secondary outline-none"
              style={{ background: '#13161F', border: '1px solid #21263A' }}>
              <option value="all">All Status</option>
              <option value="active">Active</option>
              <option value="banned">Banned</option>
              <option value="inactive">Inactive</option>
            </select>
            {/* Role filter */}
            <select
              value={role} onChange={e => { setRole(e.target.value); setPage(1) }}
              className="px-3 py-2 rounded-xl text-xs text-ink-secondary outline-none"
              style={{ background: '#13161F', border: '1px solid #21263A' }}>
              <option value="all">All Roles</option>
              <option value="user">User</option>
              <option value="admin">Admin</option>
            </select>
          </div>
        }
      />

      {/* Stat cards */}
      <div className="grid grid-cols-4 gap-4">
        <StatCard title="Total Users"    value={stats?.total ?? 0}
          icon={Users}     color="purple"
          trend={stats?.growth_pct} trendLabel="vs last 7 days" />
        <StatCard title="Active Today"   value={stats?.active_today ?? 0}
          icon={UserCheck} color="teal"   sparkData={stats?.active_spark} />
        <StatCard title="New This Week"  value={stats?.new_week ?? 0}
          icon={Users}     color="blue"
          trend={stats?.new_growth_pct} />
        <StatCard title="Banned Users"   value={stats?.banned ?? 0}
          icon={UserX}     color="red" />
      </div>

      {/* Table */}
      <AdminTable
        title="All Users"
        subtitle="Manage platform users"
        columns={columns}
        data={data?.results ?? []}
        isLoading={isLoading}
        rowKey={(u: User) => u.id}
        onRowClick={openDrawer}
        searchValue={search}
        onSearchChange={v => { setSearch(v); setPage(1) }}
        searchPlaceholder="Search by username or email..."
        sortKey={sortKey} sortDir={sortDir} onSort={handleSort}
        pagination={{ page, total: data?.total ?? 0, pageSize: 20, onPage: setPage }}
      />

      {/* User detail drawer */}
      <SlideOver
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title={selected?.username ?? 'User Details'}
        subtitle={selected?.email}>
        {selected && (
          <div>
            {/* Avatar + name */}
            <div className="flex items-center gap-4 mb-6 pb-6"
              style={{ borderBottom: '1px solid #21263A' }}>
              <div className="w-16 h-16 rounded-2xl flex items-center justify-center
                              text-xl font-bold text-white"
                style={{ background: 'linear-gradient(135deg, #7C6FF7, #4F9CF9)' }}>
                {selected.username?.slice(0, 2).toUpperCase()}
              </div>
              <div>
                <p className="text-ink-primary text-lg font-bold">{selected.username}</p>
                <p className="text-ink-muted text-sm">{selected.email}</p>
                <div className="flex items-center gap-2 mt-1.5">
                  <StatusBadge variant={selected.is_banned ? 'banned' : 'active'} />
                  <StatusBadge variant={selected.is_staff ? 'admin' : 'user'} />
                </div>
              </div>
            </div>

            {/* Details */}
            <h4 className="text-ink-muted text-xs font-semibold uppercase tracking-wider mb-3">
              Account Info
            </h4>
            <DetailRow label="User ID"       value={selected.id} mono />
            <DetailRow label="Phone"         value={selected.phone_number || '—'} mono />
            <DetailRow label="Joined"
              value={selected.date_joined
                ? format(new Date(selected.date_joined), 'MMM d, yyyy')
                : '—'} />
            <DetailRow label="Last Login"
              value={selected.last_login
                ? format(new Date(selected.last_login), 'MMM d, yyyy HH:mm')
                : 'Never'} />

            <h4 className="text-ink-muted text-xs font-semibold uppercase tracking-wider
                           mb-3 mt-5">
              Financial
            </h4>
            <DetailRow label="Wallet Balance"
              value={`KSh ${Number(selected.wallet_balance ?? 0).toLocaleString()}`} mono />
            <DetailRow label="Total Earned"
              value={`KSh ${Number(selected.total_earned ?? 0).toLocaleString()}`} mono />
            <DetailRow label="Total Deposited"
              value={`KSh ${Number(selected.total_deposited ?? 0).toLocaleString()}`} mono />

            <h4 className="text-ink-muted text-xs font-semibold uppercase tracking-wider
                           mb-3 mt-5">
              Activity
            </h4>
            <DetailRow label="Total Steps"
              value={Number(selected.total_steps ?? 0).toLocaleString()} mono />
            <DetailRow label="Challenges Joined" value={selected.challenges_joined ?? 0} />
            <DetailRow label="Challenges Won"    value={selected.challenges_won ?? 0} />
            <DetailRow label="Current Streak"    value={`${selected.current_streak ?? 0} days`} />

            {/* Actions */}
            <div className="mt-6 space-y-2">
              {selected.is_banned ? (
                <button
                  onClick={() => { unbanMut.mutate(selected.id); setDrawerOpen(false) }}
                  className="w-full py-2.5 rounded-xl text-sm font-semibold
                             text-white transition-colors"
                  style={{ background: '#22D3A0' }}>
                  Unban User
                </button>
              ) : (
                <button
                  onClick={() => { setConfirmBan(selected); setDrawerOpen(false) }}
                  className="w-full py-2.5 rounded-xl text-sm font-semibold
                             transition-colors"
                  style={{ background: 'rgba(240,96,96,0.1)',
                           color: '#F06060', border: '1px solid rgba(240,96,96,0.2)' }}>
                  Ban User
                </button>
              )}
            </div>
          </div>
        )}
      </SlideOver>

      {/* Ban confirm */}
      <ConfirmModal
        open={!!confirmBan} onClose={() => setConfirmBan(null)}
        onConfirm={() => { if (confirmBan) banMut.mutate(confirmBan) }}
        loading={banMut.isPending}
        title="Ban User"
        message={`Are you sure you want to ban "${confirmBan?.username}"? They will lose access to all challenges and cannot deposit or withdraw.`}
        confirmLabel="Ban User" variant="danger" />

      {/* Delete confirm */}
      <ConfirmModal
        open={!!confirmDel} onClose={() => setConfirmDel(null)}
        onConfirm={() => { if (confirmDel) deleteMut.mutate(confirmDel) }}
        loading={deleteMut.isPending}
        title="Delete User"
        message={`Permanently delete "${confirmDel?.username}"? This cannot be undone. Their wallet balance will be refunded first.`}
        confirmLabel="Delete Permanently" variant="danger" />
    </div>
  )
}

// Reusable icon action button
function ActionBtn({ icon: Icon, color, title, onClick }: ActionBtnProps) {
  return (
    <button
      title={title} onClick={e => { e.stopPropagation(); onClick() }}
      className="w-7 h-7 rounded-lg flex items-center justify-center
                 transition-all duration-150"
      style={{ color }}
      onMouseEnter={e => (e.currentTarget.style.background = `${color}18`)}
      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
      <Icon size={13} />
    </button>
  )
}
