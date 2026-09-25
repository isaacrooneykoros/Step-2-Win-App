import { useLiveRefetchInterval } from '../lib/realtime/useAdminRealtime'
import { useMemo, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { AlertTriangle, ArrowUpRight, CheckCircle2, CircleSlash, Info, RefreshCw, XCircle } from 'lucide-react'
import { PageHeader } from '../components/PageHeader'
import { Panel } from '../components/ui/Card'
import { Button } from '../components/ui/Button'
import { EmptyState } from '../components/ui/EmptyState'
import { ErrorState } from '../components/ui/ErrorState'
import { Skeleton } from '../components/ui/Skeleton'
import { ChartLegend, ChartTooltip } from '../components/charts/ChartTooltip'
import { SERIES, barCursor, gridProps, xAxisProps, yAxisProps } from '../lib/chartTheme'
import { cn } from '../lib/cn'
import { formatDateTime, formatNumber, formatPercent, formatRelative, sumBy } from '../lib/format'
import { trustApi } from '../components/trust/api'
import { formatAge } from '../components/trust/rules'
import type { OpsMonitoringResponse } from '../types/admin'

type CheckState = 'breach' | 'near' | 'ok' | 'watch' | 'info' | 'nodata'

interface Check {
  key: string
  group: 'Payments' | 'Withdrawals' | 'Wallets' | 'Anti-cheat'
  name: string
  what: string
  actual: ReactNode
  threshold: ReactNode
  state: CheckState
  link?: { to: string; label: string }
}

const STATE: Record<CheckState, { label: string; icon: typeof CheckCircle2; cls: string }> = {
  breach: { label: 'Breach', icon: XCircle, cls: 'bg-danger-soft text-danger' },
  near: { label: 'Near limit', icon: AlertTriangle, cls: 'bg-warning-soft text-warning' },
  watch: { label: 'Needs attention', icon: AlertTriangle, cls: 'bg-warning-soft text-warning' },
  ok: { label: 'Within limit', icon: CheckCircle2, cls: 'bg-success-soft text-success' },
  info: { label: 'No threshold', icon: Info, cls: 'bg-neutral-soft text-ink-secondary' },
  nodata: { label: 'Not enough data', icon: CircleSlash, cls: 'bg-neutral-soft text-ink-secondary' },
}

function StateBadge({ state }: { state: CheckState }) {
  const s = STATE[state]
  const Icon = s.icon
  return (
    <span className={cn('inline-flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded px-2 text-xs font-medium', s.cls)}>
      <Icon size={12} aria-hidden strokeWidth={2.25} />
      {s.label}
    </span>
  )
}

const hasBreach = (breaches: string[], prefix: string) => breaches.some((b) => b.startsWith(prefix))

function buildChecks(d: OpsMonitoringResponse): Check[] {
  const m = d.metrics
  const t = d.thresholds
  const b = d.breaches ?? []
  const drift = d.anti_cheat_drift
  /** Breach comes from the backend; "near" = at 80%+ of a non-zero limit (display only). */
  const cmp = (breach: boolean, actual?: number, limit?: number): CheckState =>
    breach ? 'breach' : actual !== undefined && limit && actual >= limit * 0.8 ? 'near' : 'ok'
  const dupRejections = Object.values(m.duplicate_request_rejections_today ?? {}).reduce((a, n) => a + (Number(n) || 0), 0)

  const checks: Check[] = [
    {
      key: 'cb-rate', group: 'Payments', name: 'Callback failure rate',
      what: `Gateway callbacks in the last 24h not processed within 5 minutes (${formatNumber(m.callback_failures_24h)} of ${formatNumber(m.callback_total_24h)}).`,
      actual: formatPercent(m.callback_failure_rate_pct, { digits: 2 }), threshold: `≤ ${formatPercent(t.max_callback_failure_rate_pct)}`,
      state: m.callback_total_24h === 0 ? 'nodata' : cmp(hasBreach(b, 'callback_failure_rate_pct'), m.callback_failure_rate_pct, t.max_callback_failure_rate_pct),
      link: { to: '/transactions', label: 'Transactions' },
    },
    {
      key: 'cb-unprocessed', group: 'Payments', name: 'Unprocessed callbacks',
      what: 'Callbacks older than 5 minutes that were never processed.',
      actual: formatNumber(m.unprocessed_callbacks), threshold: `≤ ${formatNumber(t.max_unprocessed_callbacks)}`,
      state: cmp(hasBreach(b, 'unprocessed_callbacks'), m.unprocessed_callbacks, t.max_unprocessed_callbacks),
      link: { to: '/transactions', label: 'Transactions' },
    },
    {
      key: 'pay-stuck', group: 'Payments', name: 'Payments stuck in pending',
      what: 'Payment transactions still pending 15 minutes after their last update.',
      actual: formatNumber(m.stuck_pending_payments), threshold: 'None set',
      state: m.stuck_pending_payments > 0 ? 'watch' : 'info',
      link: { to: '/transactions', label: 'Transactions' },
    },
    {
      key: 'dup-refs', group: 'Payments', name: 'Duplicate gateway references',
      what: 'Completed payments sharing one M-Pesa reference (possible double credit).',
      actual: formatNumber(m.duplicate_gateway_references?.length ?? 0), threshold: '0',
      state: cmp(hasBreach(b, 'duplicate_gateway_references')),
      link: { to: '/transactions', label: 'Transactions' },
    },
    {
      key: 'wd-stuck', group: 'Withdrawals', name: 'Withdrawals stuck in processing',
      what: 'Payouts sent to the gateway with no result 15 minutes after their last update.',
      actual: formatNumber(m.stuck_processing_withdrawals), threshold: `≤ ${formatNumber(t.max_stuck_processing)}`,
      state: cmp(hasBreach(b, 'stuck_processing_withdrawals'), m.stuck_processing_withdrawals, t.max_stuck_processing),
      link: { to: '/withdrawals', label: 'Withdrawals' },
    },
    {
      key: 'wd-queue', group: 'Withdrawals', name: 'Withdrawal review queue',
      what: m.withdrawal_queue.count ? `Oldest request waiting ${formatAge(m.withdrawal_queue.oldest_age_hours)}. The console’s review target is 24h.` : 'Requests waiting for an admin decision.',
      actual: formatNumber(m.withdrawal_queue.count), threshold: 'None set',
      state: m.withdrawal_queue.oldest_age_hours >= 24 ? 'watch' : 'info',
      link: { to: '/withdrawals', label: 'Withdrawals' },
    },
    {
      key: 'neg-bal', group: 'Wallets', name: 'Negative wallet balances',
      what: 'Users whose wallet balance is below zero.',
      actual: formatNumber(m.negative_balance_users), threshold: `≤ ${formatNumber(t.max_negative_balance_users)}`,
      state: cmp(hasBreach(b, 'negative_balance_users')),
      link: { to: '/users', label: 'Users' },
    },
    {
      key: 'dup-req', group: 'Wallets', name: 'Duplicate requests rejected today',
      what: `Repeated deposit/withdrawal submissions blocked by idempotency (${Object.entries(m.duplicate_request_rejections_today ?? {}).filter(([, n]) => Number(n) > 0).map(([k, n]) => `${k.replace('_', ' ')} ${n}`).join(', ') || 'none'}).`,
      actual: formatNumber(dupRejections), threshold: 'None set', state: 'info',
    },
    {
      key: 'flags', group: 'Anti-cheat', name: 'Open fraud flags',
      what: 'Flags raised by step verification that nobody has decided yet.',
      actual: formatNumber(m.fraud_open_flags), threshold: 'None set', state: m.fraud_open_flags > 0 ? 'watch' : 'info',
      link: { to: '/fraud', label: 'Anti-cheat' },
    },
  ]

  if (drift) {
    const enough = drift.window.enough_samples
    const dm = drift.metrics
    const dt = drift.thresholds
    const db = drift.breaches ?? []
    const st = (prefix: string): CheckState => (!enough ? 'nodata' : hasBreach(db, prefix) ? 'breach' : 'ok')
    checks.push(
      {
        key: 'drift-samples', group: 'Anti-cheat', name: 'Shadow verification samples',
        what: `Days compared between live and shadow step verification in the last ${dt.lookback_hours}h. Drift checks need at least ${dt.min_samples}.`,
        actual: formatNumber(dm.sample_count), threshold: `≥ ${formatNumber(dt.min_samples)}`, state: enough ? 'ok' : 'nodata',
      },
      {
        key: 'drift-avg', group: 'Anti-cheat', name: 'Step drift (average)',
        what: 'Average difference between legacy and shadow-verified step totals.',
        actual: enough ? formatPercent(dm.avg_abs_delta_pct) : '—', threshold: `≤ ${formatPercent(dt.max_avg_abs_delta_pct)}`, state: st('avg_abs_delta_pct'),
      },
      {
        key: 'drift-high', group: 'Anti-cheat', name: 'High-drift days',
        what: `Share of days drifting more than ${formatPercent(dt.per_sample_alert_pct)}.`,
        actual: enough ? formatPercent(dm.high_drift_ratio_pct) : '—', threshold: `≤ ${formatPercent(dt.max_high_drift_ratio_pct)}`, state: st('high_drift_ratio_pct'),
      },
      {
        key: 'drift-review', group: 'Anti-cheat', name: 'Review decision mismatch',
        what: 'Share of days where shadow verification would change the review decision.',
        actual: enough ? formatPercent(dm.review_mismatch_ratio_pct) : '—', threshold: `≤ ${formatPercent(dt.max_review_mismatch_ratio_pct)}`, state: st('review_mismatch_ratio_pct'),
      },
    )
  }
  return checks
}

const shortDay = (iso: string | number) => {
  const d = new Date(`${iso}T00:00:00`)
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

export function OpsMonitoringPage() {
  const refetchInterval = useLiveRefetchInterval(60_000)
  const opsQ = useQuery({ queryKey: ['admin', 'ops-monitoring'], queryFn: trustApi.ops, refetchInterval })
  const histQ = useQuery({ queryKey: ['admin', 'ops-monitoring', 'history'], queryFn: () => trustApi.opsHistory(14), refetchInterval: 300_000 })
  const d = opsQ.data
  const checks = useMemo(() => (d ? buildChecks(d) : []), [d])
  const breaches = checks.filter((c) => c.state === 'breach')
  const watch = checks.filter((c) => c.state === 'watch' || c.state === 'near')
  const withThreshold = checks.filter((c) => c.state === 'ok' || c.state === 'breach' || c.state === 'near')
  const groups = ['Payments', 'Withdrawals', 'Wallets', 'Anti-cheat'] as const

  const hist = histQ.data?.daily ?? []
  const cbData = hist.map((r) => ({ date: r.date, processed: r.callbacks - r.callbacks_unprocessed, unprocessed: r.callbacks_unprocessed }))
  const cbMax = Math.max(0, ...hist.map((r) => r.callbacks))
  const cbTicks = (() => {
    if (cbMax <= 0) return [0, 1]
    const step = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000].find((s) => cbMax / s <= 5) ?? Math.ceil(cbMax / 5)
    const out: number[] = []
    for (let v = 0; v < cbMax + step; v += step) out.push(v)
    return out
  })()

  return (
    <div className="space-y-5">
      <PageHeader
        title="Ops monitoring"
        description="Integrity checks run against live records each time this page loads. Thresholds come from the backend."
        meta={d ? <>Last checked {formatDateTime(d.timestamp)} ({formatRelative(d.timestamp)}) · re-runs every minute</> : undefined}
        actions={
          <Button size="sm" variant="secondary" leftIcon={<RefreshCw size={13} />} loading={opsQ.isFetching} onClick={() => { void opsQ.refetch(); void histQ.refetch() }}>
            Run checks now
          </Button>
        }
      />

      {opsQ.isLoading ? (
        <Skeleton height={64} />
      ) : opsQ.error ? (
        <ErrorState error={opsQ.error} onRetry={() => void opsQ.refetch()} title="Could not run the ops checks" />
      ) : d && (
        <div
          role="status"
          className={cn(
            'flex items-start gap-3 rounded-lg border px-4 py-3',
            breaches.length ? 'border-danger-line bg-danger-soft' : watch.length ? 'border-warning-line bg-warning-soft' : 'border-success-line bg-success-soft',
          )}
        >
          {breaches.length ? <XCircle size={18} className="mt-0.5 shrink-0 text-danger" aria-hidden /> : watch.length ? <AlertTriangle size={18} className="mt-0.5 shrink-0 text-warning" aria-hidden /> : <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-success" aria-hidden />}
          <div className="min-w-0 text-sm">
            <p className="font-semibold text-ink-primary">
              {breaches.length
                ? `${breaches.length} check${breaches.length === 1 ? '' : 's'} over threshold`
                : `All ${withThreshold.length} threshold checks are within limits`}
            </p>
            <p className="mt-0.5 text-ink-secondary">
              {breaches.length
                ? breaches.map((c) => c.name).join(' · ')
                : watch.length
                  ? `${watch.length} item${watch.length === 1 ? ' needs' : 's need'} attention: ${watch.map((c) => c.name.toLowerCase()).join(', ')}.`
                  : 'Nothing needs action right now.'}
            </p>
          </div>
        </div>
      )}

      <Panel title="Checks" description="Actual value against the backend threshold. Items without a threshold are shown for context." padding="none">
        {opsQ.isLoading ? (
          <div className="space-y-2 p-4">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} height={36} />)}</div>
        ) : opsQ.error ? (
          <div className="p-4 text-sm text-ink-muted">Checks unavailable.</div>
        ) : (
          <>
          <ul className="divide-y divide-[var(--border)] sm:hidden">
            {checks.map((c) => (
              <li key={c.key} className={cn('space-y-1.5 px-4 py-3', c.state === 'breach' && 'bg-danger-soft/40')}>
                <div className="flex items-start justify-between gap-2">
                  <p className="text-sm font-medium text-ink-primary">{c.name}</p>
                  <StateBadge state={c.state} />
                </div>
                <p className="text-xs text-ink-muted">{c.what}</p>
                <p className="num text-sm text-ink-secondary">
                  <span className={cn('font-semibold', c.state === 'breach' ? 'text-danger' : 'text-ink-primary')}>{c.actual}</span> · {c.threshold === 'None set' ? 'no threshold' : <>limit {c.threshold}</>}
                  {c.link && <> · <Link to={c.link.to} className="font-medium text-brand-text hover:underline">{c.link.label}</Link></>}
                </p>
              </li>
            ))}
          </ul>
          <div className="hidden overflow-x-auto sm:block">
            <table className="w-full min-w-[44rem] text-sm">
              <caption className="sr-only">Operational checks with actual values and thresholds</caption>
              <thead className="border-b border-surface-border text-xs text-ink-muted">
                <tr>
                  <th scope="col" className="px-4 py-2 text-left font-medium">Check</th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">Actual</th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">Threshold</th>
                  <th scope="col" className="px-4 py-2 text-left font-medium">Status</th>
                  <th scope="col" className="px-4 py-2 text-left font-medium"><span className="sr-only">Where to act</span></th>
                </tr>
              </thead>
              {groups.map((g) => {
                const rows = checks.filter((c) => c.group === g)
                if (!rows.length) return null
                return (
                  <tbody key={g} className="divide-y divide-[var(--border)] border-b border-surface-border last:border-b-0">
                    <tr className="bg-surface-base">
                      <th scope="rowgroup" colSpan={5} className="px-4 py-1.5 text-left text-2xs font-semibold uppercase tracking-wider text-ink-muted">{g}</th>
                    </tr>
                    {rows.map((c) => (
                      <tr key={c.key} className={cn(c.state === 'breach' && 'bg-danger-soft/40')}>
                        <td className="px-4 py-2.5 align-top">
                          <p className="font-medium text-ink-primary">{c.name}</p>
                          <p className="mt-0.5 max-w-[34rem] text-xs text-ink-muted">{c.what}</p>
                        </td>
                        <td className={cn('num px-4 py-2.5 text-right align-top font-semibold', c.state === 'breach' ? 'text-danger' : 'text-ink-primary')}>{c.actual}</td>
                        <td className="num px-4 py-2.5 text-right align-top text-ink-secondary">{c.threshold}</td>
                        <td className="px-4 py-2.5 align-top"><StateBadge state={c.state} /></td>
                        <td className="px-4 py-2.5 align-top">
                          {c.link && (
                            <Link to={c.link.to} className="inline-flex items-center gap-0.5 whitespace-nowrap text-xs font-medium text-brand-text hover:underline">
                              {c.link.label} <ArrowUpRight size={12} aria-hidden />
                            </Link>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                )
              })}
            </table>
          </div>
          </>
        )}
      </Panel>

      {d && d.metrics.duplicate_gateway_references?.length > 0 && (
        <Panel title="Duplicate gateway references" description="Completed payments that share an M-Pesa reference">
          <ul className="flex flex-wrap gap-2">
            {d.metrics.duplicate_gateway_references.map((r) => (
              <li key={r.mpesa_reference} className="mono rounded border border-danger-line bg-danger-soft px-2 py-1 text-xs text-danger">{r.mpesa_reference} × {r.c}</li>
            ))}
          </ul>
        </Panel>
      )}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-5">
        <Panel
          className="min-w-0 xl:col-span-2"
          title="Gateway callbacks per day"
          description="Last 14 days · from callback records"
          actions={hist.length > 0 && (
            <ChartLegend items={[
              { label: 'Processed', color: SERIES[0], value: formatNumber(sumBy(cbData, (r) => r.processed)) },
              { label: 'Unprocessed', color: SERIES[2], value: formatNumber(sumBy(cbData, (r) => r.unprocessed)) },
            ]} />
          )}
        >
          {histQ.isLoading ? <Skeleton height={220} /> : histQ.error ? (
            <ErrorState size="compact" error={histQ.error} onRetry={() => void histQ.refetch()} />
          ) : cbMax === 0 ? (
            <EmptyState size="compact" title="No callbacks in the last 14 days" />
          ) : (
            <div className="h-[220px]" role="img" aria-label="Gateway callbacks per day, processed and unprocessed">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={cbData} margin={{ top: 4, right: 4, bottom: 0, left: -16 }}>
                  <CartesianGrid {...gridProps} />
                  <XAxis dataKey="date" {...xAxisProps} tickFormatter={shortDay} />
                  <YAxis {...yAxisProps} width={40} domain={[0, cbTicks[cbTicks.length - 1]]} ticks={cbTicks} />
                  <Tooltip cursor={barCursor} content={<ChartTooltip formatLabel={(l) => (l === undefined ? '' : shortDay(l))} />} />
                  <Bar dataKey="processed" name="Processed" stackId="cb" fill={SERIES[0]} stroke="var(--surface-card)" strokeWidth={1} maxBarSize={20} isAnimationActive={false} />
                  <Bar dataKey="unprocessed" name="Unprocessed" stackId="cb" fill={SERIES[2]} stroke="var(--surface-card)" strokeWidth={1} maxBarSize={20} isAnimationActive={false} radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Panel>

        <Panel
          className="min-w-0 xl:col-span-3"
          title="Daily counts behind the checks"
          description="Check results are not stored, so this shows the underlying records per day"
          padding="none"
        >
          {histQ.isLoading ? <div className="p-4"><Skeleton height={220} /></div> : histQ.error ? (
            <div className="p-4"><ErrorState size="compact" error={histQ.error} onRetry={() => void histQ.refetch()} /></div>
          ) : (
            <div className="max-h-[272px] overflow-auto">
              <table className="w-full min-w-[36rem] text-xs">
                <caption className="sr-only">Daily counts, newest first</caption>
                <thead className="sticky top-0 bg-surface-card text-ink-muted shadow-[0_1px_0_var(--border)]">
                  <tr>
                    <th scope="col" className="px-4 py-2 text-left font-medium">Day</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">Callbacks</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">Unprocessed</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">Withdrawals</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">Payout failures</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">Payment failures</th>
                    <th scope="col" className="px-4 py-2 text-right font-medium">Fraud flags</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border)]">
                  {[...hist].reverse().map((r) => (
                    <tr key={r.date}>
                      <td className="num px-4 py-1.5 text-ink-secondary">{shortDay(r.date)}</td>
                      <td className="num px-3 py-1.5 text-right text-ink-primary">{formatNumber(r.callbacks)}</td>
                      <td className={cn('num px-3 py-1.5 text-right', r.callbacks_unprocessed ? 'font-semibold text-danger' : 'text-ink-muted')}>{formatNumber(r.callbacks_unprocessed)}</td>
                      <td className="num px-3 py-1.5 text-right text-ink-primary">{formatNumber(r.withdrawals_requested)}</td>
                      <td className={cn('num px-3 py-1.5 text-right', r.withdrawals_failed ? 'font-semibold text-danger' : 'text-ink-muted')}>{formatNumber(r.withdrawals_failed)}</td>
                      <td className={cn('num px-3 py-1.5 text-right', r.payments_failed ? 'font-semibold text-danger' : 'text-ink-muted')}>{formatNumber(r.payments_failed)}</td>
                      <td className="num px-4 py-1.5 text-right text-ink-primary">{formatNumber(r.fraud_flags)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>
    </div>
  )
}
