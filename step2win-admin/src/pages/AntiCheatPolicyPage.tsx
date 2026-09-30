import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Code2, GitBranchPlus, History, RefreshCw, ShieldCheck } from 'lucide-react'
import { PageHeader } from '../components/PageHeader'
import { AdminTable, type Column } from '../components/AdminTable'
import { StatusBadge } from '../components/StatusBadge'
import { SlideOver } from '../components/SlideOver'
import { ConfirmModal } from '../components/ConfirmModal'
import { Panel } from '../components/ui/Card'
import { Button } from '../components/ui/Button'
import { Input, Textarea } from '../components/ui/Input'
import { Modal } from '../components/ui/Modal'
import { consoleB, type AntiCheatPolicy, type PolicyConfig } from '../components/consoleb/api'
import { usePermissions } from '../lib/permissions'
import { ApiError } from '../components/system/http'
import { cn } from '../lib/cn'
import { formatDateTime, formatRelative } from '../lib/format'
import { errorMessage } from '../lib/errors'

const SECTION_LABEL: Record<string, string> = {
  ml: 'On-device motion model',
  session: 'Step sessions',
  trust: 'Trust score',
}

type Flat = Record<string, string>

function flatten(cfg: PolicyConfig): Flat {
  const out: Flat = {}
  for (const [s, vals] of Object.entries(cfg)) for (const [k, v] of Object.entries(vals)) out[`${s}.${k}`] = String(v)
  return out
}

function unflatten(flat: Flat, base: PolicyConfig): { config: PolicyConfig; errors: Record<string, string> } {
  const config: PolicyConfig = {}
  const errors: Record<string, string> = {}
  for (const [s, vals] of Object.entries(base)) {
    config[s] = {}
    for (const [k, ref] of Object.entries(vals)) {
      const raw = (flat[`${s}.${k}`] ?? '').trim()
      if (typeof ref === 'boolean') { config[s][k] = raw === 'true'; continue }
      const n = Number(raw)
      if (raw === '' || !Number.isFinite(n)) { errors[`${s}.${k}`] = 'Enter a number.'; continue }
      if (n < 0) { errors[`${s}.${k}`] = 'Can’t be negative.'; continue }
      if (k.endsWith('_threshold') && n > 1) { errors[`${s}.${k}`] = 'A probability between 0 and 1.'; continue }
      config[s][k] = n
    }
  }
  return { config, errors }
}

const humanKey = (k: string) => k.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())

export function AntiCheatPolicyPage() {
  const qc = useQueryClient()
  const { can } = usePermissions()
  const role = { isSuperuser: can('owner.anticheat_policy') }
  const q = useQuery({ queryKey: ['admin', 'anticheat-policies'], queryFn: consoleB.policies })
  const rows = useMemo(() => q.data?.results ?? [], [q.data])
  const active = rows.find((p) => p.is_active) ?? null
  const base: PolicyConfig | null = active?.config ?? q.data?.default_config ?? null
  const [view, setView] = useState<AntiCheatPolicy | null>(null)
  const [editor, setEditor] = useState(false)
  const [flat, setFlat] = useState<Flat>({})
  const [version, setVersion] = useState('')
  const [description, setDescription] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [serverErr, setServerErr] = useState<string | null>(null)
  const [activate, setActivate] = useState<AntiCheatPolicy | null>(null)
  const [reason, setReason] = useState('')
  const [msg, setMsg] = useState<string | null>(null)

  const openEditor = () => {
    if (!base) return
    setFlat(flatten(base)); setVersion(''); setDescription(''); setErrors({}); setServerErr(null); setEditor(true)
  }
  const changedKeys = base ? Object.entries(flatten(base)).filter(([k, v]) => Number(flat[k]) !== Number(v) && (flat[k] ?? '') !== v).map(([k]) => k) : []

  const create = useMutation({
    mutationFn: (config: PolicyConfig) => consoleB.createPolicy({ version: version.trim(), description: description.trim(), config }),
    onSuccess: (p) => { setEditor(false); setMsg(`Version ${p.version} created (inactive). Activate it when you are ready.`); void qc.invalidateQueries({ queryKey: ['admin', 'anticheat-policies'] }) },
    onError: (e) => { setServerErr(errorMessage(e)); if (e instanceof ApiError) setErrors(e.fields) },
  })
  const act = useMutation({
    mutationFn: () => consoleB.activatePolicy(activate!.id, reason.trim()),
    onSuccess: (p) => { setActivate(null); setReason(''); setMsg(`Version ${p.version} is now active. Step scoring uses it from the next sync.`); void qc.invalidateQueries({ queryKey: ['admin', 'anticheat-policies'] }) },
    onError: (e) => { setActivate(null); setMsg(`Not activated: ${errorMessage(e)}`) },
  })

  const submit = () => {
    if (!base) return
    const { config, errors: errs } = unflatten(flat, base)
    const e2 = { ...errs }
    if (!version.trim()) e2.version = 'Name the new version, e.g. v3-runners.'
    if (description.trim().length < 5) e2.description = 'Say what changed and why.'
    if (!changedKeys.length) e2.version = e2.version ?? 'Change at least one value.'
    setErrors(e2)
    if (Object.keys(e2).length) return
    create.mutate(config)
  }

  const columns: Column<AntiCheatPolicy>[] = [
    { key: 'version', label: 'Version', render: (p) => <span className="mono font-medium text-ink-primary">{p.version}</span> },
    { key: 'status', label: 'Status', render: (p) => <StatusBadge size="sm" tone={p.is_active ? 'success' : 'neutral'} label={p.is_active ? 'Active' : 'Inactive'} showDot={p.is_active} /> },
    { key: 'desc', label: 'What changed', hideBelow: 'md', render: (p) => <span className="line-clamp-1 text-xs text-ink-secondary">{p.description || '—'}</span> },
    { key: 'created', label: 'Created', numeric: true, render: (p) => <span className="text-xs text-ink-muted" title={formatDateTime(p.created_at)}>{formatRelative(p.created_at)}</span> },
  ]

  return (
    <div className="space-y-5">
      <PageHeader
        title="Anti-cheat policy"
        description="Versioned thresholds the step pipeline reads (steps/security.py). Create a new version from the active one, then activate it; roll back by activating an older version. The active version is never edited in place."
        actions={<>
          <Button size="sm" variant="secondary" leftIcon={<RefreshCw size={13} />} loading={q.isFetching} onClick={() => void q.refetch()}>Refresh</Button>
          <Button size="sm" variant="primary" leftIcon={<GitBranchPlus size={13} />} disabled={!base || !role.isSuperuser}
            title={role.isSuperuser ? undefined : 'Only an owner can create policy versions'} onClick={openEditor}>New version from active</Button>
        </>}
      />
      {msg && <p role="status" className="rounded-md border border-surface-border bg-surface-card px-3 py-2 text-sm text-ink-primary shadow-card">{msg}</p>}
      <Panel title="In force now" description={active ? `Version ${active.version}, activated ${formatRelative(active.updated_at)}.` : 'No version is active: the built-in default applies.'}
        actions={<StatusBadge size="sm" tone={active ? 'success' : 'neutral'} label={active ? active.version : 'Built-in default'} />}>
        {base ? (
          <div className="grid gap-4 md:grid-cols-3">
            {Object.entries(base).map(([s, vals]) => (
              <dl key={s} className="rounded-md border border-surface-border p-3">
                <dt className="mb-1.5 text-xs font-semibold text-ink-primary">{SECTION_LABEL[s] ?? s}</dt>
                {Object.entries(vals).map(([k, v]) => (
                  <dd key={k} className="flex items-baseline justify-between gap-3 py-0.5 text-xs">
                    <span className="text-ink-muted">{humanKey(k)}</span><span className="num text-ink-primary">{String(v)}</span>
                  </dd>
                ))}
              </dl>
            ))}
          </div>
        ) : <p className="text-sm text-ink-muted">Loading…</p>}
      </Panel>
      <AdminTable columns={columns} data={rows} rowKey={(p) => p.id} density="compact" title="Versions"
        isLoading={q.isLoading} error={q.error} onRetry={() => void q.refetch()}
        onRowClick={setView} isRowActive={(p) => p.id === view?.id}
        rowActions={(p) => !p.is_active && role.isSuperuser ? (
          <Button size="sm" variant="secondary" leftIcon={<History size={13} />} onClick={(e) => { e.stopPropagation(); setActivate(p) }}>
            {active && new Date(p.created_at) < new Date(active.created_at) ? 'Roll back to this' : 'Activate'}
          </Button>
        ) : null}
        emptyMessage="No policy versions yet" emptyDescription="The built-in default applies until you create and activate a version." />

      <SlideOver open={!!view} onClose={() => setView(null)} title={view ? `Version ${view.version}` : ''} subtitle={view ? `Created ${formatDateTime(view.created_at)}` : undefined}
        headerAside={view && <StatusBadge size="sm" tone={view.is_active ? 'success' : 'neutral'} label={view.is_active ? 'Active' : 'Inactive'} />}
        footer={view && !view.is_active && role.isSuperuser ? <Button variant="primary" leftIcon={<ShieldCheck size={13} />} onClick={() => setActivate(view)}>Activate this version</Button> : undefined}>
        {view && (
          <div className="space-y-3">
            <p className="text-sm text-ink-secondary">{view.description || 'No description.'}</p>
            <p className="flex items-center gap-1.5 text-xs font-semibold text-ink-muted"><Code2 size={13} aria-hidden /> Configuration (JSON)</p>
            <pre className="mono overflow-auto rounded-md border border-surface-border bg-surface-sunken p-3 text-xs text-ink-primary">{JSON.stringify(view.config, null, 2)}</pre>
          </div>
        )}
      </SlideOver>

      <Modal open={editor} onClose={() => setEditor(false)} dismissible={!create.isPending} size="lg"
        title="New policy version" description={`Starts from ${active ? `version ${active.version}` : 'the built-in default'}. It is saved inactive; nothing changes until you activate it.`}
        footer={<>
          <span className="mr-auto text-xs text-ink-muted">{changedKeys.length} value{changedKeys.length === 1 ? '' : 's'} changed</span>
          <Button variant="secondary" onClick={() => setEditor(false)} disabled={create.isPending}>Cancel</Button>
          <Button variant="primary" loading={create.isPending} onClick={submit}>Create inactive version</Button>
        </>}>
        <div className="space-y-4">
          {serverErr && <p role="alert" className="rounded-md border border-danger-line bg-danger-soft px-3 py-2 text-sm text-danger">{serverErr}</p>}
          <div className="grid gap-3 sm:grid-cols-2">
            <Input label="Version name" value={version} maxLength={64} placeholder="v3-runners" onChange={(e) => setVersion(e.target.value)} error={errors.version} className="mono" />
            <Textarea label="What changed and why" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} error={errors.description} />
          </div>
          {base && Object.entries(base).map(([s, vals]) => (
            <fieldset key={s} className="rounded-md border border-surface-border p-3">
              <legend className="px-1 text-xs font-semibold text-ink-primary">{SECTION_LABEL[s] ?? s}</legend>
              <div className="grid gap-3 sm:grid-cols-2">
                {Object.entries(vals).map(([k, ref]) => {
                  const key = `${s}.${k}`
                  const changed = String(ref) !== (flat[key] ?? '') && Number(ref) !== Number(flat[key])
                  return (
                    <Input key={key} size="sm" label={humanKey(k)} value={flat[key] ?? ''} inputMode="decimal"
                      onChange={(e) => setFlat({ ...flat, [key]: e.target.value })} error={errors[key]}
                      hint={changed ? `Was ${String(ref)}` : undefined}
                      className={cn('num', changed && !errors[key] && 'border-warning')} />
                  )
                })}
              </div>
            </fieldset>
          ))}
        </div>
      </Modal>

      <ConfirmModal open={!!activate} onClose={() => setActivate(null)} onConfirm={() => act.mutate()} loading={act.isPending}
        variant="danger" title={`Activate ${activate?.version ?? ''}`} confirmLabel="Activate"
        message="Step scoring for every customer switches to this version from the next sync. The previous version stays available for roll back."
        details={[{ label: 'New', value: activate?.version }, { label: 'Replaces', value: active?.version ?? 'Built-in default' }]}
        confirmDisabled={reason.trim().length < 5}>
        <Textarea label="Reason (kept in the audit log)" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
      </ConfirmModal>
    </div>
  )
}
