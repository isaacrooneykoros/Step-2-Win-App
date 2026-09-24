import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Ban, CheckCircle2, Clock, Coins, Lock, RefreshCw, Star, Trophy, Users } from 'lucide-react'
import { PageHeader } from '../components/PageHeader'
import { StatCard } from '../components/StatCard'
import { StatusBadge } from '../components/StatusBadge'
import { AdminTable, type Column } from '../components/AdminTable'
import { Panel } from '../components/ui/Card'
import { Button } from '../components/ui/Button'
import { SearchInput } from '../components/ui/Input'
import { Tabs } from '../components/ui/Tabs'
import { Toolbar } from '../components/ui/Toolbar'
import { ErrorState } from '../components/ui/ErrorState'
import { EmptyState } from '../components/ui/EmptyState'
import { Skeleton } from '../components/ui/Skeleton'
import { formatKES, formatKESShort, formatNumber } from '../lib/format'
import { consoleApi } from '../components/users/api'
import type { ChallengeRow } from '../components/users/types'
import { Timestamp } from '../components/users/shared'
import { ChallengeDrawer } from '../components/users/ChallengeDrawer'
import { challengeStatusLabel, formatDay, useDebounced, type ChallengeAction } from '../components/users/utils'

type StatusTab = 'all' | 'pending' | 'active' | 'completed' | 'cancelled'
const PAGE_SIZE = 25
const SORT_FIELD: Record<string, string> = {
  name: 'name', fee: 'entry_fee', pool: 'total_pool', milestone: 'milestone', dates: 'end_date', created: 'created_at',
}

function daysLeft(c: ChallengeRow): string {
  const end = new Date(`${c.end_date}T23:59:59`).getTime()
  const start = new Date(`${c.start_date}T00:00:00`).getTime()
  const now = Date.now()
  if (c.status === 'pending') return start > now ? `starts in ${Math.ceil((start - now) / 86_400_000)}d` : 'start date passed'
  if (c.status !== 'active') return ''
  const d = Math.ceil((end - now) / 86_400_000)
  return d <= 0 ? 'ends today' : `${d}d left`
}

export function ChallengesPage() {
  const [params, setParams] = useSearchParams()
  const [tab, setTab] = useState<StatusTab>((params.get('status') as StatusTab) || 'all')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' }>({ key: 'created', dir: 'desc' })
  const [pendingAction, setPendingAction] = useState<ChallengeAction | null>(null)
  const q = useDebounced(search.trim(), 300)
  const openId = params.get('open') ? Number(params.get('open')) : null

  const ordering = `${sort.dir === 'desc' ? '-' : ''}${SORT_FIELD[sort.key] ?? 'created_at'}`
  const listQ = useQuery({
    queryKey: ['admin', 'challenges', { tab, q, page, ordering }],
    queryFn: () => consoleApi.listChallenges({ page, page_size: PAGE_SIZE, status: tab === 'all' ? undefined : tab, search: q, ordering }),
    placeholderData: keepPreviousData,
  })
  const queueQ = useQuery({
    queryKey: ['admin', 'challenges', 'queue'],
    queryFn: () => consoleApi.listChallenges({ page: 1, page_size: 50, status: 'pending', ordering: 'start_date' }),
  })
  const statsQ = useQuery({ queryKey: ['admin', 'challenge-stats'], queryFn: consoleApi.challengeStats })
  const s = statsQ.data
  const queue = queueQ.data?.results ?? []

  const open = (id: number | null, action: ChallengeAction | null = null) => {
    setPendingAction(action)
    const p = new URLSearchParams(params)
    if (id === null) p.delete('open')
    else p.set('open', String(id))
    setParams(p, { replace: true })
  }

  const columns: Column<ChallengeRow>[] = [
    {
      key: 'name', label: 'Challenge', sortable: true, width: '28%',
      render: (c) => (
        <span className="block min-w-0">
          <span className="flex items-center gap-1.5">
            <span className="truncate font-medium text-ink-primary">{c.name}</span>
            {c.is_featured && <Star size={12} className="shrink-0 text-ink-muted" aria-label="Featured" />}
            {c.is_private && <Lock size={12} className="shrink-0 text-ink-muted" aria-label="Private" />}
          </span>
          <span className="block truncate text-xs text-ink-muted">by {c.created_by_username}</span>
        </span>
      ),
    },
    {
      key: 'status', label: 'Status',
      render: (c) => <StatusBadge size="sm" status={c.status === 'active' ? 'live' : c.status} label={challengeStatusLabel(c.status)} />,
    },
    {
      key: 'participants', label: 'Entries', numeric: true,
      render: (c) => <span>{formatNumber(c.current_entries)}<span className="text-ink-muted"> / {formatNumber(c.max_participants)}</span></span>,
    },
    { key: 'fee', label: 'Entry fee', sortable: true, numeric: true, hideBelow: 'md', render: (c) => <span className="mono text-[13px]">{Number(c.entry_fee) ? formatKES(c.entry_fee) : 'Free'}</span> },
    { key: 'pool', label: 'Pool', sortable: true, numeric: true, render: (c) => <span className="mono text-[13px]">{formatKES(c.total_pool)}</span> },
    { key: 'milestone', label: 'Milestone', sortable: true, numeric: true, hideBelow: 'xl', render: (c) => formatNumber(c.milestone) },
    {
      key: 'dates', label: 'Runs', sortable: true, hideBelow: 'lg',
      render: (c) => (
        <span className="block whitespace-nowrap">
          <span className="text-ink-secondary">{formatDay(c.start_date)} – {formatDay(c.end_date)}</span>
          {daysLeft(c) && <span className="block text-xs text-ink-muted">{daysLeft(c)}</span>}
        </span>
      ),
    },
    { key: 'created', label: 'Created', sortable: true, hideBelow: 'xl', render: (c) => <Timestamp value={c.created_at} className="text-ink-secondary" /> },
  ]

  const tabs = [
    { value: 'all' as const, label: 'All', count: s?.total_challenges },
    { value: 'pending' as const, label: 'Awaiting approval', count: s?.pending_challenges },
    { value: 'active' as const, label: 'Live', count: s?.live_challenges },
    { value: 'completed' as const, label: 'Completed', count: s?.completed_challenges },
    { value: 'cancelled' as const, label: 'Cancelled', count: s?.cancelled_challenges },
  ]

  return (
    <div className="space-y-5">
      <PageHeader
        title="Challenges"
        description="Approve new challenges, watch live pools and step into any challenge's leaderboard."
        actions={
          <Button size="sm" variant="secondary" leftIcon={<RefreshCw size={13} />} loading={listQ.isFetching || statsQ.isFetching}
            onClick={() => { void listQ.refetch(); void statsQ.refetch(); void queueQ.refetch() }}>
            Refresh
          </Button>
        }
      />

      {statsQ.error && !s ? (
        <ErrorState variant="inline" title="Could not load challenge totals" error={statsQ.error} onRetry={() => void statsQ.refetch()} />
      ) : (
        <section aria-label="Challenge totals" className="grid grid-cols-2 gap-3 md:grid-cols-3 min-[87.5rem]:grid-cols-5">
          <StatCard label="Awaiting approval" icon={Clock} loading={statsQ.isLoading} value={formatNumber(s?.pending_challenges)}
            tone={s?.pending_challenges ? 'warning' : 'default'} hint={s ? `${formatKESShort(s.pending_pool)} in entries` : undefined}
            onClick={() => { setTab('pending'); setPage(1) }} />
          <StatCard label="Live" icon={Trophy} loading={statsQ.isLoading} value={formatNumber(s?.live_challenges)}
            hint={s ? `${formatKESShort(s.live_pool)} in live pools` : undefined} onClick={() => { setTab('active'); setPage(1) }} />
          <StatCard label="Completed" icon={CheckCircle2} loading={statsQ.isLoading} value={formatNumber(s?.completed_challenges)}
            hint="Finalised at end date" onClick={() => { setTab('completed'); setPage(1) }} />
          <StatCard label="Cancelled" icon={Ban} loading={statsQ.isLoading} value={formatNumber(s?.cancelled_challenges)}
            hint="Closed without payout" onClick={() => { setTab('cancelled'); setPage(1) }} />
          <StatCard label="Entries, all time" icon={Users} loading={statsQ.isLoading} value={formatNumber(s?.total_entries)}
            hint={s ? `${formatKESShort(s.total_prize_pool)} total pools` : undefined} />
        </section>
      )}

      {(queueQ.isLoading || queue.length > 0 || queueQ.error) && (
        <Panel padding="none" title="Approval queue" description={queue.length ? `${queue.length} challenge${queue.length === 1 ? '' : 's'} not yet visible to users · soonest start first` : 'Challenges waiting for a decision'}>
          {queueQ.isLoading ? (
            <ul aria-hidden>{[0, 1].map((i) => <li key={i} className="px-4 py-3"><Skeleton width="60%" /><Skeleton width="40%" height={10} className="mt-2" /></li>)}</ul>
          ) : queueQ.error ? (
            <ErrorState size="compact" error={queueQ.error} onRetry={() => void queueQ.refetch()} />
          ) : (
            <ul className="divide-y divide-[var(--border)]">
              {queue.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5">
                  <button type="button" onClick={() => open(c.id)} className="min-w-0 flex-1 text-left">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-sm font-medium text-ink-primary hover:underline">{c.name}</span>
                      {c.is_private && <StatusBadge size="sm" tone="violet" label="Private" />}
                    </span>
                    <span className="block truncate text-xs text-ink-muted">
                      by {c.created_by_username} · {formatNumber(c.milestone)} steps · {formatDay(c.start_date)} – {formatDay(c.end_date)} · {daysLeft(c)}
                    </span>
                  </button>
                  <span className="text-right">
                    <span className="mono block text-sm text-ink-primary">{Number(c.entry_fee) ? formatKES(c.entry_fee) : 'Free'}</span>
                    <span className="block text-xs text-ink-muted">{formatNumber(c.current_entries)} joined · pool {formatKESShort(c.total_pool)}</span>
                  </span>
                  <span className="flex gap-1.5">
                    <Button size="sm" variant="danger-soft" onClick={() => open(c.id, 'reject')}>Reject</Button>
                    <Button size="sm" variant="primary" onClick={() => open(c.id, 'approve')}>Approve</Button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      )}

      <div className="space-y-3">
        <Tabs label="Challenge status" items={tabs} value={tab} onChange={(v) => { setTab(v); setPage(1) }} />
        <AdminTable
          columns={columns}
          data={listQ.data?.results ?? []}
          rowKey={(c) => c.id}
          isLoading={listQ.isLoading}
          error={listQ.error && !listQ.data ? listQ.error : undefined}
          onRetry={() => void listQ.refetch()}
          onRowClick={(c) => open(c.id)}
          isRowActive={(c) => c.id === openId}
          sortKey={sort.key}
          sortDir={sort.dir}
          onSort={(k) => { setSort((cur) => (cur.key === k ? { key: k, dir: cur.dir === 'asc' ? 'desc' : 'asc' } : { key: k, dir: k === 'name' ? 'asc' : 'desc' })); setPage(1) }}
          skeletonRows={8}
          toolbar={
            <Toolbar actions={<span className="num text-xs text-ink-muted">{listQ.data ? `${formatNumber(listQ.data.count)} challenges` : ''}</span>}>
              <SearchInput size="sm" value={search} onChange={(v) => { setSearch(v); setPage(1) }} placeholder="Search name, creator or invite code" containerClassName="sm:w-72" />
            </Toolbar>
          }
          emptyState={
            <EmptyState size="compact" icon={tab === 'pending' ? Clock : Coins}
              title={q ? 'No challenges match this search' : tab === 'pending' ? 'Nothing waiting for approval' : `No ${tab === 'all' ? '' : challengeStatusLabel(tab).toLowerCase() + ' '}challenges`}
              description={q ? 'Try the creator username or the exact invite code.' : undefined} />
          }
          pagination={listQ.data ? { page, total: listQ.data.count, pageSize: PAGE_SIZE, onPage: setPage, itemLabel: 'challenges' } : undefined}
        />
      </div>

      <ChallengeDrawer key={`${openId}-${pendingAction ?? ''}`} challengeId={openId} initialAction={pendingAction} onClose={() => open(null)} />
    </div>
  )
}
