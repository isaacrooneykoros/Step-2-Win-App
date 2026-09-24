import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ArrowUpRight, Check, Smartphone, X } from 'lucide-react'
import { cn } from '../../lib/cn'
import { formatDateTime, formatNumber } from '../../lib/format'
import { StatusBadge } from '../StatusBadge'
import { ErrorState } from '../ui/ErrorState'
import { Skeleton } from '../ui/Skeleton'
import { trustApi, type CaseDetail, type IntervalInfo, type RuleHit, type SessionInfo, type Severity, type TrustCase } from './api'
import { CASE_STATUS_LABEL, caseReason, caseTitle, evidenceLabel, humanizeCode, ruleInfo, TRUST_STATUS_INFO } from './rules'
import { Age, Figure, ProbabilityMeter, Section, SeverityBadge, TrustScore, When } from './ui'

export function CaseStatusBadge({ c }: { c: TrustCase }) {
  const status = c.review_status === 'escalated' ? 'escalated' : c.status
  const tone = status === 'open' ? 'warning' : status === 'escalated' ? 'violet' : status === 'actioned' || status === 'rejected' ? 'danger' : 'neutral'
  return <StatusBadge size="sm" tone={tone} label={CASE_STATUS_LABEL[status] ?? humanizeCode(status)} />
}

function fmtEvidence(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—'
  if (typeof v === 'number') return Number.isInteger(v) ? formatNumber(v) : String(Math.round(v * 1000) / 1000)
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

const HIDDEN_EVIDENCE = new Set(['message', 'note', 'qa', 'qa_seed', 'admin_action', 'admin_note', 'reviewed_at', 'reviewed_by'])

function RuleHitRow({ hit }: { hit: RuleHit }) {
  const info = ruleInfo(hit.rule_code)
  const ev = Object.entries(hit.evidence ?? {}).filter(([k]) => !HIDDEN_EVIDENCE.has(k))
  const sev = (['critical', 'high', 'medium', 'low'].includes(hit.severity ?? '') ? hit.severity : null) as Severity | null
  return (
    <li className="rounded-md border border-surface-border px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <SeverityBadge severity={sev} size="sm" />
        <span className="text-sm font-medium text-ink-primary">{info.label}</span>
        {hit.penalty !== undefined && hit.penalty !== null && (
          <span className="num ml-auto text-xs text-ink-muted">+{Math.round(hit.penalty * 10) / 10} risk</span>
        )}
      </div>
      {info.explain && <p className="mt-1 text-sm text-ink-secondary">{info.explain}</p>}
      {hit.message && hit.message !== info.explain && <p className="mt-1 text-xs text-ink-muted">Detector: “{hit.message}”</p>}
      {ev.length > 0 && (
        <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-3">
          {ev.map(([k, v]) => (
            <div key={k} className="min-w-0">
              <dt className="truncate text-ink-muted">{evidenceLabel(k)}</dt>
              <dd className="num truncate font-medium text-ink-primary" title={fmtEvidence(v)}>{fmtEvidence(v)}</dd>
            </div>
          ))}
        </dl>
      )}
      <p className="mono mt-1.5 text-2xs text-ink-muted">{hit.rule_code}</p>
    </li>
  )
}

function SessionBlock({ s, withTimeline }: { s: SessionInfo; withTimeline?: boolean }) {
  const [all, setAll] = useState(false)
  const events = s.events ?? []
  const shown = all ? events : events.slice(0, 12)
  const rejectedPct = s.total_steps ? Math.round((s.rejected_steps / s.total_steps) * 100) : 0
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Figure label="Session risk" value={`${s.session_risk_score}`} hint="review at 60+" tone={s.session_risk_score >= 60 ? 'danger' : undefined} />
        <Figure label="Steps" value={formatNumber(s.total_steps)} hint={`${formatNumber(s.rejected_steps)} rejected (${rejectedPct}%)`} tone={rejectedPct >= 50 ? 'danger' : undefined} />
        <Figure label="Duration" value={`${s.duration_minutes} min`} hint={s.duration_minutes > 0 ? `${Math.round(s.total_steps / s.duration_minutes)} steps/min` : undefined} />
        <Figure label="Trust effect" value={s.trust_adjustment > 0 ? `+${s.trust_adjustment}` : `${s.trust_adjustment}`} hint={s.status} />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <ProbabilityMeter label="Avg walk probability" value={s.avg_walk_probability} kind="walk" />
        <ProbabilityMeter label="Avg shake probability" value={s.avg_shake_probability} kind="shake" />
      </div>
      <p className="text-xs text-ink-muted">
        <When value={s.started_at} /> · {formatDateTime(s.started_at)}
        {s.device && <> · {humanizeCode(s.device.platform)} {s.device.app_version ?? ''}</>}
        {s.ml_model_version && <> · model <span className="mono">{s.ml_model_version}</span></>}
        {s.policy_version && <> · policy <span className="mono">{s.policy_version}</span></>}
      </p>
      {withTimeline && events.length > 0 && (
        <div className="overflow-x-auto rounded-md border border-surface-border">
          <table className="w-full min-w-[30rem] text-xs">
            <caption className="sr-only">Sync events in this session</caption>
            <thead className="bg-surface-elevated text-ink-muted">
              <tr>
                <th scope="col" className="px-2 py-1.5 text-right font-medium">#</th>
                <th scope="col" className="px-2 py-1.5 text-left font-medium">Server time</th>
                <th scope="col" className="px-2 py-1.5 text-right font-medium">Steps</th>
                <th scope="col" className="px-2 py-1.5 text-right font-medium">Walk</th>
                <th scope="col" className="px-2 py-1.5 text-right font-medium">Shake</th>
                <th scope="col" className="px-2 py-1.5 text-left font-medium">Result</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {shown.map((e) => (
                <tr key={e.sequence} className={cn(!e.accepted && 'bg-danger-soft/40')}>
                  <td className="num px-2 py-1 text-right text-ink-muted">{e.sequence}</td>
                  <td className="num px-2 py-1 text-ink-secondary">{new Date(e.server_time).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</td>
                  <td className="num px-2 py-1 text-right text-ink-primary">{formatNumber(e.steps_delta)}</td>
                  <td className="num px-2 py-1 text-right">{e.walk_probability?.toFixed(2) ?? '—'}</td>
                  <td className={cn('num px-2 py-1 text-right', (e.shake_probability ?? 0) >= 0.6 && 'font-semibold text-danger')}>{e.shake_probability?.toFixed(2) ?? '—'}</td>
                  <td className="px-2 py-1">
                    {e.accepted ? (
                      <span className="inline-flex items-center gap-1 text-ink-secondary"><Check size={12} aria-hidden /> Accepted</span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-danger"><X size={12} aria-hidden /> {humanizeCode(e.rejection_reason ?? 'Rejected')}</span>
                    )}
                    {e.replay_detected && <span className="ml-1 font-medium text-danger">· replay</span>}
                    {!e.signature_valid && !e.replay_detected && <span className="ml-1 text-warning">· unsigned</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {events.length > 12 && (
            <button type="button" onClick={() => setAll((v) => !v)} className="w-full border-t border-surface-border py-1.5 text-xs font-medium text-brand-text hover:bg-surface-elevated">
              {all ? 'Show first 12 events' : `Show all ${events.length} events`}
            </button>
          )}
        </div>
      )}
      {withTimeline && (s.events_total ?? 0) > events.length && (
        <p className="text-xs text-ink-muted">Showing the first {events.length} of {formatNumber(s.events_total)} events.</p>
      )}
    </div>
  )
}

function IntervalRows({ intervals }: { intervals: IntervalInfo[] }) {
  if (!intervals.length) return <p className="text-sm text-ink-muted">No interval verification stored for this day.</p>
  return (
    <ul className="divide-y divide-[var(--border)] rounded-md border border-surface-border text-xs">
      {intervals.map((iv) => {
        const t = (x: string) => new Date(x).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
        const flagged = iv.status !== 'accept'
        return (
          <li key={iv.start} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5">
            <span className="num w-24 text-ink-secondary">{t(iv.start)}–{t(iv.end)}</span>
            <span className="num w-28 text-ink-primary">{formatNumber(iv.verified_steps)} / {formatNumber(iv.raw_steps)}</span>
            <span className={cn('num w-14', iv.risk_score >= 60 ? 'font-semibold text-danger' : 'text-ink-secondary')}>risk {iv.risk_score}</span>
            <StatusBadge size="sm" tone={flagged ? (iv.status === 'reject' ? 'danger' : 'warning') : 'neutral'} label={humanizeCode(iv.status)} />
            {iv.rule_hits.length > 0 && <span className="min-w-0 truncate text-ink-muted">{iv.rule_hits.map((h) => ruleInfo(h.rule_code).label).join(', ')}</span>}
          </li>
        )
      })}
    </ul>
  )
}

function Body({ d }: { d: CaseDetail }) {
  const c = d.case
  const day = d.day
  const hist = d.trust_history
  const changedDays = hist.filter((h) => h.trust_after !== h.trust_before || h.review_state !== 'none')
  return (
    <div className="space-y-6">
      {/* Summary */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <SeverityBadge severity={c.severity} withMeaning={c.kind === 'flag'} />
          <CaseStatusBadge c={c} />
          <span className="text-xs text-ink-muted">{c.kind === 'session' ? 'Session review' : 'Fraud flag'} · <span className="mono">#{c.kind === 'flag' ? c.id : c.id.slice(0, 8)}</span></span>
        </div>
        <p className="text-base font-semibold text-ink-primary">{caseTitle(c)}</p>
        <p className="text-sm text-ink-secondary">{caseReason(c)}</p>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 pt-1 text-sm sm:grid-cols-3">
          <div><dt className="text-xs text-ink-muted">Detected</dt><dd><When value={c.created_at} stacked /></dd></div>
          <div><dt className="text-xs text-ink-muted">Activity date</dt><dd className="num text-ink-primary">{c.event_date ?? '—'}</dd></div>
          <div><dt className="text-xs text-ink-muted">Waiting</dt><dd>{c.status === 'open' ? <Age hours={c.age_hours} /> : <span className="text-ink-muted">Decided</span>}</dd></div>
        </dl>
        {c.status !== 'open' && (c.reviewed_by || c.admin_note) && (
          <p className="rounded-md bg-surface-elevated px-3 py-2 text-xs text-ink-secondary">
            {CASE_STATUS_LABEL[c.status] ?? c.status}{c.last_action && c.kind === 'flag' ? ` (${c.last_action})` : ''}
            {c.reviewed_by ? ` by ${c.reviewed_by}` : ''}{c.reviewed_at ? ` · ${formatDateTime(c.reviewed_at)}` : ''}
            {c.admin_note ? ` — “${c.admin_note}”` : ''}
          </p>
        )}
      </div>

      {/* Account */}
      <Section
        title="Account"
        aside={
          <span className="flex gap-3 text-xs">
            <Link to={`/users?user=${d.user.id}`} className="inline-flex items-center gap-0.5 font-medium text-brand-text hover:underline">User record <ArrowUpRight size={12} aria-hidden /></Link>
            <Link to={`/moderation?q=${encodeURIComponent(d.user.username)}`} className="inline-flex items-center gap-0.5 font-medium text-brand-text hover:underline">Moderate <ArrowUpRight size={12} aria-hidden /></Link>
          </span>
        }
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-ink-primary">{d.user.username}</p>
            <p className="truncate text-xs text-ink-muted">{d.user.email} · joined {d.user.date_joined ? formatDateTime(d.user.date_joined).split(',')[0] : '—'}</p>
          </div>
          <TrustScore score={d.trust.score} status={d.trust.status} />
        </div>
        <p className="text-xs text-ink-secondary">
          {TRUST_STATUS_INFO[d.trust.status]?.effect}
          {!d.user.is_active && <span className="font-medium text-danger"> Sign-in is disabled.</span>}
          {d.open_cases_for_user > 1 && <span className="font-medium text-warning"> {d.open_cases_for_user} open cases for this user.</span>}
        </p>
        {d.trust_profile && (
          <div className="grid grid-cols-2 gap-3 rounded-md border border-surface-border p-3">
            <Figure label="Verified sessions" value={formatNumber(d.trust_profile.verified_sessions)} />
            <Figure label="Suspicious sessions" value={formatNumber(d.trust_profile.suspicious_sessions)} tone={d.trust_profile.suspicious_sessions > 1 ? 'warning' : undefined} />
            <Figure label="Replay attempts" value={formatNumber(d.trust_profile.replay_attempts)} tone={d.trust_profile.replay_attempts ? 'danger' : undefined} />
            <Figure label="Steps rejected" value={formatNumber(d.trust_profile.rejected_steps)} hint={`of ${formatNumber(d.trust_profile.accepted_steps + d.trust_profile.rejected_steps)} lifetime`} />
          </div>
        )}
      </Section>

      <Section title={c.kind === 'session' ? 'Why this session was flagged' : 'Why this was flagged'}>
        {d.rule_hits.length ? (
          <ul className="space-y-2">{d.rule_hits.map((h, i) => <RuleHitRow key={`${h.rule_code}-${i}`} hit={h} />)}</ul>
        ) : (
          <p className="text-sm text-ink-muted">The detector stored no rule details for this case.</p>
        )}
      </Section>

      {d.session && (
        <Section title="Session evidence">
          <SessionBlock s={d.session} withTimeline />
        </Section>
      )}

      {day && (
        <Section title={`Steps on ${day.date}`}>
          {day.verification ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Figure label="Submitted" value={formatNumber(day.verification.raw_steps)} />
              <Figure label="Verified" value={formatNumber(day.verification.verified_steps)} tone={day.verification.verified_steps < day.verification.raw_steps ? 'warning' : undefined} hint={day.verification.suspicious_steps ? `${formatNumber(day.verification.suspicious_steps)} held back` : undefined} />
              <Figure label="Day risk" value={day.verification.risk_score} tone={day.verification.risk_score >= 60 ? 'danger' : undefined} hint={`${day.verification.accepted}/${day.verification.interval_count} intervals accepted`} />
              <Figure label="Payout" value={humanizeCode(day.verification.payout_state)} tone={day.verification.payout_state === 'eligible' ? undefined : 'warning'} hint={`Review ${humanizeCode(day.verification.review_state).toLowerCase()}`} />
            </div>
          ) : day.health_record ? (
            <p className="text-sm text-ink-secondary">
              <span className="num font-semibold text-ink-primary">{formatNumber(day.health_record.steps)}</span> steps recorded ({humanizeCode(day.health_record.source)}){day.health_record.is_suspicious ? ', marked suspicious' : ''}. No verification summary stored.
            </p>
          ) : (
            <p className="text-sm text-ink-muted">No step record for this day.</p>
          )}
          <IntervalRows intervals={day.intervals} />
        </Section>
      )}

      {d.related_sessions.length > 0 && (
        <Section title={c.kind === 'session' ? 'Other sessions that day' : 'Sessions that day'}>
          <ul className="space-y-3">
            {d.related_sessions.map((s) => (
              <li key={s.id} className="rounded-md border border-surface-border p-3"><SessionBlock s={s} /></li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="Trust score history" aside={<span className="text-xs text-ink-muted">Last 30 days · from daily verification</span>}>
        {hist.length === 0 ? (
          <p className="text-sm text-ink-muted">No daily verification records in the last 30 days.</p>
        ) : (
          <>
            <p className="text-sm text-ink-secondary">
              <span className="num font-semibold text-ink-primary">{hist[0].trust_before}</span> on {hist[0].date} →{' '}
              <span className="num font-semibold text-ink-primary">{hist[hist.length - 1].trust_after}</span> on {hist[hist.length - 1].date}
              {' '}· {changedDays.length} day{changedDays.length === 1 ? '' : 's'} with a change or review
            </p>
            {changedDays.length > 0 && (
              <div className="overflow-x-auto rounded-md border border-surface-border">
                <table className="w-full min-w-[26rem] text-xs">
                  <caption className="sr-only">Days where the trust score changed or a review was required</caption>
                  <thead className="bg-surface-elevated text-ink-muted">
                    <tr>
                      <th scope="col" className="px-2 py-1.5 text-left font-medium">Date</th>
                      <th scope="col" className="px-2 py-1.5 text-right font-medium">Trust</th>
                      <th scope="col" className="px-2 py-1.5 text-right font-medium">Verified / submitted</th>
                      <th scope="col" className="px-2 py-1.5 text-right font-medium">Risk</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--border)]">
                    {changedDays.slice(-10).reverse().map((h) => {
                      const delta = h.trust_after - h.trust_before
                      return (
                        <tr key={h.date}>
                          <td className="num px-2 py-1 text-ink-secondary">{h.date}</td>
                          <td className="num px-2 py-1 text-right">
                            {h.trust_before} → <span className="font-semibold text-ink-primary">{h.trust_after}</span>
                            <span className={cn('ml-1', delta < 0 ? 'text-danger' : 'text-ink-muted')}>({delta > 0 ? '+' : delta < 0 ? '−' : '±'}{Math.abs(delta)})</span>
                          </td>
                          <td className="num px-2 py-1 text-right">{formatNumber(h.verified_steps)} / {formatNumber(h.raw_steps)}</td>
                          <td className={cn('num px-2 py-1 text-right', h.risk_score >= 60 && 'font-semibold text-danger')}>{h.risk_score}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </Section>

      <Section title="Devices">
        {d.devices.length === 0 ? (
          <p className="text-sm text-ink-muted">No registered devices.</p>
        ) : (
          <ul className="divide-y divide-[var(--border)] rounded-md border border-surface-border">
            {d.devices.map((dev) => (
              <li key={`${dev.device_ref}-${dev.first_seen_at}`} className="flex items-center gap-3 px-3 py-2 text-sm">
                <Smartphone size={15} className="shrink-0 text-ink-muted" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-ink-primary">{humanizeCode(dev.platform)} {dev.app_version ?? ''} <span className="mono text-xs text-ink-muted">{dev.device_ref}</span></p>
                  <p className="text-xs text-ink-muted">First seen {formatDateTime(dev.first_seen_at)} · {dev.sessions} session{dev.sessions === 1 ? '' : 's'}</p>
                </div>
                <StatusBadge size="sm" tone={dev.trust_level === 'trusted' || dev.trust_level === 'standard' ? 'neutral' : 'warning'} label={`Device ${dev.trust_level}`} />
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Previous flags for this user" aside={<span className="num text-xs text-ink-muted">{d.user_flags.length}</span>}>
        {d.user_flags.length === 0 ? (
          <p className="text-sm text-ink-muted">No other flags.</p>
        ) : (
          <ul className="divide-y divide-[var(--border)] rounded-md border border-surface-border">
            {d.user_flags.slice(0, 8).map((f) => (
              <li key={f.key} className="flex flex-wrap items-center gap-2 px-3 py-1.5 text-xs">
                <SeverityBadge severity={f.severity} size="sm" />
                <span className="min-w-0 flex-1 truncate text-ink-primary">{ruleInfo(f.type).label}</span>
                <CaseStatusBadge c={f} />
                <span className="num text-ink-muted">{f.event_date}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        title="Decisions on this account"
        aside={<Link to={`/activity?resource_type=user&resource_id=${d.user.id}`} className="inline-flex items-center gap-0.5 text-xs font-medium text-brand-text hover:underline">Audit log <ArrowUpRight size={12} aria-hidden /></Link>}
      >
        {d.actions.length === 0 ? (
          <p className="text-sm text-ink-muted">No moderation decisions recorded.</p>
        ) : (
          <ol className="space-y-2">
            {d.actions.slice(0, 8).map((a) => (
              <li key={a.id} className="border-l-2 border-surface-strong pl-3 text-xs">
                <p className="text-ink-primary"><span className="font-medium">{humanizeCode(a.action)}</span> by {a.admin} · <When value={a.created_at} /></p>
                {a.trust_score && <p className="num text-ink-muted">Trust {a.trust_score.old} → {a.trust_score.new}</p>}
                {a.reason && <p className="text-ink-secondary">“{a.reason}”</p>}
              </li>
            ))}
          </ol>
        )}
      </Section>
    </div>
  )
}

export function CaseEvidence({ c }: { c: TrustCase }) {
  const q = useQuery({
    queryKey: ['admin', 'trust', 'case', c.kind, c.id],
    queryFn: () => trustApi.caseDetail(c.kind, c.id),
  })
  if (q.isLoading) {
    return (
      <div className="space-y-4" aria-busy>
        <Skeleton height={20} width="60%" />
        <Skeleton height={48} />
        <Skeleton height={120} />
        <Skeleton height={160} />
      </div>
    )
  }
  if (q.error || !q.data) return <ErrorState size="compact" error={q.error} onRetry={() => void q.refetch()} title="Could not load case evidence" />
  return <Body d={q.data} />
}
