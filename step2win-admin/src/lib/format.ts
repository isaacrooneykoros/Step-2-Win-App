/**
 * Number / money / time formatters. Use these everywhere so figures read the
 * same on every page. All accept loose API values (string | number | null).
 */
import { formatKES } from '../utils/currency'

export { formatKES }

const toNumber = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

/** 1284 -> "1,284". Returns an em dash for missing values. */
export function formatNumber(value: unknown, maximumFractionDigits = 0): string {
  const n = toNumber(value)
  if (n === null) return '—'
  return n.toLocaleString('en-KE', { maximumFractionDigits })
}

/** 12900 -> "12.9K", 4200000 -> "4.2M". For stat tiles and axis ticks. */
export function formatCompact(value: unknown): string {
  const n = toNumber(value)
  if (n === null) return '—'
  const abs = Math.abs(n)
  if (abs < 1000) return n.toLocaleString('en-KE', { maximumFractionDigits: 1 })
  return new Intl.NumberFormat('en-KE', { notation: 'compact', maximumFractionDigits: 1 }).format(n)
}

/** Whole-shilling amount without decimals: "KSh 3,010". Use formatKES for exact ledger values. */
export function formatKESShort(value: unknown): string {
  const n = toNumber(value)
  if (n === null) return '—'
  return `KSh ${Math.round(n).toLocaleString('en-KE')}`
}

/** Compact money for axes and tiles: "KSh 12.9K". */
export function formatKESCompact(value: unknown): string {
  const n = toNumber(value)
  if (n === null) return '—'
  return `KSh ${formatCompact(n)}`
}

/** 12.345 -> "+12.3%". `signed` adds a plus sign to positive values. */
export function formatPercent(value: unknown, { signed = false, digits = 1 } = {}): string {
  const n = toNumber(value)
  if (n === null) return '—'
  const s = `${Math.abs(n).toFixed(digits)}%`
  if (n < 0) return `−${s}`
  return signed && n > 0 ? `+${s}` : s
}

/** Hours as a short age: 0.4 -> "24m", 5 -> "5h", 50 -> "2d 2h". */
export function formatAgeHours(hours: unknown): string {
  const h = toNumber(hours)
  if (h === null) return '—'
  if (h < 1) return `${Math.max(1, Math.round(h * 60))}m`
  if (h < 48) return `${Math.round(h)}h`
  // Round the total first so 71.7h reads "3d", never "2d 24h".
  const total = Math.round(h)
  const d = Math.floor(total / 24)
  const rem = total - d * 24
  return rem ? `${d}d ${rem}h` : `${d}d`
}

/** ISO date -> "23 Sep 2026, 10:07" in the viewer's locale/timezone. */
export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value
  return d.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/** ISO date -> "3m ago" / "5h ago" / "23 Sep". */
export function formatRelative(value: string | null | undefined, now: number = Date.now()): string {
  if (!value) return '—'
  const t = new Date(value).getTime()
  if (Number.isNaN(t)) return value
  const s = Math.round((now - t) / 1000)
  if (s < 45) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  if (s < 86400 * 7) return `${Math.round(s / 86400)}d ago`
  return new Date(t).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })
}

/** Sum a numeric field over rows, treating bad values as 0. */
export function sumBy<T>(rows: readonly T[] | undefined, pick: (row: T) => unknown): number {
  if (!rows) return 0
  return rows.reduce((acc, row) => acc + (toNumber(pick(row)) ?? 0), 0)
}
