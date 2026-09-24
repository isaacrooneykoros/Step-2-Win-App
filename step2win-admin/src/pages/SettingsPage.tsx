import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, ChevronDown, History, RefreshCw, RotateCcw, Save, ShieldCheck } from 'lucide-react'
import { PageHeader } from '../components/PageHeader'
import { StatusBadge } from '../components/StatusBadge'
import { Panel } from '../components/ui/Card'
import { Button } from '../components/ui/Button'
import { Modal } from '../components/ui/Modal'
import { EmptyState } from '../components/ui/EmptyState'
import { ErrorState } from '../components/ui/ErrorState'
import { Skeleton } from '../components/ui/Skeleton'
import { cn } from '../lib/cn'
import { formatDateTime, formatNumber, formatRelative } from '../lib/format'
import { errorMessage } from '../lib/errors'
import { ApiError } from '../components/system/http'
import { systemApi, type SettingKey, type SettingsContext, type SystemSettings } from '../components/system/api'
import {
  display, FIELD_BY_KEY, FIELDS, parseHistoryValue, SECTIONS, sameValue, toForm, toPayload, validate,
  type FieldDef, type FormState, type FormValue, type SectionId,
} from '../components/system/fields'
import { SettingField, type StaffOption } from '../components/system/SettingField'
import { ProfileSection } from '../components/system/ProfileSection'

const MAIN_SECTIONS = SECTIONS.filter((s) => !s.advanced)
const ADVANCED_SECTIONS = SECTIONS.filter((s) => s.advanced)
const ADVANCED_IDS = new Set<SectionId>(ADVANCED_SECTIONS.map((s) => s.id))
const ADVANCED_ANCHORS = new Set(['advanced', 'server-limits', 'anti-cheat', 'staff', ...ADVANCED_SECTIONS.map((s) => `section-${s.id}`)])

function consequence(f: FieldDef, after: FormValue, ctx?: SettingsContext): string | null {
  const active = ctx?.impact.active_challenges
  switch (f.key) {
    case 'platform_fee_percentage':
      return `Applied when each challenge settles, including ${active === undefined ? 'every' : formatNumber(active)} challenge${active === 1 ? '' : 's'} already running. Winners' payouts change accordingly.`
    case 'challenge_milestones':
    case 'min_challenge_milestone':
    case 'max_challenge_milestone':
      return 'New challenges can only use the resulting milestone options. Existing challenges keep their target.'
    case 'max_challenge_participants':
      return 'Shown to creators in the app as the size limit.'
    case 'minimum_withdrawal_amount':
      return 'Withdrawal requests below this amount are refused from now on. Requests already made are not affected.'
    case 'withdrawals_enabled':
      return after ? 'Customers can request withdrawals again.' : 'Customers cannot request new withdrawals. Requests already made are still reviewed and paid.'
    case 'challenges_enabled':
      return after ? null : 'Customers cannot create challenges or rematches. Running challenges and joining continue.'
    case 'registrations_enabled':
      return after ? null : 'New accounts are refused (email and Google). Existing customers can still sign in.'
    case 'maintenance_mode':
      return after
        ? 'Every customer is shown the maintenance message instead of the app. This console and M-Pesa callbacks keep working.'
        : 'The customer app becomes available again.'
    case 'support_auto_assign_mode':
      return 'Applies to tickets opened from now on.'
    default:
      return null
  }
}

export function SettingsPage() {
  const qc = useQueryClient()
  const location = useLocation()
  const settingsQ = useQuery({ queryKey: ['admin', 'system-settings'], queryFn: systemApi.settings })
  const ctxQ = useQuery({ queryKey: ['admin', 'system-settings-context'], queryFn: systemApi.context })
  const [form, setForm] = useState<FormState | null>(null)
  const [serverErrors, setServerErrors] = useState<Partial<Record<SettingKey, string>>>({})
  const [reviewOpen, setReviewOpen] = useState(false)
  const [showErrors, setShowErrors] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(() => ADVANCED_ANCHORS.has(location.hash.slice(1)))
  const [result, setResult] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null)
  const scrolled = useRef(false)
  const keepRef = useRef<HTMLButtonElement>(null)

  const saved = useMemo(() => (settingsQ.data ? toForm(settingsQ.data) : null), [settingsQ.data])
  const current = form ?? saved
  const changes = useMemo(
    () => (current && saved ? FIELDS.filter((f) => !sameValue(f, current[f.key], saved[f.key])) : []),
    [current, saved],
  )
  const errors = useMemo(() => (current ? validate(current) : {}), [current])
  const visibleErrors = { ...(showErrors ? errors : pickTouched(errors, changes)), ...serverErrors }
  const errorCount = Object.keys(errors).length
  const dirty = changes.length > 0
  const risky = changes.filter((f) => f.risky)
  const advancedChanges = changes.filter((f) => ADVANCED_IDS.has(f.section)).length

  const ctx = ctxQ.data
  const staff: StaffOption[] = useMemo(() => (ctx?.staff ?? []).map((u) => ({ id: u.id, username: u.username, is_active: u.is_active })), [ctx])
  const staffName = (id: number) => staff.find((u) => u.id === id)?.username ?? `#${id}`

  // Warn before leaving with unsaved changes.
  useEffect(() => {
    if (!dirty) return
    const onUnload = (e: BeforeUnloadEvent) => { e.preventDefault() }
    window.addEventListener('beforeunload', onUnload)
    return () => window.removeEventListener('beforeunload', onUnload)
  }, [dirty])

  // /settings#profile (account menu) and section links.
  useEffect(() => {
    if (!location.hash || scrolled.current || settingsQ.isLoading) return
    const el = document.getElementById(location.hash.slice(1))
    if (el) { el.scrollIntoView({ block: 'start' }); scrolled.current = true }
  }, [location.hash, settingsQ.isLoading])

  const save = useMutation({
    mutationFn: () => {
      const payload: Partial<Record<SettingKey, unknown>> = {}
      for (const f of changes) payload[f.key] = toPayload(f, current![f.key])
      return systemApi.save(payload)
    },
    onSuccess: (data) => {
      qc.setQueryData(['admin', 'system-settings'], data)
      void qc.invalidateQueries({ queryKey: ['admin', 'system-settings-context'] })
      void qc.invalidateQueries({ queryKey: ['support'] })
      setForm(null); setServerErrors({}); setShowErrors(false); setReviewOpen(false)
      setResult({ tone: 'success', text: `Saved ${changes.length} change${changes.length === 1 ? '' : 's'}. In effect for customers within about 15 seconds; recorded in the change history.` })
    },
    onError: (err) => {
      const fields = err instanceof ApiError ? (err.fields as Partial<Record<SettingKey, string>>) : {}
      setServerErrors(fields)
      setReviewOpen(false)
      setResult({ tone: 'danger', text: `Not saved. ${errorMessage(err) ?? ''}`.trim() })
    },
  })

  useEffect(() => {
    if (result?.tone !== 'success') return
    const id = window.setTimeout(() => setResult(null), 6000)
    return () => window.clearTimeout(id)
  }, [result])

  const update = (key: SettingKey, value: FormValue) => {
    if (!current) return
    setForm({ ...current, [key]: value })
    if (serverErrors[key]) setServerErrors((e) => { const n = { ...e }; delete n[key]; return n })
  }
  const discard = () => { setForm(null); setServerErrors({}); setShowErrors(false) }
  const jump = (id: string) => {
    if (ADVANCED_ANCHORS.has(id)) setAdvancedOpen(true)
    window.setTimeout(() => document.getElementById(id)?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 0)
  }
  const review = () => {
    if (errorCount) {
      setShowErrors(true)
      const first = FIELDS.find((f) => errors[f.key])
      if (first) jump(`section-${first.section}`)
      return
    }
    setReviewOpen(true)
  }

  const s = settingsQ.data

  const renderSection = (sec: (typeof SECTIONS)[number]) => {
    if (!current || !saved) return null
    const fields = FIELDS.filter((f) => f.section === sec.id)
    const n = changes.filter((f) => f.section === sec.id).length
    return (
      <Panel key={sec.id} id={`section-${sec.id}`} className="scroll-mt-20" title={sec.title} description={sec.description}
        actions={
          <span className="flex items-center gap-2">
            {sec.id === 'support' && (
              <Link to="/support?panel=replies" className="text-xs font-medium text-brand-text hover:underline">Saved replies</Link>
            )}
            {n > 0 && <StatusBadge size="sm" tone="warning" label={`${n} unsaved`} />}
          </span>
        }>
        {sec.id === 'challenges' && ctx && (
          <p className="mb-4 flex items-start gap-2 rounded-md border border-surface-border bg-surface-base px-3 py-2 text-xs text-ink-secondary">
            <AlertTriangle size={13} className="mt-px shrink-0 text-warning" aria-hidden />
            <span>
              The platform fee is read when a challenge settles, not when it is created.
              <span className="num"> {formatNumber(ctx.impact.active_challenges)} active</span> and
              <span className="num"> {formatNumber(ctx.impact.pending_challenges)} pending</span> challenges would settle with a new value.
            </span>
          </p>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          {fields.map((f) => (
            <SettingField
              key={f.key}
              def={f}
              value={current[f.key]}
              saved={saved[f.key]}
              changed={!sameValue(f, current[f.key], saved[f.key])}
              error={visibleErrors[f.key]}
              enforcedBy={ctx?.enforced_by[f.key]}
              staff={staff}
              onChange={(v) => update(f.key, v)}
            />
          ))}
        </div>
      </Panel>
    )
  }

  const navItems = [
    ...MAIN_SECTIONS.map((x) => ({ id: `section-${x.id}`, title: x.title, count: changes.filter((f) => f.section === x.id).length })),
    { id: 'advanced', title: 'Advanced', count: advancedChanges },
    { id: 'history', title: 'Change history', count: 0 },
    { id: 'profile', title: 'My profile', count: 0 },
  ]

  return (
    <div className="space-y-5">
      <PageHeader
        title="Settings"
        description="Customer access, challenge and withdrawal rules, the support desk, and your own admin profile."
        meta={s?.updated_at ? <>Last saved {formatDateTime(s.updated_at)} ({formatRelative(s.updated_at)}){s.updated_by ? ` by ${s.updated_by}` : ''}</> : undefined}
        actions={
          <Button size="sm" variant="secondary" leftIcon={<RefreshCw size={13} />} loading={settingsQ.isFetching || ctxQ.isFetching}
            disabled={dirty} title={dirty ? 'Save or discard your changes first' : undefined}
            onClick={() => { void settingsQ.refetch(); void ctxQ.refetch() }}>
            Refresh
          </Button>
        }
      />

      {result && (
        <div role={result.tone === 'danger' ? 'alert' : 'status'} className={cn('flex items-center gap-3 rounded-md border px-3 py-2 text-sm', result.tone === 'success' ? 'border-success-line bg-success-soft text-success' : 'border-danger-line bg-danger-soft text-danger')}>
          <span className="flex-1 font-medium">{result.text}</span>
          <button type="button" className="text-xs underline" onClick={() => setResult(null)}>Dismiss</button>
        </div>
      )}

      {s && <AccessSummary s={s} onJump={() => jump('section-access')} />}

      <div className="grid gap-6 lg:grid-cols-[12rem_minmax(0,1fr)]">
        <nav aria-label="Settings sections" className="hidden lg:block">
          <ul className="sticky top-20 space-y-0.5 text-sm">
            {navItems.map((item) => (
              <li key={item.id}>
                <a href={`#${item.id}`} onClick={(e) => { e.preventDefault(); jump(item.id) }}
                  className="flex items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-ink-secondary hover:bg-surface-elevated hover:text-ink-primary">
                  <span className="truncate">{item.title}</span>
                  {item.count > 0 && <span className="num rounded bg-warning-soft px-1.5 text-2xs font-semibold text-warning">{item.count}</span>}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="min-w-0 space-y-5">
          {settingsQ.isLoading ? (
            Array.from({ length: 3 }).map((_, i) => (
              <Panel key={i} title={<Skeleton width={140} height={14} label={i === 0 ? 'Loading settings' : undefined} />}>
                <div className="grid gap-4 sm:grid-cols-2"><Skeleton height={56} /><Skeleton height={56} /><Skeleton height={56} /><Skeleton height={56} /></div>
              </Panel>
            ))
          ) : settingsQ.error || !current || !saved ? (
            <Panel><ErrorState title="Could not load settings" error={settingsQ.error} onRetry={() => void settingsQ.refetch()} retrying={settingsQ.isFetching} /></Panel>
          ) : (
            MAIN_SECTIONS.map(renderSection)
          )}

          <section id="advanced" className="scroll-mt-20 rounded-lg border border-surface-border bg-surface-card shadow-card">
            <button
              type="button"
              aria-expanded={advancedOpen}
              aria-controls="advanced-body"
              onClick={() => setAdvancedOpen((o) => !o)}
              className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-surface-elevated"
            >
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold text-ink-primary">Advanced</span>
                <span className="block text-xs text-ink-muted">XP, contact emails and referrals, server limits, anti-cheat thresholds and staff accounts. Rarely changed.</span>
              </span>
              {advancedChanges > 0 && <StatusBadge size="sm" tone="warning" label={`${advancedChanges} unsaved`} />}
              <ChevronDown size={16} aria-hidden className={cn('shrink-0 text-ink-muted transition-transform', advancedOpen && 'rotate-180')} />
            </button>
            {advancedOpen && (
              <div id="advanced-body" className="space-y-5 border-t border-surface-border bg-surface-base p-4">
                {current && saved && ADVANCED_SECTIONS.map(renderSection)}
                <ServerLimits ctx={ctx} loading={ctxQ.isLoading} error={ctxQ.error} onRetry={() => void ctxQ.refetch()} />
                <StaffPanel ctx={ctx} loading={ctxQ.isLoading} error={ctxQ.error} onRetry={() => void ctxQ.refetch()} />
              </div>
            )}
          </section>

          <HistoryPanel ctx={ctx} loading={ctxQ.isLoading} error={ctxQ.error} onRetry={() => void ctxQ.refetch()} staffName={staffName} />
          <ProfileSection />

      {dirty && (
        <div className="sticky bottom-3 z-30 rounded-lg border border-warning-line bg-surface-overlay shadow-pop">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
            <p className="min-w-0 flex-1 text-sm text-ink-primary">
              <span className="font-semibold">{changes.length} unsaved change{changes.length === 1 ? '' : 's'}</span>
              {risky.length > 0 && <span className="text-ink-secondary"> · {risky.length} affect{risky.length === 1 ? 's' : ''} money or access</span>}
              {errorCount > 0 && showErrors && <span className="text-danger"> · fix {errorCount} error{errorCount === 1 ? '' : 's'} first</span>}
            </p>
            <Button size="sm" variant="ghost" leftIcon={<RotateCcw size={13} />} onClick={discard} disabled={save.isPending}>Discard</Button>
            <Button size="sm" variant="primary" leftIcon={<Save size={13} />} onClick={review} loading={save.isPending}>Review and save</Button>
          </div>
        </div>
      )}
        </div>
      </div>

      <Modal
        open={reviewOpen}
        onClose={() => setReviewOpen(false)}
        dismissible={!save.isPending}
        role="alertdialog"
        initialFocus={keepRef}
        size="lg"
        title={`Save ${changes.length} change${changes.length === 1 ? '' : 's'}?`}
        description={risky.length ? 'Some of these change money or access for customers. Check each value before saving.' : 'These values replace the current settings immediately.'}
        icon={<span className={cn('flex h-8 w-8 items-center justify-center rounded-md', risky.length ? 'bg-warning-soft text-warning' : 'bg-info-soft text-info')}><AlertTriangle size={16} aria-hidden /></span>}
        footer={
          <>
            <Button variant="secondary" onClick={() => setReviewOpen(false)} disabled={save.isPending} ref={keepRef}>Keep editing</Button>
            <Button variant="primary" onClick={() => save.mutate()} loading={save.isPending} loadingText="Saving…">Save changes</Button>
          </>
        }
      >
        {current && saved && (
          <table className="w-full text-sm">
            <caption className="sr-only">Changes: before and after</caption>
            <thead>
              <tr className="border-b border-surface-border text-left text-xs text-ink-muted">
                <th scope="col" className="py-2 pr-3 font-medium">Setting</th>
                <th scope="col" className="py-2 pr-3 font-medium">Before</th>
                <th scope="col" className="py-2 font-medium">After</th>
              </tr>
            </thead>
            <tbody>
              {changes.map((f) => {
                const note = consequence(f, current[f.key], ctx)
                return (
                  <tr key={f.key} className="border-b border-surface-border align-top last:border-b-0">
                    <th scope="row" className="py-2 pr-3 text-left font-medium text-ink-primary">
                      {f.label}
                      {f.risky && <StatusBadge size="sm" tone="warning" label="Money / access" className="ml-1.5 align-middle" />}
                      {note && <p className="mt-1 text-xs font-normal text-ink-secondary">{note}</p>}
                    </th>
                    <td className="num py-2 pr-3 text-ink-muted line-through decoration-ink-disabled">{reviewValue(f, saved[f.key], null, staffName)}</td>
                    <td className="num py-2 font-medium text-ink-primary">{reviewValue(f, current[f.key], saved[f.key], staffName)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </Modal>
    </div>
  )
}

/** What customers are experiencing right now (saved values, not the unsaved form). */
function AccessSummary({ s, onJump }: { s: SystemSettings; onJump: () => void }) {
  const paused = [
    !s.withdrawals_enabled && 'Withdrawals',
    !s.challenges_enabled && 'Creating challenges',
    !s.registrations_enabled && 'New sign-ups',
  ].filter(Boolean) as string[]
  const tone = s.maintenance_mode ? 'danger' : paused.length ? 'warning' : 'success'
  return (
    <div role="status" className={cn('flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border px-4 py-3',
      tone === 'danger' ? 'border-danger-line bg-danger-soft' : tone === 'warning' ? 'border-warning-line bg-warning-soft' : 'border-surface-border bg-surface-card shadow-card')}>
      <span className="flex items-center gap-2 text-sm font-semibold text-ink-primary">
        Customer app
        <StatusBadge size="sm" tone={tone} label={s.maintenance_mode ? 'Maintenance on' : paused.length ? 'Partly paused' : 'Live'} />
      </span>
      <span className="min-w-0 flex-1 text-xs text-ink-secondary">
        {s.maintenance_mode
          ? <>Customers see: <span className="font-medium text-ink-primary">“{s.maintenance_message || 'We\'ll be right back.'}”</span></>
          : paused.length ? <>Paused: {paused.join(', ')}.</> : 'Every feature is on.'}
      </span>
      <button type="button" onClick={onJump} className="text-xs font-medium text-brand-text hover:underline">Customer access settings</button>
    </div>
  )
}

/** Milestone lists are long: show counts and what was added/removed instead of both lists. */
function reviewValue(f: FieldDef, v: FormValue, before: FormValue | null, staffName: (id: number) => string): string {
  if (f.kind !== 'milestones') return display(f, v, staffName)
  const list = v as number[]
  if (!before) return `${list.length} options`
  const prev = before as number[]
  const added = list.filter((m) => !prev.includes(m)).map((m) => m.toLocaleString('en-KE'))
  const removed = prev.filter((m) => !list.includes(m)).map((m) => m.toLocaleString('en-KE'))
  return [`${list.length} options`, added.length && `added ${added.join(', ')}`, removed.length && `removed ${removed.join(', ')}`].filter(Boolean).join(' · ')
}

function pickTouched(errors: Partial<Record<SettingKey, string>>, changed: FieldDef[]) {
  const out: Partial<Record<SettingKey, string>> = {}
  for (const f of changed) if (errors[f.key]) out[f.key] = errors[f.key]
  // Cross-field errors land on the partner field; show them if either side changed.
  const keys = new Set(changed.map((f) => f.key))
  if ((keys.has('min_challenge_milestone') || keys.has('max_challenge_milestone')) && errors.challenge_milestones) out.challenge_milestones = errors.challenge_milestones
  if (keys.has('min_challenge_milestone') && errors.max_challenge_milestone) out.max_challenge_milestone = errors.max_challenge_milestone
  if (keys.has('min_challenge_entry_fee') && errors.max_challenge_entry_fee) out.max_challenge_entry_fee = errors.max_challenge_entry_fee
  if (keys.has('maintenance_mode') && errors.maintenance_message) out.maintenance_message = errors.maintenance_message
  const sla: SettingKey[] = ['support_sla_urgent_hours', 'support_sla_high_hours', 'support_sla_medium_hours', 'support_sla_low_hours']
  if (sla.some((k) => keys.has(k))) for (const k of sla) if (errors[k]) out[k] = errors[k]
  if (keys.has('support_auto_assign_mode')) {
    if (errors.support_agent_ids) out.support_agent_ids = errors.support_agent_ids
    if (errors.support_category_assignees) out.support_category_assignees = errors.support_category_assignees
  }
  return out
}

interface CtxPanelProps { ctx?: SettingsContext; loading: boolean; error: unknown; onRetry: () => void }

function ctxState({ loading, error, onRetry }: CtxPanelProps) {
  if (loading) return <div className="space-y-2 p-4"><Skeleton height={14} /><Skeleton height={14} width="80%" /><Skeleton height={14} width="60%" /></div>
  if (error) return <ErrorState size="compact" error={error} onRetry={onRetry} />
  return null
}

const LIMIT_ROWS: Array<{ group: 'payments' | 'challenges'; key: string; label: string; fmt: (v: number) => string }> = [
  { group: 'payments', key: 'min_deposit_kes', label: 'Deposit', fmt: (v) => `from KSh ${formatNumber(v)}` },
  { group: 'payments', key: 'max_deposit_kes', label: 'Largest deposit', fmt: (v) => `KSh ${formatNumber(v)}` },
  { group: 'payments', key: 'min_withdrawal_kes', label: 'Withdrawal floor (the minimum can’t go lower)', fmt: (v) => `KSh ${formatNumber(v)}` },
  { group: 'payments', key: 'max_withdrawal_kes', label: 'Largest withdrawal', fmt: (v) => `KSh ${formatNumber(v)}` },
  { group: 'payments', key: 'max_daily_withdrawal_amount_kes', label: 'Withdrawals per user per day', fmt: (v) => `KSh ${formatNumber(v)}` },
  { group: 'payments', key: 'max_withdrawals_per_day', label: 'Withdrawal requests per day', fmt: (v) => formatNumber(v) },
  { group: 'payments', key: 'max_withdrawals_per_hour', label: 'Withdrawal requests per hour', fmt: (v) => formatNumber(v) },
  { group: 'payments', key: 'min_seconds_between_withdrawals', label: 'Gap between withdrawals', fmt: (v) => `${formatNumber(v / 60)} min` },
  { group: 'payments', key: 'withdrawal_fee_kes', label: 'Withdrawal fee', fmt: (v) => `KSh ${formatNumber(v)}` },
  { group: 'challenges', key: 'min_trust_score_for_paid_challenge', label: 'Trust score to join paid challenges', fmt: (v) => formatNumber(v) },
  { group: 'challenges', key: 'min_challenges_joined_to_create_paid', label: 'Challenges joined before creating a paid one', fmt: (v) => formatNumber(v) },
]

function ServerLimits(props: CtxPanelProps) {
  const { ctx } = props
  const ac = ctx?.server_limits.anti_cheat
  const risk = (k: string) => (ac?.[k] === null || ac?.[k] === undefined ? '—' : formatNumber(ac[k]))
  return (
    <>
      <Panel id="server-limits" className="scroll-mt-20" padding="none" title="Server limits"
        description="Fixed in the backend configuration and enforced on every request. Changing them needs a deployment, not this page.">
        {ctxState(props) ?? (
          <dl className="grid sm:grid-cols-2">
            {LIMIT_ROWS.map((r) => {
              const v = ctx?.server_limits[r.group][r.key]
              return (
                <div key={r.key} className="flex items-baseline justify-between gap-4 border-b border-surface-border px-4 py-2.5 sm:odd:border-r">
                  <dt className="text-xs text-ink-muted">{r.label}</dt>
                  <dd className="num text-sm text-ink-primary">{v === null || v === undefined ? '—' : r.fmt(Number(v))}</dd>
                </div>
              )
            })}
          </dl>
        )}
      </Panel>
      <Panel id="anti-cheat" className="scroll-mt-20" padding="none" title="Anti-cheat policy"
        description="Step validation thresholds from the backend configuration. Read-only here; decisions on cases are made in Anti-cheat."
        actions={<Link to="/anti-cheat" className="text-xs font-medium text-brand-text hover:underline">Open Anti-cheat</Link>}>
        {ctxState(props) ?? (ac && (
          <div className="p-4">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <ShieldCheck size={15} className="text-ink-muted" aria-hidden />
              <span className="text-sm text-ink-primary">Validation engine {String(ac.v2_version ?? '')}</span>
              <StatusBadge size="sm" tone={ac.v2_enabled ? 'success' : 'neutral'} label={ac.v2_enabled ? 'Enabled' : 'Disabled'} />
              {ac.v2_enabled && <StatusBadge size="sm" tone={ac.v2_shadow_mode ? 'warning' : 'success'} label={ac.v2_shadow_mode ? 'Shadow mode: scores only, no enforcement' : 'Enforcing'} />}
            </div>
            <table className="w-full text-sm">
              <caption className="sr-only">Anti-cheat thresholds</caption>
              <thead>
                <tr className="border-b border-surface-border text-left text-xs text-ink-muted">
                  <th scope="col" className="py-1.5 pr-3 font-medium">Signal</th>
                  <th scope="col" className="py-1.5 pr-3 text-right font-medium">Suspicious at</th>
                  <th scope="col" className="py-1.5 text-right font-medium">Impossible at</th>
                </tr>
              </thead>
              <tbody className="num">
                <tr className="border-b border-surface-border"><th scope="row" className="py-1.5 pr-3 text-left font-normal text-ink-secondary">Steps per minute</th><td className="py-1.5 pr-3 text-right">{risk('suspicious_steps_per_min')}</td><td className="py-1.5 text-right">{risk('impossible_steps_per_min')}</td></tr>
                <tr><th scope="row" className="py-1.5 pr-3 text-left font-normal text-ink-secondary">Cadence (steps/min)</th><td className="py-1.5 pr-3 text-right">{risk('suspicious_cadence_spm')}</td><td className="py-1.5 text-right">{risk('impossible_cadence_spm')}</td></tr>
              </tbody>
            </table>
            <p className="mt-3 text-xs text-ink-muted">
              Risk score actions: review from <span className="num font-medium text-ink-secondary">{risk('review_risk')}</span>, hold payout from{' '}
              <span className="num font-medium text-ink-secondary">{risk('payout_hold_risk')}</span>, reject from{' '}
              <span className="num font-medium text-ink-secondary">{risk('reject_risk')}</span> (0–100).
            </p>
          </div>
        ))}
      </Panel>
    </>
  )
}

function StaffPanel(props: CtxPanelProps) {
  const staff = props.ctx?.staff ?? []
  return (
    <Panel id="staff" className="scroll-mt-20" padding="none" title="Staff accounts"
      description="Everyone who can sign in to this console. Grant or remove staff access from the user's profile."
      actions={<Link to="/users" className="text-xs font-medium text-brand-text hover:underline">Manage in Users</Link>}>
      {ctxState(props) ?? (staff.length === 0 ? <EmptyState size="compact" title="No staff accounts" /> : (
        <ul className="divide-y divide-[var(--border)]">
          {staff.map((u) => (
            <li key={u.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5">
              <span className="min-w-0 flex-1">
                <Link to={`/users?user=${u.id}`} className="block truncate text-sm font-medium text-ink-primary hover:underline">{u.username}</Link>
                <span className="block truncate text-xs text-ink-muted">{u.email || '—'}</span>
              </span>
              <StatusBadge size="sm" tone="violet" label={u.is_superuser ? 'Superuser' : 'Staff'} />
              {!u.is_active && <StatusBadge size="sm" status="inactive" />}
              <span className="w-40 text-right text-xs text-ink-muted" title={u.last_login ? formatDateTime(u.last_login) : undefined}>
                {u.last_login ? `Signed in ${formatRelative(u.last_login)}` : 'Never signed in'}
              </span>
            </li>
          ))}
        </ul>
      ))}
    </Panel>
  )
}

function HistoryPanel(props: CtxPanelProps & { staffName: (id: number) => string }) {
  const history = props.ctx?.history ?? []
  return (
    <Panel id="history" className="scroll-mt-20" padding="none" title="Change history" description="Every settings save, from the audit log. Latest 25."
      actions={<Link to="/activity" className="text-xs font-medium text-brand-text hover:underline">Full audit log</Link>}>
      {ctxState(props) ?? (history.length === 0 ? (
        <EmptyState size="compact" icon={History} title="No settings changes recorded" description="Saves made on this page appear here with who changed what." />
      ) : (
        <ol className="divide-y divide-[var(--border)]">
          {history.map((h) => {
            const entries = h.changes ? Object.entries(h.changes) : []
            return (
              <li key={h.id} className="px-4 py-3">
                <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
                  <span className="font-medium text-ink-primary">{h.admin_username}</span>
                  <span className="text-ink-secondary">{entries.length ? `changed ${entries.length} setting${entries.length === 1 ? '' : 's'}` : 'saved settings with no changes'}</span>
                  <time className="ml-auto text-xs text-ink-muted" dateTime={h.created_at}>{formatDateTime(h.created_at)} · {formatRelative(h.created_at)}</time>
                </p>
                {entries.length > 0 && (
                  <ul className="mt-1.5 space-y-0.5">
                    {entries.map(([k, c]) => {
                      const f = FIELD_BY_KEY[k as SettingKey]
                      const fmt = (v: string | null) => {
                        if (!f || v === null) return v ?? '—'
                        const parsed = parseHistoryValue(f, v)
                        return parsed === null ? v : display(f, parsed, props.staffName)
                      }
                      return (
                        <li key={k} className="grid grid-cols-[minmax(0,12rem)_minmax(0,1fr)] gap-2 text-xs">
                          <span className="truncate text-ink-muted">{f?.label ?? k}</span>
                          <span className="num min-w-0 break-words text-ink-secondary">
                            <span className="line-through decoration-ink-disabled">{fmt(c.old)}</span> → <span className="font-medium text-ink-primary">{fmt(c.new)}</span>
                          </span>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </li>
            )
          })}
        </ol>
      ))}
    </Panel>
  )
}
