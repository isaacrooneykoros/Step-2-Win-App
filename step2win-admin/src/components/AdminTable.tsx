import { Search, ChevronUp, ChevronDown } from 'lucide-react'

interface Column<T> {
  key:       string
  label:     string
  render:    (row: T) => React.ReactNode
  sortable?: boolean
  width?:    string
}

interface AdminTableProps<T> {
  title:       string
  subtitle?:   string
  columns:     Column<T>[]
  data:        T[]
  isLoading?:  boolean
  searchValue?:      string
  onSearchChange?:   (v: string) => void
  searchPlaceholder?: string
  actions?:    React.ReactNode
  emptyMessage?: string
  rowKey:      (row: T) => string | number
  onRowClick?: (row: T) => void
  sortKey?:    string
  sortDir?:    'asc' | 'desc'
  onSort?:     (key: string) => void
  pagination?: {
    page:     number
    total:    number
    pageSize: number
    onPage:   (p: number) => void
  }
}

export function AdminTable<T>({
  title, subtitle, columns, data, isLoading,
  searchValue, onSearchChange, searchPlaceholder = 'Search...',
  actions, emptyMessage = 'No records found',
  rowKey, onRowClick, sortKey, sortDir, onSort,
  pagination,
}: AdminTableProps<T>) {

  const totalPages = pagination
    ? Math.ceil(pagination.total / pagination.pageSize)
    : 1

  return (
    <div className="rounded-2xl overflow-hidden"
      style={{ background: '#13161F', border: '1px solid #21263A' }}>

      {/* Table header */}
      <div className="flex items-center justify-between px-5 py-4"
        style={{ borderBottom: '1px solid #21263A' }}>
        <div>
          <h3 className="text-ink-primary font-bold">{title}</h3>
          {subtitle && (
            <p className="text-ink-muted text-xs mt-0.5">{subtitle}</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {onSearchChange && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-xl"
              style={{ background: '#0E1016', border: '1px solid #21263A', width: 200 }}>
              <Search size={13} color="#3D4260" />
              <input
                value={searchValue}
                onChange={e => onSearchChange(e.target.value)}
                placeholder={searchPlaceholder}
                className="flex-1 bg-transparent text-ink-secondary text-xs
                           outline-none placeholder-ink-muted"
              />
            </div>
          )}
          {actions}
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr style={{ borderBottom: '1px solid #21263A' }}>
              {columns.map(col => (
                <th
                  key={col.key}
                  className="text-left px-5 py-3 text-ink-muted text-xs font-semibold
                             uppercase tracking-wider select-none"
                  style={{ width: col.width }}
                  onClick={() => col.sortable && onSort?.(col.key)}>
                  <div className={`flex items-center gap-1 ${
                    col.sortable ? 'cursor-pointer hover:text-ink-secondary' : ''
                  }`}>
                    {col.label}
                    {col.sortable && sortKey === col.key && (
                      sortDir === 'asc'
                        ? <ChevronUp size={12} />
                        : <ChevronDown size={12} />
                    )}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              // Skeleton rows
              Array.from({ length: 6 }).map((_, i) => (
                <tr key={i} style={{ borderBottom: '1px solid #1C1F2E' }}>
                  {columns.map(col => (
                    <td key={col.key} className="px-5 py-3.5">
                      <div className="h-4 rounded animate-pulse"
                        style={{ background: '#191C28', width: '60%' }} />
                    </td>
                  ))}
                </tr>
              ))
            ) : data.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="px-5 py-12 text-center">
                  <p className="text-ink-muted text-sm">{emptyMessage}</p>
                </td>
              </tr>
            ) : (
              data.map(row => (
                <tr
                  key={rowKey(row)}
                  onClick={() => onRowClick?.(row)}
                  className="transition-colors"
                  style={{ borderBottom: '1px solid #1C1F2E' }}
                  onMouseEnter={e => {
                    if (onRowClick) (e.currentTarget as HTMLElement).style.background = '#191C28'
                  }}
                  onMouseLeave={e => {
                    (e.currentTarget as HTMLElement).style.background = 'transparent'
                  }}>
                  {columns.map(col => (
                    <td key={col.key} className="px-5 py-3.5">
                      {col.render(row)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {pagination && totalPages > 1 && (
        <div className="flex items-center justify-between px-5 py-3"
          style={{ borderTop: '1px solid #21263A' }}>
          <p className="text-ink-muted text-xs">
            Showing {((pagination.page - 1) * pagination.pageSize) + 1}–
            {Math.min(pagination.page * pagination.pageSize, pagination.total)} of {pagination.total}
          </p>
          <div className="flex items-center gap-1">
            <button
              disabled={pagination.page <= 1}
              onClick={() => pagination.onPage(pagination.page - 1)}
              className="w-8 h-8 rounded-lg flex items-center justify-center text-xs
                         text-ink-secondary disabled:opacity-30 hover:bg-surface-elevated
                         transition-colors">
              ‹
            </button>
            {Array.from({ length: Math.min(totalPages, 5) }, (_, i) => {
              const p = i + 1
              return (
                <button
                  key={p}
                  onClick={() => pagination.onPage(p)}
                  className="w-8 h-8 rounded-lg flex items-center justify-center text-xs
                             font-medium transition-colors"
                  style={{
                    background: pagination.page === p ? '#7C6FF7' : 'transparent',
                    color:      pagination.page === p ? '#fff'     : '#7B82A0',
                  }}>
                  {p}
                </button>
              )
            })}
            <button
              disabled={pagination.page >= totalPages}
              onClick={() => pagination.onPage(pagination.page + 1)}
              className="w-8 h-8 rounded-lg flex items-center justify-center text-xs
                         text-ink-secondary disabled:opacity-30 hover:bg-surface-elevated
                         transition-colors">
              ›
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
