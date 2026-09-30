import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { RotateCcw } from 'lucide-react'
import { Panel } from '../ui/Card'
import { Button } from '../ui/Button'
import { Tabs } from '../ui/Tabs'
import { AdminTable, type Column } from '../AdminTable'
import { StatusBadge } from '../StatusBadge'
import { ConfirmModal } from '../ConfirmModal'
import { consoleB, type DataExport, type ExportStatus } from '../consoleb/api'
import { formatDateTime, formatNumber, formatRelative } from '../../lib/format'
import { errorMessage } from '../../lib/errors'

type Tab = 'all' | ExportStatus
const TONE: Record<ExportStatus, 'warning' | 'info' | 'success' | 'danger' | 'neutral'> = {
  pending: 'warning', running: 'info', ready: 'success', failed: 'danger', expired: 'neutral',
}

function size(bytes: number): string {
  if (!bytes) return '—'
  if (bytes < 1024 * 1024) return `${formatNumber(bytes / 1024, 0)} KB`
  return `${formatNumber(bytes / (1024 * 1024), 1)} MB`
}

/**
 * Customer data export requests (privacy). Status, failure reason and retry only:
 * staff never see or download the archive itself.
 */
export function ExportQueuePanel() {
  const qc = useQueryClient()
  const [tab, setTab] = useState<Tab>('all')
  const q = useQuery({ queryKey: ['admin', 'privacy-exports', tab], queryFn: () => consoleB.exports(tab === 'all' ? undefined : tab) })
  const [retry, setRetry] = useState<DataExport | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const run = useMutation({
    mutationFn: (id: string) => consoleB.retryExport(id),
    onSuccess: () => { setRetry(null); setMsg('Queued again. The export job picks it up within a few minutes.'); void qc.invalidateQueries({ queryKey: ['admin', 'privacy-exports'] }) },
    onError: (e) => { setRetry(null); setMsg(`Not retried: ${errorMessage(e)}`) },
  })
  const counts = q.data?.counts
  const columns: Column<DataExport>[] = [
    { key: 'user', label: 'Customer', render: (r) => <span className="font-medium text-ink-primary">{r.username ?? `#${r.user_id}`}</span> },
    { key: 'status', label: 'Status', render: (r) => <StatusBadge size="sm" tone={TONE[r.status]} label={r.status_label} /> },
    { key: 'requested', label: 'Requested', render: (r) => <span className="text-xs text-ink-secondary" title={formatDateTime(r.requested_at)}>{formatRelative(r.requested_at)}</span> },
    { key: 'attempts', label: 'Attempts', numeric: true, hideBelow: 'md', render: (r) => formatNumber(r.attempts) },
    { key: 'size', label: 'Size', numeric: true, hideBelow: 'lg', render: (r) => size(r.size_bytes) },
    { key: 'downloads', label: 'Downloads', numeric: true, hideBelow: 'lg', render: (r) => formatNumber(r.download_count) },
    { key: 'error', label: 'Failure reason', hideBelow: 'md', render: (r) => <span className="mono text-2xs text-danger">{r.error ?? ''}</span> },
  ]
  return (
    <Panel title="Data export requests" padding="none"
      description="Customers’ “download my data” requests. You can see progress and retry failures; the archive itself is only ever downloadable by the customer.">
      <div className="border-b border-surface-border px-4 pt-2">
        <Tabs label="Export status" size="sm" value={tab} onChange={setTab} items={[
          { value: 'all', label: 'All' },
          { value: 'failed', label: 'Failed', count: counts?.failed },
          { value: 'pending', label: 'Waiting', count: counts?.pending },
          { value: 'running', label: 'Being prepared', count: counts?.running },
          { value: 'ready', label: 'Ready', count: counts?.ready },
          { value: 'expired', label: 'Expired', count: counts?.expired },
        ]} />
      </div>
      {msg && <p role="status" className="border-b border-surface-border px-4 py-2 text-sm text-ink-primary">{msg}</p>}
      <AdminTable columns={columns} data={q.data?.results ?? []} rowKey={(r) => r.id} density="compact"
        isLoading={q.isLoading} error={q.error} onRetry={() => void q.refetch()}
        rowActions={(r) => r.status === 'failed' ? (
          <Button size="sm" variant="secondary" leftIcon={<RotateCcw size={12} />} onClick={() => setRetry(r)}>Retry</Button>
        ) : null}
        emptyMessage="No export requests" emptyDescription="Requests from Profile > Privacy in the app appear here." />
      <ConfirmModal open={!!retry} onClose={() => setRetry(null)} onConfirm={() => retry && run.mutate(retry.id)} loading={run.isPending}
        variant="info" title="Retry this export?" confirmLabel="Retry"
        message="The export is queued again with a fresh set of attempts. The customer is notified when it is ready, as usual."
        details={retry ? [{ label: 'Customer', value: retry.username ?? `#${retry.user_id}` }, { label: 'Last error', value: retry.error ?? '—' }] : undefined} />
    </Panel>
  )
}
