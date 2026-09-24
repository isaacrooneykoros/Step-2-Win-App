/**
 * Recharts theme for the admin. All colours are CSS variables, so charts follow
 * the light/dark theme without re-rendering.
 *
 * Rules (see DESIGN_SYSTEM.md › Charts):
 * - One question per chart; single series needs no legend (the title names it).
 * - Categorical colours are assigned in fixed order — never cycled, never by rank.
 *   Validated with the dataviz palette checker: light (on #FFFFFF) and dark
 *   (on #16191D) both pass lightness band, chroma, adjacent CVD dE >= 12, and 3:1.
 * - Status colours (success/danger/warning) are NOT series colours.
 * - Solid hairline grid, no dashed lines, no gradients, no dual axes.
 * - Thin marks: bars <= 24px with 4px rounded data end, lines 2px.
 */
import {
  formatCompact,
  formatKES,
  formatKESCompact,
  formatKESShort,
  formatNumber,
  formatPercent,
} from './format'

export const SERIES = [
  'var(--chart-1)', // brand green
  'var(--chart-2)', // blue
  'var(--chart-3)', // orange
  'var(--chart-4)', // violet
  'var(--chart-5)', // magenta
  'var(--chart-6)', // ochre
] as const

/** Colour for the n-th series (0-based). Past 6 series, fold into "Other" instead of calling this. */
export function seriesColor(index: number): string {
  return SERIES[Math.min(index, SERIES.length - 1)]
}

export const chartTokens = {
  grid: 'var(--chart-grid)',
  axis: 'var(--chart-axis)',
  tick: 'var(--ink-3)',
  surface: 'var(--surface-card)',
  cursorFill: 'var(--chart-cursor)',
  cursorLine: 'var(--border-strong)',
} as const

/** Spread onto <CartesianGrid />. */
export const gridProps = {
  stroke: chartTokens.grid,
  strokeDasharray: undefined,
  vertical: false,
} as const

/** Spread onto <XAxis /> (category axis). */
export const xAxisProps = {
  tick: { fill: chartTokens.tick, fontSize: 11 },
  tickLine: false,
  axisLine: { stroke: chartTokens.axis },
  tickMargin: 8,
  minTickGap: 16,
} as const

/** Spread onto <YAxis /> (value axis). Pair with a `tickFormatter`. */
export const yAxisProps = {
  tick: { fill: chartTokens.tick, fontSize: 11 },
  tickLine: false,
  axisLine: false,
  width: 48,
  tickMargin: 4,
  allowDecimals: false,
} as const

/** Spread onto <Bar />. */
export const barProps = {
  radius: [4, 4, 0, 0] as [number, number, number, number],
  maxBarSize: 24,
  isAnimationActive: false,
}

/** Spread onto <Line />. */
export const lineProps = {
  type: 'monotone' as const,
  strokeWidth: 2,
  dot: false,
  activeDot: { r: 4, strokeWidth: 2, stroke: chartTokens.surface },
  isAnimationActive: false,
}

/** Tooltip cursor for bar charts / line charts. */
export const barCursor = { fill: chartTokens.cursorFill }
export const lineCursor = { stroke: chartTokens.cursorLine, strokeWidth: 1 }

/** Axis tick formatters. */
export const tickFormat = {
  number: (v: number) => formatCompact(v),
  kes: (v: number) => formatCompact(v),
  percent: (v: number) => `${v}%`,
}

/** Value formatters for tooltips / labels. */
export const valueFormat = {
  number: (v: unknown) => formatNumber(v),
  compact: (v: unknown) => formatCompact(v),
  kes: (v: unknown) => formatKESShort(v),
  kesExact: (v: unknown) => formatKES(v as number),
  kesCompact: (v: unknown) => formatKESCompact(v),
  percent: (v: unknown) => formatPercent(v),
}

/**
 * Clean round axis ticks (0 / 500 / 1,000 / 1,500 …) for a value axis that
 * starts at zero. Use: const t = niceTicks(max); <YAxis domain={[0, t.at(-1)]} ticks={t} />
 */
export function niceTicks(max: number, count = 4, integer = true): number[] {
  if (!Number.isFinite(max) || max <= 0) return [0, 1]
  if (integer && max <= count) return Array.from({ length: Math.ceil(max) + 1 }, (_, i) => i)
  const raw = max / count
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw * 0.8) ?? 10 * mag
  const ticks: number[] = []
  for (let v = 0; ; v += step) {
    ticks.push(Math.round(v * 1e6) / 1e6)
    if (v >= max) break
  }
  return ticks
}
