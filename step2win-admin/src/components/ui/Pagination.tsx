import { ChevronLeft, ChevronRight } from 'lucide-react'
import { cn } from '../../lib/cn'

export interface PaginationProps {
  /** 1-based current page. */
  page: number
  total: number
  pageSize: number
  onPage: (page: number) => void
  /** Noun for the summary, e.g. "users" -> "1–25 of 312 users". */
  itemLabel?: string
  className?: string
}

function pageWindow(page: number, totalPages: number): Array<number | 'gap'> {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1)
  const pages = new Set([1, totalPages, page - 1, page, page + 1])
  const sorted = [...pages].filter((p) => p >= 1 && p <= totalPages).sort((a, b) => a - b)
  const out: Array<number | 'gap'> = []
  sorted.forEach((p, i) => {
    if (i > 0 && p - sorted[i - 1] > 1) out.push('gap')
    out.push(p)
  })
  return out
}

/** "Showing 1–25 of 312" + windowed page buttons. Hidden when everything fits on one page. */
export function Pagination({ page, total, pageSize, onPage, itemLabel, className }: PaginationProps) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1
  const to = Math.min(page * pageSize, total)
  const btn = 'flex h-8 min-w-8 items-center justify-center rounded-md px-2 text-xs font-medium transition-colors'

  return (
    <nav aria-label="Pagination" className={cn('flex flex-wrap items-center justify-between gap-2', className)}>
      <p className="num text-xs text-ink-muted">
        {from.toLocaleString()}–{to.toLocaleString()} of {total.toLocaleString()}
        {itemLabel ? ` ${itemLabel}` : ''}
      </p>
      {totalPages > 1 && (
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            className={cn(btn, 'text-ink-secondary hover:bg-surface-elevated disabled:opacity-40')}
            onClick={() => onPage(page - 1)}
            disabled={page <= 1}
            aria-label="Previous page"
          >
            <ChevronLeft size={14} />
          </button>
          {pageWindow(page, totalPages).map((p, i) =>
            p === 'gap' ? (
              <span key={`gap-${i}`} className="px-1 text-xs text-ink-muted" aria-hidden>…</span>
            ) : (
              <button
                key={p}
                type="button"
                onClick={() => onPage(p)}
                aria-current={p === page ? 'page' : undefined}
                aria-label={`Page ${p}`}
                className={cn(
                  btn,
                  'num',
                  p === page ? 'bg-brand-soft text-brand-text' : 'text-ink-secondary hover:bg-surface-elevated',
                )}
              >
                {p}
              </button>
            ),
          )}
          <button
            type="button"
            className={cn(btn, 'text-ink-secondary hover:bg-surface-elevated disabled:opacity-40')}
            onClick={() => onPage(page + 1)}
            disabled={page >= totalPages}
            aria-label="Next page"
          >
            <ChevronRight size={14} />
          </button>
        </div>
      )}
    </nav>
  )
}
