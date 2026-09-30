import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { RefreshCw, ShieldCheck } from 'lucide-react'
import { PageHeader } from '../components/PageHeader'
import { AdminTable, type Column } from '../components/AdminTable'
import { StatusBadge } from '../components/StatusBadge'
import { SlideOver } from '../components/SlideOver'
import { ConfirmModal } from '../components/ConfirmModal'
import { Button } from '../components/ui/Button'
import { Select, Textarea } from '../components/ui/Input'
import { Tabs } from '../components/ui/Tabs'
import { consoleB, type LinkCluster, type LinkageRun, type RiskModel } from '../components/consoleb/api'
import { useAdminRole } from '../components/users/utils'
import { formatDateTime, formatNumber, formatRelative } from '../lib/format'
import { errorMessage } from '../lib/errors'

type Tab = 'clusters' | 'runs' | 'models'

function metric(m: Record<string, unknown>, k: string): string {
  const v = m?.[k]
  return typeof v === 'number' ? (v <= 1 ? `${(v * 100).toFixed(1)}%` : formatNumber(v, 2)) : '—'
}

export function TrustToolsPage() {
  const [tab, setTab] = useState<Tab>('clusters')
  const [minSize, setMinSize] = useState('2')
  const qc = useQueryClient()
  const role = useAdminRole()
  const clusters = useQuery({ queryKey: ['admin', 'linkage', 'clusters', minSize], queryFn: () => consoleB.clusters(Number(minSize)), enabled: tab === 'clusters' })
  const runs = useQuery({ queryKey: ['admin', 'linkage', 'runs'], queryFn: consoleB.linkageRuns, enabled: tab === 'runs' })
  const models = useQuery({ queryKey: ['admin', 'risk-ml', 'models'], queryFn: consoleB.riskModels, enabled: tab === 'models' })
  const [cluster, setCluster] = useState<LinkCluster | null>(null)
  const [activate, setActivate] = useState<RiskModel | null>(null)
  const [reason, setReason] = useState('')
  const [msg, setMsg] = useState<string | null>(null)

  const act = useMutation({
    mutationFn: () => consoleB.activateModel(activate!.version, reason.trim()),
    onSuccess: () => { setMsg(`${activate?.version} is now the active ${activate?.kind} model (shadow only).`); setActivate(null); setReason(''); void qc.invalidateQueries({ queryKey: ['admin', 'risk-ml', 'models'] }) },
    onError: (e) => { setMsg(`Not activated: ${errorMessage(e)}`); setActivate(null) },
  })

  const clusterCols: Column<LinkCluster>[] = [
    { key: 'key', label: 'Cluster', render: (c) => <span className="mono text-xs">{c.key.slice(0, 10)}</span> },
    { key: 'size', label: 'Accounts', numeric: true, render: (c) => formatNumber(c.size), sortable: true, sortValue: (c) => c.size },
    { key: 'strong', label: 'Strong links', numeric: true, render: (c) => formatNumber(c.strong_pairs), sortable: true, sortValue: (c) => c.strong_pairs },
    { key: 'medium', label: 'Medium links', numeric: true, hideBelow: 'md', render: (c) => formatNumber(c.medium_pairs) },
    { key: 'score', label: 'Top pair score', numeric: true, hideBelow: 'md', render: (c) => formatNumber(c.max_pair_score, 2), sortable: true, sortValue: (c) => c.max_pair_score },
    { key: 'members', label: 'Members', hideBelow: 'lg', render: (c) => <span className="line-clamp-1 text-xs text-ink-secondary">{c.members.map((m) => m.username).join(', ')}</span> },
    { key: 'seen', label: 'First seen', numeric: true, render: (c) => <span className="text-xs text-ink-muted">{formatRelative(c.first_seen_at)}</span> },
  ]
  const runCols: Column<LinkageRun>[] = [
    { key: 'started', label: 'Started', render: (r) => formatDateTime(r.started_at) },
    { key: 'status', label: 'Result', render: (r) => <StatusBadge size="sm" tone={!r.finished_at ? 'info' : r.ok ? 'success' : 'danger'} label={!r.finished_at ? 'Running or interrupted' : r.ok ? 'OK' : 'Failed'} /> },
    { key: 'secs', label: 'Duration', numeric: true, render: (r) => (typeof r.stats?.seconds === 'number' ? `${formatNumber(r.stats.seconds as number, 1)} s` : '—') },
    { key: 'stats', label: 'Counts', hideBelow: 'md', render: (r) => (
      <span className="mono line-clamp-1 text-2xs text-ink-muted">
        {Object.entries(r.stats ?? {}).filter(([k, v]) => k !== 'seconds' && typeof v !== 'object').map(([k, v]) => `${k}=${String(v)}`).join('  ') || '—'}
      </span>
    ) },
  ]
  const modelCols: Column<RiskModel>[] = [
    { key: 'version', label: 'Version', render: (m) => <span className="mono text-xs font-medium">{m.version}</span> },
    { key: 'kind', label: 'Kind', render: (m) => <span className="text-xs">{m.kind === 'anomaly' ? 'Anomaly' : 'Supervised'}</span> },
    { key: 'status', label: 'Status', render: (m) => <StatusBadge size="sm" tone={m.is_active ? 'success' : 'neutral'} label={m.is_active ? 'Active (shadow)' : m.trained_on !== 'real' ? `Synthetic, can’t activate` : 'Inactive'} /> },
    { key: 'prec', label: 'Precision', numeric: true, hideBelow: 'md', render: (m) => metric(m.metrics, 'precision') },
    { key: 'rec', label: 'Recall', numeric: true, hideBelow: 'md', render: (m) => metric(m.metrics, 'recall') },
    { key: 'auc', label: 'AUC', numeric: true, hideBelow: 'lg', render: (m) => metric(m.metrics, 'roc_auc') },
    { key: 'created', label: 'Trained', numeric: true, render: (m) => <span className="text-xs text-ink-muted">{formatRelative(m.created_at)}</span> },
  ]

  return (
    <div className="space-y-5">
      <PageHeader
        title="Trust tools"
        description="Linked-account clusters from the nightly linkage job, its run history, and the shadow risk models. Nothing here moves money; labelling is done from each case in Anti-cheat."
        actions={<Button size="sm" variant="secondary" leftIcon={<RefreshCw size={13} />} onClick={() => void qc.invalidateQueries({ queryKey: ['admin'] })}>Refresh</Button>}
      />
      {msg && <p role="status" className="rounded-md border border-surface-border bg-surface-card px-3 py-2 text-sm text-ink-primary shadow-card">{msg}</p>}
      <Tabs label="Trust tools" value={tab} onChange={setTab} items={[
        { value: 'clusters', label: 'Linked-account clusters', count: clusters.data?.count },
        { value: 'runs', label: 'Linkage runs' },
        { value: 'models', label: 'Risk models' },
      ]} />
      {tab === 'clusters' && (
        <AdminTable columns={clusterCols} data={clusters.data?.results ?? []} rowKey={(c) => c.key} density="compact"
          isLoading={clusters.isLoading} error={clusters.error} onRetry={() => void clusters.refetch()}
          toolbar={
            <div className="flex items-center gap-2 px-1">
              <Select size="sm" aria-label="Minimum cluster size" value={minSize} onChange={(e) => setMinSize(e.target.value)} className="w-40">
                <option value="2">2 or more accounts</option><option value="3">3 or more</option><option value="5">5 or more</option><option value="10">10 or more</option>
              </Select>
            </div>
          }
          onRowClick={setCluster} isRowActive={(c) => c.key === cluster?.key}
          emptyMessage="No clusters" emptyDescription="Accounts linked by devices, networks or payout numbers appear here after the nightly linkage run." />
      )}
      {tab === 'runs' && (
        <AdminTable columns={runCols} data={runs.data?.results ?? []} rowKey={(r) => r.id} density="compact"
          isLoading={runs.isLoading} error={runs.error} onRetry={() => void runs.refetch()}
          emptyMessage="No linkage runs yet" emptyDescription="The linkage job runs nightly (Ops monitoring > Scheduled jobs)." />
      )}
      {tab === 'models' && (
        <>
          {models.data?.note && <p className="text-xs text-ink-muted">{models.data.note}</p>}
          <AdminTable columns={modelCols} data={models.data?.results ?? []} rowKey={(m) => m.version} density="compact"
            isLoading={models.isLoading} error={models.error} onRetry={() => void models.refetch()}
            rowActions={(m) => !m.is_active && m.trained_on === 'real' ? (
              <Button size="sm" variant="secondary" leftIcon={<ShieldCheck size={13} />} disabled={!role.isSuperuser}
                title={role.isSuperuser ? undefined : 'Only a superuser can change the active model'}
                onClick={(e) => { e.stopPropagation(); setActivate(m) }}>Activate</Button>
            ) : null}
            emptyMessage="No trained models" emptyDescription="Models are trained with the risk_ml management commands." />
        </>
      )}

      <SlideOver open={!!cluster} onClose={() => setCluster(null)} title={cluster ? `Cluster of ${cluster.size} accounts` : ''}
        subtitle={cluster ? `First seen ${formatDateTime(cluster.first_seen_at)}` : undefined}>
        {cluster && (
          <div className="space-y-3">
            <p className="text-sm text-ink-secondary">{cluster.strong_pairs} strong and {cluster.medium_pairs} medium links. Open an account to see its linked accounts, evidence and household marks.</p>
            <ul className="divide-y divide-[var(--border)] rounded-md border border-surface-border">
              {cluster.members.map((m) => (
                <li key={m.user_id} className="flex items-center justify-between px-3 py-2 text-sm">
                  <Link to={`/users?user=${m.user_id}`} className="font-medium text-brand-text hover:underline">{m.username}</Link>
                  <span className="mono text-xs text-ink-muted">#{m.user_id}</span>
                </li>
              ))}
            </ul>
            {cluster.size > cluster.members.length && <p className="text-xs text-ink-muted">Showing {cluster.members.length} of {cluster.size}.</p>}
          </div>
        )}
      </SlideOver>

      <ConfirmModal open={!!activate} onClose={() => setActivate(null)} onConfirm={() => act.mutate()} loading={act.isPending}
        variant="warning" title={`Activate ${activate?.version ?? ''}`} confirmLabel="Activate"
        message="The nightly scoring job uses this model from its next run. Scores stay shadow-only: they never change steps, trust or payouts."
        confirmDisabled={reason.trim().length < 5}>
        <Textarea label="Reason (kept in the audit log)" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
      </ConfirmModal>
    </div>
  )
}
