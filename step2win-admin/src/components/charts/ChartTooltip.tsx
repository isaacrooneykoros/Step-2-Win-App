import type { ReactNode } from 'react'

interface TooltipEntry {
  name?: string | number
  value?: unknown
  color?: string
  dataKey?: string | number
  payload?: Record<string, unknown>
}

export interface ChartTooltipProps {
  active?: boolean
  payload?: readonly TooltipEntry[]
  label?: string | number
  /** Format each value. Defaults to en-KE number formatting. */
  formatValue?: (value: unknown, entry: TooltipEntry) => ReactNode
  /** Optional heading formatter (e.g. dates). */
  formatLabel?: (label: string | number | undefined) => ReactNode
  /** Hide the series swatch (single-series charts). */
  hideSwatch?: boolean
}

/**
 * Themed tooltip for Recharts: `<Tooltip content={<ChartTooltip formatValue={valueFormat.kes} />} />`.
 * Values are in ink colours; the swatch beside them carries series identity.
 */
export function ChartTooltip({ active, payload, label, formatValue, formatLabel, hideSwatch }: ChartTooltipProps) {
  if (!active || !payload?.length) return null
  return (
    <div className="min-w-36 rounded-md border border-surface-border bg-surface-overlay px-3 py-2 text-xs shadow-float">
      {label !== undefined && label !== '' && (
        <p className="mb-1.5 font-medium text-ink-secondary">{formatLabel ? formatLabel(label) : label}</p>
      )}
      <div className="space-y-1">
        {payload.map((entry, i) => (
          <div key={`${entry.dataKey ?? entry.name ?? i}`} className="flex items-center gap-2">
            {!hideSwatch && (
              <span aria-hidden className="h-2 w-2 shrink-0 rounded-sm" style={{ background: entry.color }} />
            )}
            <span className="text-ink-secondary">{entry.name}</span>
            <span className="num ml-auto pl-3 font-semibold text-ink-primary">
              {formatValue ? formatValue(entry.value, entry) : Number(entry.value ?? 0).toLocaleString('en-KE')}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

export interface LegendItem {
  label: string
  color: string
  value?: ReactNode
}

/** Static legend row placed above a chart (required for >= 2 series). */
export function ChartLegend({ items }: { items: LegendItem[] }) {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-secondary">
      {items.map((item) => (
        <li key={item.label} className="flex items-center gap-1.5">
          <span aria-hidden className="h-2 w-2 rounded-sm" style={{ background: item.color }} />
          <span>{item.label}</span>
          {item.value !== undefined && <span className="num font-semibold text-ink-primary">{item.value}</span>}
        </li>
      ))}
    </ul>
  )
}
