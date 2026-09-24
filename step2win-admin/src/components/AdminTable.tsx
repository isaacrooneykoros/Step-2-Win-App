import { useMemo, useState, type KeyboardEvent, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react'
import { cn } from '../lib/cn'
import { SearchInput } from './ui/Input'
import { Pagination } from './ui/Pagination'
import { EmptyState } from './ui/EmptyState'
import { ErrorState } from './ui/ErrorState'
import { Skeleton } from './ui/Skeleton'

export interface Column<T> {
  key:       string
  label:     string
  render:    (row: T) => ReactNode
  sortable?: boolean
  /** Value used for built-in client sorting when the table is not controlled via `onSort`. */
  sortValue?: (row: T) => string | number | null | undefined
  width?:    string
  /** Right-align numbers and money. `numeric` also applies tabular figures. */
  align?:    'left' | 'right' | 'center'
  numeric?:  boolean
  /** Hide the column below a breakpoint to keep narrow screens scannable. */
  hideBelow?: 'sm' | 'md' | 'lg' | 'xl'
  className?: string
}

interface AdminTableProps<T> {
  /** Optional heading; omit when the page header already names the table. */
  title?:      string
  subtitle?:   string
  columns:     Column<T>[]
  data:        T[]
  isLoading?:  boolean
  /** Query error. Renders an error state with `onRetry` instead of rows. */
  error?:      unknown
  onRetry?:    () => void
  searchValue?:      string
  onSearchChange?:   (v: string) => void
  searchPlaceholder?: string
  /** Buttons at the right of the header (export, create…). */
  actions?:    ReactNode
  /** Filter row rendered under the header (Toolbar / FilterBar). */
  toolbar?:    ReactNode
  emptyMessage?: string
  emptyDescription?: string
  /** Full custom empty state. */
  emptyState?: ReactNode
  rowKey:      (row: T) => string | number
  onRowClick?: (row: T) => void
  /** Row-level actions rendered in a trailing right-aligned column. Stop propagation is handled. */
  rowActions?: (row: T) => ReactNode
  /** Marks a row as selected/open (e.g. the record shown in a SlideOver). */
  isRowActive?: (row: T) => boolean
  sortKey?:    string
  sortDir?:    'asc' | 'desc'
  onSort?:     (key: string) => void
  pagination?: {
    page:     number
    total:    number
    pageSize: number
    onPage:   (p: number) => void
    itemLabel?: string
  }
  /** Scroll height for the body; enables the sticky header. e.g. 560 or '60vh'. */
  maxHeight?:  number | string
  /** Row density. `compact` = 36px rows (default), `comfortable` = 44px. */
  density?:    'compact' | 'comfortable'
  skeletonRows?: number
  className?:  string
}

const HIDE: Record<NonNullable<Column<unknown>['hideBelow']>, string> = {
  sm: 'hidden sm:table-cell',
  md: 'hidden md:table-cell',
  lg: 'hidden lg:table-cell',
  xl: 'hidden xl:table-cell',
}

const alignCls = (align?: Column<unknown>['align'], numeric?: boolean) =>
  align === 'right' || (numeric && align !== 'left' && align !== 'center')
    ? 'text-right'
    : align === 'center' ? 'text-center' : 'text-left'

/**
 * Dense operational table: sticky header, sortable headers with aria-sort,
 * skeleton rows, empty and error states, pagination, row actions and an
 * optional search/filter toolbar.
 */
export function AdminTable<T>({
  title, subtitle, columns, data, isLoading, error, onRetry,
  searchValue, onSearchChange, searchPlaceholder = 'Search…',
  actions, toolbar, emptyMessage = 'No records found', emptyDescription, emptyState,
  rowKey, onRowClick, rowActions, isRowActive, sortKey, sortDir, onSort,
  pagination, maxHeight, density = 'compact', skeletonRows = 6, className,
}: AdminTableProps<T>) {
  const controlled = Boolean(onSort)
  const [localSort, setLocalSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>(null)
  const activeKey = controlled ? sortKey : localSort?.key
  const activeDir = controlled ? sortDir : localSort?.dir

  const rows = useMemo(() => {
    if (controlled || !localSort) return data
    const col = columns.find((c) => c.key === localSort.key)
    if (!col?.sortValue) return data
    const get = col.sortValue
    const sorted = [...data].sort((a, b) => {
      const va = get(a)
      const vb = get(b)
      if (va === vb) return 0
      if (va === null || va === undefined) return 1
      if (vb === null || vb === undefined) return -1
      return va < vb ? -1 : 1
    })
    return localSort.dir === 'asc' ? sorted : sorted.reverse()
  }, [controlled, localSort, data, columns])

  const handleSort = (col: Column<T>) => {
    if (controlled) {
      onSort?.(col.key)
      return
    }
    setLocalSort((cur) =>
      cur?.key === col.key ? { key: col.key, dir: cur.dir === 'asc' ? 'desc' : 'asc' } : { key: col.key, dir: 'desc' },
    )
  }

  const colCount = columns.length + (rowActions ? 1 : 0)
  const cellPad = density === 'compact' ? 'px-3 py-2' : 'px-4 py-3'
  const hasHeader = Boolean(title || subtitle || actions || onSearchChange)

  const onRowKey = (e: KeyboardEvent<HTMLTableRowElement>, row: T) => {
    if (!onRowClick) return
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onRowClick(row)
    }
  }

  return (
    <div className={cn('min-w-0 overflow-hidden rounded-lg border border-surface-border bg-surface-card shadow-card', className)}>
      {hasHeader && (
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-surface-border px-4 py-2.5">
          <div className="min-w-0">
            {title && <h2 className="text-sm font-semibold text-ink-primary">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-xs text-ink-muted">{subtitle}</p>}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {onSearchChange && (
              <SearchInput
                size="sm"
                value={searchValue ?? ''}
                onChange={onSearchChange}
                placeholder={searchPlaceholder}
              />
            )}
            {actions}
          </div>
        </div>
      )}
      {toolbar && <div className="border-b border-surface-border px-4 py-2.5">{toolbar}</div>}

      <div className="overflow-auto" style={maxHeight !== undefined ? { maxHeight } : undefined}>
        <table className="w-full border-collapse text-sm">
          {title && <caption className="sr-only">{title}</caption>}
          <thead>
            <tr>
              {columns.map((col) => {
                const sorted = activeKey === col.key
                const ariaSort = col.sortable ? (sorted ? (activeDir === 'asc' ? 'ascending' : 'descending') : 'none') : undefined
                const SortIcon = sorted ? (activeDir === 'asc' ? ArrowUp : ArrowDown) : ArrowUpDown
                return (
                  <th
                    key={col.key}
                    scope="col"
                    aria-sort={ariaSort}
                    style={{ width: col.width }}
                    className={cn(
                      'sticky top-0 z-10 whitespace-nowrap border-b border-surface-border bg-surface-card text-xs font-medium text-ink-muted',
                      cellPad,
                      alignCls(col.align, col.numeric),
                      col.hideBelow && HIDE[col.hideBelow],
                    )}
                  >
                    {col.sortable ? (
                      <button
                        type="button"
                        onClick={() => handleSort(col)}
                        className={cn(
                          'inline-flex items-center gap-1 rounded hover:text-ink-primary',
                          sorted && 'text-ink-primary',
                          (col.align === 'right' || col.numeric) && 'flex-row-reverse',
                        )}
                      >
                        {col.label}
                        <SortIcon size={12} aria-hidden className={sorted ? '' : 'opacity-50'} />
                      </button>
                    ) : (
                      col.label
                    )}
                  </th>
                )
              })}
              {rowActions && (
                <th scope="col" className={cn('sticky top-0 z-10 border-b border-surface-border bg-surface-card text-right text-xs font-medium text-ink-muted', cellPad)}>
                  <span className="sr-only">Actions</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {error ? (
              <tr>
                <td colSpan={colCount}>
                  <ErrorState size="compact" error={error} onRetry={onRetry} />
                </td>
              </tr>
            ) : isLoading ? (
              Array.from({ length: skeletonRows }).map((_, i) => (
                <tr key={i} className="border-b border-surface-border last:border-b-0">
                  {columns.map((col, ci) => (
                    <td key={col.key} className={cn(cellPad, col.hideBelow && HIDE[col.hideBelow])}>
                      <Skeleton width={ci === 0 ? '70%' : '50%'} className={col.align === 'right' || col.numeric ? 'ml-auto' : ''} />
                    </td>
                  ))}
                  {rowActions && <td className={cellPad} />}
                </tr>
              ))
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={colCount}>
                  {emptyState ?? <EmptyState size="compact" title={emptyMessage} description={emptyDescription} />}
                </td>
              </tr>
            ) : (
              rows.map((row) => {
                const active = isRowActive?.(row)
                return (
                  <tr
                    key={rowKey(row)}
                    onClick={onRowClick ? () => onRowClick(row) : undefined}
                    onKeyDown={onRowClick ? (e) => onRowKey(e, row) : undefined}
                    tabIndex={onRowClick ? 0 : undefined}
                    aria-selected={isRowActive ? Boolean(active) : undefined}
                    className={cn(
                      'border-b border-surface-border last:border-b-0',
                      onRowClick && 'cursor-pointer hover:bg-surface-elevated/60 focus-visible:bg-surface-elevated/60 focus-visible:outline-none',
                      active && 'bg-brand-soft/60',
                    )}
                  >
                    {columns.map((col) => (
                      <td
                        key={col.key}
                        className={cn(
                          'align-middle text-ink-primary',
                          cellPad,
                          alignCls(col.align, col.numeric),
                          col.numeric && 'num whitespace-nowrap',
                          col.hideBelow && HIDE[col.hideBelow],
                          col.className,
                        )}
                      >
                        {col.render(row)}
                      </td>
                    ))}
                    {rowActions && (
                      <td className={cn(cellPad, 'whitespace-nowrap text-right')} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                        <div className="inline-flex items-center justify-end gap-1">{rowActions(row)}</div>
                      </td>
                    )}
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>

      {pagination && !error && pagination.total > 0 && (
        <div className="border-t border-surface-border px-4 py-2">
          <Pagination {...pagination} />
        </div>
      )}
    </div>
  )
}
