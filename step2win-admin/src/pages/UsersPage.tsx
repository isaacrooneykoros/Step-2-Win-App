import { useEffect, useRef, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
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
import { API_BASE } from '../config/network'
import { useAuthStore } from '../store/authStore'
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

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

function isValidPhone(phone: string | null): boolean {
  if (!phone) return false
  return /^[\d+\-() ]{7,20}$/.test(phone)
}

function getProfileIssues(user: User): string[] {
  const issues: string[] = []

  if (!user.email) {
    issues.push('Missing email')
  } else if (!isValidEmail(user.email)) {
    issues.push('Invalid email format')
  }

  if (!user.phone_number) {
    issues.push('Missing phone number')
  } else if (!isValidPhone(user.phone_number)) {
    issues.push('Invalid phone format')
  }

  return issues
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

interface LiveStepUpdate {
  user_id: number
  username: string
  date: string
  synced_at: string
  steps: number
  approved_steps: number
  submitted_steps: number
  source?: string | null
  distance_km?: number | null
  calories_active?: number | null
  active_minutes?: number | null
  is_suspicious: boolean
  trust_score: number
  trust_status: string
  flags_raised: number
}

interface UserEditDraft {
  username: string
  email: string
  phone_number: string
}

interface ActionBtnProps {
  icon: React.ElementType
  color: string
  title: string
  onClick: () => void
}

export function UsersPage() {
  const qc = useQueryClient()
  const accessToken = useAuthStore((state) => state.accessToken)
  const wsRef = useRef<WebSocket | null>(null)
  const [searchParams, setSearchParams] = useSearchParams()

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
  const [confirmReset, setConfirmReset] = useState<User | null>(null)
  const [isEditing, setIsEditing] = useState(false)
  const [editError, setEditError] = useState('')
  const [editDraft, setEditDraft] = useState<UserEditDraft>({ username: '', email: '', phone_number: '' })
  const [liveConnected, setLiveConnected] = useState(false)
  const [liveUpdate, setLiveUpdate] = useState<LiveStepUpdate | null>(null)

  // ── Data ─────────────────────────────────────────────────────────────
  const { data, isLoading } = useQuery<UsersData>({
    queryKey: ['admin', 'users', { search, page, status, role, sortKey, sortDir }],
    queryFn: async (): Promise<UsersData> => {
      const response = await api.get<UsersData>('/api/admin/users/', {
        params: { search, page, status, role, sort: sortKey, dir: sortDir }
      })
      return response.data
    },
  })

  const { data: stats } = useQuery<UserStats>({
    queryKey: ['admin', 'user-stats'],
    queryFn: async (): Promise<UserStats> => {
      const response = await api.get<UserStats>('/api/admin/users/stats/')
      return response.data
    },
  })

  const banMut = useMutation({
    mutationFn: async (user: User) => {
      const response = await api.post(`/api/admin/users/${user.id}/ban/`)
      return response.data
    },
    onSuccess:  () => { qc.invalidateQueries({ queryKey: ['admin', 'users'] }); setConfirmBan(null) },
  })

  const unbanMut = useMutation({
    mutationFn: async (id: number) => {
      const response = await api.post(`/api/admin/users/${id}/unban/`)
      return response.data
    },
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['admin', 'users'] }),
  })

  const deleteMut = useMutation({
    mutationFn: async (user: User) => {
      const response = await api.delete(`/api/admin/users/${user.id}/`)
      return response.data
    },
    onSuccess:  () => { qc.invalidateQueries({ queryKey: ['admin', 'users'] }); setConfirmDel(null) },
  })

  const saveMut = useMutation({
    mutationFn: async () => {
      if (!selected) {
        throw new Error('No user selected')
      }

      const payload = {
        username: editDraft.username.trim(),
        email: editDraft.email.trim(),
        phone_number: editDraft.phone_number.trim(),
      }

      const response = await api.patch<User>(`/api/admin/users/${selected.id}/update_user/`, payload)
      return response.data
    },
    onSuccess: (updatedUser) => {
      qc.invalidateQueries({ queryKey: ['admin', 'users'] })
      setSelected(updatedUser)
      setIsEditing(false)
      setEditError('')
    },
    onError: (err) => {
      setEditError(err instanceof Error ? err.message : 'Failed to save user changes.')
    },
  })

  const resetStepsMut = useMutation({
    mutationFn: async (user: User) => {
      const response = await api.post<{ status: string; user: User }>(`/api/admin/users/${user.id}/reset_steps/`)
      return response.data
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['admin', 'users'] })
      if (selected && data.user.id === selected.id) {
        setSelected((current) => (current ? { ...current, total_steps: data.user.total_steps } : current))
      }
      setConfirmReset(null)
    },
  })

  const handleSort = (key: string) => {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir('desc') }
  }

  const openDrawer = (user: User, editing = false) => {
    setSelected(user)
    setEditDraft({
      username: user.username,
      email: user.email,
      phone_number: user.phone_number || '',
    })
    setIsEditing(editing)
    setEditError('')
    setDrawerOpen(true)
  }
  const selectedLiveSnapshot = selected && liveUpdate?.user_id === selected.id ? liveUpdate : null

  useEffect(() => {
    if (!selected) {
      setIsEditing(false)
      setEditError('')
      return
    }

    if (!isEditing) {
      setEditDraft({
        username: selected.username,
        email: selected.email,
        phone_number: selected.phone_number || '',
      })
    }
  }, [isEditing, selected])

  useEffect(() => {
    if (!accessToken) {
      setLiveConnected(false)
      return
    }

    const wsBase = API_BASE.replace(/^http/, 'ws').replace(/\/$/, '')
    const socket = new WebSocket(`${wsBase}/ws/admin/steps/live/?token=${encodeURIComponent(accessToken)}`)
    wsRef.current = socket

    socket.onopen = () => {
      setLiveConnected(true)
    }

    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data)
        if (message.type !== 'admin.steps.update' || !message.payload) {
          return
        }

        const payload = message.payload as LiveStepUpdate
        setLiveUpdate(payload)

        qc.setQueriesData<UsersData>({ queryKey: ['admin', 'users'] }, (current) => {
          if (!current?.results) {
            return current
          }

          return {
            ...current,
            results: current.results.map((user) => (
              user.id === payload.user_id
                ? { ...user, total_steps: payload.steps ?? payload.approved_steps ?? user.total_steps }
                : user
            )),
          }
        })

        setSelected((current) => {
          if (!current || current.id !== payload.user_id) {
            return current
          }

          return {
            ...current,
            total_steps: payload.steps ?? payload.approved_steps ?? current.total_steps,
          }
        })
      } catch {
        // Ignore malformed websocket payloads.
      }
    }

    socket.onerror = () => {
      setLiveConnected(false)
    }

    socket.onclose = () => {
      setLiveConnected(false)
    }

    return () => {
      socket.close()
      wsRef.current = null
    }
  }, [accessToken, qc])

  useEffect(() => {
    const openUserId = Number(searchParams.get('openUserId'))
    if (!Number.isFinite(openUserId) || openUserId <= 0) {
      return
    }

    const target = data?.results?.find((user) => user.id === openUserId)
    if (!target) {
      return
    }

    openDrawer(target)
    setSearchParams((current) => {
      const next = new URLSearchParams(current)
      next.delete('openUserId')
      return next
    }, { replace: true })
  }, [data?.results, searchParams, setSearchParams])

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
      key: 'verification', label: 'Details Check',
      render: (u: User) => {
        const issues = getProfileIssues(u)
        const isValid = issues.length === 0

        return (
          <span
            className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold"
            style={{
              background: isValid ? 'rgba(34,211,160,0.14)' : 'rgba(245,166,35,0.16)',
              color: isValid ? '#22D3A0' : '#F5A623',
              border: `1px solid ${isValid ? 'rgba(34,211,160,0.24)' : 'rgba(245,166,35,0.26)'}`,
            }}>
            {isValid ? 'Verified' : `${issues.length} issue${issues.length > 1 ? 's' : ''}`}
          </span>
        )
      },
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
            onClick={() => openDrawer(u, true)} />
          {/* Reset steps */}
          <ActionBtn icon={RotateCcw} color="#F5A623" title="Reset steps"
            onClick={() => setConfirmReset(u)} />
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
            <span
              className="inline-flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-semibold"
              style={{
                background: liveConnected ? 'rgba(34,211,160,0.12)' : 'rgba(148,163,184,0.12)',
                color: liveConnected ? '#22D3A0' : '#94A3B8',
                border: `1px solid ${liveConnected ? 'rgba(34,211,160,0.24)' : 'rgba(148,163,184,0.24)'}`,
              }}>
              <span className="w-2 h-2 rounded-full" style={{ background: liveConnected ? '#22D3A0' : '#94A3B8' }} />
              {liveConnected ? 'Live step feed' : 'Live feed offline'}
            </span>
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
        onClose={() => { setDrawerOpen(false); setIsEditing(false); setEditError('') }}
        title={isEditing ? `Edit ${selected?.username ?? 'User'}` : (selected?.username ?? 'User Details')}
        subtitle={selected?.email}>
        {selected && (
          <div>
            {isEditing && (
              <div className="mb-5 p-4 rounded-xl" style={{ background: 'rgba(124,111,247,0.08)', border: '1px solid rgba(124,111,247,0.22)' }}>
                <p className="text-sm font-semibold" style={{ color: '#7C6FF7' }}>Editing user profile</p>
                <p className="text-xs text-ink-muted mt-1">Update username, email, or phone number. The change saves to the admin API.</p>
                {editError && (
                  <p className="text-xs mt-2" style={{ color: '#F06060' }}>{editError}</p>
                )}
                <div className="space-y-3 mt-4">
                  <label className="block">
                    <span className="text-xs font-semibold uppercase tracking-wider text-ink-muted">Username</span>
                    <input
                      value={editDraft.username}
                      onChange={(e) => setEditDraft((current) => ({ ...current, username: e.target.value }))}
                      className="mt-1 w-full px-3 py-2 rounded-xl text-sm outline-none"
                      style={{ background: '#13161F', border: '1px solid #21263A', color: '#F0F2F8' }}
                    />
                  </label>
                  <label className="block">
                    <span className="text-xs font-semibold uppercase tracking-wider text-ink-muted">Email</span>
                    <input
                      type="email"
                      value={editDraft.email}
                      onChange={(e) => setEditDraft((current) => ({ ...current, email: e.target.value }))}
                      className="mt-1 w-full px-3 py-2 rounded-xl text-sm outline-none"
                      style={{ background: '#13161F', border: '1px solid #21263A', color: '#F0F2F8' }}
                    />
                  </label>
                  <label className="block">
                    <span className="text-xs font-semibold uppercase tracking-wider text-ink-muted">Phone Number</span>
                    <input
                      value={editDraft.phone_number}
                      onChange={(e) => setEditDraft((current) => ({ ...current, phone_number: e.target.value }))}
                      className="mt-1 w-full px-3 py-2 rounded-xl text-sm outline-none"
                      style={{ background: '#13161F', border: '1px solid #21263A', color: '#F0F2F8' }}
                    />
                  </label>
                </div>
                <div className="flex items-center gap-2 mt-4">
                  <button
                    onClick={() => saveMut.mutate()}
                    disabled={saveMut.isPending}
                    className="px-4 py-2 rounded-xl text-sm font-semibold text-white"
                    style={{ background: '#7C6FF7' }}>
                    {saveMut.isPending ? 'Saving...' : 'Save changes'}
                  </button>
                  <button
                    onClick={() => {
                      setIsEditing(false)
                      setEditError('')
                      if (selected) {
                        setEditDraft({
                          username: selected.username,
                          email: selected.email,
                          phone_number: selected.phone_number || '',
                        })
                      }
                    }}
                    className="px-4 py-2 rounded-xl text-sm font-semibold"
                    style={{ background: 'rgba(255,255,255,0.04)', color: '#F0F2F8' }}>
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {(() => {
              const issues = getProfileIssues(selected)
              const isValid = issues.length === 0

              return (
                <div
                  className="mb-5 p-4 rounded-xl"
                  style={{
                    background: isValid ? 'rgba(34,211,160,0.08)' : 'rgba(245,166,35,0.12)',
                    border: `1px solid ${isValid ? 'rgba(34,211,160,0.22)' : 'rgba(245,166,35,0.25)'}`,
                  }}>
                  <p
                    className="text-sm font-semibold"
                    style={{ color: isValid ? '#22D3A0' : '#F5A623' }}>
                    {isValid ? 'User details look correct' : 'User details need review'}
                  </p>
                  <p className="text-xs text-ink-muted mt-1">
                    {isValid
                      ? 'Email and phone number are present and properly formatted.'
                      : 'Check and correct the fields below to avoid payout and notification issues.'}
                  </p>
                  {!isValid && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {issues.map((issue) => (
                        <span
                          key={issue}
                          className="px-2 py-1 rounded-lg text-[11px] font-semibold"
                          style={{ background: 'rgba(245,166,35,0.16)', color: '#F5A623' }}>
                          {issue}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )
            })()}

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

            <h4 className="text-ink-muted text-xs font-semibold uppercase tracking-wider mb-3 mt-5">
              Live Steps
            </h4>
            {selectedLiveSnapshot ? (
              <div
                className="rounded-xl p-4 mb-2"
                style={{ background: 'rgba(79,156,249,0.08)', border: '1px solid rgba(79,156,249,0.18)' }}>
                <p className="text-2xl font-black text-ink-primary">
                  {Number(selectedLiveSnapshot.steps ?? 0).toLocaleString()}
                </p>
                <p className="text-xs text-ink-muted mt-1">
                  Synced {selectedLiveSnapshot.synced_at ? format(new Date(selectedLiveSnapshot.synced_at), 'HH:mm:ss') : 'just now'}
                </p>
                <div className="grid grid-cols-2 gap-2 mt-3 text-xs">
                  <div className="rounded-lg p-2" style={{ background: 'rgba(255,255,255,0.04)' }}>
                    <p className="text-ink-muted">Submitted</p>
                    <p className="text-ink-primary font-semibold">{Number(selectedLiveSnapshot.submitted_steps ?? 0).toLocaleString()}</p>
                  </div>
                  <div className="rounded-lg p-2" style={{ background: 'rgba(255,255,255,0.04)' }}>
                    <p className="text-ink-muted">Trust</p>
                    <p className="text-ink-primary font-semibold">{selectedLiveSnapshot.trust_status}</p>
                  </div>
                  <div className="rounded-lg p-2" style={{ background: 'rgba(255,255,255,0.04)' }}>
                    <p className="text-ink-muted">Flags</p>
                    <p className="text-ink-primary font-semibold">{selectedLiveSnapshot.flags_raised}</p>
                  </div>
                  <div className="rounded-lg p-2" style={{ background: 'rgba(255,255,255,0.04)' }}>
                    <p className="text-ink-muted">Suspicious</p>
                    <p className="text-ink-primary font-semibold">{selectedLiveSnapshot.is_suspicious ? 'Yes' : 'No'}</p>
                  </div>
                </div>
              </div>
            ) : (
              <div className="rounded-xl p-4 mb-2" style={{ background: 'rgba(148,163,184,0.08)', border: '1px solid rgba(148,163,184,0.16)' }}>
                <p className="text-sm text-ink-primary font-semibold">Waiting for the next sync</p>
                <p className="text-xs text-ink-muted mt-1">Open this user’s device and trigger a step sync to see live updates here.</p>
              </div>
            )}

            {/* Actions */}
            <div className="mt-6 space-y-2">
              <button
                onClick={() => setIsEditing((value) => !value)}
                className="w-full py-2.5 rounded-xl text-sm font-semibold"
                style={{ background: 'rgba(124,111,247,0.12)', color: '#7C6FF7', border: '1px solid rgba(124,111,247,0.22)' }}>
                {isEditing ? 'Close editor' : 'Edit details'}
              </button>
              <button
                onClick={() => setConfirmReset(selected)}
                className="w-full py-2.5 rounded-xl text-sm font-semibold"
                style={{ background: 'rgba(245,166,35,0.12)', color: '#F5A623', border: '1px solid rgba(245,166,35,0.22)' }}>
                Reset steps
              </button>
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

      {/* Reset steps confirm */}
      <ConfirmModal
        open={!!confirmReset} onClose={() => setConfirmReset(null)}
        onConfirm={() => { if (confirmReset) resetStepsMut.mutate(confirmReset) }}
        loading={resetStepsMut.isPending}
        title="Reset Step Counters"
        message={`Reset lifetime step counters for "${confirmReset?.username}"? This clears total steps and best day steps, but keeps the account and step history records.`}
        confirmLabel="Reset Steps" variant="warning" />
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
