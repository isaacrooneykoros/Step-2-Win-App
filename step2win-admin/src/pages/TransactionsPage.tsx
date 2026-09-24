import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useMutation, useQuery } from '@tanstack/react-query'
import { AlertTriangle, Download, ReceiptText, RefreshCw } from 'lucide-react'
import { PageHeader } from '../components/PageHeader'
import { AdminTable, type Column } from '../components/AdminTable'
import { SlideOver } from '../components/SlideOver'
import { DetailRow } from '../components/DetailRow'
import { StatusBadge } from '../components/StatusBadge'
import { Card } from '../components/ui/Card'
import { Button } from '../components/ui/Button'
import { Input, SearchInput, Select } from '../components/ui/Input'
import { Toolbar, FilterChip } from '../components/ui/Toolbar'
import { EmptyState } from '../components/ui/EmptyState'
import { ErrorState } from '../components/ui/ErrorState'
import { Skeleton } from '../components/ui/Skeleton'
import { cn } from '../lib/cn'
import { formatDateTime, formatKES, formatNumber } from '../lib/format'
import { financeApi } from '../components/finance/api'
import { useDebounced } from '../components/finance/hooks'
import type { LedgerFilters, LedgerRow, LedgerType } from '../components/finance/types'
import { LEDGER_TYPE_LABEL, Money, Reference, Section, SignedMoney, When, toNum } from '../components/finance/ui'

const PAGE_SIZE = 50
const TYPES = Object.keys(LEDGER_TYPE_LABEL) as LedgerType[]

const EMPTY: LedgerFilters = { types: [], direction: 'all', user: '', q: '', from: '', to: '', ordering: '-created_at' }

function TotalsBar({ loading, count, credits, debits, net, users, error }: {
  loading: boolean; count?: number; credits?: string; debits?: string; net?: string; users?: number; error?: boolean
}) {
  const items = [
    { label: 'Entries', value: formatNumber(count) },
    { label: 'Credits', value: credits !== undefined ? <SignedMoney value={credits} /> : '—' },
    { label: 'Debits', value: debits !== undefined ? <SignedMoney value={debits} /> : '—' },
    { label: 'Net', value: net !== undefined ? <SignedMoney value={net} /> : '—' },
    { label: 'Users', value: formatNumber(users) },
  ]
  return (
    <Card padding="none" aria-label="Totals for the current filters">
      <dl className="grid grid-cols-2 divide-surface-border sm:grid-cols-5 sm:divide-x">
        {items.map((it) => (
          <div key={it.label} className="px-4 py-2.5">
            <dt className="text-xs text-ink-muted">{it.label}</dt>
            <dd className="num mt-0.5 text-sm font-semibold text-ink-primary">
              {loading ? <Skeleton width={90} height={16} /> : error ? '—' : it.value}
            </dd>
          </div>
        ))}
      </dl>
    </Card>
  )
}

export function TransactionsPage() {
  const [params] = useSearchParams()
  const [filters, setFilters] = useState<LedgerFilters>(() => ({ ...EMPTY, user: params.get('user') ?? '' }))
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<LedgerRow | null>(null)

  const debouncedUser = useDebounced(filters.user)
  const debouncedQ = useDebounced(filters.q)
  const effective: LedgerFilters = { ...filters, user: debouncedUser, q: debouncedQ }

  const set = (patch: Partial<LedgerFilters>) => {
    setFilters((f) => ({ ...f, ...patch }))
    setPage(1)
  }

  const q = useQuery({
    queryKey: ['admin', 'finance', 'ledger', effective, page],
    queryFn: () => financeApi.ledger(effective, PAGE_SIZE, (page - 1) * PAGE_SIZE),
    placeholderData: (prev) => prev,
  })
  const exportCsv = useMutation({ mutationFn: () => financeApi.exportLedger(effective) })

  const data = q.data
  const toggleType = (t: LedgerType) =>
    set({ types: filters.types.includes(t) ? filters.types.filter((x) => x !== t) : [...filters.types, t] })

  const onSort = (key: string) => {
    const field = key === 'amount' ? 'amount' : 'created_at'
    const current = filters.ordering.replace('-', '')
    const desc = filters.ordering.startsWith('-')
    set({ ordering: (current === field && desc ? field : `-${field}`) as LedgerFilters['ordering'] })
  }
  const sortKey = filters.ordering.replace('-', '') === 'amount' ? 'amount' : 'time'
  const sortDir = filters.ordering.startsWith('-') ? 'desc' : 'asc'

  const columns: Column<LedgerRow>[] = [
    { key: 'time', label: 'Time', sortable: true, render: (r) => <span className="text-ink-secondary"><When value={r.created_at} /></span> },
    { key: 'user', label: 'User', render: (r) => <span className="font-medium">{r.user_username ?? <span className="text-ink-muted">System</span>}</span> },
    { key: 'type', label: 'Type', render: (r) => <span className="whitespace-nowrap text-ink-secondary">{LEDGER_TYPE_LABEL[r.type] ?? r.type}</span> },
    { key: 'amount', label: 'Amount', numeric: true, sortable: true, render: (r) => <SignedMoney value={r.amount} /> },
    { key: 'before', label: 'Balance before', numeric: true, hideBelow: 'xl', render: (r) => <Money value={r.balance_before} muted /> },
    { key: 'after', label: 'Balance after', numeric: true, hideBelow: 'md', render: (r) => <Money value={r.balance_after} /> },
    { key: 'ref', label: 'Reference', hideBelow: 'lg', render: (r) => <Reference value={r.reference_id} /> },
    {
      key: 'check', label: 'Check', align: 'right',
      render: (r) => (r.arithmetic_ok ? <span className="text-xs text-ink-muted">Balanced</span> : <StatusBadge size="sm" tone="danger" label="Mismatch" />),
    },
  ]

  const chips = [
    ...filters.types.map((t) => ({ key: `t-${t}`, label: `Type: ${LEDGER_TYPE_LABEL[t]}`, clear: () => toggleType(t) })),
    filters.direction !== 'all' && { key: 'dir', label: filters.direction === 'credit' ? 'Credits only' : 'Debits only', clear: () => set({ direction: 'all' }) },
    filters.user && { key: 'user', label: `User: ${filters.user}`, clear: () => set({ user: '' }) },
    filters.q && { key: 'q', label: `Reference: ${filters.q}`, clear: () => set({ q: '' }) },
    filters.from && { key: 'from', label: `From ${filters.from}`, clear: () => set({ from: '' }) },
    filters.to && { key: 'to', label: `To ${filters.to}`, clear: () => set({ to: '' }) },
  ].filter(Boolean) as Array<{ key: string; label: string; clear: () => void }>

  const meta = selected?.metadata && Object.keys(selected.metadata).length ? selected.metadata : null

  return (
    <div className="space-y-5">
      <PageHeader
        title="Transactions"
        description="Every wallet ledger entry, newest first. Totals and the CSV export follow the filters."
        actions={
          <>
            <Button
              size="sm"
              variant="secondary"
              leftIcon={<Download size={13} />}
              loading={exportCsv.isPending}
              disabled={!data?.count}
              onClick={() => exportCsv.mutate()}
            >
              Export CSV
            </Button>
            <Button size="sm" variant="secondary" leftIcon={<RefreshCw size={13} />} loading={q.isFetching} onClick={() => void q.refetch()}>
              Refresh
            </Button>
          </>
        }
      />

      {exportCsv.error && (
        <ErrorState variant="inline" title="Export failed" error={exportCsv.error} onRetry={() => exportCsv.mutate()} retrying={exportCsv.isPending} />
      )}

      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter by type">
        <button
          type="button"
          aria-pressed={filters.types.length === 0}
          onClick={() => set({ types: [] })}
          className={cn(
            'h-7 rounded-md border px-2.5 text-xs font-medium transition-colors',
            filters.types.length === 0 ? 'border-brand bg-brand-soft text-brand-text' : 'border-surface-border bg-surface-card text-ink-secondary hover:text-ink-primary',
          )}
        >
          All types
        </button>
        {TYPES.map((t) => {
          const on = filters.types.includes(t)
          return (
            <button
              key={t}
              type="button"
              aria-pressed={on}
              onClick={() => toggleType(t)}
              className={cn(
                'h-7 rounded-md border px-2.5 text-xs font-medium transition-colors',
                on ? 'border-brand bg-brand-soft text-brand-text' : 'border-surface-border bg-surface-card text-ink-secondary hover:text-ink-primary',
              )}
            >
              {LEDGER_TYPE_LABEL[t]}
            </button>
          )
        })}
      </div>

      <TotalsBar
        loading={q.isLoading}
        error={!!q.error}
        count={data?.count}
        credits={data?.totals.credits}
        debits={data?.totals.debits}
        net={data?.totals.net}
        users={data?.totals.users}
      />

      <AdminTable
        columns={columns}
        data={data?.results ?? []}
        rowKey={(r) => r.id}
        isLoading={q.isLoading}
        error={q.error}
        onRetry={() => void q.refetch()}
        onRowClick={setSelected}
        isRowActive={(r) => r.id === selected?.id}
        sortKey={sortKey}
        sortDir={sortDir}
        onSort={onSort}
        maxHeight="68vh"
        skeletonRows={10}
        toolbar={
          <div className="space-y-2">
            <Toolbar>
              <SearchInput size="sm" value={filters.q} onChange={(v) => set({ q: v })} placeholder="Reference or description" />
              <SearchInput size="sm" value={filters.user} onChange={(v) => set({ user: v })} placeholder="User, email or phone" containerClassName="sm:w-52" />
              <Select size="sm" aria-label="Direction" value={filters.direction} onChange={(e) => set({ direction: e.target.value as LedgerFilters['direction'] })} containerClassName="w-40">
                <option value="all">All directions</option>
                <option value="credit">Credits only</option>
                <option value="debit">Debits only</option>
              </Select>
              <Input type="date" size="sm" aria-label="From date" value={filters.from} max={filters.to || undefined} onChange={(e) => set({ from: e.target.value })} className="w-[8.75rem]" />
              <Input type="date" size="sm" aria-label="To date" value={filters.to} min={filters.from || undefined} onChange={(e) => set({ to: e.target.value })} className="w-[8.75rem]" />
            </Toolbar>
            {chips.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                {chips.map((c) => <FilterChip key={c.key} label={c.label} onRemove={c.clear} />)}
                <button type="button" onClick={() => set({ ...EMPTY, ordering: filters.ordering })} className="text-xs font-medium text-brand-text hover:underline">
                  Clear all
                </button>
              </div>
            )}
          </div>
        }
        emptyState={
          chips.length ? (
            <EmptyState size="compact" icon={ReceiptText} title="No ledger entries match these filters" action={<Button size="sm" variant="secondary" onClick={() => set({ ...EMPTY })}>Clear filters</Button>} />
          ) : (
            <EmptyState size="compact" icon={ReceiptText} title="No ledger entries yet" description="Deposits, challenge entries, payouts and refunds appear here as they happen." />
          )
        }
        pagination={{ page, total: data?.count ?? 0, pageSize: PAGE_SIZE, onPage: setPage, itemLabel: 'entries' }}
      />

      <SlideOver
        open={!!selected}
        onClose={() => setSelected(null)}
        title={selected ? LEDGER_TYPE_LABEL[selected.type] ?? selected.type : ''}
        subtitle={selected ? `Ledger entry #${selected.id}` : undefined}
        headerAside={selected && !selected.arithmetic_ok ? <StatusBadge size="sm" tone="danger" label="Mismatch" /> : undefined}
      >
        {selected && (
          <div className="space-y-5">
            <div className="rounded-md border border-surface-border bg-surface-sunken/50 px-4 py-3">
              <p className="text-xs text-ink-muted">{toNum(selected.amount) >= 0 ? 'Credited to wallet' : 'Debited from wallet'}</p>
              <p className="mt-0.5 text-2xl font-semibold tracking-tight"><SignedMoney value={selected.amount} /></p>
              <p className="mt-1 text-sm text-ink-secondary">{selected.description || '—'}</p>
            </div>
            {!selected.arithmetic_ok && (
              <p className="flex items-start gap-2 rounded-md border border-danger-line bg-danger-soft px-3 py-2 text-sm text-danger">
                <AlertTriangle size={15} className="mt-0.5 shrink-0" aria-hidden />
                Balance before plus amount does not equal balance after for this row.
              </p>
            )}
            <Section title="Entry">
              <div className="rounded-md border border-surface-border px-3">
                <DetailRow label="User" value={selected.user_username ?? 'System'} />
                <DetailRow label="Time" value={formatDateTime(selected.created_at)} />
                <DetailRow label="Balance before" value={formatKES(toNum(selected.balance_before))} mono />
                <DetailRow label="Amount" value={<SignedMoney value={selected.amount} />} />
                <DetailRow label="Balance after" value={formatKES(toNum(selected.balance_after))} mono />
                <DetailRow label="Reference" value={selected.reference_id ? <Reference value={selected.reference_id} truncate={false} /> : null} />
              </div>
            </Section>
            {meta && (
              <Section title="Metadata">
                <div className="rounded-md border border-surface-border px-3">
                  {Object.entries(meta).map(([k, v]) => (
                    <DetailRow key={k} label={k.replace(/_/g, ' ')} value={typeof v === 'object' ? JSON.stringify(v) : String(v)} mono />
                  ))}
                </div>
              </Section>
            )}
          </div>
        )}
      </SlideOver>
    </div>
  )
}
