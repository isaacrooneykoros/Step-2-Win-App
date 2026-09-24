import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { ChartLegend, ChartTooltip } from '../charts/ChartTooltip'
import { barCursor, gridProps, xAxisProps, yAxisProps } from '../../lib/chartTheme'
import { formatNumber } from '../../lib/format'
import type { Severity, TrustSummary } from './api'

/**
 * Severity is ordinal, so it uses one sequential hue (violet, not a status
 * colour) from strong (critical) to light (low). Legend + tooltip + totals
 * carry identity; the stack order matches the legend.
 */
const SEQ: Record<Severity, string> = {
  critical: 'var(--chart-4)',
  high: 'color-mix(in srgb, var(--chart-4) 72%, var(--surface-card))',
  medium: 'color-mix(in srgb, var(--chart-4) 48%, var(--surface-card))',
  low: 'color-mix(in srgb, var(--chart-4) 30%, var(--surface-card))',
}
const ORDER: Severity[] = ['critical', 'high', 'medium', 'low']
const LABEL: Record<Severity, string> = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' }

const shortDay = (iso: string | number) => {
  const d = new Date(`${iso}T00:00:00`)
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

function flagTotals(daily: TrustSummary['daily']) {
  const t: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 }
  for (const d of daily) for (const s of ORDER) t[s] += d[s]
  return t
}

/** Whole-number ticks (counts can't be fractional). */
function intTicks(max: number): number[] {
  if (max <= 0) return [0, 1]
  const step = [1, 2, 5, 10, 20, 50, 100, 200, 500].find((st) => max / st <= 5) ?? Math.ceil(max / 5)
  const out: number[] = []
  for (let v = 0; v < max + step; v += step) out.push(v)
  return out
}

export function FlagsLegend({ daily }: { daily: TrustSummary['daily'] }) {
  const t = flagTotals(daily)
  return <ChartLegend items={ORDER.map((s) => ({ label: LABEL[s], color: SEQ[s], value: formatNumber(t[s]) }))} />
}

export function FlagsPerDayChart({ daily, height = 200 }: { daily: TrustSummary['daily']; height?: number }) {
  const max = Math.max(0, ...daily.map((d) => ORDER.reduce((a, s) => a + d[s], 0)))
  const ticks = intTicks(max)
  return (
    <div style={{ height }} role="img" aria-label={`Fraud flags per day by severity, ${daily.length} days`}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={daily} margin={{ top: 4, right: 4, bottom: 0, left: -16 }}>
          <CartesianGrid {...gridProps} />
          <XAxis dataKey="date" {...xAxisProps} tickFormatter={shortDay} />
          <YAxis {...yAxisProps} width={40} domain={[0, ticks[ticks.length - 1]]} ticks={ticks} />
          <Tooltip cursor={barCursor} content={<ChartTooltip formatLabel={(l) => (l === undefined ? '' : shortDay(l))} />} />
          {ORDER.map((s, i) => (
            <Bar
              key={s}
              dataKey={s}
              name={LABEL[s]}
              stackId="sev"
              fill={SEQ[s]}
              stroke="var(--surface-card)"
              strokeWidth={1}
              maxBarSize={18}
              isAnimationActive={false}
              radius={i === ORDER.length - 1 ? [3, 3, 0, 0] : 0}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
