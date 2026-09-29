import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { History } from 'lucide-react'
import { StatusBadge, type BadgeTone } from '../StatusBadge'
import { EmptyState } from '../ui/EmptyState'
import { ErrorState } from '../ui/ErrorState'
import { Select } from '../ui/Input'
import { Skeleton } from '../ui/Skeleton'
import { cn } from '../../lib/cn'
import { formatDateTime, formatNumber } from '../../lib/format'
import { consoleApi } from './api'
import type { TimelineCategory, TimelineEvent } from './linkageTypes'
import { SectionTitle } from './shared'
import { formatDay } from './utils'

const CATEGORIES: Array<{ value: TimelineCategory; label: string }> = [
  { value: 'steps', label: 'Steps' },
  { value: 'syncs', label: 'Syncs' },
  { value: 'devices', label: 'Devices and sessions' },
  { value: 'flags', label: 'Flags' },
  { value: 'trust', label: 'Trust' },
  { value: 'admin', label: 'Staff actions' },
  { value: 'money', label: 'Payouts and holds' },
  { value: 'risk', label: 'Risk model' },
  { value: 'linkage', label: 'Linked accounts' },
]
const CATEGORY_LABEL = Object.fromEntries(CATEGORIES.map((c) => [c.value, c.label])) as Record<TimelineCategory, string>
const TONE: Record<TimelineEvent['tone'], BadgeTone> = {
  neutral: 'neutral', info: 'info', warning: 'warning', danger: 'danger', success: 'success',
}
const RANGES = [7, 30, 90]

/**
 * Evidence timeline for one account: per-day steps (counted by the phone vs credited
 * vs eligible for money) and every event that matters for a review, newest first.
 */
export function EvidenceTimeline({ userId }: { userId: number }) {
  const [days, setDays] = useState(30)
  const [active, setActive] = useState<Set<TimelineCategory>>(new Set(CATEGORIES.map((c) => c.value)))
  const types = active.size === CATEGORIES.length ? undefined : [...active].join(',')
  const q = useQuery({
    queryKey: ['admin', 'user-timeline', userId, days, types ?? 'all'],
    queryFn: () => consoleApi.userTimeline(userId, { days, types }),
    staleTime: 60_000,
    enabled: active.size > 0,
  })
  const d = q.data
  const grouped = useMemo(() => {
    const out = new Map<string, TimelineEvent[]>()
    for (const e of d?.events ?? []) out.set(e.day, [...(out.get(e.day) ?? []), e])
    return [...out.entries()]
  }, [d])
  const toggle = (c: TimelineCategory) => {
    const next = new Set(active)
    if (next.has(c)) next.delete(c)
    else next.add(c)
    setActive(next)
  }

  return (
    <section aria-labelledby="evidence-timeline-title">
      <SectionTitle
        aside={
          <Select aria-label="Time range" value={String(days)} onChange={(e) => setDays(Number(e.target.value))} size="sm" className="w-auto text-xs">
            {RANGES.map((r) => <option key={r} value={r}>Last {r} days</option>)}
          </Select>
        }
      >
        <span id="evidence-timeline-title">Evidence timeline</span>
      </SectionTitle>

      <div className="mb-3 flex flex-wrap gap-1.5" role="group" aria-label="Show events">
        {CATEGORIES.map((c) => (
          <button
            key={c.value}
            type="button"
            aria-pressed={active.has(c.value)}
            onClick={() => toggle(c.value)}
            className={cn(
              'rounded-md border px-2 py-1 text-xs',
              active.has(c.value)
                ? 'border-brand bg-surface-elevated text-ink-primary'
                : 'border-surface-border text-ink-muted hover:text-ink-secondary',
            )}
          >
            {c.label}
          </button>
        ))}
      </div>

      {active.size === 0 ? (
        <EmptyState size="compact" icon={History} title="Nothing selected" description="Choose at least one kind of event." />
      ) : q.isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : q.isError ? (
        <ErrorState variant="inline" error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />
      ) : !d ? null : (
        <div className="space-y-4">
          {d.days.length > 0 && (
            <div className="overflow-x-auto rounded-md border border-surface-border">
              <table className="w-full text-sm">
                <caption className="sr-only">Steps per day</caption>
                <thead>
                  <tr className="border-b border-surface-border text-left text-2xs text-ink-muted">
                    <th scope="col" className="px-3 py-2 font-medium">Day</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium" title="Raw total reported by the phone">Counted</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium" title="Counts toward goals and challenges">Credited</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium" title="Credited and the day is not under review">Money-eligible</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">Syncs</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">Flags</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium" title="Shadow model; no enforcement">Risk</th>
                  </tr>
                </thead>
                <tbody>
                  {d.days.map((r) => (
                    <tr key={r.date} className="border-b border-surface-border last:border-0">
                      <td className="px-3 py-1.5 text-ink-primary">
                        {formatDay(r.date)}
                        {r.under_review && <StatusBadge size="sm" tone="warning" label="Under review" className="ml-2" />}
                      </td>
                      <td className="num px-3 py-1.5 text-right text-ink-secondary">{formatNumber(r.counted)}</td>
                      <td className="num px-3 py-1.5 text-right text-ink-primary">{formatNumber(r.credited)}</td>
                      <td className={cn('num px-3 py-1.5 text-right', r.money_eligible < r.credited ? 'text-warning' : 'text-ink-primary')}>
                        {formatNumber(r.money_eligible)}
                      </td>
                      <td className="num px-3 py-1.5 text-right text-ink-secondary">
                        {formatNumber(r.syncs)}{r.rejected_syncs > 0 && <span className="text-danger"> ({r.rejected_syncs})</span>}
                      </td>
                      <td className={cn('num px-3 py-1.5 text-right', r.flags ? 'text-warning' : 'text-ink-muted')}>{formatNumber(r.flags)}</td>
                      <td className="num px-3 py-1.5 text-right text-ink-secondary">{r.risk_score == null ? '—' : Math.round(r.risk_score * 100)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {grouped.length === 0 ? (
            <EmptyState size="compact" icon={History} title="No events in this range" description="Try a longer range or more kinds of events." />
          ) : (
            <ol className="space-y-3" aria-label="Events, newest first">
              {grouped.map(([day, events]) => (
                <li key={day}>
                  <p className="mb-1 text-2xs font-semibold uppercase tracking-[0.04em] text-ink-muted">{formatDay(day, true)}</p>
                  <ul className="divide-y divide-surface-border rounded-md border border-surface-border">
                    {events.map((e, i) => (
                      <li key={`${e.at}-${e.kind}-${i}`} className="flex items-start gap-3 px-3 py-2">
                        <time dateTime={e.at} title={formatDateTime(e.at)} className="num w-11 shrink-0 pt-0.5 text-2xs text-ink-muted">
                          {new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </time>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <StatusBadge size="sm" tone={TONE[e.tone] ?? 'neutral'} label={CATEGORY_LABEL[e.category] ?? e.category} />
                            <span className="text-sm text-ink-primary">{e.title}</span>
                          </div>
                          {e.detail && <p className="mt-0.5 break-words text-xs text-ink-secondary">{e.detail}</p>}
                        </div>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </section>
  )
}
