import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertOctagon, Banknote, CheckCircle2, Clock, History, Inbox, RefreshCw, RotateCw, X, XCircle } from 'lucide-react'
import { PageHeader } from '../components/PageHeader'
import { StatCard } from '../components/StatCard'
import { AdminTable, type Column } from '../components/AdminTable'
import { ConfirmModal } from '../components/ConfirmModal'
import { SlideOver } from '../components/SlideOver'
import { Panel } from '../components/ui/Card'
import { Button } from '../components/ui/Button'
import { Input, SearchInput, Select, Textarea } from '../components/ui/Input'
import { Tabs } from '../components/ui/Tabs'
import { Toolbar, FilterChip } from '../components/ui/Toolbar'
import { EmptyState } from '../components/ui/EmptyState'
import { ErrorState } from '../components/ui/ErrorState'
import { cn } from '../lib/cn'
import { formatAgeHours, formatKES, formatNumber } from '../lib/format'
import { ApiError, financeApi } from '../components/finance/api'
import { useDebounced, useMediaQuery } from '../components/finance/hooks'
import type { WithdrawalRow, WithdrawalStatus } from '../components/finance/types'
import { WithdrawalReview } from '../components/finance/WithdrawalReview'
import {
  AgeIndicator, METHOD_LABEL, Money, SLA_HOURS, WITHDRAWAL_STATUS_LABEL, When, WithdrawalStatusBadge, maskedDestination, slaTone, toNum,
} from '../components/finance/ui'

type Tab = 'queue' | 'history'
const REFRESH_MS = 30_000
/** Amounts at or above this need the amount typed to confirm the payout. */
const TYPE_TO_CONFIRM_KES = 5000
const HISTORY_PAGE = 25
const REJECT_REASONS = [
  'The destination number does not match the account holder.',
  'Account is under anti-cheat review. Please contact support.',
  'Duplicate request. Please submit a single withdrawal.',
]

interface ResultMessage {
  tone: 'success' | 'danger' | 'info'
  title: string
  body: string
}

function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 429) return `${err.message} Refresh the queue before trying again.`
    return err.message
  }
  return err instanceof Error ? err.message : 'Unknown error.'
}

function ResultBanner({ result, onDismiss }: { result: ResultMessage; onDismiss: () => void }) {
  const Icon = result.tone === 'success' ? CheckCircle2 : result.tone === 'danger' ? XCircle : AlertOctagon
  return (
    <div
      role={result.tone === 'danger' ? 'alert' : 'status'}
      className={cn(
        'flex items-start gap-3 rounded-lg border px-4 py-3',
        result.tone === 'success' && 'border-success-line bg-success-soft',
        result.tone === 'danger' && 'border-danger-line bg-danger-soft',
        result.tone === 'info' && 'border-surface-border bg-notice-soft',
      )}
    >
      <Icon
        size={17}
        aria-hidden
        className={cn('mt-0.5 shrink-0', result.tone === 'success' ? 'text-success' : result.tone === 'danger' ? 'text-danger' : 'text-notice')}
      />
      <div className="min-w-0 flex-1 text-sm">
        <p className="font-semibold text-ink-primary">{result.title}</p>
        <p className="mt-0.5 break-words text-ink-secondary">{result.body}</p>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss message"
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-ink-muted hover:bg-surface-card hover:text-ink-primary"
      >
        <X size={14} />
      </button>
    </div>
  )
}

export function AdminWithdrawalsPage() {
  const qc = useQueryClient()
  const wide = useMediaQuery('(min-width: 1280px)')
  const [tab, setTab] = useState<Tab>('queue')
  const [result, setResult] = useState<ResultMessage | null>(null)

  // Queue
  const [queueSearch, setQueueSearch] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)

  // History
  const [hStatus, setHStatus] = useState<string>('all')
  const [hMethod, setHMethod] = useState('')
  const [hSearch, setHSearch] = useState('')
  const [hFrom, setHFrom] = useState('')
  const [hTo, setHTo] = useState('')
  const [hPage, setHPage] = useState(1)
  const [historyRow, setHistoryRow] = useState<WithdrawalRow | null>(null)
  const hSearchDebounced = useDebounced(hSearch)

  // Actions
  const [approveTarget, setApproveTarget] = useState<WithdrawalRow | null>(null)
  const [rejectTarget, setRejectTarget] = useState<WithdrawalRow | null>(null)
  const [reason, setReason] = useState('')

  const statsQ = useQuery({ queryKey: ['admin', 'withdrawal-stats'], queryFn: financeApi.stats, refetchInterval: REFRESH_MS })
  const queueQ = useQuery({
    queryKey: ['admin', 'finance', 'withdrawals', 'queue'],
    queryFn: () => financeApi.withdrawals({ status: 'pending_review', limit: 200, offset: 0 }),
    refetchInterval: REFRESH_MS,
  })
  const historyFilters = {
    status: hStatus, method: hMethod || undefined, q: hSearchDebounced, from: hFrom || undefined, to: hTo || undefined,
    limit: HISTORY_PAGE, offset: (hPage - 1) * HISTORY_PAGE,
  }
  const historyQ = useQuery({
    queryKey: ['admin', 'finance', 'withdrawals', 'history', historyFilters],
    queryFn: () => financeApi.withdrawals(historyFilters),
    enabled: tab === 'history',
    placeholderData: (prev) => prev,
  })

  const queue = useMemo(() => queueQ.data?.results ?? [], [queueQ.data])
  const queueRows = useMemo(() => {
    const s = queueSearch.trim().toLowerCase()
    if (!s) return queue
    return queue.filter((w) =>
      [w.username, w.email, w.phone_number, w.id].some((v) => v?.toLowerCase().includes(s)),
    )
  }, [queue, queueSearch])

  const selected = queue.find((w) => w.id === selectedId) ?? null
  // On wide screens keep a request open in the review pane: the oldest by default.
  const paneRow = wide ? (selected ?? queueRows[0] ?? null) : null

  const overSla = queue.filter((w) => w.age_hours >= SLA_HOURS).length
  const oldest = queue[0]?.age_hours ?? null
  const stats = statsQ.data

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['admin', 'finance'] })
    void qc.invalidateQueries({ queryKey: ['admin', 'withdrawal-stats'] })
    void qc.invalidateQueries({ queryKey: ['admin', 'notifications'] })
    void qc.invalidateQueries({ queryKey: ['admin', 'overview'] })
    void qc.invalidateQueries({ queryKey: ['admin', 'ops-monitoring'] })
  }

  const nextAfter = (id: string) => {
    const idx = queueRows.findIndex((w) => w.id === id)
    return queueRows[idx + 1]?.id ?? queueRows[idx - 1]?.id ?? null
  }

  const approve = useMutation({
    mutationFn: (w: WithdrawalRow) => financeApi.approve(w.id),
    onSuccess: (data, w) => {
      setResult({
        tone: 'success',
        title: `Approved · ${formatKES(toNum(w.amount_kes))} to ${w.username}`,
        body: `Sent to IntaSend for ${METHOD_LABEL[w.method]} ${maskedDestination(w)}. Status is now ${data.status ?? 'processing'}${data.tracking_id ? ` · tracking ID ${data.tracking_id}` : ''}. The request is marked Paid when the gateway confirms.`,
      })
      setSelectedId(nextAfter(w.id))
      setDrawerOpen(false)
    },
    onError: (err, w) => {
      const status = err instanceof ApiError ? err.status : 0
      setResult({
        tone: 'danger',
        title: status === 502 ? `Payout failed · ${formatKES(toNum(w.amount_kes))} to ${w.username}` : `Could not approve ${w.username}'s withdrawal`,
        body:
          status === 502
            ? `${describeError(err)} The gateway call did not succeed, so the backend marked the request Failed and returned the amount to the user's wallet. It is listed under History.`
            : describeError(err),
      })
      if (status === 502) {
        setSelectedId(nextAfter(w.id))
        setDrawerOpen(false)
      }
    },
    onSettled: () => {
      setApproveTarget(null)
      invalidate()
    },
  })

  const reject = useMutation({
    mutationFn: ({ w, why }: { w: WithdrawalRow; why: string }) => financeApi.reject(w.id, why),
    onSuccess: (_d, { w }) => {
      setResult({
        tone: 'success',
        title: `Rejected · ${w.username}`,
        body: `${formatKES(toNum(w.amount_kes))} was returned to ${w.username}'s wallet and the user was notified with your reason.`,
      })
      setSelectedId(nextAfter(w.id))
      setDrawerOpen(false)
    },
    onError: (err, { w }) => setResult({ tone: 'danger', title: `Could not reject ${w.username}'s withdrawal`, body: describeError(err) }),
    onSettled: () => {
      setRejectTarget(null)
      setReason('')
      invalidate()
    },
  })

  const check = useMutation({
    mutationFn: (w: WithdrawalRow) => financeApi.checkStatus(w.id),
    onSuccess: (data, w) =>
      setResult({
        tone: 'info',
        title: `Gateway status for ${w.username}'s payout`,
        body: typeof data.result === 'object' ? JSON.stringify(data.result) : String(data.result ?? data.message ?? 'No details returned.'),
      }),
    onError: (err, w) => setResult({ tone: 'danger', title: `Could not check ${w.username}'s payout`, body: describeError(err) }),
  })

  const busy = approve.isPending || reject.isPending

  const openRow = (w: WithdrawalRow) => {
    setSelectedId(w.id)
    if (!wide) setDrawerOpen(true)
  }

  const actionsFor = (w: WithdrawalRow, layout: 'pane' | 'drawer') => {
    if (w.status === 'pending_review') {
      return (
        <div className={cn('flex gap-2', layout === 'pane' ? 'w-full' : 'justify-end')}>
          <Button variant="danger-soft" onClick={() => setRejectTarget(w)} disabled={busy} className={layout === 'pane' ? 'flex-1' : ''}>
            Reject
          </Button>
          <Button variant="primary" onClick={() => setApproveTarget(w)} disabled={busy} className={layout === 'pane' ? 'flex-[2]' : ''}>
            Approve and send
          </Button>
        </div>
      )
    }
    if ((w.status === 'failed' || w.status === 'processing' || w.status === 'approved') && w.tracking_reference) {
      return (
        <Button variant="secondary" leftIcon={<RotateCw size={13} />} loading={check.isPending} onClick={() => check.mutate(w)}>
          Check payout status
        </Button>
      )
    }
    return null
  }

  // ── Columns ──
  const queueColumns: Column<WithdrawalRow>[] = [
    {
      key: 'user', label: 'User', sortable: true, sortValue: (r) => r.username.toLowerCase(),
      render: (r) => (
        <span className="block min-w-0">
          <span className="block truncate font-medium">{r.username}</span>
          <span className="block truncate text-xs text-ink-muted">{METHOD_LABEL[r.method]} · <span className="mono">{maskedDestination(r)}</span></span>
        </span>
      ),
    },
    { key: 'amount', label: 'Amount', numeric: true, sortable: true, sortValue: (r) => toNum(r.amount_kes), render: (r) => <Money value={r.amount_kes} /> },
    { key: 'requested', label: 'Requested', hideBelow: 'md', render: (r) => <span className="text-ink-secondary"><When value={r.created_at} /></span> },
    { key: 'age', label: 'Waiting', align: 'right', sortable: true, sortValue: (r) => r.age_hours, render: (r) => <AgeIndicator hours={r.age_hours} /> },
  ]

  const historyColumns: Column<WithdrawalRow>[] = [
    { key: 'created', label: 'Requested', render: (r) => <span className="text-ink-secondary"><When value={r.created_at} /></span> },
    { key: 'user', label: 'User', render: (r) => <span className="font-medium">{r.username}</span> },
    { key: 'amount', label: 'Amount', numeric: true, render: (r) => <Money value={r.amount_kes} /> },
    { key: 'dest', label: 'Destination', hideBelow: 'lg', render: (r) => <span className="mono text-xs text-ink-secondary">{maskedDestination(r)}</span> },
    { key: 'status', label: 'Status', render: (r) => <WithdrawalStatusBadge status={r.status} /> },
    { key: 'reviewer', label: 'Reviewed by', hideBelow: 'xl', render: (r) => <span className="text-ink-secondary">{r.reviewed_by ?? '—'}</span> },
    {
      key: 'outcome', label: 'Note', hideBelow: 'md', className: 'max-w-[18rem]',
      render: (r) => {
        const note = r.fail_reason || r.rejection_reason
        return note ? <span className={cn('block truncate text-xs', r.fail_reason ? 'text-danger' : 'text-ink-secondary')} title={note}>{note}</span> : <span className="text-ink-muted">—</span>
      },
    },
  ]

  const historyChips = [
    hStatus !== 'all' && { key: 'status', label: `Status: ${WITHDRAWAL_STATUS_LABEL[hStatus as WithdrawalStatus] ?? hStatus}`, clear: () => setHStatus('all') },
    hMethod && { key: 'method', label: `Method: ${METHOD_LABEL[hMethod]}`, clear: () => setHMethod('') },
    hFrom && { key: 'from', label: `From ${hFrom}`, clear: () => setHFrom('') },
    hTo && { key: 'to', label: `To ${hTo}`, clear: () => setHTo('') },
  ].filter(Boolean) as Array<{ key: string; label: string; clear: () => void }>

  const approveAmount = approveTarget ? toNum(approveTarget.amount_kes) : 0
  const needsTyped = approveAmount >= TYPE_TO_CONFIRM_KES
  const reasonOk = reason.trim().length >= 5

  return (
    <div className="space-y-5">
      <PageHeader
        title="Withdrawals"
        description="Review payout requests oldest first. Approving sends the money through IntaSend straight away."
        actions={
          <Button
            size="sm"
            variant="secondary"
            leftIcon={<RefreshCw size={13} />}
            loading={queueQ.isFetching || statsQ.isFetching}
            onClick={() => { void queueQ.refetch(); void statsQ.refetch(); if (tab === 'history') void historyQ.refetch() }}
          >
            Refresh
          </Button>
        }
      />

      <section aria-label="Queue summary" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Awaiting review"
          icon={Inbox}
          loading={queueQ.isLoading}
          value={formatNumber(queueQ.data?.count)}
          hint={queueQ.data ? `${formatKES(toNum(queueQ.data.total_amount_kes))} requested` : undefined}
          tone={queueQ.data?.count ? 'warning' : 'default'}
        />
        <StatCard
          label="Oldest request"
          icon={Clock}
          loading={queueQ.isLoading}
          value={oldest === null ? 'None' : formatAgeHours(oldest)}
          hint={overSla ? `${overSla} over the ${SLA_HOURS}h review target` : `Review target ${SLA_HOURS}h`}
          tone={oldest === null ? 'default' : slaTone(oldest) === 'danger' ? 'danger' : slaTone(oldest) === 'warning' ? 'warning' : 'default'}
        />
        <StatCard
          label="Paid today"
          icon={Banknote}
          loading={statsQ.isLoading}
          value={stats ? formatKES(toNum(stats.total_paid_today)) : '—'}
          hint={stats ? `${stats.completed_today} confirmed by gateway · ${stats.approved_today} approved` : undefined}
        />
        <StatCard
          label="Failed today"
          icon={AlertOctagon}
          loading={statsQ.isLoading}
          value={formatNumber(stats?.failed_today)}
          hint={stats?.failed_today ? 'Refunded to wallets · see History' : 'No failed payouts'}
          tone={stats?.failed_today ? 'danger' : 'default'}
          onClick={stats?.failed_today ? () => { setTab('history'); setHStatus('failed'); setHPage(1) } : undefined}
        />
      </section>

      {result && <ResultBanner result={result} onDismiss={() => setResult(null)} />}

      <Tabs
        label="Withdrawal views"
        value={tab}
        onChange={setTab}
        idPrefix="wd"
        items={[
          { value: 'queue', label: 'Review queue', count: queueQ.data?.count },
          { value: 'history', label: 'History' },
        ]}
      />

      {tab === 'queue' ? (
        <div role="tabpanel" id="wd-panel-queue" aria-labelledby="wd-tab-queue" className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_26rem] xl:items-start">
          <AdminTable
            columns={queueColumns}
            data={queueRows}
            rowKey={(r) => r.id}
            isLoading={queueQ.isLoading}
            error={queueQ.error}
            onRetry={() => void queueQ.refetch()}
            onRowClick={openRow}
            isRowActive={(r) => r.id === (paneRow?.id ?? (drawerOpen ? selectedId : null))}
            toolbar={
              <Toolbar actions={<span className="hidden text-xs text-ink-muted sm:inline">Oldest first · refreshes every 30s</span>}>
                <SearchInput size="sm" value={queueSearch} onChange={setQueueSearch} placeholder="Filter by user, phone or ID" />
              </Toolbar>
            }
            emptyState={
              queue.length > 0 ? (
                <EmptyState size="compact" title="No requests match this filter" action={<Button size="sm" variant="secondary" onClick={() => setQueueSearch('')}>Clear filter</Button>} />
              ) : (
                <EmptyState size="compact" icon={CheckCircle2} title="No withdrawals waiting for review" description="New requests appear here as users submit them. Decided requests are under History." />
              )
            }
            skeletonRows={5}
          />

          {wide && (
            <Panel
              padding="none"
              className="sticky top-[4.5rem] max-h-[calc(100vh-6rem)]"
              title={paneRow ? `Review · ${paneRow.username}` : 'Review'}
              description={paneRow ? `${queueRows.findIndex((w) => w.id === paneRow.id) + 1} of ${queueRows.length} in queue` : undefined}
            >
              {paneRow && paneRow.status === 'pending_review' && (
                <div className="border-b border-surface-border px-4 py-3">{actionsFor(paneRow, 'pane')}</div>
              )}
              <div className="max-h-[calc(100vh-14rem)] overflow-y-auto px-4 py-4">
                {queueQ.isLoading ? (
                  <div className="space-y-3" aria-hidden>
                    <div className="h-16 animate-pulse rounded-md bg-surface-elevated" />
                    <div className="h-40 animate-pulse rounded-md bg-surface-elevated" />
                  </div>
                ) : queueQ.error ? (
                  <ErrorState size="compact" error={queueQ.error} onRetry={() => void queueQ.refetch()} />
                ) : paneRow ? (
                  <WithdrawalReview key={paneRow.id} row={paneRow} />
                ) : (
                  <EmptyState size="compact" icon={Inbox} title="Nothing to review" description="Select a request to see the user's balance, trust signals and history." />
                )}
              </div>
            </Panel>
          )}
        </div>
      ) : (
        <div role="tabpanel" id="wd-panel-history" aria-labelledby="wd-tab-history" className="space-y-3">
          <AdminTable
            columns={historyColumns}
            data={historyQ.data?.results ?? []}
            rowKey={(r) => r.id}
            isLoading={historyQ.isLoading}
            error={historyQ.error}
            onRetry={() => void historyQ.refetch()}
            onRowClick={setHistoryRow}
            isRowActive={(r) => r.id === historyRow?.id}
            toolbar={
              <div className="space-y-2">
                <Toolbar
                  actions={
                    historyQ.data && (
                      <span className="num text-xs text-ink-muted">
                        {formatNumber(historyQ.data.count)} requests · <span className="mono text-ink-secondary">{formatKES(toNum(historyQ.data.total_amount_kes))}</span>
                      </span>
                    )
                  }
                >
                  <SearchInput size="sm" value={hSearch} onChange={(v) => { setHSearch(v); setHPage(1) }} placeholder="User, phone, tracking ref or ID" />
                  <Select size="sm" aria-label="Status" value={hStatus} onChange={(e) => { setHStatus(e.target.value); setHPage(1) }} containerClassName="w-40">
                    <option value="all">All statuses</option>
                    {(Object.keys(WITHDRAWAL_STATUS_LABEL) as WithdrawalStatus[]).map((s) => (
                      <option key={s} value={s}>{WITHDRAWAL_STATUS_LABEL[s]}</option>
                    ))}
                  </Select>
                  <Select size="sm" aria-label="Method" value={hMethod} onChange={(e) => { setHMethod(e.target.value); setHPage(1) }} containerClassName="w-36">
                    <option value="">All methods</option>
                    <option value="mpesa">M-Pesa</option>
                    <option value="bank">Bank</option>
                    <option value="paybill">Paybill / Till</option>
                  </Select>
                  <Input type="date" size="sm" aria-label="Requested from" value={hFrom} max={hTo || undefined} onChange={(e) => { setHFrom(e.target.value); setHPage(1) }} className="w-[8.75rem]" />
                  <Input type="date" size="sm" aria-label="Requested to" value={hTo} min={hFrom || undefined} onChange={(e) => { setHTo(e.target.value); setHPage(1) }} className="w-[8.75rem]" />
                </Toolbar>
                {historyChips.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    {historyChips.map((c) => <FilterChip key={c.key} label={c.label} onRemove={() => { c.clear(); setHPage(1) }} />)}
                    <button type="button" className="text-xs font-medium text-brand-text hover:underline" onClick={() => { setHStatus('all'); setHMethod(''); setHFrom(''); setHTo(''); setHSearch(''); setHPage(1) }}>
                      Clear all
                    </button>
                  </div>
                )}
              </div>
            }
            emptyMessage="No withdrawals match these filters"
            emptyDescription="Try a wider date range or another status."
            emptyState={<EmptyState size="compact" icon={History} title="No withdrawals match these filters" description="Try a wider date range or another status." />}
            pagination={{ page: hPage, total: historyQ.data?.count ?? 0, pageSize: HISTORY_PAGE, onPage: setHPage, itemLabel: 'requests' }}
          />
        </div>
      )}

      {/* Narrow screens: queue review in a drawer */}
      <SlideOver
        open={!wide && drawerOpen && !!selected}
        onClose={() => setDrawerOpen(false)}
        title={selected ? `Review · ${selected.username}` : ''}
        subtitle={selected ? `Requested ${new Date(selected.created_at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}` : undefined}
        width={520}
        footer={selected ? actionsFor(selected, 'drawer') : undefined}
      >
        {selected && <WithdrawalReview key={selected.id} row={selected} />}
      </SlideOver>

      {/* History detail */}
      <SlideOver
        open={!!historyRow}
        onClose={() => setHistoryRow(null)}
        title={historyRow ? historyRow.username : ''}
        subtitle={historyRow ? `${METHOD_LABEL[historyRow.method]} withdrawal` : undefined}
        headerAside={historyRow && <WithdrawalStatusBadge status={historyRow.status} />}
        width={520}
        footer={historyRow ? actionsFor(historyRow, 'drawer') : undefined}
      >
        {historyRow && <WithdrawalReview key={historyRow.id} row={historyRow} />}
      </SlideOver>

      <ConfirmModal
        key={`approve-${approveTarget?.id ?? 'none'}`}
        open={!!approveTarget}
        onClose={() => !approve.isPending && setApproveTarget(null)}
        onConfirm={() => approveTarget && approve.mutate(approveTarget)}
        loading={approve.isPending}
        variant="danger"
        title="Approve and send payout"
        confirmLabel={approve.isPending ? 'Sending…' : `Send ${formatKES(approveAmount)}`}
        message={
          approveTarget && (
            <>
              <span className="mono font-semibold text-ink-primary">{formatKES(approveAmount)}</span> will be sent to{' '}
              <span className="mono font-semibold text-ink-primary">{maskedDestination(approveTarget)}</span> via {METHOD_LABEL[approveTarget.method]} as soon as you confirm.
            </>
          )
        }
        details={
          approveTarget
            ? [
                { label: 'User', value: approveTarget.username },
                { label: 'Amount', value: <span className="mono">{formatKES(approveAmount)}</span> },
                { label: 'Destination', value: <span className="mono">{maskedDestination(approveTarget)}</span> },
                { label: 'Waiting', value: formatAgeHours(approveTarget.age_hours) },
                { label: 'Request', value: <span className="mono text-xs">{approveTarget.id.slice(0, 8)}…</span> },
              ]
            : undefined
        }
        consequence="This cannot be reversed from the admin console. If the gateway refuses the payout, the request is marked Failed and the amount goes back to the user's wallet."
        confirmText={needsTyped ? String(Math.round(approveAmount)) : undefined}
      >
        {needsTyped && <p className="text-xs text-ink-muted">Large payout: type the amount in shillings to confirm.</p>}
      </ConfirmModal>

      <ConfirmModal
        key={`reject-${rejectTarget?.id ?? 'none'}`}
        open={!!rejectTarget}
        onClose={() => { if (!reject.isPending) { setRejectTarget(null); setReason('') } }}
        onConfirm={() => rejectTarget && reasonOk && reject.mutate({ w: rejectTarget, why: reason.trim() })}
        loading={reject.isPending}
        variant="warning"
        title="Reject withdrawal"
        confirmLabel="Reject and refund"
        confirmDisabled={!reasonOk}
        message={
          rejectTarget && (
            <>
              <span className="mono font-semibold text-ink-primary">{formatKES(toNum(rejectTarget.amount_kes))}</span> will go back to{' '}
              <span className="font-semibold text-ink-primary">{rejectTarget.username}</span>'s wallet. Nothing is sent to M-Pesa. The user is notified with the reason below.
            </>
          )
        }
        details={
          rejectTarget
            ? [
                { label: 'User', value: rejectTarget.username },
                { label: 'Amount', value: <span className="mono">{formatKES(toNum(rejectTarget.amount_kes))}</span> },
                { label: 'Destination', value: <span className="mono">{maskedDestination(rejectTarget)}</span> },
              ]
            : undefined
        }
      >
        <Textarea
          label="Reason (shown to the user)"
          required
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          disabled={reject.isPending}
          maxLength={500}
          hint={reasonOk ? `${reason.trim().length}/500` : 'At least 5 characters.'}
        />
        <div className="flex flex-wrap gap-1.5" aria-label="Common reasons">
          {REJECT_REASONS.map((r) => (
            <button
              key={r}
              type="button"
              disabled={reject.isPending}
              onClick={() => setReason(r)}
              className="rounded border border-surface-border bg-surface-elevated px-2 py-1 text-left text-xs text-ink-secondary hover:border-surface-strong hover:text-ink-primary disabled:opacity-50"
            >
              {r}
            </button>
          ))}
        </div>
      </ConfirmModal>
    </div>
  )
}
