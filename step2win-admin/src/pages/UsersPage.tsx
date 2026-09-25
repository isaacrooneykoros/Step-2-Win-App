import { useLiveRefetchInterval } from '../lib/realtime/useAdminRealtime'
import { useIsFlashing } from '../lib/realtime/store'
import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Ban, RefreshCw, ShieldAlert, ShieldCheck, UserPlus, Users, UserX } from 'lucide-react'
import { PageHeader } from '../components/PageHeader'
import { StatCard } from '../components/StatCard'
import { StatusBadge } from '../components/StatusBadge'
import { AdminTable, type Column } from '../components/AdminTable'
import { Button } from '../components/ui/Button'
import { SearchInput, Select } from '../components/ui/Input'
import { SegmentedControl } from '../components/ui/Tabs'
import { FilterChip, Toolbar } from '../components/ui/Toolbar'
import { ErrorState } from '../components/ui/ErrorState'
import { EmptyState } from '../components/ui/EmptyState'
import { formatKES, formatNumber } from '../lib/format'
import { consoleApi } from '../components/users/api'
import type { ConsoleUser } from '../components/users/types'
import { Timestamp, TrustMeter, UserCell } from '../components/users/shared'
import { useDebounced } from '../components/users/utils'
import { UserDrawer } from '../components/users/UserDrawer'

type StatusFilter = 'all' | 'active' | 'banned' | 'deleted' | 'staff'
const STATUS_ITEMS = [
  { value: 'all' as const, label: 'All' },
  { value: 'active' as const, label: 'Active' },
  { value: 'banned' as const, label: 'Banned' },
  { value: 'deleted' as const, label: 'Deleted' },
  { value: 'staff' as const, label: 'Staff' },
]
const TRUST_OPTIONS = [
  { value: '', label: 'Any trust level' },
  { value: 'flagged', label: 'Has open flags' },
  { value: 'good', label: 'Good (81–100)' },
  { value: 'warn', label: 'Warn (61–80)' },
  { value: 'review', label: 'Review (41–60)' },
  { value: 'restrict', label: 'Restricted (21–40)' },
  { value: 'suspend', label: 'Suspended (1–20)' },
  { value: 'ban', label: 'Trust banned (0)' },
]
const PAGE_SIZE = 25
/** Column key -> server ordering field. */
const SORT_FIELD: Record<string, string> = {
  user: 'username',
  trust: 'trust_value',
  balance: 'wallet_balance',
  locked: 'locked_balance',
  steps: 'total_steps',
  joined: 'date_joined',
  seen: 'last_seen_at',
}

export function UsersPage() {
  const [params, setParams] = useSearchParams()
  const [search, setSearch] = useState(params.get('q') ?? '')
  const [status, setStatus] = useState<StatusFilter>((params.get('status') as StatusFilter) || 'all')
  const [trust, setTrust] = useState(params.get('trust') ?? '')
  const [page, setPage] = useState(1)
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' }>({ key: 'joined', dir: 'desc' })
  const q = useDebounced(search.trim(), 300)
  const selectedId = params.get('user') ? Number(params.get('user')) : null

  const ordering = `${sort.dir === 'desc' ? '-' : ''}${SORT_FIELD[sort.key] ?? 'date_joined'}`
  const refetchInterval = useLiveRefetchInterval(30_000)
  const isFlashing = useIsFlashing('user')
  const listQ = useQuery({
    refetchInterval,
    queryKey: ['admin', 'users', { q, status, trust, page, ordering }],
    queryFn: () =>
      consoleApi.listUsers({ page, page_size: PAGE_SIZE, search: q, status: status === 'all' ? undefined : status, trust: trust || undefined, ordering }),
    placeholderData: keepPreviousData,
  })
  const statsQ = useQuery({ queryKey: ['admin', 'user-stats'], queryFn: consoleApi.userStats, refetchInterval })
  const s = statsQ.data

  const setFilter = (next: { status?: StatusFilter; trust?: string }) => {
    if (next.status !== undefined) setStatus(next.status)
    if (next.trust !== undefined) setTrust(next.trust)
    setPage(1)
  }
  const openUser = (id: number | null) => {
    const p = new URLSearchParams(params)
    if (id === null) p.delete('user')
    else p.set('user', String(id))
    setParams(p, { replace: true })
  }
  const onSort = (key: string) => {
    setSort((cur) => (cur.key === key ? { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'user' ? 'asc' : 'desc' }))
    setPage(1)
  }

  const columns: Column<ConsoleUser>[] = [
    {
      key: 'user', label: 'User', sortable: true, width: '26%',
      render: (u) => <UserCell username={u.username} secondary={u.email || u.phone_number} />,
    },
    {
      key: 'status', label: 'Status',
      render: (u) => (
        <span className="flex flex-wrap items-center gap-1">
          <StatusBadge size="sm" status={u.is_deleted ? 'deleted' : u.is_active ? 'active' : 'banned'} />
          {u.is_staff && <StatusBadge size="sm" status="staff" />}
        </span>
      ),
    },
    {
      key: 'trust', label: 'Trust', sortable: true,
      render: (u) => (
        <span className="flex items-center gap-2">
          <TrustMeter score={u.trust_score} status={u.trust_status} compact />
          {u.open_flags > 0 && (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-warning" title={`${u.open_flags} open anti-cheat flag(s)`}>
              <ShieldAlert size={12} aria-hidden />
              {u.open_flags}
              <span className="sr-only">open flags</span>
            </span>
          )}
        </span>
      ),
    },
    {
      key: 'balance', label: 'Available', sortable: true, numeric: true,
      render: (u) => <span className="mono text-[13px]">{formatKES(u.available_balance)}</span>,
    },
    {
      key: 'locked', label: 'Locked', sortable: true, numeric: true, hideBelow: 'lg',
      render: (u) =>
        Number(u.locked_balance) > 0 ? <span className="mono text-[13px]">{formatKES(u.locked_balance)}</span> : <span className="text-ink-muted">—</span>,
    },
    {
      key: 'steps', label: 'Lifetime steps', sortable: true, numeric: true, hideBelow: 'xl',
      render: (u) => formatNumber(u.total_steps),
    },
    {
      key: 'joined', label: 'Joined', sortable: true, hideBelow: 'md',
      render: (u) => <Timestamp value={u.date_joined} className="text-ink-secondary" />,
    },
    {
      key: 'seen', label: 'Last active', sortable: true, hideBelow: 'sm',
      render: (u) => <Timestamp value={u.last_seen_at ?? u.last_login} className="text-ink-secondary" />,
    },
  ]

  const chips = [
    q && { key: 'q', label: `Search: ${q}`, clear: () => setSearch('') },
    status !== 'all' && { key: 'status', label: `Status: ${STATUS_ITEMS.find((x) => x.value === status)?.label}`, clear: () => setFilter({ status: 'all' }) },
    trust && { key: 'trust', label: `Trust: ${TRUST_OPTIONS.find((x) => x.value === trust)?.label}`, clear: () => setFilter({ trust: '' }) },
  ].filter(Boolean) as Array<{ key: string; label: string; clear: () => void }>

  const data = listQ.data
  const refreshing = listQ.isFetching || statsQ.isFetching

  return (
    <div className="space-y-5">
      <PageHeader
        title="Users"
        description="Find an account, check its money and trust, and act on it. Every action is written to the audit log."
        actions={
          <Button size="sm" variant="secondary" leftIcon={<RefreshCw size={13} />} loading={refreshing}
            onClick={() => { void listQ.refetch(); void statsQ.refetch() }}>
            Refresh
          </Button>
        }
      />

      {statsQ.error && !s ? (
        <ErrorState variant="inline" title="Could not load user totals" error={statsQ.error} onRetry={() => void statsQ.refetch()} />
      ) : (
        <section aria-label="User totals" className="grid grid-cols-2 gap-3 md:grid-cols-3 min-[87.5rem]:grid-cols-6">
          <StatCard label="Total users" icon={Users} loading={statsQ.isLoading} value={formatNumber(s?.total_users)}
            hint={s ? `${formatNumber(s.staff_users)} staff` : undefined} onClick={() => setFilter({ status: 'all', trust: '' })} />
          <StatCard label="Active" icon={ShieldCheck} loading={statsQ.isLoading} value={formatNumber(s?.active_users)}
            hint="Can sign in" onClick={() => setFilter({ status: 'active' })} />
          <StatCard label="New · 7 days" icon={UserPlus} loading={statsQ.isLoading} value={formatNumber(s?.new_users_7d)}
            hint={s ? `${formatNumber(s.new_users_24h)} in the last 24h` : undefined}
            onClick={() => { setSort({ key: 'joined', dir: 'desc' }); setFilter({ status: 'all', trust: '' }) }} />
          <StatCard label="With open flags" icon={ShieldAlert} loading={statsQ.isLoading} value={formatNumber(s?.flagged_users)}
            tone={s?.flagged_users ? 'warning' : 'default'} hint="Anti-cheat review pending" onClick={() => setFilter({ trust: 'flagged' })} />
          <StatCard label="Low trust" icon={UserX} loading={statsQ.isLoading} value={formatNumber(s?.low_trust_users)}
            tone={s?.low_trust_users ? 'danger' : 'default'} hint="Trust score 40 or below" onClick={() => setFilter({ trust: 'restrict' })} />
          <StatCard label="Banned" icon={Ban} loading={statsQ.isLoading} value={formatNumber(s?.banned_users)}
            hint="Deactivated accounts" onClick={() => setFilter({ status: 'banned' })} />
        </section>
      )}

      <AdminTable
        columns={columns}
        data={data?.results ?? []}
        rowKey={(u) => u.id}
        isLoading={listQ.isLoading}
        error={listQ.error && !data ? listQ.error : undefined}
        onRetry={() => void listQ.refetch()}
        onRowClick={(u) => openUser(u.id)}
        isRowActive={(u) => u.id === selectedId}
        isRowFlashing={(u) => isFlashing(u.id)}
        sortKey={sort.key}
        sortDir={sort.dir}
        onSort={onSort}
        skeletonRows={10}
        toolbar={
          <div className="space-y-2">
            <Toolbar
              actions={
                <span className="num text-xs text-ink-muted" aria-live="polite">
                  {data ? `${formatNumber(data.count)} ${data.count === 1 ? 'user' : 'users'}` : ''}
                </span>
              }
            >
              <SearchInput size="sm" value={search} onChange={(v) => { setSearch(v); setPage(1) }}
                placeholder="Search username, email, phone or ID" containerClassName="sm:w-72" />
              <SegmentedControl label="Account status" items={STATUS_ITEMS} value={status} onChange={(v) => setFilter({ status: v })} />
              <Select size="sm" aria-label="Trust level" value={trust} onChange={(e) => setFilter({ trust: e.target.value })} containerClassName="w-48">
                {TRUST_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </Select>
            </Toolbar>
            {chips.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                {chips.map((c) => <FilterChip key={c.key} label={c.label} onRemove={c.clear} />)}
                <button type="button" className="px-1 text-xs font-medium text-brand-text hover:underline"
                  onClick={() => { setSearch(''); setFilter({ status: 'all', trust: '' }) }}>
                  Clear all
                </button>
              </div>
            )}
          </div>
        }
        emptyState={
          <EmptyState size="compact" icon={Users}
            title={chips.length ? 'No users match these filters' : 'No users yet'}
            description={chips.length ? 'Try a shorter search or remove a filter.' : 'Accounts appear here as people sign up.'} />
        }
        pagination={data ? { page, total: data.count, pageSize: PAGE_SIZE, onPage: setPage, itemLabel: 'users' } : undefined}
      />

      <UserDrawer userId={selectedId} onClose={() => openUser(null)} />
    </div>
  )
}
