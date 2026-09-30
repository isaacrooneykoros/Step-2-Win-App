import { useState } from 'react'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2, Clock, RefreshCw, SearchCheck, Wallet, XCircle } from 'lucide-react'
import { PageHeader } from '../components/PageHeader'
import { StatCard } from '../components/StatCard'
import { StatusBadge } from '../components/StatusBadge'
import { AdminTable, type Column } from '../components/AdminTable'
import { SlideOver } from '../components/SlideOver'
import { DetailRow } from '../components/DetailRow'
import { ConfirmModal } from '../components/ConfirmModal'
import { Button } from '../components/ui/Button'
import { SearchInput } from '../components/ui/Input'
import { Tabs } from '../components/ui/Tabs'
import { Toolbar } from '../components/ui/Toolbar'
import { EmptyState } from '../components/ui/EmptyState'
import { ErrorState } from '../components/ui/ErrorState'
import { Skeleton } from '../components/ui/Skeleton'
import { consoleApi } from '../components/users/api'
import type { DepositRow } from '../components/users/partATypes'
import { ActionNotice, ChangeList, SectionTitle, Timestamp, UserCell } from '../components/users/shared'
import { useDebounced } from '../components/users/utils'
import { formatAgeHours, formatDateTime, formatKES, formatNumber } from '../lib/format'
import { usePermissions } from '../lib/permissions'

type Tab = 'all' | 'stuck' | 'pending' | 'failed' | 'completed'
const PAGE_SIZE = 25
const OUTCOME_TEXT: Record<string, string> = {
  credited: 'IntaSend confirmed the payment. The wallet was credited once and the user was notified.',
  already_completed: 'This deposit was already credited. Nothing changed.',
  failed: 'IntaSend reports this payment did not complete. The deposit is marked failed; nothing was credited.',
  pending: 'IntaSend still shows this payment as pending. Try again later.',
}

export function DepositsPage() {
  const qc = useQueryClient()
  const { can } = usePermissions()
  const [tab, setTab] = useState<Tab>('all')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [openId, setOpenId] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<DepositRow | null>(null)
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null)
  const q = useDebounced(search.trim(), 300)

  const list = useQuery({
    queryKey: ['admin', 'deposits', { tab, q, page }],
    queryFn: () => consoleApi.deposits({ q, page, page_size: PAGE_SIZE, status: tab === 'all' ? undefined : tab === 'pending' ? 'pending' : tab === 'failed' ? 'failed' : tab }),
    placeholderData: keepPreviousData,
  })
  const detail = useQuery({ queryKey: ['admin', 'deposit', openId], queryFn: () => consoleApi.depositDetail(openId as string), enabled: !!openId })
  const verify = useMutation({
    mutationFn: (id: string) => consoleApi.verifyDeposit(id),
    onSuccess: (res) => {
      setConfirm(null)
      setNotice({ tone: res.outcome === 'credited' || res.outcome === 'already_completed' ? 'success' : 'danger', text: OUTCOME_TEXT[res.outcome] ?? res.outcome })
      void qc.invalidateQueries({ queryKey: ['admin', 'deposits'] })
      void qc.invalidateQueries({ queryKey: ['admin', 'deposit'] })
    },
    onError: (e) => { setConfirm(null); setNotice({ tone: 'danger', text: e instanceof Error ? e.message : 'Verification failed.' }) },
  })
  const counts = list.data?.counts
  const d = detail.data

  const columns: Column<DepositRow>[] = [
    { key: 'user', label: 'User', render: (r) => <UserCell username={r.username} secondary={<span className="mono">{r.phone_number}</span>} /> },
    { key: 'amount', label: 'Amount', numeric: true, render: (r) => <span className="mono text-[13px]">{formatKES(r.amount_kes)}</span> },
    { key: 'status', label: 'Status', render: (r) => <StatusBadge size="sm" status={r.status} /> },
    { key: 'ref', label: 'M-Pesa ref', hideBelow: 'md', render: (r) => <span className="mono text-xs">{r.mpesa_reference || '—'}</span> },
    { key: 'order', label: 'Order', hideBelow: 'xl', render: (r) => <span className="mono text-xs text-ink-muted">{r.order_id}</span> },
    { key: 'age', label: 'Started', numeric: true, render: (r) => <Timestamp value={r.created_at} className="text-ink-secondary" /> },
  ]

  return (
    <div className="space-y-5">
      <PageHeader
        title="Deposits"
        description="Every M-Pesa deposit attempt. Find one by M-Pesa reference, phone or user, and resolve stuck ones by asking IntaSend."
        actions={<Button size="sm" variant="secondary" leftIcon={<RefreshCw size={13} />} loading={list.isFetching} onClick={() => void list.refetch()}>Refresh</Button>}
      />
      {notice && <ActionNotice tone={notice.tone} onDismiss={() => setNotice(null)}>{notice.text}</ActionNotice>}
      <section aria-label="Deposit totals" className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Stuck over 15 min" icon={AlertTriangle} value={formatNumber(counts?.stuck)} loading={list.isLoading} tone={counts?.stuck ? 'warning' : 'default'} onClick={() => { setTab('stuck'); setPage(1) }} />
        <StatCard label="Waiting for M-Pesa" icon={Clock} value={formatNumber(counts?.pending)} loading={list.isLoading} onClick={() => { setTab('pending'); setPage(1) }} />
        <StatCard label="Failed or cancelled" icon={XCircle} value={formatNumber(counts?.failed)} loading={list.isLoading} onClick={() => { setTab('failed'); setPage(1) }} />
        <StatCard label="Credited" icon={CheckCircle2} value={formatNumber(counts?.completed)} loading={list.isLoading} onClick={() => { setTab('completed'); setPage(1) }} />
      </section>
      <div className="space-y-3">
        <Tabs label="Deposit status" value={tab} onChange={(v) => { setTab(v); setPage(1) }} items={[
          { value: 'all', label: 'All' }, { value: 'stuck', label: 'Stuck', count: counts?.stuck },
          { value: 'pending', label: 'Pending' }, { value: 'failed', label: 'Failed' }, { value: 'completed', label: 'Credited' },
        ]} />
        <AdminTable
          columns={columns}
          data={list.data?.results ?? []}
          rowKey={(r) => r.id}
          isLoading={list.isLoading}
          error={list.error && !list.data ? list.error : undefined}
          onRetry={() => void list.refetch()}
          onRowClick={(r) => setOpenId(r.id)}
          isRowActive={(r) => r.id === openId}
          density="compact"
          toolbar={<Toolbar actions={<span className="num text-xs text-ink-muted">{list.data ? `${formatNumber(list.data.count)} deposits` : ''}</span>}>
            <SearchInput size="sm" value={search} onChange={(v) => { setSearch(v); setPage(1) }} placeholder="M-Pesa ref, phone, order id or user" containerClassName="sm:w-80" />
          </Toolbar>}
          emptyState={<EmptyState size="compact" icon={Wallet} title={q ? 'No deposits match this search' : 'No deposits here'} description={q ? 'Check the M-Pesa reference or try the phone number.' : undefined} />}
          pagination={list.data ? { page, total: list.data.count, pageSize: PAGE_SIZE, onPage: setPage, itemLabel: 'deposits' } : undefined}
        />
      </div>

      <SlideOver open={!!openId} onClose={() => setOpenId(null)} width={640}
        title={d ? `${formatKES(d.deposit.amount_kes)} from ${d.deposit.username}` : 'Deposit'}
        subtitle={d ? `Order ${d.deposit.order_id}` : undefined}
        headerAside={d && <StatusBadge size="sm" status={d.deposit.status} />}
        footer={d && d.deposit.status !== 'completed' && can('finance.deposits') ? (
          <Button variant="primary" leftIcon={<SearchCheck size={14} />} onClick={() => setConfirm(d.deposit)} disabled={!d.deposit.collection_id}
            title={d.deposit.collection_id ? undefined : 'This deposit never reached IntaSend'}>Verify with IntaSend</Button>
        ) : undefined}>
        {detail.isLoading ? <Skeleton height={200} /> : detail.error || !d ? <ErrorState error={detail.error} onRetry={() => void detail.refetch()} /> : (
          <div>
            <DetailRow label="User" value={d.deposit.username} />
            <DetailRow label="Phone" value={d.deposit.phone_number} mono />
            <DetailRow label="Amount" value={formatKES(d.deposit.amount_kes)} mono />
            <DetailRow label="M-Pesa reference" value={d.deposit.mpesa_reference} mono />
            <DetailRow label="IntaSend invoice" value={d.deposit.collection_id} mono />
            <DetailRow label="Started" value={formatDateTime(d.deposit.created_at)} />
            <DetailRow label="Waiting" value={d.deposit.status === 'completed' ? null : formatAgeHours(d.deposit.age_hours)} />
            <DetailRow label="Failure reason" value={d.deposit.fail_reason} />
            <DetailRow label="Wallet credit" value={d.wallet_transaction ? `${formatKES(d.wallet_transaction.amount)} · ledger #${d.wallet_transaction.id}` : 'Not credited'} />

            <SectionTitle>Gateway callbacks (read-only)</SectionTitle>
            {d.callbacks.length === 0 ? <p className="text-sm text-ink-muted">No callback received from IntaSend for this deposit.</p> : (
              <ul className="space-y-2">
                {d.callbacks.map((c) => (
                  <li key={c.id} className="rounded-md border border-surface-border">
                    <div className="flex items-center justify-between gap-2 border-b border-surface-border px-3 py-1.5 text-xs">
                      <span className="text-ink-secondary">{formatDateTime(c.created_at)}</span>
                      <StatusBadge size="sm" tone={c.processed ? 'success' : 'warning'} label={c.processed ? 'Processed' : 'Not processed'} />
                    </div>
                    <pre className="mono max-h-48 overflow-auto whitespace-pre-wrap break-all bg-surface-sunken px-3 py-2 text-[11px] text-ink-secondary">{JSON.stringify(c.payload, null, 2)}</pre>
                  </li>
                ))}
              </ul>
            )}
            <SectionTitle>Change history</SectionTitle>
            {d.history.length === 0 && d.audit.length === 0 ? <p className="text-sm text-ink-muted">No changes recorded.</p> : (
              <ul className="space-y-2">
                {d.audit.map((a) => <li key={`a${a.id}`} className="text-sm text-ink-primary">{a.description} <span className="text-xs text-ink-muted">· {a.admin_username} · <Timestamp value={a.created_at} /></span></li>)}
                {d.history.map((h) => (
                  <li key={`h${h.id}`} className="text-xs">
                    <p className="text-ink-muted">{h.action} by {h.actor ?? 'system'} · <Timestamp value={h.timestamp} /></p>
                    <ChangeList changes={Object.fromEntries(Object.entries(h.changes ?? {}).map(([k, v]) => [k, Array.isArray(v) ? { old: v[0], new: v[1] } : v]))} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </SlideOver>

      <ConfirmModal open={!!confirm} onClose={() => setConfirm(null)} onConfirm={() => confirm && verify.mutate(confirm.id)} loading={verify.isPending}
        variant="warning" title="Verify deposit with IntaSend" confirmLabel="Verify and resolve"
        message="We ask IntaSend for this payment's real status. If it completed, the wallet is credited exactly once (a second check changes nothing). If it failed, it is marked failed."
        details={confirm ? [
          { label: 'User', value: confirm.username },
          { label: 'Amount', value: formatKES(confirm.amount_kes) },
          { label: 'Phone', value: <span className="mono">{confirm.phone_number}</span> },
          { label: 'Order', value: <span className="mono">{confirm.order_id}</span> },
        ] : []}
        consequence="The result is recorded in the audit log; the user gets an in-app notice if credited." />
    </div>
  )
}
