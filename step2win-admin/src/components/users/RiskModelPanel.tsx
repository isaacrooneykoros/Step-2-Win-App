import { useQuery } from '@tanstack/react-query'
import { Activity } from 'lucide-react'
import { StatusBadge, type BadgeTone } from '../StatusBadge'
import { EmptyState } from '../ui/EmptyState'
import { ErrorState } from '../ui/ErrorState'
import { Skeleton } from '../ui/Skeleton'
import { cn } from '../../lib/cn'
import { formatKES, formatNumber } from '../../lib/format'
import { consoleApi } from './api'
import { SectionTitle, Timestamp } from './shared'
import type { RiskScoreRow } from './types'
import { formatDay } from './utils'

/** Score bands used only for display; the shadow model enforces nothing. */
function band(score: number): { tone: BadgeTone; label: string; fill: string } {
  if (score >= 0.7) return { tone: 'danger', label: 'Highly unusual', fill: 'bg-danger' }
  if (score >= 0.4) return { tone: 'warning', label: 'Unusual', fill: 'bg-warning' }
  return { tone: 'neutral', label: 'Typical', fill: 'bg-ink-muted' }
}

function ScoreMeter({ score }: { score: number }) {
  const b = band(score)
  const pct = Math.round(score * 100)
  return (
    <span className="inline-flex items-center gap-2">
      <span className="num w-7 text-right text-sm font-medium text-ink-primary">{pct}</span>
      <span className="h-1.5 w-12 overflow-hidden rounded-sm bg-surface-elevated" aria-hidden>
        <span className={cn('block h-full rounded-sm', b.fill)} style={{ width: `${Math.max(2, pct)}%` }} />
      </span>
      <StatusBadge size="sm" tone={b.tone} label={b.label} />
    </span>
  )
}

function contextLine(row: RiskScoreRow): string | null {
  const c = row.context
  const parts: string[] = []
  if (c.steps != null) parts.push(`${formatNumber(c.steps)} steps`)
  if (c.entry_fee_exposure_kes) parts.push(`${formatKES(c.entry_fee_exposure_kes)} in paid challenges`)
  if (c.days_to_deadline != null) parts.push(c.days_to_deadline === 0 ? 'deadline day' : `${c.days_to_deadline} days to deadline`)
  if (c.no_motion_data) parts.push('no motion data')
  return parts.length ? parts.join(' · ') : null
}

/**
 * "Risk model (shadow)" panel for the user drawer: the latest nightly anomaly score,
 * its top reasons and the model version. Read-only; nothing here changes steps,
 * trust or payouts.
 */
export function RiskModelPanel({ userId }: { userId: number }) {
  const q = useQuery({
    queryKey: ['admin', 'user-risk', userId],
    queryFn: () => consoleApi.userRiskScores(userId, 30),
    staleTime: 60_000,
  })
  const d = q.data
  const recent = (d?.scores ?? []).filter((s) => !s.supervised).slice(0, 7)

  return (
    <section aria-labelledby="risk-model-title">
      <SectionTitle aside={<StatusBadge size="sm" tone="neutral" label="Shadow · no enforcement" />}>
        <span id="risk-model-title">Risk model (shadow)</span>
      </SectionTitle>
      {q.isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : q.isError ? (
        <ErrorState variant="inline" error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />
      ) : !d?.latest ? (
        <EmptyState
          size="compact"
          icon={Activity}
          title="No risk score yet"
          description="Scores are computed nightly for users with recent step activity."
        />
      ) : (
        <div className="rounded-md border border-surface-border px-3 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs text-ink-muted">Anomaly score for {formatDay(d.latest.date, true)}</p>
              <div className="mt-1"><ScoreMeter score={d.latest.score} /></div>
            </div>
            <div className="text-right text-xs text-ink-muted">
              <p>Model <span className="mono text-ink-secondary">{d.latest.model_version}</span></p>
              <p>Updated <Timestamp value={d.latest.updated_at} /></p>
            </div>
          </div>
          {contextLine(d.latest) && <p className="mt-2 text-xs text-ink-secondary">{contextLine(d.latest)}</p>}
          {d.latest.explanations.length > 0 ? (
            <ol className="mt-3 space-y-1.5">
              {d.latest.explanations.map((e) => (
                <li key={`${e.code}-${e.feature}`} className="flex items-start gap-2 text-sm text-ink-primary">
                  <span className="num mt-0.5 w-9 shrink-0 text-right text-2xs text-ink-muted" title="Contribution to the score">
                    +{Math.round(e.contribution * 100)}
                  </span>
                  <span className="min-w-0">{e.text}</span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="mt-3 text-sm text-ink-secondary">Nothing unusual found for this day.</p>
          )}
          {recent.length > 1 && (
            <div className="mt-3 border-t border-surface-border pt-2">
              <p className="text-2xs text-ink-muted">Recent days</p>
              <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
                {recent.map((s) => (
                  <li key={s.date} className="text-xs text-ink-secondary">
                    {formatDay(s.date)} <span className="num font-medium text-ink-primary">{Math.round(s.score * 100)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className="mt-3 text-2xs text-ink-muted">{d.note}</p>
        </div>
      )}
    </section>
  )
}
