import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { format } from 'date-fns'
import {
  ArrowDownToLine, ArrowUpFromLine, Banknote, CheckCircle2, ChevronDown, ChevronRight, Coins, Download, Landmark, RefreshCw, Scale, ShieldAlert,
} from 'lucide-react'
import { PageHeader } from '../components/PageHeader'
import { StatCard } from '../components/StatCard'
import { StatusBadge } from '../components/StatusBadge'
import { Panel } from '../components/ui/Card'
import { Button } from '../components/ui/Button'
import { EmptyState } from '../components/ui/EmptyState'
import { ErrorState } from '../components/ui/ErrorState'
import { Skeleton } from '../components/ui/Skeleton'
import { ChartLegend } from '../components/charts/ChartTooltip'
import { SERIES } from '../lib/chartTheme'
import { formatKES, formatKESShort, formatNumber, formatPercent } from '../lib/format'
import { downloadCsv, financeApi } from '../components/finance/api'
import { ChartSkeleton, MeterList, TimeBarChart, bucketDaily } from '../components/finance/charts'
import type { FinanceReport, ReconciliationCheck, WithdrawalStatus } from '../components/finance/types'
import {
  Money, PeriodPicker, WITHDRAWAL_STATUS_LABEL, When, formatPeriod, periodParams, toNum, type Period,
} from '../components/finance/ui'

const DAILY_KEYS = ['deposits', 'withdrawals_requested', 'withdrawals_paid', 'entries', 'payouts', 'refunds', 'fees'] as const

function sum(report: FinanceReport | undefined, key: (typeof DAILY_KEYS)[number]) {
  return (report?.daily ?? []).reduce((a, r) => a + (Number(r[key]) || 0), 0)
}

function FlowRow({ label, note, value, sign, strong }: { label: string; note?: string; value: unknown; sign?: '+' | '−' | '='; strong?: boolean }) {
  return (
    <li className={strong ? 'flex items-baseline justify-between gap-3 border-t border-surface-strong px-4 pb-1 pt-2.5' : 'flex items-baseline justify-between gap-3 px-4 py-2'}>
      <span className="min-w-0">
        <span className={strong ? 'block text-sm font-semibold text-ink-primary' : 'block text-sm text-ink-secondary'}>{label}</span>
        {note && <span className="block text-xs text-ink-muted">{note}</span>}
      </span>
      <span className="flex shrink-0 items-baseline gap-2">
        {sign && <span className="mono w-3 text-center text-ink-muted" aria-hidden>{sign}</span>}
        <Money value={value} className={strong ? 'font-semibold' : ''} />
      </span>
    </li>
  )
}

function CheckItem({ check }: { check: ReconciliationCheck }) {
  const [open, setOpen] = useState(false)
  const hasRows = !!check.rows?.length || !!check.detail
  const Icon = check.ok ? CheckCircle2 : ShieldAlert
  return (
    <li className="px-4 py-3">
      <div className="flex items-start gap-3">
        <Icon size={16} aria-hidden className={check.ok ? 'mt-0.5 shrink-0 text-success' : 'mt-0.5 shrink-0 text-danger'} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium text-ink-primary">{check.label}</p>
            <span className="flex items-center gap-2">
              {!check.ok && (
                <span className="num text-sm font-semibold text-danger">
                  {check.unit.startsWith('KSh') ? formatKES(toNum(check.value)) : formatNumber(check.value)}{' '}
                  <span className="text-xs font-normal text-ink-muted">{check.unit.replace(/^KSh /, '')}</span>
                </span>
              )}
              <StatusBadge size="sm" tone={check.ok ? 'success' : 'danger'} label={check.ok ? 'Pass' : 'Check'} />
            </span>
          </div>
          <p className="mt-0.5 text-xs text-ink-muted">{check.description}</p>
          {hasRows && !check.ok && (
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              className="mt-1.5 inline-flex items-center gap-1 text-xs font-medium text-brand-text hover:underline"
            >
              {open ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
              {open ? 'Hide details' : 'Show details'}
            </button>
          )}
          {open && check.detail && (
            <dl className="mt-2 grid grid-cols-2 gap-2 text-xs">
              {Object.entries(check.detail).map(([k, v]) => (
                <div key={k} className="rounded border border-surface-border px-2 py-1.5">
                  <dt className="text-ink-muted">{k.replace(/_/g, ' ')}</dt>
                  <dd className="mono text-ink-primary">{formatKES(toNum(v))}</dd>
                </div>
              ))}
            </dl>
          )}
          {open && check.rows && check.rows.length > 0 && (
            <div className="mt-2 overflow-x-auto rounded border border-surface-border">
              <table className="w-full text-xs">
                <caption className="sr-only">{check.label} details</caption>
                <thead>
                  <tr className="border-b border-surface-border text-left text-ink-muted">
                    {Object.keys(check.rows[0]).filter((k) => !k.endsWith('_id')).map((k) => (
                      <th key={k} scope="col" className="whitespace-nowrap px-2 py-1.5 font-medium">{k.replace(/_/g, ' ')}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {check.rows.map((r, i) => (
                    <tr key={i} className="border-b border-surface-border last:border-b-0">
                      {Object.entries(r).filter(([k]) => !k.endsWith('_id')).map(([k, v]) => (
                        <td key={k} className={typeof v === 'string' && /^-?\d+\.\d{2}$/.test(v) ? 'mono whitespace-nowrap px-2 py-1.5 text-right text-ink-primary' : 'px-2 py-1.5 text-ink-primary'}>
                          {typeof v === 'string' && /^-?\d+\.\d{2}$/.test(v) ? formatKES(toNum(v)) : String(v)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </li>
  )
}

function GatewayTable({ report }: { report: FinanceReport }) {
  const statuses = ['completed', 'pending', 'initiated', 'failed', 'cancelled']
  const rows = (['deposit', 'payout'] as const).map((type) => {
    const cells = statuses.map((s) => report.gateway[`${type}:${s}`] ?? { count: 0, amount_kes: '0.00' })
    const total = cells.reduce((a, c) => a + c.count, 0)
    const failed = cells[3].count + cells[4].count
    return { type, cells, total, failed }
  })
  return (
    <table className="w-full text-sm">
      <caption className="sr-only">Gateway results by type and status</caption>
      <thead>
        <tr className="border-b border-surface-border text-xs text-ink-muted">
          <th scope="col" className="px-4 py-2 text-left font-medium">Type</th>
          {statuses.map((s) => <th key={s} scope="col" className="px-3 py-2 text-right font-medium capitalize">{s}</th>)}
          <th scope="col" className="px-4 py-2 text-right font-medium">Failed or cancelled</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.type} className="border-b border-surface-border last:border-b-0">
            <th scope="row" className="px-4 py-2 text-left font-medium text-ink-primary">{r.type === 'deposit' ? 'STK deposits' : 'Payouts'}</th>
            {r.cells.map((c, i) => (
              <td key={i} className="num px-3 py-2 text-right text-ink-primary" title={formatKES(toNum(c.amount_kes))}>
                {c.count ? formatNumber(c.count) : <span className="text-ink-muted">0</span>}
              </td>
            ))}
            <td className="num px-4 py-2 text-right">
              {r.total ? (
                <span className={r.failed ? 'font-semibold text-danger' : 'text-ink-secondary'}>{formatPercent((r.failed / r.total) * 100, { digits: 0 })}</span>
              ) : (
                <span className="text-ink-muted">—</span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export function ReportsPage() {
  const [period, setPeriod] = useState<Period>({ preset: '30', from: '', to: '' })
  const params = periodParams(period)
  const q = useQuery({
    queryKey: ['admin', 'finance', 'report', params],
    queryFn: () => financeApi.report(params),
    placeholderData: (prev) => prev,
  })
  const r = q.data
  const loading = q.isLoading

  const deposits = sum(r, 'deposits')
  const paid = sum(r, 'withdrawals_paid')
  const { rows: flowRows, unit } = bucketDaily(r?.daily ?? [], [...DAILY_KEYS])
  const failedChecks = (r?.reconciliation ?? []).filter((c) => !c.ok).length

  const exportDaily = () => {
    if (!r) return
    downloadCsv(
      `step2win-finance-${r.period.from}_${r.period.to}.csv`,
      ['date', 'deposits_kes', 'withdrawals_requested_kes', 'withdrawals_paid_kes', 'challenge_entries_kes', 'challenge_payouts_kes', 'refunds_kes', 'platform_fees_kes'],
      r.daily.map((d) => [d.date, d.deposits.toFixed(2), d.withdrawals_requested.toFixed(2), d.withdrawals_paid.toFixed(2), d.entries.toFixed(2), d.payouts.toFixed(2), d.refunds.toFixed(2), d.fees.toFixed(2)]),
    )
  }

  const withdrawalRows = r
    ? (Object.keys(WITHDRAWAL_STATUS_LABEL) as WithdrawalStatus[]).map((s) => ({
        key: s,
        label: WITHDRAWAL_STATUS_LABEL[s],
        value: toNum(r.withdrawals.requested_by_status[s]?.amount_kes),
        note: `${r.withdrawals.requested_by_status[s]?.count ?? 0} requests`,
      }))
    : []

  return (
    <div className="space-y-5">
      <PageHeader
        title="Financial reports"
        description="Where money came from and went for a period, and whether the books agree."
        meta={r ? `${formatPeriod(r.period.from, r.period.to)} · ${r.period.timezone} · generated ${format(new Date(r.generated_at), 'HH:mm')}` : undefined}
        actions={
          <>
            <PeriodPicker value={period} onChange={setPeriod} />
            <Button size="sm" variant="secondary" leftIcon={<Download size={13} />} onClick={exportDaily} disabled={!r}>
              Export CSV
            </Button>
            <Button size="sm" variant="secondary" leftIcon={<RefreshCw size={13} />} loading={q.isFetching} onClick={() => void q.refetch()}>
              Refresh
            </Button>
          </>
        }
      />

      {q.error && !r ? (
        <Panel><ErrorState title="Could not load the financial report" error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} /></Panel>
      ) : (
        <>
          <section aria-label="Period summary" className="grid grid-cols-2 gap-3 md:grid-cols-3 min-[87.5rem]:grid-cols-5">
            <StatCard label="Platform fee revenue" icon={Coins} loading={loading} value={formatKESShort(r?.revenue.platform_fees_kes)}
              hint={r ? `${r.revenue.fee_records} challenge${r.revenue.fee_records === 1 ? '' : 's'} finalised` : undefined} />
            <StatCard label="Deposits credited" icon={ArrowDownToLine} loading={loading} value={formatKESShort(r?.ledger.deposit.amount_kes)}
              hint={r ? `${formatNumber(r.ledger.deposit.count)} deposits` : undefined} to="/transactions" />
            <StatCard label="Withdrawals paid" icon={ArrowUpFromLine} loading={loading} value={formatKESShort(r?.withdrawals.paid_kes)}
              hint={r ? `${r.withdrawals.paid_count} confirmed by gateway` : undefined} to="/withdrawals" />
            <StatCard label="Net cash in" icon={Scale} loading={loading} value={formatKESShort(r?.net_cash_kes)} hint="Deposits minus paid withdrawals" />
            <StatCard label="Held in open pools" icon={Landmark} loading={loading} value={formatKESShort(r?.pools.open_kes)}
              hint={r ? `${r.pools.open_count} open challenges · right now` : undefined} to="/challenges" />
          </section>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
            <Panel
              className="xl:col-span-2"
              title="Cash in vs cash out"
              description={`Deposits credited vs withdrawals paid, KSh per ${unit}`}
              actions={
                <ChartLegend items={[
                  { label: 'Deposits', color: SERIES[0], value: formatKESShort(deposits) },
                  { label: 'Withdrawals paid', color: SERIES[1], value: formatKESShort(paid) },
                ]} />
              }
            >
              {loading ? <ChartSkeleton height={240} /> : deposits + paid === 0 ? (
                <EmptyState size="compact" icon={Banknote} title="No deposits or paid withdrawals in this period" />
              ) : (
                <TimeBarChart rows={flowRows} unit={unit} kind="kes" height={240} series={[
                  { key: 'deposits', label: 'Deposits', color: SERIES[0] },
                  { key: 'withdrawals_paid', label: 'Withdrawals paid', color: SERIES[1] },
                ]} />
              )}
            </Panel>

            <Panel padding="none" title="Challenge money" description="Entries in, winnings and refunds out, fees kept">
              {loading || !r ? (
                <div className="space-y-3 p-4" aria-hidden>{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} height={18} />)}</div>
              ) : (
                <ul className="py-1">
                  <FlowRow label="Entry contributions" note={`${formatNumber(r.ledger.challenge_entry.count)} entries debited`} value={r.ledger.challenge_entry.amount_kes} />
                  <FlowRow label="Paid to winners" note={`${formatNumber(r.ledger.payout.count)} payouts credited`} value={r.ledger.payout.amount_kes} sign="−" />
                  <FlowRow label="Refunded" note={`${formatNumber(r.ledger.refund.count)} refunds (challenges and failed payouts)`} value={r.ledger.refund.amount_kes} sign="−" />
                  <FlowRow label="Platform fees" note="Recorded when a challenge is finalised" value={r.revenue.platform_fees_kes} strong />
                  <li className="mt-2 border-t border-surface-border px-4 py-2.5 text-xs text-ink-muted">
                    Pools finalised: <Money value={r.pools.finalised_kes} className="text-xs" /> ({r.pools.finalised_count}) · cancelled:{' '}
                    <Money value={r.pools.cancelled_kes} className="text-xs" /> ({r.pools.cancelled_count})
                  </li>
                </ul>
              )}
            </Panel>
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Panel title="Withdrawals requested, by outcome" description="Requests created in the period, KSh by current status"
              footer={<Link to="/withdrawals" className="inline-flex items-center gap-1 text-xs font-medium text-brand-text hover:underline">Open withdrawals <ChevronRight size={13} aria-hidden /></Link>}>
              {loading ? <div className="space-y-4" aria-hidden>{[0, 1, 2, 3].map((i) => <Skeleton key={i} height={26} />)}</div>
                : withdrawalRows.every((w) => w.value === 0) ? <EmptyState size="compact" title="No withdrawal requests in this period" />
                : <MeterList rows={withdrawalRows.filter((w) => w.value > 0)} color={SERIES[1]} format={(v) => formatKES(v)} />}
            </Panel>

            <Panel padding="none" title="Gateway results" description="IntaSend transactions created in the period, by status (hover a count for KSh)">
              {loading || !r ? <div className="space-y-3 p-4" aria-hidden><Skeleton height={20} /><Skeleton height={20} /></div> : <div className="overflow-x-auto"><GatewayTable report={r} /></div>}
            </Panel>
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 lg:items-start">
            <Panel
              padding="none"
              title="Reconciliation checks"
              description={r ? `Point-in-time checks · run ${format(new Date(r.generated_at), 'HH:mm')}` : 'Point-in-time checks'}
              actions={r && <StatusBadge tone={failedChecks ? 'danger' : 'success'} label={failedChecks ? `${failedChecks} to review` : 'All passing'} />}
            >
              {loading || !r ? (
                <div className="space-y-3 p-4" aria-hidden>{[0, 1, 2, 3].map((i) => <Skeleton key={i} height={34} />)}</div>
              ) : (
                <ul className="divide-y divide-[var(--border)]">
                  {[...r.reconciliation].sort((a, b) => Number(a.ok) - Number(b.ok)).map((c) => <CheckItem key={c.key} check={c} />)}
                </ul>
              )}
            </Panel>

            <Panel padding="none" title="Fee revenue by challenge" description="Largest platform fees collected in the period">
              {loading || !r ? (
                <div className="space-y-3 p-4" aria-hidden>{[0, 1, 2].map((i) => <Skeleton key={i} height={18} />)}</div>
              ) : r.revenue.top_challenges.length === 0 ? (
                <EmptyState size="compact" icon={Coins} title="No platform fees in this period" description="Fees are recorded when a paid challenge is finalised." />
              ) : (
                <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <caption className="sr-only">Platform fees by challenge</caption>
                  <thead>
                    <tr className="border-b border-surface-border text-left text-xs text-ink-muted">
                      <th scope="col" className="px-4 py-2 font-medium">Challenge</th>
                      <th scope="col" className="hidden px-3 py-2 text-right font-medium sm:table-cell">Pool</th>
                      <th scope="col" className="px-3 py-2 text-right font-medium">Fee</th>
                      <th scope="col" className="px-4 py-2 text-right font-medium">Collected</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.revenue.top_challenges.map((c) => (
                      <tr key={`${c.challenge_id}-${c.collected_at}`} className="border-b border-surface-border last:border-b-0">
                        <td className="px-4 py-2 font-medium text-ink-primary"><span className="block max-w-[16rem] truncate" title={c.challenge}>{c.challenge}</span></td>
                        <td className="hidden px-3 py-2 text-right sm:table-cell"><Money value={c.total_pool} muted /></td>
                        <td className="px-3 py-2 text-right"><Money value={c.amount_kes} /></td>
                        <td className="whitespace-nowrap px-4 py-2 text-right text-xs text-ink-muted"><When value={c.collected_at} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
              )}
            </Panel>
          </div>
        </>
      )}
    </div>
  )
}

