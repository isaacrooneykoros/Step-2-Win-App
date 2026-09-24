/* eslint-disable react-refresh/only-export-components */
import type { ReactNode } from 'react'
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { ChartTooltip } from '../charts/ChartTooltip'
import { Skeleton } from '../ui/Skeleton'
import {
  barCursor, barProps, gridProps, lineCursor, lineProps, niceTicks, tickFormat, valueFormat, xAxisProps, yAxisProps,
} from '../../lib/chartTheme'
import { longDay, shortDay } from './ui'

export interface SeriesSpec {
  key: string
  label: string
  color: string
}

type Row = { date: string } & Record<string, number | string>

/**
 * Long periods are summed into weeks so bars stay readable (> 92 days).
 * Returns rows keyed by the first day of each bucket, plus the bucket label.
 */
export function bucketDaily<T extends { date: string }>(rows: T[], keys: string[]): { rows: Row[]; unit: 'day' | 'week' } {
  if (rows.length <= 92) return { rows: rows as unknown as Row[], unit: 'day' }
  const out: Row[] = []
  for (let i = 0; i < rows.length; i += 7) {
    const chunk = rows.slice(i, i + 7) as unknown as Row[]
    const r: Row = { date: chunk[0].date, days: chunk.length }
    for (const k of keys) r[k] = chunk.reduce((acc, c) => acc + (Number(c[k]) || 0), 0)
    out.push(r)
  }
  return { rows: out, unit: 'week' }
}

export function ChartSkeleton({ height }: { height: number }) {
  return (
    <div className="flex items-end gap-2 px-1" style={{ height }} aria-hidden>
      {Array.from({ length: 16 }).map((_, i) => (
        <Skeleton key={i} className="flex-1" height={`${25 + ((i * 41) % 65)}%`} />
      ))}
    </div>
  )
}

const fmt = (kind: 'kes' | 'number') => (kind === 'kes' ? valueFormat.kes : valueFormat.number)

function labelFor(unit: 'day' | 'week') {
  return (l: string | number | undefined) => (unit === 'week' ? `Week of ${longDay(l)}` : longDay(l))
}

export function TimeBarChart({
  rows, series, kind, height = 220, unit = 'day', stacked,
}: { rows: Row[]; series: SeriesSpec[]; kind: 'kes' | 'number'; height?: number; unit?: 'day' | 'week'; stacked?: boolean }) {
  const max = Math.max(
    0,
    ...rows.map((r) =>
      stacked ? series.reduce((a, s) => a + (Number(r[s.key]) || 0), 0) : Math.max(...series.map((s) => Number(r[s.key]) || 0)),
    ),
  )
  const ticks = niceTicks(max)
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} margin={{ top: 4, right: 4, bottom: 0, left: -8 }} barGap={2}>
          <CartesianGrid {...gridProps} />
          <XAxis dataKey="date" {...xAxisProps} tickFormatter={shortDay} />
          <YAxis {...yAxisProps} domain={[0, ticks[ticks.length - 1]]} ticks={ticks} tickFormatter={kind === 'kes' ? tickFormat.kes : tickFormat.number} />
          <Tooltip cursor={barCursor} content={<ChartTooltip hideSwatch={series.length === 1} formatValue={fmt(kind)} formatLabel={labelFor(unit)} />} />
          {series.map((s, i) => (
            <Bar
              key={s.key}
              dataKey={s.key}
              name={s.label}
              fill={s.color}
              stackId={stacked ? 'a' : undefined}
              {...barProps}
              radius={stacked && i < series.length - 1 ? [0, 0, 0, 0] : barProps.radius}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

export function TimeLineChart({
  rows, series, kind, height = 220, unit = 'day', valueFormatter,
}: { rows: Row[]; series: SeriesSpec[]; kind: 'kes' | 'number'; height?: number; unit?: 'day' | 'week'; valueFormatter?: (v: unknown) => ReactNode }) {
  const max = Math.max(0, ...rows.flatMap((r) => series.map((s) => Number(r[s.key]) || 0)))
  const ticks = niceTicks(max)
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: -8 }}>
          <CartesianGrid {...gridProps} />
          <XAxis dataKey="date" {...xAxisProps} tickFormatter={shortDay} />
          <YAxis {...yAxisProps} domain={[0, ticks[ticks.length - 1]]} ticks={ticks} tickFormatter={kind === 'kes' ? tickFormat.kes : tickFormat.number} />
          <Tooltip cursor={lineCursor} content={<ChartTooltip hideSwatch={series.length === 1} formatValue={valueFormatter ?? fmt(kind)} formatLabel={labelFor(unit)} />} />
          {series.map((s) => (
            <Line key={s.key} dataKey={s.key} name={s.label} stroke={s.color} {...lineProps} dot={rows.length <= 14 ? { r: 3, strokeWidth: 0, fill: s.color } : false} />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

/** Horizontal meter rows for 2–7 categories (preferred over donuts). */
export function MeterList({ rows, color, format }: {
  rows: Array<{ label: ReactNode; value: number; note?: ReactNode; key: string }>
  color: string
  format: (v: number) => ReactNode
}) {
  const max = Math.max(1, ...rows.map((r) => r.value))
  return (
    <ul className="space-y-3">
      {rows.map((r) => (
        <li key={r.key}>
          <div className="mb-1 flex items-baseline justify-between gap-3 text-sm">
            <span className="min-w-0 truncate text-ink-secondary">
              {r.label}
              {r.note && <span className="text-xs text-ink-muted"> · {r.note}</span>}
            </span>
            <span className="num shrink-0 font-semibold text-ink-primary">{format(r.value)}</span>
          </div>
          <div className="h-2 rounded-sm bg-surface-elevated" aria-hidden>
            <div className="h-2 rounded-sm" style={{ width: `${(r.value / max) * 100}%`, minWidth: r.value > 0 ? 2 : 0, background: color }} />
          </div>
        </li>
      ))}
    </ul>
  )
}
