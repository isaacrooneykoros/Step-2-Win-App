import { useState, type ElementType, type ReactNode } from 'react'
import { useRealtimeStore } from '../lib/realtime/store'
import { Link } from 'react-router-dom'
import { ArrowDownRight, ArrowUpRight } from 'lucide-react'
import { Line, LineChart, ResponsiveContainer, YAxis } from 'recharts'
import { cn } from '../lib/cn'
import { Skeleton } from './ui/Skeleton'
import { formatPercent } from '../lib/format'

export interface StatDelta {
  /** Percent change vs the previous period, e.g. 12.5 or -4.2. */
  value: number
  /** Named comparison, e.g. "vs previous 7 days". Required: a delta without a period is meaningless. */
  period: string
  /** Which direction is good. Colours follow meaning, not sign. Default 'up'. */
  good?: 'up' | 'down' | 'neutral'
}

interface StatCardProps {
  /** Metric label (sentence case, no colon). `label` is an alias. */
  title?:      string
  label?:      string
  value:       ReactNode
  icon?:       ElementType
  /** Supporting line under the value (context, not decoration). */
  hint?:       ReactNode
  /** Change vs previous period — pass ONLY when the API provides a comparable previous value. */
  delta?:      StatDelta
  /** Legacy: percent change rendered as a delta ("good" = up). Prefer `delta`. */
  trend?:      number
  /** Legacy: shown as the hint / delta period. */
  trendLabel?: string
  prefix?:     string          // e.g. "KSh "
  suffix?:     string          // e.g. " users"
  /** Legacy, accepted for compatibility. */
  isMoney?:    boolean
  /** Optional trend line (oldest -> newest). */
  sparkData?:  number[]
  /** Legacy accent names; ignored for decoration. Use `tone` for meaning. */
  color?:      'purple' | 'teal' | 'blue' | 'amber' | 'red' | 'indigo'
  /** Semantic state of the value, e.g. a non-empty queue is `warning`. */
  tone?:       'default' | 'warning' | 'danger' | 'success'
  /** Small status text next to the label, e.g. "Over threshold". */
  badge?:      ReactNode
  loading?:    boolean
  /** Makes the whole card a link to the relevant page. */
  to?:         string
  onClick?:    () => void
  className?:  string
}

const TONE_VALUE: Record<NonNullable<StatCardProps['tone']>, string> = {
  default: 'text-ink-primary',
  warning: 'text-warning',
  danger:  'text-danger',
  success: 'text-success',
}

function DeltaChip({ delta }: { delta: StatDelta }) {
  const good = delta.good ?? 'up'
  const isUp = delta.value > 0
  const isFlat = delta.value === 0
  const positive = good === 'neutral' || isFlat ? null : (good === 'up') === isUp
  const Icon = isUp ? ArrowUpRight : ArrowDownRight
  return (
    <span className="inline-flex items-center gap-1 text-xs">
      <span
        className={cn(
          'num inline-flex items-center gap-0.5 font-semibold',
          positive === null ? 'text-ink-secondary' : positive ? 'text-success' : 'text-danger',
        )}
      >
        {!isFlat && <Icon size={13} aria-hidden />}
        {formatPercent(delta.value, { signed: true })}
      </span>
      <span className="text-ink-muted">{delta.period}</span>
    </span>
  )
}

/**
 * KPI tile: label, value, optional delta (only with a real previous period),
 * hint and sparkline. Links to the page where the operator can act.
 */
export function StatCard({
  title, label, value, icon: Icon, hint, delta, trend, trendLabel,
  prefix = '', suffix = '', sparkData, tone = 'default', badge, loading, to, onClick, className,
}: StatCardProps) {
  const name = label ?? title ?? ''
  const effectiveDelta: StatDelta | undefined =
    delta ?? (trend !== undefined && Number.isFinite(trend) ? { value: trend, period: trendLabel ?? '' } : undefined)
  const effectiveHint = hint ?? (delta || trend === undefined ? trendLabel : undefined)
  const displayValue = typeof value === 'number' ? value.toLocaleString('en-KE') : value
  const spark = sparkData && sparkData.length > 1 ? sparkData.map((v, i) => ({ i, v })) : null
  const interactive = Boolean(to || onClick)

  // Briefly highlight the value when a live event just changed it (not on first load
  // or when the operator changes a filter: only while `kpiLive` is set by an event).
  const kpiLive = useRealtimeStore((s) => s.kpiLive)
  const valueKey = loading ? null : typeof displayValue === 'string' || typeof displayValue === 'number' ? String(displayValue) : null
  const [seen, setSeen] = useState({ key: valueKey, flashes: 0 })
  if (seen.key !== valueKey) {
    const flash = kpiLive && seen.key !== null && valueKey !== null
    setSeen({ key: valueKey, flashes: flash ? seen.flashes + 1 : seen.flashes })
  }

  const body = (
    <>
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <p className="truncate text-xs font-medium text-ink-secondary">{name}</p>
          {badge}
        </div>
        {Icon && <Icon size={15} className="mt-px shrink-0 text-ink-muted" aria-hidden />}
      </div>
      {loading ? (
        <div className="mt-2 space-y-2" aria-hidden>
          <Skeleton width="55%" height={24} />
          <Skeleton width="70%" height={10} />
        </div>
      ) : (
        <>
          <p
            key={seen.flashes}
            className={cn('mt-1.5 truncate text-[22px] font-semibold leading-7 tracking-[-0.01em]', TONE_VALUE[tone], seen.flashes > 0 && 'live-value')}
          >
            {prefix}{displayValue}{suffix}
          </p>
          {(effectiveDelta || effectiveHint) && (
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-ink-muted">
              {effectiveDelta && <DeltaChip delta={effectiveDelta} />}
              {effectiveHint && <span className="min-w-0 truncate">{effectiveHint}</span>}
            </div>
          )}
          {spark && (
            <div className="mt-2 h-8" aria-hidden>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={spark} margin={{ top: 2, right: 2, bottom: 2, left: 2 }}>
                  <YAxis hide domain={['dataMin', 'dataMax']} />
                  <Line type="monotone" dataKey="v" stroke="var(--chart-1)" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </>
      )}
    </>
  )

  const cls = cn(
    'block min-w-0 rounded-lg border border-surface-border bg-surface-card p-3.5 text-left shadow-card',
    interactive && 'transition-colors hover:border-surface-strong hover:bg-surface-elevated/40',
    className,
  )

  if (to) return <Link to={to} className={cls}>{body}</Link>
  if (onClick) return <button type="button" onClick={onClick} className={cn(cls, 'w-full')}>{body}</button>
  return <div className={cls}>{body}</div>
}
