import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowUpRight, CheckCircle2, Gavel, History, Lock, MessageSquare, RefreshCw, ShieldAlert, Unlock, UserCheck, Users } from 'lucide-react'
import { PageHeader } from '../components/PageHeader'
import { StatCard } from '../components/StatCard'
import { AdminTable, type Column } from '../components/AdminTable'
import { SlideOver } from '../components/SlideOver'
import { StatusBadge } from '../components/StatusBadge'
import { Panel } from '../components/ui/Card'
import { Button } from '../components/ui/Button'
import { Input, SearchInput, Select } from '../components/ui/Input'
import { Tabs } from '../components/ui/Tabs'
import { Toolbar, FilterChip } from '../components/ui/Toolbar'
import { EmptyState } from '../components/ui/EmptyState'
import { ErrorState } from '../components/ui/ErrorState'
import { Skeleton } from '../components/ui/Skeleton'
import { formatNumber } from '../lib/format'
import { useDebounced, useMediaQuery } from '../components/finance/hooks'
import { ApiError, trustApi, type AuditEntry, type ModerationAction, type ModerationUser } from '../components/trust/api'
import { ACTION_LABEL, moderationSpec, projectScore } from '../components/trust/decisions'
import { caseReason, caseTitle, humanizeCode, TRUST_STATUS_INFO } from '../components/trust/rules'
import { DecisionModal, ResultBanner, Section, SeverityBadge, TrustScore, When, type DecisionSpec, type ResultMessage } from '../components/trust/ui'

type Tab = 'queue' | 'enforced' | 'history'
const HISTORY_PAGE = 25
const REFRESH_MS = 30_000

type Pending =
  | { kind: 'trust'; user: ModerationUser; action: ModerationAction }
  | { kind: 'signin'; user: ModerationUser; enable: boolean }

const HISTORY_ACTION_LABEL: Record<string, string> = {
  warn: 'Warned', restrict: 'Restricted', suspend: 'Suspended', ban: 'Banned',
  unrestrict: 'Restriction lifted', unsuspend: 'Suspension lifted', unban: 'Ban lifted',
  dismiss_flag: 'Flag dismissed', session_review: 'Session reviewed',
}
const ACTION_TONE: Record<string, 'danger' | 'warning' | 'success' | 'neutral' | 'info'> = {
  warn: 'warning', restrict: 'danger', suspend: 'danger', ban: 'danger',
  unrestrict: 'success', unsuspend: 'success', unban: 'success', dismiss_flag: 'neutral', session_review: 'info',
}

function describe(err: unknown): string {
  if (err instanceof ApiError) return err.message
  return err instanceof Error ? err.message : 'Unknown error.'
}

function ActionBadge({ a }: { a: AuditEntry }) {
  // "ban"/"unban" from the Users page change sign-in, not the trust score.
  const signin = (a.action === 'ban' || a.action === 'unban') && !a.trust_score
  const label = signin ? (a.action === 'ban' ? 'Sign-in disabled' : 'Sign-in enabled') : a.action === 'session_review' && a.decision ? `Session ${a.decision.new}` : HISTORY_ACTION_LABEL[a.action] ?? humanizeCode(a.action)
  return <StatusBadge size="sm" tone={ACTION_TONE[a.action] ?? 'neutral'} label={label} />
}

function signinSpec(u: ModerationUser, enable: boolean): DecisionSpec {
  return {
    title: enable ? `Enable sign-in · ${u.username}` : `Disable sign-in · ${u.username}`,
    confirmLabel: enable ? 'Enable sign-in' : 'Disable sign-in',
    variant: enable ? 'warning' : 'danger',
    message: enable
      ? 'The account can sign in again. The trust score is not changed.'
      : 'The account is deactivated: the user cannot sign in or use the app. Wallet balance and history are kept. The trust score is not changed.',
    details: [{ label: 'User', value: u.username }, { label: 'Email', value: u.email }],
    consequence: enable ? undefined : 'The user is signed out on their next request.',
    allowMessage: false,
    presets: enable ? ['Appeal accepted after review.'] : ['Confirmed cheating across multiple sessions.'],
  }
}

function UserPane({ u, onAct, busy }: { u: ModerationUser; onAct: (p: Pending) => void; busy: boolean }) {
  const casesQ = useQuery({
    queryKey: ['admin', 'trust', 'cases', { user_id: u.id, status: 'open' }],
    queryFn: () => trustApi.cases({ user_id: u.id, status: 'open', limit: 20 }),
  })
  const histQ = useQuery({
    queryKey: ['admin', 'trust', 'moderation-history', { user_id: u.id }],
    queryFn: () => trustApi.moderationHistory({ user_id: u.id, limit: 10 }),
  })
  const st = u.trust_status
  const lift: ModerationAction | null = st === 'RESTRICT' ? 'unrestrict' : st === 'SUSPEND' ? 'unsuspend' : st === 'BAN' ? 'unban' : null
  const enforce: ModerationAction[] = (['warn', 'restrict', 'suspend', 'ban'] as const).filter((a) => projectScore(u.trust_score, a) !== u.trust_score || a === 'warn')

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate text-base font-semibold text-ink-primary">{u.username}</p>
            <p className="truncate text-xs text-ink-muted">{u.email} · joined {u.date_joined ? new Date(u.date_joined).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'}</p>
          </div>
          <TrustScore score={u.trust_score} status={u.trust_status} />
        </div>
        <p className="text-sm text-ink-secondary">{TRUST_STATUS_INFO[st]?.effect}</p>
        <p className="flex items-center gap-1.5 text-sm">
          {u.is_active ? <Unlock size={14} className="text-ink-muted" aria-hidden /> : <Lock size={14} className="text-danger" aria-hidden />}
          <span className={u.is_active ? 'text-ink-secondary' : 'font-medium text-danger'}>{u.is_active ? 'Sign-in allowed' : 'Sign-in disabled'}</span>
        </p>
        <div className="flex gap-3 text-xs">
          <Link to={`/users?user=${u.id}`} className="inline-flex items-center gap-0.5 font-medium text-brand-text hover:underline">User record <ArrowUpRight size={12} aria-hidden /></Link>
          <Link to={`/fraud?q=${encodeURIComponent(u.username)}`} className="inline-flex items-center gap-0.5 font-medium text-brand-text hover:underline">Anti-cheat cases <ArrowUpRight size={12} aria-hidden /></Link>
        </div>
      </div>

      <Section title="Trust enforcement">
        <div className="grid grid-cols-2 gap-2">
          {enforce.map((a) => (
            <Button key={a} size="sm" variant={a === 'warn' ? 'secondary' : 'danger-soft'} disabled={busy} onClick={() => onAct({ kind: 'trust', user: u, action: a })}>
              {ACTION_LABEL[a]}
            </Button>
          ))}
          {lift && (
            <Button size="sm" variant="primary" disabled={busy} className="col-span-2" onClick={() => onAct({ kind: 'trust', user: u, action: lift })}>
              {ACTION_LABEL[lift]}
            </Button>
          )}
        </div>
        <p className="text-xs text-ink-muted">Changes the anti-cheat trust score. Suspend and ban stop step syncs; they do not block sign-in.</p>
      </Section>

      <Section title="Account access">
        <Button size="sm" fullWidth variant={u.is_active ? 'danger-soft' : 'secondary'} disabled={busy} leftIcon={u.is_active ? <Lock size={13} /> : <UserCheck size={13} />} onClick={() => onAct({ kind: 'signin', user: u, enable: !u.is_active })}>
          {u.is_active ? 'Disable sign-in' : 'Enable sign-in'}
        </Button>
      </Section>

      <Section title="Open anti-cheat cases" aside={<span className="num text-xs text-ink-muted">{casesQ.data?.count ?? ''}</span>}>
        {casesQ.isLoading ? <Skeleton height={60} /> : casesQ.error ? (
          <ErrorState size="compact" error={casesQ.error} onRetry={() => void casesQ.refetch()} />
        ) : !casesQ.data?.results.length ? (
          <p className="text-sm text-ink-muted">No open cases.</p>
        ) : (
          <ul className="divide-y divide-[var(--border)] rounded-md border border-surface-border">
            {casesQ.data.results.map((c) => (
              <li key={c.key} className="space-y-0.5 px-3 py-2">
                <div className="flex items-center gap-2">
                  <SeverityBadge severity={c.severity} size="sm" />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink-primary">{caseTitle(c)}</span>
                  <span className="text-xs text-ink-muted"><When value={c.created_at} /></span>
                </div>
                <p className="truncate text-xs text-ink-muted">{caseReason(c)}</p>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Decision history">
        {histQ.isLoading ? <Skeleton height={60} /> : histQ.error ? (
          <ErrorState size="compact" error={histQ.error} onRetry={() => void histQ.refetch()} />
        ) : !histQ.data?.results.length ? (
          <p className="text-sm text-ink-muted">No moderation decisions recorded for this account.</p>
        ) : (
          <ol className="space-y-3">
            {histQ.data.results.map((a) => (
              <li key={a.id} className="border-l-2 border-surface-strong pl-3 text-xs">
                <div className="flex flex-wrap items-center gap-2"><ActionBadge a={a} /><span className="text-ink-muted">{a.admin} · <When value={a.created_at} /></span></div>
                {a.trust_score && <p className="num mt-1 text-ink-secondary">Trust {a.trust_score.old} → {a.trust_score.new}</p>}
                {a.reason && <p className="mt-0.5 text-ink-primary">“{a.reason}”</p>}
                {a.message_to_user && <p className="mt-0.5 flex items-start gap-1 text-ink-muted"><MessageSquare size={12} className="mt-px shrink-0" aria-hidden /> Sent: “{a.message_to_user}”</p>}
              </li>
            ))}
          </ol>
        )}
      </Section>
    </div>
  )
}

export function ModerationPage() {
  const qc = useQueryClient()
  const wide = useMediaQuery('(min-width: 1400px)')
  const [params] = useSearchParams()
  const [tab, setTabRaw] = useState<Tab>('queue')
  const [result, setResult] = useState<ResultMessage | null>(null)
  const [search, setSearch] = useState(params.get('q') ?? '')
  const q = useDebounced(search.trim())
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [pending, setPending] = useState<Pending | null>(null)

  const [hSearch, setHSearchRaw] = useState('')
  const [hAction, setHActionRaw] = useState('')
  const [hFrom, setHFromRaw] = useState('')
  const [hTo, setHToRaw] = useState('')
  const [hPage, setHPage] = useState(1)
  const reset = <T,>(set: (v: T) => void) => (v: T) => { set(v); setHPage(1) }
  const setHSearch = reset(setHSearchRaw)
  const setHAction = reset(setHActionRaw)
  const setHFrom = reset(setHFromRaw)
  const setHTo = reset(setHToRaw)
  const setTab = (t: Tab) => { setTabRaw(t); setSelectedId(null); setDrawerOpen(false) }
  const hq = useDebounced(hSearch.trim())

  const view = tab === 'enforced' ? 'enforced' : 'queue'
  // Unfiltered lists feed the KPIs; the filtered ones (only while searching) feed the table.
  const queueQ = useQuery({ queryKey: ['admin', 'trust', 'moderation', 'queue', ''], queryFn: () => trustApi.moderationUsers('queue'), refetchInterval: REFRESH_MS })
  const enforcedQ = useQuery({ queryKey: ['admin', 'trust', 'moderation', 'enforced', ''], queryFn: () => trustApi.moderationUsers('enforced'), refetchInterval: REFRESH_MS })
  const searchQ = useQuery({
    queryKey: ['admin', 'trust', 'moderation', tab === 'enforced' ? 'enforced' : 'queue', q],
    queryFn: () => trustApi.moderationUsers(tab === 'enforced' ? 'enforced' : 'queue', q),
    enabled: !!q && tab !== 'history',
    placeholderData: (prev) => prev,
  })
  const weekQ = useQuery({
    queryKey: ['admin', 'trust', 'moderation-history', 'last-7-days'],
    queryFn: () => trustApi.moderationHistory({ from: new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10), limit: 1 }),
  })
  const hFilters = { q: hq || undefined, action: hAction || undefined, from: hFrom || undefined, to: hTo || undefined, limit: HISTORY_PAGE, offset: (hPage - 1) * HISTORY_PAGE }
  const historyQ = useQuery({
    queryKey: ['admin', 'trust', 'moderation-history', hFilters],
    queryFn: () => trustApi.moderationHistory(hFilters),
    enabled: tab === 'history',
    placeholderData: (prev) => prev,
  })

  const listQ = q ? searchQ : view === 'enforced' ? enforcedQ : queueQ
  const rows = useMemo(() => listQ.data?.results ?? [], [listQ.data])
  const selected = rows.find((r) => r.id === selectedId) ?? null
  const paneRow = wide && tab !== 'history' ? (selected ?? rows[0] ?? null) : null
  const disabledCount = enforcedQ.data?.results.filter((u) => !u.is_active).length

  const act = useMutation({
    mutationFn: async ({ p, reason, message }: { p: Pending; reason: string; message: string }) => {
      if (p.kind === 'signin') {
        return p.enable ? trustApi.enableAccount(p.user.id, reason) : trustApi.disableAccount(p.user.id, reason)
      }
      return trustApi.moderate(p.user.id, p.action, { reason, message_to_user: message || undefined })
    },
    onSuccess: (data, { p, message }) => {
      if (p.kind === 'signin') {
        setResult({ tone: 'success', title: `${p.enable ? 'Sign-in enabled' : 'Sign-in disabled'} · ${p.user.username}`, body: 'Recorded in the audit log with your reason.' })
      } else {
        const d = data as { trust_score?: { before: number; after: number }; trust_status?: { after: string } }
        setResult({
          tone: 'success',
          title: `${ACTION_LABEL[p.action]} · ${p.user.username}`,
          body: `Trust score ${d.trust_score?.before ?? '—'} → ${d.trust_score?.after ?? '—'} (${TRUST_STATUS_INFO[d.trust_status?.after ?? '']?.label ?? d.trust_status?.after ?? ''}). Recorded in the audit log.${message ? ' Your message was delivered to the user’s Support inbox.' : ''}`,
        })
      }
      setDrawerOpen(false)
    },
    onError: (err, { p }) => setResult({ tone: 'danger', title: `Could not update ${p.user.username}`, body: describe(err) }),
    onSettled: () => {
      setPending(null)
      void qc.invalidateQueries({ queryKey: ['admin', 'trust'] })
      void qc.invalidateQueries({ queryKey: ['admin', 'users'] })
      void qc.invalidateQueries({ queryKey: ['admin', 'fraud-overview'] })
    },
  })

  const openRow = (u: ModerationUser) => {
    setSelectedId(u.id)
    if (!wide) setDrawerOpen(true)
  }

  const userColumns: Column<ModerationUser>[] = [
    {
      key: 'user', label: 'User',
      render: (r) => (
        <span className="block min-w-0">
          <span className="block truncate font-medium text-ink-primary">{r.username}</span>
          <span className="block truncate text-xs text-ink-muted">{r.email}</span>
        </span>
      ),
    },
    { key: 'trust', label: 'Trust', render: (r) => <TrustScore score={r.trust_score} status={r.trust_status} compact /> },
    {
      key: 'cases', label: 'Open cases', hideBelow: 'md',
      render: (r) => r.open_flags + r.open_sessions === 0 ? <span className="text-ink-muted">None</span> : (
        <span className="inline-flex items-center gap-2">
          <SeverityBadge severity={r.top_severity} size="sm" />
          <span className="num whitespace-nowrap text-xs text-ink-secondary">{r.open_flags} flag{r.open_flags === 1 ? '' : 's'}{r.open_sessions ? ` · ${r.open_sessions} session${r.open_sessions === 1 ? '' : 's'}` : ''}</span>
        </span>
      ),
    },
    {
      key: 'access', label: 'Sign-in', hideBelow: 'lg',
      render: (r) => r.is_active ? <span className="text-ink-secondary">Allowed</span> : <StatusBadge size="sm" tone="danger" label="Disabled" />,
    },
    {
      key: 'last', label: 'Last decision', hideBelow: 'xl',
      render: (r) => r.last_action ? (
        <span className="block text-xs leading-tight"><span className="block whitespace-nowrap text-ink-secondary">{HISTORY_ACTION_LABEL[r.last_action.action] ?? humanizeCode(r.last_action.action)}</span><span className="block text-ink-muted"><When value={r.last_action.created_at} /></span></span>
      ) : <span className="text-ink-muted">—</span>,
    },
  ]

  const historyColumns: Column<AuditEntry>[] = [
    { key: 'when', label: 'When', render: (r) => <span className="text-ink-secondary"><When value={r.created_at} /></span> },
    { key: 'user', label: 'User', render: (r) => <span className="font-medium text-ink-primary">{r.username}</span> },
    { key: 'action', label: 'Decision', render: (r) => <ActionBadge a={r} /> },
    { key: 'trust', label: 'Trust', hideBelow: 'md', render: (r) => r.trust_score ? <span className="num text-ink-secondary">{r.trust_score.old} → <span className="font-semibold text-ink-primary">{r.trust_score.new}</span></span> : <span className="text-ink-muted">—</span> },
    {
      key: 'reason', label: 'Reason', hideBelow: 'md', className: 'max-w-[22rem]',
      render: (r) => (
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-xs text-ink-secondary" title={r.reason ?? undefined}>{r.reason ?? <span className="text-ink-muted">Not recorded</span>}</span>
          {r.message_to_user && <MessageSquare size={12} className="shrink-0 text-ink-muted" aria-label="Message sent to user" />}
        </span>
      ),
    },
    { key: 'by', label: 'By', hideBelow: 'lg', render: (r) => <span className="text-ink-secondary">{r.admin}</span> },
  ]

  const hChips = [
    hAction && { key: 'a', label: `Decision: ${HISTORY_ACTION_LABEL[hAction] ?? hAction}`, clear: () => setHAction('') },
    hFrom && { key: 'f', label: `From ${hFrom}`, clear: () => setHFrom('') },
    hTo && { key: 't', label: `To ${hTo}`, clear: () => setHTo('') },
  ].filter(Boolean) as Array<{ key: string; label: string; clear: () => void }>
  const [historyRow, setHistoryRow] = useState<AuditEntry | null>(null)

  const spec = pending ? (pending.kind === 'trust' ? moderationSpec(pending.user, pending.action) : signinSpec(pending.user, pending.enable)) : null

  const usersTable = (
    <AdminTable
      columns={userColumns}
      data={rows}
      rowKey={(r) => r.id}
      isLoading={listQ.isLoading}
      error={listQ.error}
      onRetry={() => void listQ.refetch()}
      onRowClick={openRow}
      isRowActive={(r) => r.id === (paneRow?.id ?? (drawerOpen ? selectedId : null))}
      toolbar={
        <Toolbar actions={<span className="hidden text-xs text-ink-muted sm:inline">{view === 'queue' ? 'Most severe open case first, then lowest trust' : 'Lowest trust first'}</span>}>
          <SearchInput size="sm" value={search} onChange={setSearch} placeholder="User name, email or ID" />
        </Toolbar>
      }
      emptyState={
        q ? <EmptyState size="compact" title={`No accounts match “${q}”`} action={<Button size="sm" variant="secondary" onClick={() => setSearch('')}>Clear search</Button>} />
          : view === 'queue'
            ? <EmptyState size="compact" icon={CheckCircle2} title="No accounts need a decision" description="Accounts appear here when they have open anti-cheat cases or a trust score between 41 and 60." />
            : <EmptyState size="compact" icon={CheckCircle2} title="No accounts under enforcement" description="Restricted, suspended, banned and sign-in-disabled accounts are listed here." />
      }
      skeletonRows={6}
    />
  )

  return (
    <div className="space-y-5">
      <PageHeader
        title="Moderation"
        description="Account-level decisions for users with open anti-cheat cases or low trust. Every decision needs a reason and is written to the audit log."
        actions={
          <Button size="sm" variant="secondary" leftIcon={<RefreshCw size={13} />} loading={queueQ.isFetching || enforcedQ.isFetching}
            onClick={() => { void queueQ.refetch(); void enforcedQ.refetch(); void weekQ.refetch(); if (tab === 'history') void historyQ.refetch() }}>
            Refresh
          </Button>
        }
      />

      <section aria-label="Moderation summary" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Needs a decision" icon={Gavel} loading={queueQ.isLoading} value={formatNumber(queueQ.data?.count)} hint="Open cases or trust 41–60" tone={queueQ.data?.count ? 'warning' : 'default'} onClick={() => setTab('queue')} />
        <StatCard label="Under enforcement" icon={ShieldAlert} loading={enforcedQ.isLoading} value={formatNumber(enforcedQ.data?.count)} hint="Restricted, suspended or banned" onClick={() => setTab('enforced')} />
        <StatCard label="Sign-in disabled" icon={Lock} loading={enforcedQ.isLoading} value={formatNumber(disabledCount)} hint="Non-staff accounts" tone={disabledCount ? 'danger' : 'default'} />
        <StatCard label="Decisions · last 7 days" icon={History} loading={weekQ.isLoading} value={formatNumber(weekQ.data?.count)} hint="Trust & safety audit entries" onClick={() => setTab('history')} />
      </section>

      {result && <ResultBanner result={result} onDismiss={() => setResult(null)} />}

      <Tabs
        label="Moderation views" value={tab} onChange={setTab} idPrefix="mod"
        items={[
          { value: 'queue', label: 'Needs decision', count: queueQ.data?.count },
          { value: 'enforced', label: 'Under enforcement', count: enforcedQ.data?.count },
          { value: 'history', label: 'History' },
        ]}
      />

      {tab !== 'history' ? (
        <div role="tabpanel" id={`mod-panel-${tab}`} aria-labelledby={`mod-tab-${tab}`} className="grid grid-cols-1 gap-4 min-[1400px]:grid-cols-[minmax(0,1fr)_24rem] min-[1400px]:items-start">
          {usersTable}
          {wide && (
            <Panel padding="none" className="sticky top-[4.5rem] max-h-[calc(100vh-6rem)]" title={paneRow ? `Decide · ${paneRow.username}` : 'Decide'}>
              <div className="max-h-[calc(100vh-10rem)] overflow-y-auto px-4 py-4">
                {listQ.isLoading ? <Skeleton height={200} /> : paneRow ? (
                  <UserPane key={paneRow.id} u={paneRow} busy={act.isPending} onAct={setPending} />
                ) : (
                  <EmptyState size="compact" icon={Users} title="No account selected" description="Select an account to see its trust, open cases and decision history." />
                )}
              </div>
            </Panel>
          )}
        </div>
      ) : (
        <div role="tabpanel" id="mod-panel-history" aria-labelledby="mod-tab-history">
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
                <Toolbar actions={historyQ.data && <span className="num text-xs text-ink-muted">{formatNumber(historyQ.data.count)} decisions</span>}>
                  <SearchInput size="sm" value={hSearch} onChange={setHSearch} placeholder="User or admin" />
                  <Select size="sm" aria-label="Decision" value={hAction} onChange={(e) => setHAction(e.target.value)} containerClassName="w-full sm:w-44">
                    <option value="">All decisions</option>
                    {Object.entries(HISTORY_ACTION_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    <option value="ban">Banned / sign-in disabled</option>
                    <option value="unban">Ban lifted / sign-in enabled</option>
                  </Select>
                  <Input type="date" size="sm" aria-label="From" value={hFrom} max={hTo || undefined} onChange={(e) => setHFrom(e.target.value)} className="w-full sm:w-[8.75rem]" containerClassName="w-[calc(50%-4px)] sm:w-auto" />
                  <Input type="date" size="sm" aria-label="To" value={hTo} min={hFrom || undefined} onChange={(e) => setHTo(e.target.value)} className="w-full sm:w-[8.75rem]" containerClassName="w-[calc(50%-4px)] sm:w-auto" />
                </Toolbar>
                {hChips.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    {hChips.map((c) => <FilterChip key={c.key} label={c.label} onRemove={c.clear} />)}
                  </div>
                )}
              </div>
            }
            emptyState={<EmptyState size="compact" icon={History} title="No decisions match these filters" description="Every warn, restrict, suspend, ban, lift, dismissal and session review is listed here." />}
            pagination={{ page: hPage, total: historyQ.data?.count ?? 0, pageSize: HISTORY_PAGE, onPage: setHPage, itemLabel: 'decisions' }}
          />
        </div>
      )}

      <SlideOver
        open={!wide && drawerOpen && !!selected}
        onClose={() => setDrawerOpen(false)}
        title={selected ? `Decide · ${selected.username}` : ''}
        width={480}
      >
        {selected && <UserPane key={selected.id} u={selected} busy={act.isPending} onAct={setPending} />}
      </SlideOver>

      <SlideOver open={!!historyRow} onClose={() => setHistoryRow(null)} title={historyRow ? historyRow.username : ''} subtitle={historyRow ? historyRow.description : undefined} headerAside={historyRow && <ActionBadge a={historyRow} />}>
        {historyRow && (
          <dl className="text-sm">
            {[
              ['When', <When key="w" value={historyRow.created_at} stacked />],
              ['Decided by', historyRow.admin],
              ['Trust score', historyRow.trust_score ? `${historyRow.trust_score.old} → ${historyRow.trust_score.new}` : '—'],
              ['Status', historyRow.trust_status ? `${historyRow.trust_status.old} → ${historyRow.trust_status.new}` : '—'],
              ['Flag', historyRow.flag_id ? `#${historyRow.flag_id}` : '—'],
              ['Reason', historyRow.reason ?? 'Not recorded'],
              ['Message to user', historyRow.message_to_user ?? 'None sent'],
            ].map(([k, v]) => (
              <div key={String(k)} className="border-b border-surface-border py-2.5 last:border-b-0">
                <dt className="text-xs text-ink-muted">{k}</dt>
                <dd className="num mt-0.5 break-words text-ink-primary">{v}</dd>
              </div>
            ))}
            <div className="pt-3">
              <Link to={`/activity?resource_type=user&resource_id=${historyRow.user_id}`} className="inline-flex items-center gap-0.5 text-xs font-medium text-brand-text hover:underline">Full audit log for this user <ArrowUpRight size={12} aria-hidden /></Link>
            </div>
          </dl>
        )}
      </SlideOver>

      <DecisionModal
        key={pending ? `${pending.user.id}-${pending.kind === 'trust' ? pending.action : String(pending.enable)}` : 'none'}
        spec={spec}
        open={!!pending}
        loading={act.isPending}
        onClose={() => { if (!act.isPending) setPending(null) }}
        onConfirm={(reason, message) => pending && act.mutate({ p: pending, reason, message })}
      />
    </div>
  )
}
