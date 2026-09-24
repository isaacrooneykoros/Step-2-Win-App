import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { format } from 'date-fns'
import { Activity, Footprints, RefreshCw, Trophy, UserPlus, Users, Wallet } from 'lucide-react'
import { PageHeader } from '../components/PageHeader'
import { StatCard } from '../components/StatCard'
import { Panel } from '../components/ui/Card'
import { Button } from '../components/ui/Button'
import { EmptyState } from '../components/ui/EmptyState'
import { ErrorState } from '../components/ui/ErrorState'
import { Skeleton } from '../components/ui/Skeleton'
import { ChartLegend } from '../components/charts/ChartTooltip'
import { SERIES } from '../lib/chartTheme'
import { formatCompact, formatKES, formatNumber, formatPercent } from '../lib/format'
import { financeApi } from '../components/finance/api'
import { ChartSkeleton, MeterList, TimeBarChart, TimeLineChart, bucketDaily } from '../components/finance/charts'
import type { AnalyticsReport } from '../components/finance/types'
import { Figure, PeriodPicker, formatPeriod, periodParams, toNum, type Period } from '../components/finance/ui'

const STATUS_LABEL: Record<string, string> = { pending: 'Awaiting approval', active: 'Live', completed: 'Completed', cancelled: 'Cancelled' }

/** Retention cell: single-hue sequential wash (brand green), text stays ink. */
function CohortTable({ cohorts }: { cohorts: AnalyticsReport['cohorts'] }) {
  const weeks = Math.max(0, ...cohorts.map((c) => c.retention_pct.length))
  const visible = cohorts.filter((c) => c.size > 0)
  if (visible.length === 0) {
    return <EmptyState size="compact" icon={UserPlus} title="No signups in the last 8 weeks" description="Cohorts appear once new accounts are created." />
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[34rem] border-separate border-spacing-0.5 text-xs">
        <caption className="sr-only">Share of each weekly signup cohort that synced steps in each following week</caption>
        <thead>
          <tr className="text-ink-muted">
            <th scope="col" className="px-2 py-1.5 text-left font-medium">Signup week</th>
            <th scope="col" className="px-2 py-1.5 text-right font-medium">Users</th>
            {Array.from({ length: weeks }).map((_, i) => (
              <th key={i} scope="col" className="px-1 py-1.5 text-center font-medium">W{i}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {visible.map((c) => (
            <tr key={c.week_start}>
              <th scope="row" className="whitespace-nowrap px-2 py-1.5 text-left font-medium text-ink-primary">
                {format(new Date(`${c.week_start}T00:00:00`), 'd MMM')}
              </th>
              <td className="num px-2 py-1.5 text-right text-ink-secondary">{c.size}</td>
              {Array.from({ length: weeks }).map((_, i) => {
                const v = c.retention_pct[i]
                if (v === undefined || v === null) return <td key={i} className="rounded-sm bg-surface-sunken/60" aria-label="Not yet reached" />
                return (
                  <td
                    key={i}
                    className="num rounded-sm px-1 py-1.5 text-center font-medium text-ink-primary"
                    style={{ background: `color-mix(in srgb, var(--chart-1) ${Math.round(8 + v * 0.55)}%, var(--surface-card))` }}
                  >
                    {Math.round(v)}%
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function AnalyticsPage() {
  const [period, setPeriod] = useState<Period>({ preset: '30', from: '', to: '' })
  const params = periodParams(period)
  const q = useQuery({
    queryKey: ['admin', 'finance', 'analytics', params],
    queryFn: () => financeApi.analytics(params),
    placeholderData: (prev) => prev,
  })
  const a = q.data
  const loading = q.isLoading
  const keys = ['signups', 'active_users', 'steps', 'challenge_joins', 'challenges_created']
  const { rows, unit } = bucketDaily(a?.daily ?? [], keys)
  // Averages don't sum: for weekly buckets use per-day values averaged.
  const avgRows = unit === 'week'
    ? rows.map((r) => ({ ...r, active_users: Math.round((Number(r.active_users) || 0) / (Number(r.days) || 7)), avg: Number(r.active_users) ? Math.round(Number(r.steps) / Number(r.active_users)) : 0 }))
    : (a?.daily ?? []).map((d) => ({ ...d, avg: d.avg_steps_per_active }))

  const signups = (a?.daily ?? []).reduce((s, d) => s + d.signups, 0)
  const joins = (a?.daily ?? []).reduce((s, d) => s + d.challenge_joins, 0)
  const created = (a?.daily ?? []).reduce((s, d) => s + d.challenges_created, 0)

  return (
    <div className="space-y-5">
      <PageHeader
        title="Analytics"
        description="Who walks, who comes back, and how challenges follow. Active = at least one step synced that day."
        meta={a ? `${formatPeriod(a.period.from, a.period.to)} · ${a.period.timezone} · generated ${format(new Date(a.generated_at), 'HH:mm')}` : undefined}
        actions={
          <>
            <PeriodPicker value={period} onChange={setPeriod} />
            <Button size="sm" variant="secondary" leftIcon={<RefreshCw size={13} />} loading={q.isFetching} onClick={() => void q.refetch()}>
              Refresh
            </Button>
          </>
        }
      />

      {q.error && !a ? (
        <Panel><ErrorState title="Could not load analytics" error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} /></Panel>
      ) : (
        <>
          <section aria-label="Key metrics" className="grid grid-cols-2 gap-3 md:grid-cols-3 min-[87.5rem]:grid-cols-6">
            <StatCard label="Total users" icon={Users} loading={loading} value={formatNumber(a?.users.total)} hint={a ? `${formatNumber(a.users.new)} new in period` : undefined} to="/users" />
            <StatCard label="Active in period" icon={Activity} loading={loading} value={formatNumber(a?.users.active_in_period)}
              hint={a && a.users.total ? `${formatPercent((a.users.active_in_period / a.users.total) * 100, { digits: 0 })} of all users` : undefined} />
            <StatCard label="Avg daily active" icon={Activity} loading={loading} value={formatNumber(a?.users.avg_daily_active, 1)}
              hint={a?.users.stickiness_pct !== null && a?.users.stickiness_pct !== undefined ? `${formatPercent(a.users.stickiness_pct, { digits: 0 })} of 30-day actives` : 'No 30-day actives'} />
            <StatCard label="Active last 30 days" icon={Users} loading={loading} value={formatNumber(a?.users.active_last_30d)} hint={a ? `${formatNumber(a.users.active_last_7d)} in last 7 days` : undefined} />
            <StatCard label="Steps per active day" icon={Footprints} loading={loading} value={formatNumber(a?.steps.avg_per_active_day)}
              hint={a ? `${formatCompact(a.steps.total)} steps in period` : undefined} to="/steps" />
            <StatCard label="Challenge joins" icon={Trophy} loading={loading} value={formatNumber(a?.challenges.joins)}
              hint={a ? `${formatNumber(a.challenges.unique_joiners)} different users` : undefined} to="/challenges" />
          </section>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Panel title="Daily active walkers" description={`Users with at least one step synced${unit === 'week' ? ' · weekly average per day' : ' per day'}`}
              actions={a && <span className="num text-xs text-ink-muted">avg {formatNumber(a.users.avg_daily_active, 1)} per day</span>}>
              {loading ? <ChartSkeleton height={220} /> : !a || a.users.active_in_period === 0 ? (
                <EmptyState size="compact" icon={Activity} title="Nobody synced steps in this period" description="If users are walking, check step sync in ops monitoring." />
              ) : (
                <TimeLineChart rows={avgRows} unit={unit} kind="number" series={[{ key: 'active_users', label: 'Active walkers', color: SERIES[0] }]} />
              )}
            </Panel>

            <Panel title="New signups" description={`Accounts created per ${unit}`} actions={a && <span className="num text-xs text-ink-muted">{formatNumber(signups)} total</span>}>
              {loading ? <ChartSkeleton height={220} /> : signups === 0 ? (
                <EmptyState size="compact" icon={UserPlus} title="No new accounts in this period" />
              ) : (
                <TimeBarChart rows={rows} unit={unit} kind="number" series={[{ key: 'signups', label: 'Signups', color: SERIES[0] }]} />
              )}
            </Panel>
          </div>

          <Panel title="Retention by signup week" description="Share of each weekly signup cohort that synced steps in week 0, 1, 2… after signing up · last 8 weeks">
            {loading || !a ? <div className="space-y-2" aria-hidden>{[0, 1, 2, 3].map((i) => <Skeleton key={i} height={24} />)}</div> : <CohortTable cohorts={a.cohorts} />}
          </Panel>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Panel title="Average steps per active walker" description={`Steps divided by active walkers, per ${unit === 'week' ? 'week (daily average)' : 'day'}`}>
              {loading ? <ChartSkeleton height={220} /> : !a || a.steps.total === 0 ? (
                <EmptyState size="compact" icon={Footprints} title="No steps synced in this period" />
              ) : (
                <TimeLineChart rows={avgRows} unit={unit} kind="number" series={[{ key: 'avg', label: 'Steps per walker', color: SERIES[0] }]} />
              )}
            </Panel>

            <Panel title="How far active users walk" description="Walker-days in the period by daily step total">
              {loading || !a ? <div className="space-y-4" aria-hidden>{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} height={24} />)}</div> : a.steps.user_days === 0 ? (
                <EmptyState size="compact" icon={Footprints} title="No walker-days in this period" />
              ) : (
                <MeterList
                  color={SERIES[0]}
                  format={(v) => `${formatNumber(v)} · ${formatPercent((v / a.steps.user_days) * 100, { digits: 0 })}`}
                  rows={a.steps.distribution.map((d) => ({ key: d.label, label: `${d.label} steps`, value: d.user_days }))}
                />
              )}
            </Panel>
          </div>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
            <Panel className="xl:col-span-2" title="Challenge activity" description={`Joins and new challenges per ${unit}`}
              actions={a && <ChartLegend items={[
                { label: 'Joins', color: SERIES[0], value: formatNumber(joins) },
                { label: 'Challenges created', color: SERIES[1], value: formatNumber(created) },
              ]} />}>
              {loading ? <ChartSkeleton height={220} /> : joins + created === 0 ? (
                <EmptyState size="compact" icon={Trophy} title="No challenge activity in this period" />
              ) : (
                <TimeBarChart rows={rows} unit={unit} kind="number" series={[
                  { key: 'challenge_joins', label: 'Joins', color: SERIES[0] },
                  { key: 'challenges_created', label: 'Challenges created', color: SERIES[1] },
                ]} />
              )}
            </Panel>

            <Panel title="Challenges created in period" description="By current status">
              {loading || !a ? <div className="space-y-4" aria-hidden>{[0, 1, 2, 3].map((i) => <Skeleton key={i} height={24} />)}</div> : a.challenges.created === 0 ? (
                <EmptyState size="compact" icon={Trophy} title="No challenges created in this period" />
              ) : (
                <MeterList color={SERIES[1]} format={(v) => formatNumber(v)}
                  rows={Object.entries(a.challenges.status).map(([k, v]) => ({ key: k, label: STATUS_LABEL[k] ?? k, value: v }))} />
              )}
            </Panel>
          </div>

          <Panel title="Conversion and outcomes" description="From signing up to paying in and finishing a challenge">
            {loading || !a ? (
              <div className="grid grid-cols-2 gap-4 md:grid-cols-5" aria-hidden>{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} height={40} />)}</div>
            ) : (
              <div className="grid grid-cols-2 gap-x-4 gap-y-5 md:grid-cols-3 xl:grid-cols-5">
                <Figure label="New users who joined a challenge" value={a.money.new_user_join_rate_pct === null ? '—' : formatPercent(a.money.new_user_join_rate_pct, { digits: 0 })}
                  hint={`${formatNumber(a.money.new_users_joined_challenge)} of ${formatNumber(a.users.new)} new users`} />
                <Figure label="Users who deposited" value={formatNumber(a.money.depositors)} hint="At least one deposit credited in period" />
                <Figure label="Avg participants per challenge" value={formatNumber(a.challenges.avg_participants, 1)} hint={`${formatNumber(a.challenges.created)} challenges created`} />
                <Figure label="Avg entry contribution" value={a.challenges.avg_entry_fee_kes === null ? '—' : formatKES(toNum(a.challenges.avg_entry_fee_kes))} hint="Challenges created in period" />
                <Figure label="Qualified finishers" value={a.challenges.qualification_rate_pct === null ? '—' : formatPercent(a.challenges.qualification_rate_pct, { digits: 0 })}
                  hint={a.challenges.finished_participants ? `${formatNumber(a.challenges.qualified_participants)} of ${formatNumber(a.challenges.finished_participants)} in finalised challenges` : 'No challenges finalised in period'} />
              </div>
            )}
          </Panel>

          <p className="flex items-center gap-1.5 text-xs text-ink-muted">
            <Wallet size={12} aria-hidden /> Money totals for the same period are in Financial reports.
          </p>
        </>
      )}
    </div>
  )
}
