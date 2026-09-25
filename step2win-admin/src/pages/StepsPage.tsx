import { useLiveRefetchInterval } from '../lib/realtime/useAdminRealtime'
import { useIsFlashing } from '../lib/realtime/store'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { AlertTriangle, Download, Footprints, RefreshCw, ShieldAlert, Users } from 'lucide-react'
import { PageHeader } from '../components/PageHeader'
import { StatCard } from '../components/StatCard'
import { StatusBadge } from '../components/StatusBadge'
import { AdminTable, type Column } from '../components/AdminTable'
import { SlideOver } from '../components/SlideOver'
import { DetailRow } from '../components/DetailRow'
import { Panel } from '../components/ui/Card'
import { Button } from '../components/ui/Button'
import { Input, SearchInput, Select } from '../components/ui/Input'
import { SegmentedControl } from '../components/ui/Tabs'
import { FilterChip, Toolbar } from '../components/ui/Toolbar'
import { EmptyState } from '../components/ui/EmptyState'
import { ErrorState } from '../components/ui/ErrorState'
import { Skeleton } from '../components/ui/Skeleton'
import { ChartLegend, ChartTooltip } from '../components/charts/ChartTooltip'
import { SERIES, barCursor, barProps, gridProps, niceTicks, tickFormat, valueFormat, xAxisProps, yAxisProps } from '../lib/chartTheme'
import { formatCompact, formatNumber, formatPercent } from '../lib/format'
import { cn } from '../lib/cn'
import { consoleApi } from '../components/users/api'
import type { StepLog } from '../components/users/types'
import { InlineLink, SectionTitle, Timestamp, UserCell } from '../components/users/shared'
import { daysAgo, downloadCsv, formatDay, humanize, isoDay, useDebounced } from '../components/users/utils'

type Range = '7' | '30' | '90' | 'custom'
const RANGES = [
  { value: '7' as const, label: '7D' },
  { value: '30' as const, label: '30D' },
  { value: '90' as const, label: '90D' },
  { value: 'custom' as const, label: 'Custom' },
]
type Flag = 'all' | 'true' | 'false'
const FLAG_ITEMS = [
  { value: 'all' as const, label: 'All logs' },
  { value: 'true' as const, label: 'Suspicious' },
  { value: 'false' as const, label: 'Clean' },
]
const SOURCES = [
  { value: '', label: 'Any source' },
  { value: 'device_sensor', label: 'Device sensor' },
  { value: 'google_fit', label: 'Google Fit' },
  { value: 'apple_health', label: 'Apple Health' },
  { value: 'manual', label: 'Manual entry' },
]
const PAGE_SIZE = 50
const sourceLabel = (v: string) => SOURCES.find((x) => x.value === v)?.label ?? humanize(v)

function ChartSkeleton({ height }: { height: number }) {
  return (
    <div className="flex items-end gap-2 px-1" style={{ height }} aria-hidden>
      {Array.from({ length: 14 }).map((_, i) => <Skeleton key={i} className="flex-1" height={`${30 + ((i * 37) % 60)}%`} />)}
    </div>
  )
}

function ReasonChips({ row }: { row: StepLog }) {
  if (!row.is_suspicious) return <span className="text-ink-muted">—</span>
  if (!row.reasons.length) return <StatusBadge size="sm" tone="warning" label="Suspicious" />
  const flags = row.reasons.filter((r) => r.kind === 'flag')
  const shown = flags.length ? flags : row.reasons
  return (
    <span className="flex flex-wrap gap-1">
      {shown.slice(0, 2).map((r) => (
        <StatusBadge key={`${r.kind}-${r.id}`} size="sm" tone={r.severity ? undefined : 'warning'} status={r.severity ?? undefined}
          label={r.kind === 'flag' ? humanize(r.type) : 'Over daily limit'} />
      ))}
      {shown.length > 2 && <span className="text-xs text-ink-muted">+{shown.length - 2}</span>}
    </span>
  )
}

export function StepsPage() {
  const navigate = useNavigate()
  const [range, setRange] = useState<Range>('30')
  const [from, setFrom] = useState(daysAgo(29))
  const [to, setTo] = useState(isoDay(new Date()))
  const [search, setSearch] = useState('')
  const [source, setSource] = useState('')
  const [flag, setFlag] = useState<Flag>('all')
  const [page, setPage] = useState(1)
  const [sort, setSort] = useState<{ key: 'date' | 'steps'; dir: 'asc' | 'desc' }>({ key: 'date', dir: 'desc' })
  const [selected, setSelected] = useState<StepLog | null>(null)
  const q = useDebounced(search.trim(), 300)

  const fromDate = range === 'custom' ? from : daysAgo(Number(range) - 1)
  const toDate = range === 'custom' ? to : isoDay(new Date())
  const filters = {
    search: q || undefined,
    from_date: fromDate || undefined,
    to_date: toDate || undefined,
    source: source || undefined,
    suspicious: flag === 'all' ? undefined : flag,
  }
  const refetchInterval = useLiveRefetchInterval(30_000)
  const isFlashing = useIsFlashing('steps')
  const listQ = useQuery({
    refetchInterval,
    queryKey: ['admin', 'step-logs', filters, page, sort],
    queryFn: () => consoleApi.stepLogs({ ...filters, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE, order: sort.dir, sort: sort.key }),
    placeholderData: keepPreviousData,
  })
  const data = listQ.data
  const sum = data?.summary
  const reset = () => setPage(1)

  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)
  const exportCsv = async () => {
    setExporting(true)
    setExportError(null)
    try {
      const all = await consoleApi.stepLogs({ ...filters, limit: 500, offset: 0, order: 'desc' })
      downloadCsv(
        `step-logs_${fromDate}_${toDate}.csv`,
        ['date', 'username', 'email', 'steps', 'source', 'distance_km', 'active_minutes', 'suspicious', 'reasons', 'synced_at'],
        all.results.map((r) => [r.date, r.username, r.email, r.steps, r.source, r.distance_km, r.active_minutes, r.is_suspicious,
          r.reasons.map((x) => x.type).join('; '), r.synced_at]),
      )
    } catch (e) {
      setExportError(e instanceof Error ? e.message : 'Export failed')
    } finally {
      setExporting(false)
    }
  }

  const daily = (sum?.daily ?? []).map((d) => ({ ...d, label: formatDay(d.date) }))
  const dailyTicks = niceTicks(Math.max(0, ...daily.map((d) => d.steps)))
  const dist = (sum?.distribution ?? []).map((b) => ({ ...b, clean: b.count - b.suspicious }))
  const distTicks = niceTicks(Math.max(0, ...dist.map((b) => b.count)))
  const avg = data && data.total ? sum!.total_steps / data.total : null

  const columns: Column<StepLog>[] = [
    {
      key: 'user', label: 'User', width: '24%',
      render: (r) => (
        <span className="flex items-center gap-2">
          {r.is_suspicious && <AlertTriangle size={14} className="shrink-0 text-warning" aria-label="Suspicious" />}
          <UserCell username={r.username} secondary={r.email} />
        </span>
      ),
    },
    { key: 'date', label: 'Day', sortable: true, render: (r) => <span className="whitespace-nowrap">{formatDay(r.date, true)}</span> },
    {
      key: 'steps', label: 'Steps', sortable: true, numeric: true,
      render: (r) => <span className={cn('font-medium', r.is_suspicious && 'text-warning')}>{formatNumber(r.steps)}</span>,
    },
    { key: 'source', label: 'Source', hideBelow: 'md', render: (r) => <span className="text-ink-secondary">{sourceLabel(r.source)}</span> },
    { key: 'distance', label: 'Distance', numeric: true, hideBelow: 'xl', render: (r) => (r.distance_km == null ? '—' : `${formatNumber(r.distance_km, 2)} km`) },
    { key: 'active', label: 'Active min', numeric: true, hideBelow: 'xl', render: (r) => formatNumber(r.active_minutes) },
    { key: 'reasons', label: 'Signals', hideBelow: 'sm', render: (r) => <ReasonChips row={r} /> },
    { key: 'synced', label: 'Last synced', hideBelow: 'lg', render: (r) => <Timestamp value={r.synced_at} className="text-ink-secondary" /> },
  ]

  const chips = [
    q && { key: 'q', label: `User: ${q}`, clear: () => { setSearch(''); reset() } },
    source && { key: 'source', label: `Source: ${sourceLabel(source)}`, clear: () => { setSource(''); reset() } },
    flag !== 'all' && { key: 'flag', label: flag === 'true' ? 'Suspicious only' : 'Clean only', clear: () => { setFlag('all'); reset() } },
  ].filter(Boolean) as Array<{ key: string; label: string; clear: () => void }>

  const rangeLabel = `${formatDay(fromDate)} – ${formatDay(toDate)}`

  return (
    <div className="space-y-5">
      <PageHeader
        title="Step logs"
        description="Daily step records as synced from users' devices. Suspicious days carry the anti-cheat signals that marked them."
        meta={`Showing ${rangeLabel}`}
        actions={
          <>
            <Button size="sm" variant="secondary" leftIcon={<Download size={13} />} loading={exporting} onClick={() => void exportCsv()}
              disabled={!data?.total}>
              Export CSV
            </Button>
            <Button size="sm" variant="secondary" leftIcon={<RefreshCw size={13} />} loading={listQ.isFetching} onClick={() => void listQ.refetch()}>
              Refresh
            </Button>
          </>
        }
      />
      {exportError && <ErrorState variant="inline" title="Export failed" error={exportError} />}

      <Toolbar>
        <SegmentedControl label="Date range" items={RANGES} value={range} onChange={(v) => { setRange(v); reset() }} />
        {range === 'custom' && (
          <span className="flex items-center gap-1.5">
            <Input size="sm" type="date" aria-label="From date" value={from} max={to} onChange={(e) => { setFrom(e.target.value); reset() }} />
            <span className="text-xs text-ink-muted">to</span>
            <Input size="sm" type="date" aria-label="To date" value={to} min={from} onChange={(e) => { setTo(e.target.value); reset() }} />
          </span>
        )}
        <SearchInput size="sm" value={search} onChange={(v) => { setSearch(v); reset() }} placeholder="Filter by username or email" />
        <Select size="sm" aria-label="Source" value={source} onChange={(e) => { setSource(e.target.value); reset() }} containerClassName="w-40">
          {SOURCES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </Select>
        <SegmentedControl label="Suspicious filter" items={FLAG_ITEMS} value={flag} onChange={(v) => { setFlag(v); reset() }} />
      </Toolbar>
      {chips.length > 0 && (
        <div className="-mt-2 flex flex-wrap items-center gap-1.5">
          {chips.map((c) => <FilterChip key={c.key} label={c.label} onRemove={c.clear} />)}
        </div>
      )}

      {listQ.error && !data ? (
        <ErrorState variant="inline" title="Could not load step logs" error={listQ.error} onRetry={() => void listQ.refetch()} />
      ) : (
        <section aria-label="Step totals" className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatCard label="Steps recorded" icon={Footprints} loading={listQ.isLoading} value={formatCompact(sum?.total_steps)}
            hint={sum ? `${formatNumber(sum.total_steps)} exact` : undefined} />
          <StatCard label="Daily logs" icon={Footprints} loading={listQ.isLoading} value={formatNumber(data?.total)}
            hint={avg !== null ? `${formatNumber(Math.round(avg))} steps per log` : 'No logs'} />
          <StatCard label="Users with logs" icon={Users} loading={listQ.isLoading} value={formatNumber(sum?.users_with_logs)} />
          <StatCard label="Suspicious logs" icon={ShieldAlert} loading={listQ.isLoading} value={formatNumber(sum?.suspicious_count)}
            tone={sum?.suspicious_count ? 'warning' : 'default'}
            hint={data?.total ? `${formatPercent(((sum?.suspicious_count ?? 0) / data.total) * 100)} of logs` : undefined}
            onClick={() => { setFlag('true'); reset() }} />
        </section>
      )}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-5">
        <Panel className="xl:col-span-3" title="Steps per day" description={`All matching logs · ${rangeLabel}`}
          actions={<span className="num text-xs text-ink-muted">{formatNumber(sum?.total_steps)} total</span>}>
          {listQ.isLoading ? <ChartSkeleton height={200} /> : daily.length === 0 ? (
            <EmptyState size="compact" icon={Footprints} title="No steps in this range" description="Widen the date range or clear filters." />
          ) : (
            <div className="h-[200px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={daily} margin={{ top: 4, right: 4, bottom: 0, left: -8 }}>
                  <CartesianGrid {...gridProps} />
                  <XAxis dataKey="label" {...xAxisProps} />
                  <YAxis {...yAxisProps} domain={[0, dailyTicks[dailyTicks.length - 1]]} ticks={dailyTicks} tickFormatter={tickFormat.number} />
                  <Tooltip cursor={barCursor} content={<ChartTooltip hideSwatch formatValue={valueFormat.number} />} />
                  <Bar dataKey="steps" name="Steps" fill={SERIES[0]} {...barProps} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Panel>
        <Panel className="xl:col-span-2" title="Daily totals distribution" description="How many logs fall in each step band"
          actions={<ChartLegend items={[{ label: 'Clean', color: SERIES[0] }, { label: 'Suspicious', color: SERIES[2] }]} />}>
          {listQ.isLoading ? <ChartSkeleton height={200} /> : !data?.total ? (
            <EmptyState size="compact" icon={Footprints} title="No logs to distribute" />
          ) : (
            <div className="h-[200px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={dist} margin={{ top: 4, right: 4, bottom: 0, left: -8 }}>
                  <CartesianGrid {...gridProps} />
                  <XAxis dataKey="label" {...xAxisProps} minTickGap={4} />
                  <YAxis {...yAxisProps} domain={[0, distTicks[distTicks.length - 1]]} ticks={distTicks} tickFormatter={tickFormat.number} />
                  <Tooltip cursor={barCursor} content={<ChartTooltip formatValue={valueFormat.number} />} />
                  <Bar dataKey="clean" name="Clean" stackId="a" fill={SERIES[0]} {...barProps} radius={[0, 0, 0, 0]} />
                  <Bar dataKey="suspicious" name="Suspicious" stackId="a" fill={SERIES[2]} {...barProps} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Panel>
      </div>

      <AdminTable
        columns={columns}
        data={data?.results ?? []}
        rowKey={(r) => r.id}
        isLoading={listQ.isLoading}
        error={listQ.error && !data ? listQ.error : undefined}
        onRetry={() => void listQ.refetch()}
        onRowClick={setSelected}
        isRowActive={(r) => r.id === selected?.id}
        isRowFlashing={(r) => isFlashing(r.user_id)}
        sortKey={sort.key}
        sortDir={sort.dir}
        onSort={(k) => { setSort((c) => (c.key === k ? { key: c.key, dir: c.dir === 'asc' ? 'desc' : 'asc' } : { key: k as 'date' | 'steps', dir: 'desc' })); reset() }}
        skeletonRows={12}
        emptyMessage="No step logs match"
        emptyDescription="Try a wider date range or remove a filter."
        pagination={data ? { page, total: data.total, pageSize: PAGE_SIZE, onPage: setPage, itemLabel: 'logs' } : undefined}
      />

      <DayDrawer row={selected} onClose={() => setSelected(null)} onOpenUser={(id) => navigate(`/users?user=${id}`)} />
    </div>
  )
}

function DayDrawer({ row, onClose, onOpenUser }: { row: StepLog | null; onClose: () => void; onOpenUser: (id: number) => void }) {
  const navigate = useNavigate()
  const hourlyQ = useQuery({
    queryKey: ['admin', 'step-hourly', row?.user_id, row?.date],
    queryFn: () => consoleApi.stepHourly(row!.user_id, row!.date),
    enabled: !!row,
  })
  const hours = hourlyQ.data?.hours ?? []
  const hourlyTotal = hourlyQ.data?.summary.total_steps ?? 0
  const peak = hours.reduce((m, h) => (h.steps > m.steps ? h : m), { steps: 0, label: '—' } as { steps: number; label: string })
  const ticks = niceTicks(Math.max(0, ...hours.map((h) => h.steps)))
  return (
    <SlideOver
      open={!!row} onClose={onClose} width={560}
      title={row ? `${row.username} · ${formatDay(row.date)}` : ''}
      subtitle={row ? formatDay(row.date, true) : undefined}
      headerAside={row && <StatusBadge size="sm" tone={row.is_suspicious ? 'warning' : 'success'} label={row.is_suspicious ? 'Suspicious' : 'Clean'} />}
      footer={row && (
        <>
          {row.is_suspicious && <Button size="sm" variant="secondary" leftIcon={<ShieldAlert size={13} />} onClick={() => navigate('/fraud')}>Review in anti-cheat</Button>}
          <Button size="sm" variant="primary" onClick={() => onOpenUser(row.user_id)}>Open user</Button>
        </>
      )}
    >
      {row && (
        <div>
          <SectionTitle>Day record</SectionTitle>
          <DetailRow label="Steps" value={<span className="num font-semibold">{formatNumber(row.steps)}</span>} />
          <DetailRow label="Source" value={sourceLabel(row.source)} />
          <DetailRow label="Distance" value={row.distance_km == null ? null : `${formatNumber(row.distance_km, 2)} km`} />
          <DetailRow label="Active calories" value={row.calories_active == null ? null : formatNumber(row.calories_active)} />
          <DetailRow label="Active minutes" value={row.active_minutes == null ? null : formatNumber(row.active_minutes)} />
          <DetailRow label="Last synced" value={<Timestamp value={row.synced_at} exact />} />
          <DetailRow label="Record ID" value={String(row.id)} mono />

          {row.is_suspicious && (
            <>
              <SectionTitle>Why it was marked suspicious</SectionTitle>
              {row.reasons.length === 0 ? (
                <p className="text-sm text-ink-muted">Marked suspicious at sync time; no flag or activity record matches this day.</p>
              ) : (
                <ul className="divide-y divide-[var(--border)] rounded-md border border-surface-border">
                  {row.reasons.map((r) => (
                    <li key={`${r.kind}-${r.id}`} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                      {r.severity ? <StatusBadge size="sm" status={r.severity} /> : <StatusBadge size="sm" tone="warning" label="Activity" />}
                      <span className="min-w-0 flex-1 text-ink-primary">{r.kind === 'flag' ? humanize(r.type) : r.type}</span>
                      <StatusBadge size="sm" tone={r.reviewed ? 'neutral' : 'warning'} label={r.reviewed ? 'Reviewed' : 'Not reviewed'} />
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}

          <SectionTitle aside={hourlyTotal > 0 ? <span className="text-xs text-ink-muted">Peak {peak.label} · {formatNumber(peak.steps)}</span> : undefined}>
            Hourly breakdown
          </SectionTitle>
          {hourlyQ.isLoading ? <ChartSkeleton height={160} /> : hourlyQ.error ? (
            <ErrorState size="compact" error={hourlyQ.error} onRetry={() => void hourlyQ.refetch()} />
          ) : hourlyTotal === 0 ? (
            <EmptyState size="compact" icon={Footprints} title="No hourly data for this day"
              description="Hourly buckets are only stored for syncs from the current app. The daily total above still counts." />
          ) : (
            <>
              <div className="h-[160px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={hours} margin={{ top: 4, right: 4, bottom: 0, left: -8 }}>
                    <CartesianGrid {...gridProps} />
                    <XAxis dataKey="label" {...xAxisProps} interval={3} />
                    <YAxis {...yAxisProps} domain={[0, ticks[ticks.length - 1]]} ticks={ticks} tickFormatter={tickFormat.number} />
                    <Tooltip cursor={barCursor} content={<ChartTooltip hideSwatch formatValue={valueFormat.number} />} />
                    <Bar dataKey="steps" name="Steps" fill={SERIES[0]} {...barProps} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              {hourlyTotal !== row.steps && (
                <p className="mt-2 text-xs text-ink-muted">
                  Hourly buckets add up to {formatNumber(hourlyTotal)} steps; the daily record says {formatNumber(row.steps)}.
                  A gap usually means some syncs arrived without hourly detail.
                </p>
              )}
            </>
          )}
          <div className="mt-4"><InlineLink onClick={() => onOpenUser(row.user_id)}>See this user's 30-day activity</InlineLink></div>
        </div>
      )}
    </SlideOver>
  )
}
