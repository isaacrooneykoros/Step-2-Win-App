import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ChevronRight } from 'lucide-react'

export interface Crumb {
  label: string
  to?: string
}

interface PageHeaderProps {
  title:     string
  /** Legacy alias of `description`. */
  subtitle?: ReactNode
  /** One line: what this page is for / what's in scope. */
  description?: ReactNode
  actions?:  ReactNode
  breadcrumbs?: Crumb[]
  /** Small trailing info under the title, e.g. "Updated 10:23". */
  meta?: ReactNode
}

/** Page title row. One per page; actions sit right and wrap below on small screens. */
export function PageHeader({ title, subtitle, description, actions, breadcrumbs, meta }: PageHeaderProps) {
  const desc = description ?? subtitle
  return (
    <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        {breadcrumbs && breadcrumbs.length > 0 && (
          <nav aria-label="Breadcrumb" className="mb-1">
            <ol className="flex flex-wrap items-center gap-1 text-xs text-ink-muted">
              {breadcrumbs.map((c, i) => (
                <li key={`${c.label}-${i}`} className="flex items-center gap-1">
                  {i > 0 && <ChevronRight size={12} aria-hidden />}
                  {c.to ? (
                    <Link to={c.to} className="hover:text-ink-primary hover:underline">{c.label}</Link>
                  ) : (
                    <span aria-current="page">{c.label}</span>
                  )}
                </li>
              ))}
            </ol>
          </nav>
        )}
        <h1 className="text-xl font-semibold tracking-[-0.01em] text-ink-primary">{title}</h1>
        {desc && <p className="mt-0.5 text-sm text-ink-secondary">{desc}</p>}
        {meta && <div className="mt-1 text-xs text-ink-muted">{meta}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}
