import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, RotateCcw, Save } from 'lucide-react'
import { Panel } from '../ui/Card'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { ErrorState } from '../ui/ErrorState'
import { Skeleton } from '../ui/Skeleton'
import { StatusBadge } from '../StatusBadge'
import { ConfirmModal } from '../ConfirmModal'
import { cn } from '../../lib/cn'
import { formatDateTime } from '../../lib/format'
import { errorMessage } from '../../lib/errors'
import { ApiError } from './http'
import { systemApi, type PrivacySettings } from './api'
import { usePermissions } from '../../lib/permissions'

type Key = Exclude<keyof PrivacySettings, 'server' | 'updated_at' | 'updated_by'>

interface Row {
  key: Key
  label: string
  hint: string
  kind: 'bool' | 'int' | 'optInt'
  unit?: string
  group: 'consent' | 'retention' | 'export'
  warning?: string
  zeroOff?: boolean
}

const ROWS: Row[] = [
  { key: 'require_consent_at_registration', label: 'Refuse sign-ups that send no consent answers', kind: 'bool', group: 'consent',
    hint: 'Current app versions always ask for consent and are always checked. This also refuses old app builds that have no consent checkboxes.',
    warning: 'Turn on only after the updated app has shipped and most customers have installed it: until then, new customers on old builds can’t sign up.' },
  { key: 'min_terms_version', label: 'Ask again below Terms version', kind: 'int', group: 'consent',
    hint: 'Customers who accepted an older Terms version are asked to accept again. Raised automatically when Terms are published with “notify users”.' },
  { key: 'min_privacy_version', label: 'Ask again below Privacy Policy version', kind: 'int', group: 'consent',
    hint: 'Same, for the Privacy Policy.' },
  { key: 'retention_enabled', label: 'Run the privacy retention job', kind: 'bool', group: 'retention',
    hint: 'Master switch. Off keeps all data below forever; leave it on.' },
  { key: 'walk_raw_points_days', label: 'Raw walk GPS points', kind: 'optInt', unit: 'days', group: 'retention',
    hint: 'Detailed GPS points of walks are deleted after this; the simplified route is kept. Blank = the server value.' },
  { key: 'sync_payload_days', label: 'Step sync raw payloads', kind: 'int', unit: 'days', group: 'retention', zeroOff: true,
    hint: 'Trimmed to aggregate fields after this.' },
  { key: 'legacy_waypoint_days', label: 'Legacy GPS waypoints', kind: 'int', unit: 'days', group: 'retention', zeroOff: true, hint: 'Deleted after this.' },
  { key: 'interval_verification_days', label: 'Per-interval anti-cheat results', kind: 'int', unit: 'days', group: 'retention', zeroOff: true, hint: 'Deleted after this.' },
  { key: 'risk_ml_days', label: 'Shadow risk-model features and scores', kind: 'int', unit: 'days', group: 'retention', zeroOff: true, hint: 'Deleted after this.' },
  { key: 'password_reset_days', label: 'Password-reset codes (with IP)', kind: 'int', unit: 'days', group: 'retention', zeroOff: true, hint: 'Deleted after this.' },
  { key: 'login_log_days', label: 'Login attempt logs', kind: 'int', unit: 'days', group: 'retention', zeroOff: true, hint: 'Deleted after this.' },
  { key: 'retention_batch_size', label: 'Retention batch size', kind: 'int', unit: 'rows', group: 'retention', hint: 'Rows per batch; keep the default unless the job is slow.' },
  { key: 'export_link_hours', label: 'Export download link lasts', kind: 'int', unit: 'hours', group: 'export', hint: 'How long a finished data export can be downloaded by the customer.' },
  { key: 'export_cooldown_hours', label: 'Time between exports', kind: 'int', unit: 'hours', group: 'export', hint: 'A customer can request one export per this many hours.' },
]

const GROUPS: Array<{ id: Row['group']; title: string }> = [
  { id: 'consent', title: 'Consent' },
  { id: 'retention', title: 'Data retention' },
  { id: 'export', title: 'Data exports' },
]

type Form = Record<Key, string | boolean>

function toForm(s: PrivacySettings): Form {
  const out = {} as Form
  for (const r of ROWS) {
    const v = s[r.key]
    out[r.key] = r.kind === 'bool' ? Boolean(v) : v === null || v === undefined ? '' : String(v)
  }
  return out
}

function payloadValue(r: Row, v: string | boolean): unknown {
  if (r.kind === 'bool') return v
  const s = String(v).trim()
  if (r.kind === 'optInt' && !s) return null
  return Number.parseInt(s, 10)
}

/** Settings > Privacy (GET/PATCH /api/privacy/admin/settings/). Saved on its own. */
export function PrivacyPanel() {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['admin', 'privacy-settings'], queryFn: systemApi.privacy })
  const saved = useMemo(() => (q.data ? toForm(q.data) : null), [q.data])
  const [form, setForm] = useState<Form | null>(null)
  const [errors, setErrors] = useState<Partial<Record<Key, string>>>({})
  const [confirm, setConfirm] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const canEdit = usePermissions().can('settings.system')
  const current = form ?? saved
  const changed = useMemo(
    () => (current && saved ? ROWS.filter((r) => String(current[r.key]).trim() !== String(saved[r.key]).trim()) : []),
    [current, saved],
  )

  useEffect(() => {
    if (!notice) return
    const t = window.setTimeout(() => setNotice(null), 5000)
    return () => window.clearTimeout(t)
  }, [notice])

  const save = useMutation({
    mutationFn: () => {
      const body: Partial<Record<Key, unknown>> = {}
      for (const r of changed) body[r.key] = payloadValue(r, current![r.key])
      return systemApi.savePrivacy(body)
    },
    onSuccess: (data) => {
      qc.setQueryData(['admin', 'privacy-settings'], data)
      void qc.invalidateQueries({ queryKey: ['admin', 'system-settings-context'] })
      setForm(null); setErrors({}); setConfirm(false)
      setNotice(`Saved ${changed.length} privacy change${changed.length === 1 ? '' : 's'}; recorded in the audit log.`)
    },
    onError: (err) => {
      setConfirm(false)
      if (err instanceof ApiError) setErrors(err.fields as Partial<Record<Key, string>>)
    },
  })

  const validate = (): boolean => {
    if (!current) return false
    const next: Partial<Record<Key, string>> = {}
    for (const r of changed) {
      if (r.kind === 'bool') continue
      const s = String(current[r.key]).trim()
      if (r.kind === 'optInt' && !s) continue
      if (!/^\d+$/.test(s)) next[r.key] = r.zeroOff ? 'Use a whole number (0 switches the rule off).' : 'Use a whole number.'
    }
    setErrors(next)
    return Object.keys(next).length === 0
  }

  return (
    <Panel id="section-privacy" className="scroll-mt-20" title="Privacy"
      description="Consent at sign-up, how long personal data is kept, and customer data exports. Saved separately from the settings above."
      actions={changed.length > 0 ? <StatusBadge size="sm" tone="warning" label={`${changed.length} unsaved`} /> : undefined}>
      {q.isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2"><Skeleton height={56} /><Skeleton height={56} /><Skeleton height={56} /><Skeleton height={56} /></div>
      ) : q.error || !current || !saved ? (
        <ErrorState title="Could not load privacy settings" error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />
      ) : (
        <div className="space-y-5">
          {notice && <p role="status" className="rounded-md border border-success-line bg-success-soft px-3 py-2 text-sm text-success">{notice}</p>}
          {save.error && !(save.error instanceof ApiError && Object.keys(save.error.fields ?? {}).length) && (
            <p role="alert" className="rounded-md border border-danger-line bg-danger-soft px-3 py-2 text-sm text-danger">Not saved. {errorMessage(save.error)}</p>
          )}
          {GROUPS.map((g) => (
            <section key={g.id} aria-labelledby={`privacy-${g.id}`}>
              <h3 id={`privacy-${g.id}`} className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-muted">{g.title}</h3>
              <div className="grid gap-4 sm:grid-cols-2">
                {ROWS.filter((r) => r.group === g.id).map((r) => {
                  const v = current[r.key]
                  const dirty = changed.includes(r)
                  if (r.kind === 'bool') {
                    const on = v === true
                    return (
                      <div key={r.key} className={cn('rounded-md border px-3 py-2.5 sm:col-span-2', dirty ? 'border-warning-line bg-warning-soft/40' : 'border-surface-border')}>
                        <div className="flex items-start justify-between gap-4">
                          <div className="min-w-0">
                            <label htmlFor={`pv-${r.key}`} className="text-sm font-medium text-ink-primary">{r.label}</label>
                            <p className="mt-0.5 text-xs text-ink-muted">{r.hint}</p>
                          </div>
                          <button id={`pv-${r.key}`} type="button" role="switch" aria-checked={on}
                            onClick={() => setForm({ ...current, [r.key]: !on })}
                            className={cn('relative mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors',
                              on ? 'border-transparent bg-brand' : 'border-surface-strong bg-surface-sunken')}>
                            <span className="sr-only">{on ? 'On' : 'Off'}</span>
                            <span aria-hidden className={cn('inline-block h-3.5 w-3.5 rounded-full shadow-card transition-transform', on ? 'translate-x-[18px] bg-surface-card' : 'translate-x-[3px] bg-ink-muted')} />
                          </button>
                        </div>
                        {r.warning && (
                          <p className="mt-1.5 flex items-start gap-1.5 rounded-md border border-warning-line bg-warning-soft px-2 py-1.5 text-2xs text-warning">
                            <AlertTriangle size={12} className="mt-px shrink-0" aria-hidden /><span>{r.warning}</span>
                          </p>
                        )}
                        {dirty && <p className="mt-1 text-2xs font-medium text-warning">Unsaved · was {saved[r.key] ? 'On' : 'Off'}</p>}
                      </div>
                    )
                  }
                  const serverHint = r.key === 'walk_raw_points_days' && q.data
                    ? ` Server value ${q.data.server.walk_raw_points_days} days, never more than ${q.data.server.walk_raw_points_max_days}. In force now: ${q.data.server.walk_raw_points_effective_days} days.`
                    : ''
                  return (
                    <div key={r.key}>
                      <Input label={r.label} value={String(v)} inputMode="numeric"
                        placeholder={r.kind === 'optInt' && q.data ? `Server: ${q.data.server.walk_raw_points_days}` : undefined}
                        onChange={(e) => setForm({ ...current, [r.key]: e.target.value })}
                        hint={`${r.hint}${r.zeroOff ? ' 0 switches this rule off.' : ''}${serverHint}`}
                        error={errors[r.key]}
                        className={cn('num', dirty && !errors[r.key] && 'border-warning')}
                        rightSlot={r.unit ? <span className="pointer-events-none pr-2 text-xs text-ink-muted">{r.unit}</span> : undefined} />
                      {dirty && <p className="mt-1 text-2xs font-medium text-warning">Unsaved · was {String(saved[r.key]) || 'server value'}</p>}
                    </div>
                  )
                })}
              </div>
            </section>
          ))}
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-surface-border pt-3">
            {q.data?.updated_at && (
              <span className="mr-auto text-xs text-ink-muted">Last saved {formatDateTime(q.data.updated_at)}{q.data.updated_by ? ` by ${q.data.updated_by}` : ''}</span>
            )}
            <Button size="sm" variant="ghost" leftIcon={<RotateCcw size={13} />} disabled={!changed.length || save.isPending}
              onClick={() => { setForm(null); setErrors({}) }}>Discard</Button>
            <Button size="sm" variant="primary" leftIcon={<Save size={13} />} disabled={!changed.length || !canEdit} title={canEdit ? undefined : 'Your role can’t change settings'} loading={save.isPending}
              onClick={() => { if (validate()) setConfirm(true) }}>Save privacy settings</Button>
          </div>
        </div>
      )}
      <ConfirmModal open={confirm} onClose={() => setConfirm(false)} onConfirm={() => save.mutate()} loading={save.isPending}
        variant={changed.some((r) => r.key === 'require_consent_at_registration' || r.group === 'retention') ? 'warning' : 'info'}
        title={`Save ${changed.length} privacy change${changed.length === 1 ? '' : 's'}?`}
        message="Retention changes apply at the next nightly run; shorter periods delete older data that can’t be recovered."
        confirmLabel="Save"
        details={current && saved ? changed.map((r) => ({
          label: r.label,
          value: r.kind === 'bool' ? `${saved[r.key] ? 'On' : 'Off'} → ${current[r.key] ? 'On' : 'Off'}` : `${String(saved[r.key]) || 'server value'} → ${String(current[r.key]) || 'server value'}`,
        })) : []} />
    </Panel>
  )
}
