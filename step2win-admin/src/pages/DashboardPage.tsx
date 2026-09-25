import { useState, type ElementType, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  Activity, AlertOctagon, Banknote, ChevronRight, Footprints, HeadphonesIcon, LogIn, RefreshCw,
  ShieldAlert, Smartphone, Trophy, UserPlus, Users, Wallet, Coins, CheckCircle2,
} from 'lucide-react'
import {
  Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { format } from 'date-fns'
import { adminApi } from '../services/adminApi'
import { PageHeader } from '../components/PageHeader'
import { StatCard, type StatDelta } from '../components/StatCard'
import { StatusBadge } from '../components/StatusBadge'
import { Panel } from '../components/ui/Card'
import { Button } from '../components/ui/Button'
import { SegmentedControl } from '../components/ui/Tabs'
import { ErrorState } from '../components/ui/ErrorState'
import { EmptyState } from '../components/ui/EmptyState'
import { Skeleton } from '../components/ui/Skeleton'
import { ChartLegend, ChartTooltip } from '../components/charts/ChartTooltip'
import {
  barCursor, barProps, gridProps, lineCursor, lineProps, niceTicks, SERIES, tickFormat, valueFormat, xAxisProps, yAxisProps,
} from '../lib/chartTheme'
import {
  formatAgeHours, formatCompact, formatKES, formatKESShort, formatNumber, formatPercent, formatRelative, sumBy,
} from '../lib/format'
import { cn } from '../lib/cn'
import { useLiveRefetchInterval } from '../lib/realtime/useAdminRealtime'
import { useRealtimeStore } from '../lib/realtime/store'
import { PULSE_KEY, realtimeApi } from '../lib/realtime/api'

type Period = '7' | '30' | '90'
const PERIODS = [
  { value: '7' as const, label: '7D' },
  { value: '30' as const, label: '30D' },
  { value: '90' as const, label: '90D' },
]
const REFRESH_MS = 60_000

/**
 * The backend reports growth as 0.0 when the previous period had no activity,
 * so a zero cannot be told apart from "no comparison". Only show real changes.
 */
function deltaFrom(value: number | undefined, days: number, good: StatDelta['good'] = 'up'): StatDelta | undefined {
  if (value === undefined || value === null || !Number.isFinite(value) || value === 0) return undefined
  return { value, period: `vs previous ${days}d`, good }
}

// ── Needs attention ─────────────────────────────────────────────────────────

type AttentionTone = 'danger' | 'warning' | 'clear'

interface AttentionItem {
  key: string
  label: string
  count: number | null
  detail: ReactNode
  to: string
  icon: ElementType
  tone: AttentionTone
}

const TONE_RANK: Record<AttentionTone, number> = { danger: 0, warning: 1, clear: 2 }

function AttentionRow({ item }: { item: AttentionItem }) {
  const Icon = item.icon
  const clear = item.tone === 'clear'
  return (
    <li>
      <Link
        to={item.to}
        className="group flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-surface-elevated/60 focus-visible:bg-surface-elevated/60"
      >
        <span
          className={cn(
            'flex h-8 w-8 shrink-0 items-center justify-center rounded-md',
            item.tone === 'danger' && 'bg-danger-soft text-danger',
            item.tone === 'warning' && 'bg-warning-soft text-warning',
            clear && 'bg-surface-elevated text-ink-muted',
          )}
        >
          <Icon size={15} aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className={cn('block truncate text-sm font-medium', clear ? 'text-ink-secondary' : 'text-ink-primary')}>
            {item.label}
          </span>
          <span className="block truncate text-xs text-ink-muted">{item.detail}</span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {item.count === null ? (
            <span className="text-xs text-ink-muted">Unavailable</span>
          ) : clear ? (
            <span className="inline-flex items-center gap-1 text-xs text-ink-muted">
              <CheckCircle2 size={13} className="text-success" aria-hidden /> Clear
            </span>
          ) : (
            <span
              className={cn(
                'num min-w-7 text-right text-lg font-semibold',
                item.tone === 'danger' ? 'text-danger' : 'text-warning',
              )}
            >
              {item.count.toLocaleString()}
            </span>
          )}
          <ChevronRight size={15} className="text-ink-muted transition-transform group-hover:translate-x-0.5" aria-hidden />
        </span>
      </Link>
    </li>
  )
}

// ── Platform health ─────────────────────────────────────────────────────────

interface HealthRowProps {
  label: string
  value: ReactNode
  limit?: ReactNode
  status: 'ok' | 'over' | 'info'
  statusLabel?: string
}

function HealthRow({ label, value, limit, status, statusLabel }: HealthRowProps) {
  return (
    <li className="flex items-center justify-between gap-3 px-4 py-2">
      <span className="min-w-0">
        <span className="block truncate text-sm text-ink-secondary">{label}</span>
        {limit && <span className="block text-xs text-ink-muted">{limit}</span>}
      </span>
      <span className="flex shrink-0 items-center gap-2">
        <span className="num text-sm font-semibold text-ink-primary">{value}</span>
        <StatusBadge
          size="sm"
          tone={status === 'ok' ? 'success' : status === 'over' ? 'danger' : 'neutral'}
          label={statusLabel ?? (status === 'ok' ? 'OK' : status === 'over' ? 'Over limit' : 'Info')}
        />
      </span>
    </li>
  )
}

function ListSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <ul aria-hidden>
      {Array.from({ length: rows }).map((_, i) => (
        <li key={i} className="flex items-center gap-3 px-4 py-3">
          <Skeleton width={32} height={32} className="rounded-md" />
          <span className="flex-1 space-y-1.5">
            <Skeleton width="45%" />
            <Skeleton width="70%" height={10} />
          </span>
        </li>
      ))}
    </ul>
  )
}

function ChartSkeleton({ height }: { height: number }) {
  return (
    <div className="flex items-end gap-2 px-1" style={{ height }} aria-hidden>
      {Array.from({ length: 14 }).map((_, i) => (
        <Skeleton key={i} className="flex-1" height={`${30 + ((i * 37) % 60)}%`} />
      ))}
    </div>
  )
}

// ── Page ────────────────────────────────────────────────────────────────────

export function DashboardPage() {
  const [period, setPeriod] = useState<Period>('7')
  const days = Number(period)
  const navigate = useNavigate()

  // Live events refetch these as customers act; polling only while the socket is down.
  const refetchInterval = useLiveRefetchInterval(REFRESH_MS)
  const live = useRealtimeStore((s) => s.status === 'live')
  const overviewQ = useQuery({
    queryKey: ['admin', 'overview', days],
    queryFn: () => adminApi.getOverview(days),
    refetchInterval,
    placeholderData: (prev) => prev,
  })
  const withdrawalsQ = useQuery({
    queryKey: ['admin', 'withdrawal-stats'],
    queryFn: () => adminApi.getWithdrawalStats(),
    refetchInterval,
  })
  const fraudQ = useQuery({
    queryKey: ['admin', 'fraud-overview'],
    queryFn: () => adminApi.getFraudOverview(),
    refetchInterval,
  })
  const opsQ = useQuery({
    queryKey: ['admin', 'ops-monitoring'],
    queryFn: () => adminApi.getOpsMonitoring(),
    refetchInterval,
  })
  const notificationsQ = useQuery({
    queryKey: ['admin', 'notifications'],
    queryFn: () => adminApi.getNotifications(),
    refetchInterval,
  })
  const pulseQ = useQuery({
    queryKey: PULSE_KEY,
    queryFn: realtimeApi.pulse,
    refetchInterval,
  })

  const stats = overviewQ.data
  const ws = withdrawalsQ.data
  const fraud = fraudQ.data
  const ops = opsQ.data
  const notif = notificationsQ.data

  const refreshing =
    overviewQ.isFetching || withdrawalsQ.isFetching || fraudQ.isFetching || opsQ.isFetching || notificationsQ.isFetching
  const refreshAll = () => {
    void pulseQ.refetch()
    void overviewQ.refetch()
    void withdrawalsQ.refetch()
    void fraudQ.refetch()
    void opsQ.refetch()
    void notificationsQ.refetch()
  }

  // ── Derived period figures (all from overview charts) ──
  const walletRows = (stats?.revenue_chart ?? []).map((r) => ({
    date: r.date,
    deposits: Math.abs(Number(r.deposits) || 0),
    withdrawals: Math.abs(Number(r.withdrawals) || 0),
  }))
  const depositsTotal = sumBy(walletRows, (r) => r.deposits)
  const withdrawalsTotal = sumBy(walletRows, (r) => r.withdrawals)
  const signupsTotal = sumBy(stats?.user_chart, (r) => r.users)
  const stepsTotal = sumBy(stats?.step_chart, (r) => r.steps)
  const walletTicks = niceTicks(Math.max(0, ...walletRows.flatMap((r) => [r.deposits, r.withdrawals])))
  const stepTicks = niceTicks(Math.max(0, ...(stats?.step_chart ?? []).map((r) => r.steps)))
  const signupTicks = niceTicks(Math.max(0, ...(stats?.user_chart ?? []).map((r) => r.users)))
  const stepsAvg = stats?.step_chart?.length ? stepsTotal / stats.step_chart.length : 0

  // ── Attention queue ──
  const opsBreaches = [...(ops?.breaches ?? []), ...(ops?.anti_cheat_drift?.breaches ?? [])]
  const pendingW = ws?.pending_count ?? null
  const oldestHours = ops?.metrics.withdrawal_queue.oldest_age_hours ?? 0
  const attention: AttentionItem[] = [
    {
      key: 'withdrawals',
      label: 'Withdrawals awaiting review',
      count: pendingW,
      detail: pendingW
        ? `${formatKES(ws?.pending_total_kes)} requested${oldestHours > 0 ? ` · oldest ${formatAgeHours(oldestHours)}` : ''}`
        : 'Payout queue is empty',
      to: '/withdrawals',
      icon: Banknote,
      tone: pendingW ? (oldestHours >= 24 ? 'danger' : 'warning') : 'clear',
    },
    {
      key: 'failed-payouts',
      label: 'Failed payouts today',
      count: ws?.failed_today ?? null,
      detail: ws?.failed_today ? 'Retry or reject from the withdrawals queue' : `${ws?.completed_today ?? 0} completed today`,
      to: '/withdrawals',
      icon: AlertOctagon,
      tone: ws?.failed_today ? 'danger' : 'clear',
    },
    {
      key: 'fraud',
      label: 'Open anti-cheat flags',
      count: fraud?.open_flags ?? null,
      detail: fraud
        ? `${fraud.critical_unread} critical · ${fraud.high_unread} high unreviewed · ${fraud.flags_today} raised today`
        : 'Fraud overview unavailable',
      to: '/fraud',
      icon: ShieldAlert,
      tone: fraud?.critical_unread ? 'danger' : fraud?.open_flags ? 'warning' : 'clear',
    },
    {
      key: 'support',
      label: 'Open support tickets',
      count: notif?.summary.open_support_tickets ?? null,
      detail: notif?.summary.open_support_tickets ? 'Waiting for a staff reply or resolution' : 'No open tickets',
      to: '/support',
      icon: HeadphonesIcon,
      tone: notif?.summary.open_support_tickets ? 'warning' : 'clear',
    },
    {
      key: 'challenges',
      label: 'Challenges awaiting approval',
      count: stats?.challenges_pending ?? null,
      detail: stats?.challenges_pending ? 'Created by users, not yet live' : 'Nothing to approve',
      to: '/challenges',
      icon: Trophy,
      tone: stats?.challenges_pending ? 'warning' : 'clear',
    },
    {
      key: 'ops',
      label: 'Ops threshold breaches',
      count: ops ? opsBreaches.length : null,
      detail: opsBreaches.length ? opsBreaches.join(' · ') : 'Payments, callbacks and step drift within limits',
      to: '/monitoring/ops',
      icon: Activity,
      tone: opsBreaches.length ? 'danger' : 'clear',
    },
  ]
  const attentionSorted = [...attention].sort((a, b) => TONE_RANK[a.tone] - TONE_RANK[b.tone])
  const openCount = attention.filter((a) => a.tone !== 'clear').length
  const attentionLoading = withdrawalsQ.isLoading || fraudQ.isLoading || opsQ.isLoading || notificationsQ.isLoading || overviewQ.isLoading

  const m = ops?.metrics
  const t = ops?.thresholds
  const drift = ops?.anti_cheat_drift

  const updatedAt = stats?.timestamp ? format(new Date(stats.timestamp), live ? 'HH:mm:ss' : 'HH:mm') : null
  const pulse = pulseQ.data
  const kpiLoading = overviewQ.isLoading

  return (
    <div className="space-y-5">
      <PageHeader
        title="Dashboard"
        description="Queues that need a decision, platform health, and activity for the selected period."
        meta={updatedAt ? `Updated ${updatedAt} · ${live ? 'live' : 'refreshes every minute'}` : undefined}
        actions={
          <>
            <SegmentedControl label="Reporting period" items={PERIODS} value={period} onChange={setPeriod} />
            <Button size="sm" variant="secondary" onClick={refreshAll} loading={refreshing} leftIcon={<RefreshCw size={13} />}>
              Refresh
            </Button>
          </>
        }
      />

      {/* ── Attention + health ── */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Panel
          className="xl:col-span-2"
          padding="none"
          title="Needs attention"
          description={
            attentionLoading ? 'Checking queues…' : openCount ? `${openCount} of ${attention.length} queues need action` : 'All queues are clear'
          }
        >
          {attentionLoading ? (
            <ListSkeleton rows={6} />
          ) : (
            <ul className="divide-y divide-[var(--border)]">
              {attentionSorted.map((item) => <AttentionRow key={item.key} item={item} />)}
            </ul>
          )}
        </Panel>

        <Panel
          padding="none"
          title="Platform health"
          description={ops ? `Checked ${formatRelative(ops.timestamp)}` : 'Ops monitoring'}
          actions={
            ops && (
              <StatusBadge
                tone={opsBreaches.length ? 'danger' : 'success'}
                label={opsBreaches.length ? `${opsBreaches.length} breach${opsBreaches.length === 1 ? '' : 'es'}` : 'All checks passing'}
              />
            )
          }
          footer={
            <Link to="/monitoring/ops" className="inline-flex items-center gap-1 text-xs font-medium text-brand-text hover:underline">
              Open ops monitoring <ChevronRight size={13} aria-hidden />
            </Link>
          }
        >
          {opsQ.isLoading ? (
            <ListSkeleton rows={5} />
          ) : opsQ.error || !m || !t ? (
            <ErrorState size="compact" title="Ops monitoring unavailable" error={opsQ.error} onRetry={() => void opsQ.refetch()} />
          ) : (
            <ul className="divide-y divide-[var(--border)] py-1">
              <HealthRow
                label="M-Pesa callback failures (24h)"
                value={formatPercent(m.callback_failure_rate_pct)}
                limit={`${formatNumber(m.callback_failures_24h)} of ${formatNumber(m.callback_total_24h)} · limit ${t.max_callback_failure_rate_pct}%`}
                status={m.callback_failure_rate_pct > t.max_callback_failure_rate_pct ? 'over' : 'ok'}
              />
              <HealthRow
                label="Unprocessed callbacks"
                value={formatNumber(m.unprocessed_callbacks)}
                limit={`limit ${t.max_unprocessed_callbacks}`}
                status={m.unprocessed_callbacks > t.max_unprocessed_callbacks ? 'over' : 'ok'}
              />
              <HealthRow
                label="Withdrawals stuck processing"
                value={formatNumber(m.stuck_processing_withdrawals)}
                limit={`limit ${t.max_stuck_processing}`}
                status={m.stuck_processing_withdrawals > t.max_stuck_processing ? 'over' : 'ok'}
              />
              <HealthRow
                label="Payments stuck pending"
                value={formatNumber(m.stuck_pending_payments)}
                status={m.stuck_pending_payments > 0 ? 'over' : 'ok'}
                statusLabel={m.stuck_pending_payments > 0 ? 'Check' : 'OK'}
              />
              <HealthRow
                label="Negative wallet balances"
                value={formatNumber(m.negative_balance_users)}
                limit={`limit ${t.max_negative_balance_users}`}
                status={m.negative_balance_users > t.max_negative_balance_users ? 'over' : 'ok'}
              />
              {drift && (
                <HealthRow
                  label={`Step drift (${drift.window.hours}h)`}
                  value={drift.window.enough_samples ? formatPercent(drift.metrics.avg_abs_delta_pct) : `${drift.metrics.sample_count}/${drift.thresholds.min_samples}`}
                  limit={drift.window.enough_samples ? `avg limit ${drift.thresholds.max_avg_abs_delta_pct}%` : 'samples, too few to judge'}
                  status={!drift.window.enough_samples ? 'info' : drift.ok ? 'ok' : 'over'}
                  statusLabel={!drift.window.enough_samples ? 'Low data' : undefined}
                />
              )}
            </ul>
          )}
        </Panel>
      </div>

      {/* ── KPIs ── */}
      {overviewQ.error && !stats ? (
        <ErrorState variant="inline" title="Could not load platform metrics" error={overviewQ.error} onRetry={() => void overviewQ.refetch()} retrying={overviewQ.isFetching} />
      ) : (
        <section aria-label="Key metrics" className="grid grid-cols-2 gap-3 md:grid-cols-3 min-[87.5rem]:grid-cols-6">
          <StatCard
            label="Total users"
            icon={Users}
            loading={kpiLoading}
            value={formatNumber(stats?.total_users)}
            hint={stats?.users ? `${formatNumber(stats.users.active_week)} active in last 7 days` : undefined}
            to="/users"
          />
          <StatCard
            label={`New signups · ${days}d`}
            icon={UserPlus}
            loading={kpiLoading}
            value={formatNumber(signupsTotal)}
            delta={deltaFrom(stats?.user_growth_pct, days)}
            hint={deltaFrom(stats?.user_growth_pct, days) ? undefined : 'No prior-period data'}
            to="/users"
          />
          <StatCard
            label="Live challenges"
            icon={Trophy}
            loading={kpiLoading}
            value={formatNumber(stats?.live_challenges)}
            hint={stats ? `${formatNumber(stats.challenges_pending)} awaiting approval` : undefined}
            to="/challenges"
          />
          <StatCard
            label={`Steps recorded · ${days}d`}
            icon={Footprints}
            loading={kpiLoading}
            value={formatCompact(stepsTotal)}
            hint={`${formatCompact(Math.round(stepsAvg))} per day avg`}
            to="/steps"
          />
          <StatCard
            label={`Deposits · ${days}d`}
            icon={Wallet}
            loading={kpiLoading}
            value={formatKESShort(depositsTotal)}
            hint={`${formatKESShort(withdrawalsTotal)} withdrawn`}
            to="/transactions"
          />
          <StatCard
            label={`Platform fees · ${days}d`}
            icon={Coins}
            loading={kpiLoading}
            value={formatKESShort(stats?.revenue_kes)}
            delta={deltaFrom(stats?.revenue_growth_pct, days)}
            hint={deltaFrom(stats?.revenue_growth_pct, days) ? undefined : 'No prior-period data'}
            to="/reports"
          />
        </section>
      )}

      {/* ── Live activity (rolling windows, refetched as phones sync) ── */}
      <section aria-label="Live activity" className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard
          label="Step syncs · last hour"
          icon={RefreshCw}
          loading={pulseQ.isLoading}
          value={formatNumber(pulse?.step_syncs_last_hour ?? undefined)}
          hint="Accepted and rejected sync events"
          to="/steps"
        />
        <StatCard
          label="People syncing · last hour"
          icon={Smartphone}
          loading={pulseQ.isLoading}
          value={formatNumber(pulse?.users_synced_last_hour ?? undefined)}
          hint="Distinct users whose steps landed"
          to="/steps"
        />
        <StatCard
          label="Sign-ins · last hour"
          icon={LogIn}
          loading={pulseQ.isLoading}
          value={formatNumber(pulse?.logins_last_hour ?? undefined)}
          hint="New device sessions"
          to="/users"
        />
        <StatCard
          label="Sign-ups · last 24h"
          icon={UserPlus}
          loading={pulseQ.isLoading}
          value={formatNumber(pulse?.signups_last_24h ?? undefined)}
          hint="New accounts"
          to="/users"
        />
      </section>

      {/* ── Charts ── */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel
          title="Wallet flow"
          description={`Deposits and withdrawals per day, KSh · last ${days} days`}
          actions={
            <ChartLegend
              items={[
                { label: 'Deposits', color: SERIES[0], value: formatKESShort(depositsTotal) },
                { label: 'Withdrawals', color: SERIES[1], value: formatKESShort(withdrawalsTotal) },
              ]}
            />
          }
        >
          {kpiLoading ? (
            <ChartSkeleton height={220} />
          ) : depositsTotal + withdrawalsTotal === 0 ? (
            <EmptyState size="compact" icon={Wallet} title="No wallet movement in this period" description="Deposits and withdrawals will appear here as they are recorded." />
          ) : (
            <div className="h-[220px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={walletRows} margin={{ top: 4, right: 4, bottom: 0, left: -8 }} barGap={2}>
                  <CartesianGrid {...gridProps} />
                  <XAxis dataKey="date" {...xAxisProps} />
                  <YAxis {...yAxisProps} domain={[0, walletTicks[walletTicks.length - 1]]} ticks={walletTicks} tickFormatter={tickFormat.kes} />
                  <Tooltip cursor={barCursor} content={<ChartTooltip formatValue={valueFormat.kes} />} />
                  <Bar dataKey="deposits" name="Deposits" fill={SERIES[0]} {...barProps} />
                  <Bar dataKey="withdrawals" name="Withdrawals" fill={SERIES[1]} {...barProps} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Panel>

        <Panel
          title="Steps recorded per day"
          description="All synced steps. A sudden drop usually points to a sync problem."
          actions={<span className="num text-xs text-ink-muted">{formatNumber(stepsTotal)} total</span>}
        >
          {kpiLoading ? (
            <ChartSkeleton height={220} />
          ) : stepsTotal === 0 ? (
            <EmptyState size="compact" icon={Footprints} title="No steps synced in this period" description="If users are active, check step sync and ops monitoring." />
          ) : (
            <div className="h-[220px]">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={stats?.step_chart ?? []} margin={{ top: 8, right: 8, bottom: 0, left: -8 }}>
                  <CartesianGrid {...gridProps} />
                  <XAxis dataKey="date" {...xAxisProps} />
                  <YAxis {...yAxisProps} domain={[0, stepTicks[stepTicks.length - 1]]} ticks={stepTicks} tickFormatter={tickFormat.number} />
                  <Tooltip cursor={lineCursor} content={<ChartTooltip hideSwatch formatValue={valueFormat.number} />} />
                  <Line dataKey="steps" name="Steps" stroke={SERIES[0]} {...lineProps} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </Panel>

        <Panel
          title="New signups per day"
          description={`Accounts created · last ${days} days`}
          actions={<span className="num text-xs text-ink-muted">{formatNumber(signupsTotal)} total</span>}
        >
          {kpiLoading ? (
            <ChartSkeleton height={180} />
          ) : signupsTotal === 0 ? (
            <EmptyState size="compact" icon={UserPlus} title="No new accounts in this period" />
          ) : (
            <div className="h-[180px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={stats?.user_chart ?? []} margin={{ top: 4, right: 4, bottom: 0, left: -8 }}>
                  <CartesianGrid {...gridProps} />
                  <XAxis dataKey="date" {...xAxisProps} />
                  <YAxis {...yAxisProps} domain={[0, signupTicks[signupTicks.length - 1]]} ticks={signupTicks} tickFormatter={tickFormat.number} />
                  <Tooltip cursor={barCursor} content={<ChartTooltip hideSwatch formatValue={valueFormat.number} />} />
                  <Bar dataKey="users" name="Signups" fill={SERIES[0]} {...barProps} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Panel>

        <Panel
          title="Challenges by status"
          description="Current count across all challenges"
          footer={
            <Link to="/challenges" className="inline-flex items-center gap-1 text-xs font-medium text-brand-text hover:underline">
              Manage challenges <ChevronRight size={13} aria-hidden />
            </Link>
          }
        >
          {kpiLoading ? (
            <div className="space-y-4" aria-hidden>
              {[0, 1, 2].map((i) => <Skeleton key={i} height={28} />)}
            </div>
          ) : (
            (() => {
              const rows = [
                { label: 'Live', value: stats?.challenges_active ?? 0, note: 'accepting steps now' },
                { label: 'Awaiting approval', value: stats?.challenges_pending ?? 0, note: 'not visible to users yet' },
                { label: 'Completed', value: stats?.challenges_completed ?? 0, note: 'finalised' },
              ]
              const max = Math.max(1, ...rows.map((r) => r.value))
              return (
                <ul className="space-y-3.5">
                  {rows.map((r) => (
                    <li key={r.label}>
                      <div className="mb-1 flex items-baseline justify-between gap-3 text-sm">
                        <span className="text-ink-secondary">
                          {r.label} <span className="text-xs text-ink-muted">· {r.note}</span>
                        </span>
                        <span className="num font-semibold text-ink-primary">{formatNumber(r.value)}</span>
                      </div>
                      <div className="h-2 rounded-sm bg-surface-elevated" aria-hidden>
                        <div className="h-2 rounded-sm" style={{ width: `${(r.value / max) * 100}%`, background: SERIES[0] }} />
                      </div>
                    </li>
                  ))}
                </ul>
              )
            })()
          )}
        </Panel>
      </div>

      {/* ── Recent records ── */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 lg:items-start">
        <Panel
          padding="none"
          title="Latest anti-cheat flags"
          description="Most recent unresolved signals"
          actions={
            <Button size="sm" variant="ghost" onClick={() => navigate('/fraud')} rightIcon={<ChevronRight size={13} />}>
              Review
            </Button>
          }
        >
          {fraudQ.isLoading ? (
            <ListSkeleton rows={4} />
          ) : fraudQ.error ? (
            <ErrorState size="compact" error={fraudQ.error} onRetry={() => void fraudQ.refetch()} />
          ) : (fraud?.recent_flags ?? []).length === 0 ? (
            <EmptyState size="compact" icon={ShieldAlert} title="No open flags" description="New anti-cheat signals will be listed here." />
          ) : (
            <table className="w-full text-sm">
              <caption className="sr-only">Latest anti-cheat flags</caption>
              <thead>
                <tr className="border-b border-surface-border text-left text-xs text-ink-muted">
                  <th scope="col" className="px-4 py-2 font-medium">User</th>
                  <th scope="col" className="px-3 py-2 font-medium">Signal</th>
                  <th scope="col" className="px-3 py-2 font-medium">Severity</th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">Raised</th>
                </tr>
              </thead>
              <tbody>
                {(fraud?.recent_flags ?? []).slice(0, 6).map((f) => (
                  <tr key={f.id} className="border-b border-surface-border last:border-b-0">
                    <td className="max-w-40 truncate px-4 py-2 font-medium text-ink-primary">{f.user_username}</td>
                    <td className="px-3 py-2 text-ink-secondary">{f.flag_type.replace(/_/g, ' ')}</td>
                    <td className="px-3 py-2"><StatusBadge size="sm" status={f.severity} /></td>
                    <td className="whitespace-nowrap px-4 py-2 text-right text-xs text-ink-muted">{formatRelative(f.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        <Panel
          padding="none"
          title="Newest accounts"
          description="Latest registrations"
          actions={
            <Button size="sm" variant="ghost" onClick={() => navigate('/users')} rightIcon={<ChevronRight size={13} />}>
              All users
            </Button>
          }
        >
          {overviewQ.isLoading ? (
            <ListSkeleton rows={4} />
          ) : (stats?.recent_users ?? []).length === 0 ? (
            <EmptyState size="compact" icon={Users} title="No accounts yet" />
          ) : (
            <table className="w-full text-sm">
              <caption className="sr-only">Newest accounts</caption>
              <thead>
                <tr className="border-b border-surface-border text-left text-xs text-ink-muted">
                  <th scope="col" className="px-4 py-2 font-medium">Username</th>
                  <th scope="col" className="hidden px-3 py-2 font-medium sm:table-cell">Email</th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">Joined</th>
                </tr>
              </thead>
              <tbody>
                {(stats?.recent_users ?? []).slice(0, 6).map((u) => (
                  <tr key={u.id} className="border-b border-surface-border last:border-b-0">
                    <td className="px-4 py-2 font-medium text-ink-primary">{u.username}</td>
                    <td className="hidden max-w-56 truncate px-3 py-2 text-ink-secondary sm:table-cell">{u.email}</td>
                    <td className="whitespace-nowrap px-4 py-2 text-right text-xs text-ink-muted">{u.joined}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>
    </div>
  )
}
