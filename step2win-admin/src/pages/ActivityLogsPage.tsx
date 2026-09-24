import { Fragment, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { ChevronRight, Download, History, RefreshCw } from 'lucide-react'
import { PageHeader } from '../components/PageHeader'
import { Button } from '../components/ui/Button'
import { Input, SearchInput, Select } from '../components/ui/Input'
import { FilterChip, Toolbar } from '../components/ui/Toolbar'
import { SegmentedControl } from '../components/ui/Tabs'
import { Pagination } from '../components/ui/Pagination'
import { EmptyState } from '../components/ui/EmptyState'
import { ErrorState } from '../components/ui/ErrorState'
import { Skeleton } from '../components/ui/Skeleton'
import { formatDateTime } from '../lib/format'
import { cn } from '../lib/cn'
import { consoleApi } from '../components/users/api'
import type { AuditLogRow } from '../components/users/types'
import { AuditActionBadge, ChangeList, Timestamp } from '../components/users/shared'
import { AUDIT_ACTIONS, auditAction } from '../components/users/auditActions'
import { downloadCsv, humanize, useDebounced } from '../components/users/utils'

const RESOURCES = [
  { value: 'user', label: 'User' }, { value: 'challenge', label: 'Challenge' }, { value: 'transaction', label: 'Transaction' },
  { value: 'withdrawal', label: 'Withdrawal' }, { value: 'badge', label: 'Badge' }, { value: 'settings', label: 'System settings' },
  { value: 'support', label: 'Support' }, { value: 'auth', label: 'Authentication' },
]
const PAGE_SIZE = 50

export function ActivityLogsPage() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const [search, setSearch] = useState('')
  const [action, setAction] = useState('')
  const [resource, setResource] = useState(params.get('resource_type') ?? '')
  const [resourceId, setResourceId] = useState(params.get('resource_id') ?? '')
  const [admin, setAdmin] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [scope, setScope] = useState<'changes' | 'all'>('changes')
  const [page, setPage] = useState(1)
  const [open, setOpen] = useState<Set<number>>(new Set())
  const q = useDebounced(search.trim(), 300)

  const filters = {
    search: q || undefined,
    action: action || undefined,
    resource_type: resource || undefined,
    resource_id: resourceId || undefined,
    admin_username: admin || undefined,
    from_date: from ? `${from}T00:00:00` : undefined,
    to_date: to ? `${to}T23:59:59` : undefined,
    exclude_auth: scope === 'changes' && action !== 'login' && action !== 'logout' ? 'true' : undefined,
  }
  const logsQ = useQuery({
    queryKey: ['admin', 'audit-logs', filters, page],
    queryFn: () => consoleApi.auditLogs({ ...filters, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }),
    placeholderData: keepPreviousData,
  })
  const data = logsQ.data
  const reset = () => { setPage(1); setOpen(new Set()) }
  const toggle = (id: number) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })

  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)
  const exportCsv = async () => {
    setExporting(true)
    setExportError(null)
    try {
      const all = await consoleApi.auditLogs({ ...filters, limit: 1000, offset: 0 })
      downloadCsv(`audit-log_${new Date().toISOString().slice(0, 10)}.csv`,
        ['time', 'admin', 'action', 'resource_type', 'resource_id', 'resource_name', 'description', 'ip_address', 'changes'],
        all.results.map((r) => [r.created_at, r.admin_username, r.action, r.resource_type, r.resource_id, r.resource_name, r.description, r.ip_address, r.changes ? JSON.stringify(r.changes) : '']))
    } catch (e) {
      setExportError(e instanceof Error ? e.message : 'Export failed')
    } finally {
      setExporting(false)
    }
  }

  const targetLink = (r: AuditLogRow) => {
    if (r.resource_id == null) return null
    if (r.resource_type === 'user' && r.action !== 'delete') return `/users?user=${r.resource_id}`
    if (r.resource_type === 'challenge' && r.action !== 'delete') return `/challenges?open=${r.resource_id}`
    if (r.resource_type === 'badge') return '/badges'
    if (r.resource_type === 'settings') return '/settings'
    return null
  }

  const chips = [
    q && { key: 'q', label: `Search: ${q}`, clear: () => setSearch('') },
    action && { key: 'a', label: `Action: ${auditAction(action).label}`, clear: () => setAction('') },
    resource && { key: 'r', label: `Resource: ${humanize(resource)}`, clear: () => setResource('') },
    resourceId && { key: 'rid', label: `Record #${resourceId}`, clear: () => setResourceId('') },
    admin && { key: 'ad', label: `Admin: ${admin}`, clear: () => setAdmin('') },
    (from || to) && { key: 'd', label: `Dates: ${from || '…'} – ${to || '…'}`, clear: () => { setFrom(''); setTo('') } },
  ].filter(Boolean) as Array<{ key: string; label: string; clear: () => void }>

  const cell = 'px-3 py-2 align-middle'

  return (
    <div className="space-y-5">
      <PageHeader
        title="Audit log"
        description="Who did what, to which record, and when. Entries cannot be edited or deleted from the console."
        actions={
          <>
            <Button size="sm" variant="secondary" leftIcon={<Download size={13} />} loading={exporting} disabled={!data?.total} onClick={() => void exportCsv()}>
              Export CSV
            </Button>
            <Button size="sm" variant="secondary" leftIcon={<RefreshCw size={13} />} loading={logsQ.isFetching} onClick={() => void logsQ.refetch()}>
              Refresh
            </Button>
          </>
        }
      />
      {exportError && <ErrorState variant="inline" title="Export failed" error={exportError} />}

      <div className="min-w-0 overflow-hidden rounded-lg border border-surface-border bg-surface-card shadow-card">
        <div className="space-y-2 border-b border-surface-border px-4 py-2.5">
          <Toolbar actions={<span className="num text-xs text-ink-muted" aria-live="polite">{data ? `${data.total.toLocaleString()} entries` : ''}</span>}>
            <SegmentedControl label="Entry scope" value={scope} onChange={(v) => { setScope(v); reset() }}
              items={[{ value: 'changes' as const, label: 'Changes' }, { value: 'all' as const, label: 'Include sign-ins' }]} />
            <SearchInput size="sm" value={search} onChange={(v) => { setSearch(v); reset() }} placeholder="Search description, record or admin" containerClassName="sm:w-72" />
            <Select size="sm" aria-label="Action" value={action} onChange={(e) => { setAction(e.target.value); reset() }} containerClassName="w-40">
              <option value="">Any action</option>
              {Object.entries(AUDIT_ACTIONS).sort((a, b) => a[1].label.localeCompare(b[1].label)).map(([code, m]) => <option key={code} value={code}>{m.label}</option>)}
            </Select>
            <Select size="sm" aria-label="Resource type" value={resource} onChange={(e) => { setResource(e.target.value); reset() }} containerClassName="w-40">
              <option value="">Any resource</option>
              {RESOURCES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
            </Select>
            <Select size="sm" aria-label="Admin" value={admin} onChange={(e) => { setAdmin(e.target.value); reset() }} containerClassName="w-40">
              <option value="">Any admin</option>
              {(data?.admins ?? []).map((a) => <option key={a} value={a}>{a}</option>)}
            </Select>
            <span className="flex items-center gap-1.5">
              <Input size="sm" type="date" aria-label="From date" value={from} max={to || undefined} onChange={(e) => { setFrom(e.target.value); reset() }} />
              <span className="text-xs text-ink-muted">to</span>
              <Input size="sm" type="date" aria-label="To date" value={to} min={from || undefined} onChange={(e) => { setTo(e.target.value); reset() }} />
            </span>
          </Toolbar>
          {chips.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              {chips.map((c) => <FilterChip key={c.key} label={c.label} onRemove={() => { c.clear(); reset() }} />)}
            </div>
          )}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <caption className="sr-only">Admin audit log</caption>
            <thead>
              <tr className="border-b border-surface-border text-left text-xs text-ink-muted">
                <th scope="col" className="w-8 px-2 py-2"><span className="sr-only">Details</span></th>
                <th scope="col" className="px-3 py-2 font-medium">When</th>
                <th scope="col" className="px-3 py-2 font-medium">Admin</th>
                <th scope="col" className="px-3 py-2 font-medium">Action</th>
                <th scope="col" className="px-3 py-2 font-medium">Target</th>
                <th scope="col" className="hidden px-3 py-2 font-medium md:table-cell">Description</th>
                <th scope="col" className="hidden px-3 py-2 font-medium xl:table-cell">IP address</th>
              </tr>
            </thead>
            <tbody>
              {logsQ.error && !data ? (
                <tr><td colSpan={7}><ErrorState size="compact" error={logsQ.error} onRetry={() => void logsQ.refetch()} /></td></tr>
              ) : logsQ.isLoading ? (
                Array.from({ length: 10 }).map((_, i) => (
                  <tr key={i} className="border-b border-surface-border">
                    <td className="px-2 py-2.5" />
                    {[40, 50, 40, 60].map((w, j) => <td key={j} className="px-3 py-2.5"><Skeleton width={`${w}%`} /></td>)}
                    <td className="hidden px-3 py-2.5 md:table-cell"><Skeleton width="80%" /></td>
                    <td className="hidden px-3 py-2.5 xl:table-cell"><Skeleton width="50%" /></td>
                  </tr>
                ))
              ) : !data?.results.length ? (
                <tr><td colSpan={7}>
                  <EmptyState size="compact" icon={History} title={chips.length ? 'No entries match these filters' : 'No admin actions recorded yet'}
                    description={chips.length ? 'Remove a filter or widen the date range.' : 'Bans, approvals, edits and settings changes are recorded here.'} />
                </td></tr>
              ) : (
                data.results.map((r) => {
                  const expanded = open.has(r.id)
                  const link = targetLink(r)
                  const detailId = `audit-detail-${r.id}`
                  return (
                    <Fragment key={r.id}>
                      <tr className={cn('border-b border-surface-border hover:bg-surface-elevated/60', expanded && 'bg-surface-elevated/40')}>
                        <td className="px-2 py-1 align-middle">
                          <button type="button" onClick={() => toggle(r.id)} aria-expanded={expanded} aria-controls={detailId}
                            aria-label={expanded ? 'Hide details' : 'Show details'}
                            className="flex h-7 w-7 items-center justify-center rounded text-ink-muted hover:bg-surface-elevated hover:text-ink-primary">
                            <ChevronRight size={14} className={cn('transition-transform', expanded && 'rotate-90')} aria-hidden />
                          </button>
                        </td>
                        <td className={cn(cell, 'whitespace-nowrap text-ink-secondary')}><Timestamp value={r.created_at} /></td>
                        <td className={cn(cell, 'font-medium text-ink-primary')}>{r.admin_username}</td>
                        <td className={cell}><AuditActionBadge action={r.action} /></td>
                        <td className={cn(cell, 'max-w-64')}>
                          <span className="flex min-w-0 items-baseline gap-1.5">
                            {link ? (
                              <button type="button" onClick={() => navigate(link)} className="truncate text-left font-medium text-ink-primary hover:text-brand-text hover:underline">
                                {r.resource_name || 'Open record'}
                              </button>
                            ) : (
                              <span className="truncate font-medium text-ink-primary">{r.resource_name || '—'}</span>
                            )}
                            <span className="shrink-0 text-xs text-ink-muted">{humanize(r.resource_type)}</span>
                          </span>
                        </td>
                        <td className={cn(cell, 'hidden max-w-md text-ink-secondary md:table-cell')}>
                          <span className="line-clamp-1" title={r.description}>{r.description}</span>
                        </td>
                        <td className={cn(cell, 'mono hidden whitespace-nowrap text-xs text-ink-secondary xl:table-cell')}>{r.ip_address ?? '—'}</td>
                      </tr>
                      {expanded && (
                        <tr id={detailId} className="border-b border-surface-border bg-surface-elevated/40">
                          <td />
                          <td colSpan={6} className="px-3 pb-3 pt-1">
                            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
                              <div className="space-y-2">
                                <p className="text-sm text-ink-primary">{r.description}</p>
                                <ChangeList changes={r.changes} />
                                {!r.changes && <p className="text-xs text-ink-muted">No field changes were recorded for this entry.</p>}
                              </div>
                              <dl className="space-y-1 text-xs">
                                <div className="flex justify-between gap-3"><dt className="text-ink-muted">Exact time</dt><dd className="text-ink-primary">{formatDateTime(r.created_at)}</dd></div>
                                <div className="flex justify-between gap-3"><dt className="text-ink-muted">Entry ID</dt><dd className="mono text-ink-primary">{r.id}</dd></div>
                                <div className="flex justify-between gap-3"><dt className="text-ink-muted">IP address</dt><dd className="mono text-ink-primary">{r.ip_address ?? '—'}</dd></div>
                                <div className="flex justify-between gap-3"><dt className="text-ink-muted">Record</dt><dd className="text-ink-primary">{humanize(r.resource_type)} {r.resource_id != null ? `#${r.resource_id}` : ''}</dd></div>
                              </dl>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
        {data && data.total > 0 && (
          <div className="border-t border-surface-border px-4 py-2">
            <Pagination page={page} total={data.total} pageSize={PAGE_SIZE} onPage={(p) => { setPage(p); setOpen(new Set()) }} itemLabel="entries" />
          </div>
        )}
      </div>
    </div>
  )
}
