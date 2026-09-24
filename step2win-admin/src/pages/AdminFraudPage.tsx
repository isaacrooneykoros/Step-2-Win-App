import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertOctagon, CheckCircle2, Clock, Inbox, RefreshCw, ShieldCheck, UserX } from 'lucide-react'
import { PageHeader } from '../components/PageHeader'
import { StatCard } from '../components/StatCard'
import { AdminTable, type Column } from '../components/AdminTable'
import { SlideOver } from '../components/SlideOver'
import { Panel } from '../components/ui/Card'
import { Button } from '../components/ui/Button'
import { Input, SearchInput, Select } from '../components/ui/Input'
import { Tabs } from '../components/ui/Tabs'
import { Toolbar, FilterChip } from '../components/ui/Toolbar'
import { EmptyState } from '../components/ui/EmptyState'
import { ErrorState } from '../components/ui/ErrorState'
import { Skeleton } from '../components/ui/Skeleton'
import { cn } from '../lib/cn'
import { formatNumber } from '../lib/format'
import { useDebounced, useMediaQuery } from '../components/finance/hooks'
import {
  ApiError, trustApi, type CaseFilters, type FlagAction, type SessionDecision, type Severity, type TrustCase,
} from '../components/trust/api'
import { CaseEvidence, CaseStatusBadge } from '../components/trust/CaseEvidence'
import { FlagsLegend, FlagsPerDayChart } from '../components/trust/FlagsPerDayChart'
import { ACTION_LABEL, flagActionSpec, sessionDecisionSpec } from '../components/trust/decisions'
import { caseReason, caseTitle, formatAge, ruleInfo, SEVERITY_MEANING, TRUST_STATUS_INFO } from '../components/trust/rules'
import { Age, DecisionModal, ResultBanner, SeverityBadge, TrustScore, When, type ResultMessage } from '../components/trust/ui'

type Tab = 'queue' | 'history' | 'trends'
const PAGE = 50
const REFRESH_MS = 30_000
const SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low']

type Pending =
  | { kind: 'flag'; c: TrustCase; action: FlagAction }
  | { kind: 'session'; c: TrustCase; decision: SessionDecision }

function describe(err: unknown): string {
  if (err instanceof ApiError) return err.message
  return err instanceof Error ? err.message : 'Unknown error.'
}

export function AdminFraudPage() {
  const qc = useQueryClient()
  const wide = useMediaQuery('(min-width: 1400px)')
  const [params] = useSearchParams()
  const [tab, setTabRaw] = useState<Tab>('queue')
  const [result, setResult] = useState<ResultMessage | null>(null)

  const [page, setPage] = useState(1)
  const [search, setSearchRaw] = useState(params.get('q') ?? '')
  const [severity, setSeverityRaw] = useState<string>(params.get('severity') ?? '')
  const [kind, setKindRaw] = useState<string>('')
  const [type, setTypeRaw] = useState<string>('')
  const [from, setFromRaw] = useState('')
  const [to, setToRaw] = useState('')
  // Any filter change goes back to page 1.
  const reset = <T,>(set: (v: T) => void) => (v: T) => { set(v); setPage(1) }
  const setSearch = reset(setSearchRaw)
  const setSeverity = reset(setSeverityRaw)
  const setKind = reset(setKindRaw)
  const setType = reset(setTypeRaw)
  const setFrom = reset(setFromRaw)
  const setTo = reset(setToRaw)
  const setTab = reset(setTabRaw)
  const q = useDebounced(search.trim())

  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [pending, setPending] = useState<Pending | null>(null)

  const status = tab === 'history' ? 'closed' : 'open'
  const filters: CaseFilters = {
    status, q: q || undefined, severity: severity || undefined, kind: kind || undefined, type: type || undefined,
    from: from || undefined, to: to || undefined, limit: PAGE, offset: (page - 1) * PAGE,
  }

  const summaryQ = useQuery({ queryKey: ['admin', 'trust', 'summary'], queryFn: () => trustApi.summary(30), refetchInterval: REFRESH_MS })
  const casesQ = useQuery({
    queryKey: ['admin', 'trust', 'cases', filters],
    queryFn: () => trustApi.cases(filters),
    enabled: tab !== 'trends',
    placeholderData: (prev) => prev,
    refetchInterval: tab === 'queue' ? REFRESH_MS : false,
  })

  const rows = useMemo(() => casesQ.data?.results ?? [], [casesQ.data])
  const selected = rows.find((r) => r.key === selectedKey) ?? null
  const paneRow = wide && tab === 'queue' ? (selected ?? rows[0] ?? null) : null
  const s = summaryQ.data

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['admin', 'trust'] })
    void qc.invalidateQueries({ queryKey: ['admin', 'notifications'] })
    void qc.invalidateQueries({ queryKey: ['admin', 'fraud-overview'] })
    void qc.invalidateQueries({ queryKey: ['admin', 'ops-monitoring'] })
  }

  const nextAfter = (key: string) => {
    const i = rows.findIndex((r) => r.key === key)
    return rows[i + 1]?.key ?? rows[i - 1]?.key ?? null
  }

  const decide = useMutation({
    mutationFn: async ({ p, reason, message }: { p: Pending; reason: string; message: string }) => {
      const body = { reason, message_to_user: message || undefined }
      return p.kind === 'flag'
        ? trustApi.flagAction(p.c.id, p.action, body)
        : trustApi.sessionDecision(p.c.id, p.decision, body)
    },
    onSuccess: (data, { p, message }) => {
      const who = p.c.user.username
      const trust = data.trust_score && data.trust_status
        ? ` Trust score ${data.trust_score.before} → ${data.trust_score.after} (${TRUST_STATUS_INFO[data.trust_status.after]?.label ?? data.trust_status.after}).`
        : ''
      const note = message ? ' The user was sent your message in their Support inbox.' : ''
      if (p.kind === 'flag') {
        setResult({
          tone: 'success',
          title: p.action === 'dismiss' ? `Dismissed · ${ruleInfo(p.c.type).label} for ${who}` : `${ACTION_LABEL[p.action]} · ${who}`,
          body: `Flag #${p.c.id} closed and recorded in the audit log.${trust}${note}`,
        })
      } else {
        setResult({
          tone: 'success',
          title: `Session ${p.decision} · ${who}`,
          body: `${p.decision === 'escalated' ? 'The review stays open, marked Escalated.' : 'The review is closed.'} Recorded in the audit log.${note}`,
        })
      }
      if (!(p.kind === 'session' && p.decision === 'escalated')) setSelectedKey(nextAfter(p.c.key))
      setDrawerOpen(false)
    },
    onError: (err, { p }) => {
      setResult({ tone: 'danger', title: `Could not record the decision for ${p.c.user.username}`, body: describe(err) })
    },
    onSettled: () => {
      setPending(null)
      invalidate()
    },
  })

  const openRow = (r: TrustCase) => {
    setSelectedKey(r.key)
    if (!wide || tab !== 'queue') setDrawerOpen(true)
  }

  // J / K move through the queue on wide screens (ignored while typing).
  useEffect(() => {
    if (!wide || tab !== 'queue') return
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return
      if (e.key !== 'j' && e.key !== 'k') return
      const cur = rows.findIndex((r) => r.key === (paneRow?.key ?? ''))
      const next = rows[e.key === 'j' ? cur + 1 : cur - 1]
      if (next) { e.preventDefault(); setSelectedKey(next.key) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [wide, tab, rows, paneRow?.key])

  const busy = decide.isPending

  const actionsFor = (c: TrustCase, layout: 'pane' | 'drawer') => {
    if (c.status !== 'open') return null
    const wrap = layout === 'pane' ? 'grid grid-cols-2 gap-2' : 'flex flex-wrap justify-end gap-2'
    if (c.kind === 'session') {
      return (
        <div className={wrap}>
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => setPending({ kind: 'session', c, decision: 'approved' })}>Approve session</Button>
          <Button variant="danger-soft" size="sm" disabled={busy} onClick={() => setPending({ kind: 'session', c, decision: 'rejected' })}>Reject session</Button>
          {c.review_status !== 'escalated' && (
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setPending({ kind: 'session', c, decision: 'escalated' })}>Escalate</Button>
          )}
          <Link to={`/moderation?q=${encodeURIComponent(c.user.username)}`} className="inline-flex h-8 items-center justify-center rounded-md px-3 text-sm font-medium text-brand-text hover:bg-surface-elevated">
            Moderate account
          </Link>
        </div>
      )
    }
    return (
      <div className="space-y-2">
        <div className={wrap}>
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => setPending({ kind: 'flag', c, action: 'dismiss' })}>Dismiss</Button>
          <Button variant="primary" size="sm" disabled={busy} onClick={() => setPending({ kind: 'flag', c, action: 'warn' })}>Confirm and warn</Button>
        </div>
        <div className={cn(layout === 'pane' ? 'grid grid-cols-3 gap-2' : 'flex flex-wrap justify-end gap-2')} role="group" aria-label="Confirm and enforce">
          {(['restrict', 'suspend', 'ban'] as const).map((a) => (
            <Button key={a} variant="danger-soft" size="sm" disabled={busy} onClick={() => setPending({ kind: 'flag', c, action: a })}>
              {a === 'ban' ? 'Ban' : ACTION_LABEL[a]}
            </Button>
          ))}
        </div>
      </div>
    )
  }

  const columns: Column<TrustCase>[] = [
    {
      key: 'severity', label: 'Severity', width: '7.5rem',
      render: (r) => <SeverityBadge severity={r.severity} size="sm" />,
    },
    {
      key: 'case', label: 'Case',
      render: (r) => (
        <span className="block min-w-0 max-w-[22rem]">
          <span className="block truncate font-medium text-ink-primary">{caseTitle(r)}</span>
          <span className="block truncate text-xs text-ink-muted" title={caseReason(r)}>{caseReason(r)}</span>
        </span>
      ),
    },
    {
      key: 'user', label: 'User', hideBelow: 'md',
      render: (r) => (
        <span className="block min-w-0">
          <span className="block truncate text-ink-primary">{r.user.username}</span>
          <span className="block"><TrustScore score={r.user.trust_score} status={r.user.trust_status} compact /></span>
        </span>
      ),
    },
    ...(tab === 'history'
      ? [
          { key: 'status', label: 'Outcome', render: (r: TrustCase) => <CaseStatusBadge c={r} /> },
          { key: 'by', label: 'Decided', hideBelow: 'lg' as const, render: (r: TrustCase) => <span className="text-xs text-ink-secondary">{r.reviewed_by ?? '—'}{r.reviewed_at ? <> · <When value={r.reviewed_at} /></> : null}</span> },
          { key: 'detected', label: 'Detected', hideBelow: 'xl' as const, render: (r: TrustCase) => <span className="text-ink-secondary"><When value={r.created_at} /></span> },
        ]
      : [
          { key: 'age', label: 'Waiting', align: 'right' as const, render: (r: TrustCase) => (
            <span className="inline-flex items-center gap-1.5">
              {r.review_status === 'escalated' && <CaseStatusBadge c={r} />}
              <span title={`Detected ${new Date(r.created_at).toLocaleString('en-GB')}`}><Age hours={r.age_hours} /></span>
            </span>
          ) },
        ]),
  ]

  const types = casesQ.data?.types ?? []
  const bySev = casesQ.data?.by_severity
  const chips = [
    severity && { key: 'sev', label: `Severity: ${severity}`, clear: () => setSeverity('') },
    kind && { key: 'kind', label: kind === 'flag' ? 'Fraud flags only' : 'Session reviews only', clear: () => setKind('') },
    type && { key: 'type', label: `Rule: ${type === 'session_risk' ? 'Session risk' : ruleInfo(type).label}`, clear: () => setType('') },
    from && { key: 'from', label: `From ${from}`, clear: () => setFrom('') },
    to && { key: 'to', label: `To ${to}`, clear: () => setTo('') },
    q && { key: 'q', label: `User: ${q}`, clear: () => setSearch('') },
  ].filter(Boolean) as Array<{ key: string; label: string; clear: () => void }>
  const clearAll = () => { setSeverity(''); setKind(''); setType(''); setFrom(''); setTo(''); setSearch('') }

  const toolbar = (
    <div className="space-y-2">
      <Toolbar
        actions={casesQ.data && (
          <span className="num hidden text-xs text-ink-muted sm:inline">
            {formatNumber(casesQ.data.count)} {tab === 'history' ? 'decided' : 'open'} · {tab === 'queue' ? 'severity, then oldest' : 'newest first'}
          </span>
        )}
      >
        <SearchInput size="sm" value={search} onChange={setSearch} placeholder="User name, email or ID" containerClassName="w-full sm:w-52" />
        <Select size="sm" aria-label="Severity" value={severity} onChange={(e) => setSeverity(e.target.value)} containerClassName="w-[calc(50%-4px)] sm:w-36">
          <option value="">All severities</option>
          {SEVERITIES.map((sv) => (
            <option key={sv} value={sv}>{sv.charAt(0).toUpperCase() + sv.slice(1)}{bySev && !severity ? ` (${bySev[sv]})` : ''}</option>
          ))}
        </Select>
        <Select size="sm" aria-label="Case type" value={kind} onChange={(e) => { setKind(e.target.value); setType('') }} containerClassName="w-[calc(50%-4px)] sm:w-40">
          <option value="">Flags and sessions</option>
          <option value="flag">Fraud flags</option>
          <option value="session">Session reviews</option>
        </Select>
        <Select size="sm" aria-label="Rule" value={type} onChange={(e) => setType(e.target.value)} containerClassName="w-[calc(50%-4px)] sm:w-44">
          <option value="">All rules</option>
          {types.map((t) => (
            <option key={t.type} value={t.type}>{t.type === 'session_risk' ? 'Session risk' : ruleInfo(t.type).label} ({t.count})</option>
          ))}
        </Select>
        <Input type="date" size="sm" aria-label="Activity from" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} className="w-full sm:w-[8.75rem]" containerClassName="w-[calc(50%-4px)] sm:w-auto" />
        <Input type="date" size="sm" aria-label="Activity to" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} className="w-full sm:w-[8.75rem]" containerClassName="w-[calc(50%-4px)] sm:w-auto" />
      </Toolbar>
      {chips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {chips.map((c) => <FilterChip key={c.key} label={c.label} onRemove={c.clear} />)}
          <button type="button" className="text-xs font-medium text-brand-text hover:underline" onClick={clearAll}>Clear all</button>
        </div>
      )}
    </div>
  )

  const filtered = chips.length > 0
  const table = (
    <AdminTable
      columns={columns}
      data={rows}
      rowKey={(r) => r.key}
      isLoading={casesQ.isLoading}
      error={casesQ.error}
      onRetry={() => void casesQ.refetch()}
      onRowClick={openRow}
      isRowActive={(r) => r.key === (paneRow?.key ?? (drawerOpen ? selectedKey : null))}
      toolbar={toolbar}
      emptyState={
        filtered ? (
          <EmptyState size="compact" title="No cases match these filters" action={<Button size="sm" variant="secondary" onClick={clearAll}>Clear filters</Button>} />
        ) : tab === 'history' ? (
          <EmptyState size="compact" title="No decided cases yet" description="Cases appear here once someone dismisses, confirms or reviews them." />
        ) : (
          <EmptyState size="compact" icon={CheckCircle2} title="No open anti-cheat cases" description="New fraud flags and high-risk sessions appear here as the step pipeline raises them." />
        )
      }
      pagination={{ page, total: casesQ.data?.count ?? 0, pageSize: PAGE, onPage: setPage, itemLabel: 'cases' }}
      skeletonRows={8}
    />
  )

  const pendingSpec = pending
    ? pending.kind === 'flag' ? flagActionSpec(pending.c, pending.action) : sessionDecisionSpec(pending.c, pending.decision)
    : null

  const critHigh = s ? s.open_by_severity.critical + s.open_by_severity.high : undefined

  return (
    <div className="space-y-5">
      <PageHeader
        title="Anti-cheat"
        description="Triage fraud flags and high-risk step sessions raised by the verification pipeline. Most severe first, then oldest."
        actions={
          <Button
            size="sm" variant="secondary" leftIcon={<RefreshCw size={13} />}
            loading={casesQ.isFetching || summaryQ.isFetching}
            onClick={() => { void summaryQ.refetch(); void casesQ.refetch() }}
          >
            Refresh
          </Button>
        }
      />

      <section aria-label="Queue summary" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Open cases" icon={Inbox} loading={summaryQ.isLoading}
          value={formatNumber(s?.open_total)}
          hint={s ? `${s.open_flags} flags · ${s.open_sessions} sessions` : undefined}
          tone={s?.open_total ? 'warning' : 'default'}
          onClick={() => { setTab('queue'); clearAll() }}
        />
        <StatCard
          label="Critical and high" icon={AlertOctagon} loading={summaryQ.isLoading}
          value={formatNumber(critHigh)}
          hint={s ? `${s.open_by_severity.critical} critical · ${s.open_by_severity.high} high` : undefined}
          tone={critHigh ? 'danger' : 'default'}
          onClick={s?.open_by_severity.critical ? () => { setTab('queue'); setSeverity('critical') } : undefined}
        />
        <StatCard
          label="Oldest open case" icon={Clock} loading={summaryQ.isLoading}
          value={s?.oldest_open_age_hours == null ? 'None' : formatAge(s.oldest_open_age_hours)}
          hint="Review target 24h"
          tone={s?.oldest_open_age_hours == null ? 'default' : s.oldest_open_age_hours >= 24 ? 'danger' : s.oldest_open_age_hours >= 12 ? 'warning' : 'default'}
        />
        <StatCard
          label="Decided · last 7 days" icon={ShieldCheck} loading={summaryQ.isLoading}
          value={s ? formatNumber(s.decided_7d.actioned + s.decided_7d.dismissed + s.decided_7d.sessions) : '—'}
          hint={s ? `${s.decided_7d.actioned} confirmed · ${s.decided_7d.dismissed} dismissed · ${s.decided_7d.sessions} sessions` : undefined}
          onClick={() => setTab('history')}
        />
      </section>

      {summaryQ.error && <ErrorState variant="inline" error={summaryQ.error} onRetry={() => void summaryQ.refetch()} />}
      {result && <ResultBanner result={result} onDismiss={() => setResult(null)} />}

      <Tabs
        label="Anti-cheat views" value={tab} onChange={setTab} idPrefix="ac"
        items={[
          { value: 'queue', label: 'Triage queue', count: s?.open_total },
          { value: 'history', label: 'Decided' },
          { value: 'trends', label: 'Trends' },
        ]}
      />

      {tab === 'queue' && (
        <div role="tabpanel" id="ac-panel-queue" aria-labelledby="ac-tab-queue" className="grid grid-cols-1 gap-4 min-[1400px]:grid-cols-[minmax(0,1fr)_28rem] min-[1400px]:items-start">
          {table}
          {wide && (
            <Panel
              padding="none"
              className="sticky top-[4.5rem] max-h-[calc(100vh-6rem)]"
              title={paneRow ? `Case · ${paneRow.user.username}` : 'Case'}
              description={paneRow ? `${rows.findIndex((r) => r.key === paneRow.key) + 1 + (page - 1) * PAGE} of ${casesQ.data?.count ?? rows.length} open · J / K to move` : undefined}
            >
              {paneRow && paneRow.status === 'open' && (
                <div className="border-b border-surface-border px-4 py-3">{actionsFor(paneRow, 'pane')}</div>
              )}
              <div className="max-h-[calc(100vh-17rem)] overflow-y-auto px-4 py-4">
                {casesQ.isLoading ? (
                  <div className="space-y-3" aria-hidden><Skeleton height={64} /><Skeleton height={160} /></div>
                ) : casesQ.error ? (
                  <ErrorState size="compact" error={casesQ.error} onRetry={() => void casesQ.refetch()} />
                ) : paneRow ? (
                  <CaseEvidence key={paneRow.key} c={paneRow} />
                ) : (
                  <EmptyState size="compact" icon={Inbox} title="Nothing to review" description="Select a case to see its rule hits, session timeline, trust history and devices." />
                )}
              </div>
            </Panel>
          )}
        </div>
      )}

      {tab === 'history' && (
        <div role="tabpanel" id="ac-panel-history" aria-labelledby="ac-tab-history">{table}</div>
      )}

      {tab === 'trends' && (
        <div role="tabpanel" id="ac-panel-trends" aria-labelledby="ac-tab-trends" className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <Panel
            className="lg:col-span-2"
            title="Fraud flags per day"
            description="New flags by severity · last 30 days (session reviews not included)"
            actions={s && <FlagsLegend daily={s.daily} />}
          >
            {summaryQ.isLoading ? <Skeleton height={220} /> : !s || s.daily.every((d) => SEVERITIES.every((sv) => d[sv] === 0)) ? (
              <EmptyState size="compact" title="No flags in the last 30 days" />
            ) : (
              <FlagsPerDayChart daily={s.daily} height={260} />
            )}
          </Panel>
          <Panel title="Accounts under enforcement" description="Current trust score bands" padding="none">
            {summaryQ.isLoading ? <div className="p-4"><Skeleton height={140} /></div> : s && (
              <ul className="divide-y divide-[var(--border)] text-sm">
                {([
                  ['RESTRICT', s.enforcement.restricted],
                  ['SUSPEND', s.enforcement.suspended],
                  ['BAN', s.enforcement.banned],
                ] as const).map(([st, n]) => (
                  <li key={st} className="flex items-start justify-between gap-3 px-4 py-2.5">
                    <span className="min-w-0">
                      <span className="block font-medium text-ink-primary">{TRUST_STATUS_INFO[st].label}</span>
                      <span className="block text-xs text-ink-muted">{TRUST_STATUS_INFO[st].effect}</span>
                    </span>
                    <span className="num text-base font-semibold text-ink-primary">{formatNumber(n)}</span>
                  </li>
                ))}
                <li className="flex items-center justify-between gap-3 px-4 py-2.5">
                  <span className="flex items-center gap-2 font-medium text-ink-primary"><UserX size={14} aria-hidden className="text-ink-muted" />Sign-in disabled</span>
                  <span className="num text-base font-semibold text-ink-primary">{formatNumber(s.enforcement.disabled_accounts)}</span>
                </li>
              </ul>
            )}
            <div className="border-t border-surface-border px-4 py-2.5">
              <Link to="/moderation" className="text-xs font-medium text-brand-text hover:underline">Review enforced accounts in Moderation</Link>
            </div>
          </Panel>
          <Panel title="What severity means" description="Set by the rule that fired; open counts include session reviews" className="lg:col-span-3" padding="none">
            <ul className="grid grid-cols-1 divide-y divide-[var(--border)] sm:grid-cols-2 sm:divide-x sm:divide-y-0 lg:grid-cols-4">
              {SEVERITIES.map((sv) => (
                <li key={sv} className="space-y-1 px-4 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <SeverityBadge severity={sv} size="sm" />
                    <span className="num text-sm font-semibold text-ink-primary">{s ? formatNumber(s.open_by_severity[sv]) : '—'} <span className="font-normal text-ink-muted">open</span></span>
                  </div>
                  <p className="text-xs text-ink-secondary">{SEVERITY_MEANING[sv]}</p>
                </li>
              ))}
            </ul>
          </Panel>
        </div>
      )}

      <SlideOver
        open={drawerOpen && !!selected && !(wide && tab === 'queue')}
        onClose={() => setDrawerOpen(false)}
        title={selected ? `Case · ${selected.user.username}` : ''}
        subtitle={selected ? caseTitle(selected) : undefined}
        headerAside={selected && <SeverityBadge severity={selected.severity} size="sm" />}
        width={560}
        footer={selected ? actionsFor(selected, 'drawer') : undefined}
      >
        {selected && <CaseEvidence key={selected.key} c={selected} />}
      </SlideOver>

      <DecisionModal
        key={pending ? `${pending.c.key}-${pending.kind === 'flag' ? pending.action : pending.decision}` : 'none'}
        spec={pendingSpec}
        open={!!pending}
        loading={decide.isPending}
        onClose={() => { if (!decide.isPending) setPending(null) }}
        onConfirm={(reason, message) => pending && decide.mutate({ p: pending, reason, message })}
      />
    </div>
  )
}

