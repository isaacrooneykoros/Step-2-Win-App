import { useRef, type KeyboardEvent } from 'react'
import { Clock, Flag, Megaphone, UserRound } from 'lucide-react'
import { cn } from '../../lib/cn'
import { formatAgeHours, formatDateTime, formatRelative } from '../../lib/format'
import { StatusBadge } from '../StatusBadge'
import type { QueueTicket } from './api'
import { CATEGORY_LABEL, PRIORITY_LABEL, PRIORITY_TONE, SLA_TEXT, STATUS_LABEL, STATUS_TONE, slaState } from './meta'

interface QueueListProps {
  rows: QueueTicket[]
  selectedId: number | null
  onSelect: (row: QueueTicket) => void
  label: string
}

/**
 * Ticket queue as a keyboard-navigable list (Up/Down, Home/End, Enter).
 * Each row: priority, subject, customer, last message preview, and how long
 * the customer has been waiting against the response target.
 */
export function QueueList({ rows, selectedId, onSelect, label }: QueueListProps) {
  const refs = useRef<Array<HTMLButtonElement | null>>([])

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = -1
    if (e.key === 'ArrowDown') next = Math.min(rows.length - 1, index + 1)
    else if (e.key === 'ArrowUp') next = Math.max(0, index - 1)
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = rows.length - 1
    if (next < 0) return
    e.preventDefault()
    refs.current[next]?.focus()
    onSelect(rows[next])
  }

  return (
    <ul aria-label={label} className="divide-y divide-[var(--border)]">
      {rows.map((t, i) => {
        const selected = t.id === selectedId
        const sla = slaState(t)
        const needsReply = t.waiting_on === 'staff'
        return (
          <li key={t.id}>
            <button
              ref={(el) => { refs.current[i] = el }}
              type="button"
              aria-current={selected ? 'true' : undefined}
              onClick={() => onSelect(t)}
              onKeyDown={(e) => onKeyDown(e, i)}
              className={cn(
                'relative block w-full px-4 py-3 text-left transition-colors focus-visible:z-10 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand',
                selected ? 'bg-brand-soft' : 'hover:bg-surface-elevated',
              )}
            >
              {selected && <span aria-hidden className="absolute inset-y-0 left-0 w-0.5 bg-brand" />}
              <div className="flex items-start justify-between gap-3">
                <p className={cn('min-w-0 truncate text-sm', needsReply ? 'font-semibold text-ink-primary' : 'font-medium text-ink-secondary')}>
                  {t.subject}
                </p>
                <span className="shrink-0 text-2xs text-ink-muted">
                  <time dateTime={t.last_message_at ?? t.updated_at} title={formatDateTime(t.last_message_at ?? t.updated_at)}>
                    {formatRelative(t.last_message_at ?? t.updated_at)}
                  </time>
                </span>
              </div>
              <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-ink-muted">
                <span className="truncate font-medium text-ink-secondary">{t.user_username}</span>
                <span aria-hidden>·</span>
                <span className="shrink-0">{CATEGORY_LABEL[t.category] ?? t.category}</span>
                <span aria-hidden>·</span>
                <span className="mono shrink-0">#{t.id}</span>
              </p>
              {t.last_message_preview && (
                <p className="mt-1 line-clamp-1 text-xs text-ink-muted">
                  {t.last_message_is_admin ? <span className="font-medium text-ink-secondary">Staff: </span> : null}
                  {t.last_message_preview}
                </p>
              )}
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {t.is_notice ? (
                  <StatusBadge size="sm" tone="violet" label={<span className="inline-flex items-center gap-1"><Megaphone size={10} aria-hidden />Notice</span>} />
                ) : (
                  <StatusBadge size="sm" tone={PRIORITY_TONE[t.priority]} label={PRIORITY_LABEL[t.priority]} />
                )}
                <StatusBadge size="sm" tone={STATUS_TONE[t.status]} label={STATUS_LABEL[t.status]} />
                {t.escalated ? (
                  <StatusBadge size="sm" tone="danger" label={<span className="inline-flex items-center gap-1"><Flag size={10} aria-hidden />Escalated</span>} />
                ) : t.overdue ? (
                  <StatusBadge size="sm" tone="danger" label="Overdue" />
                ) : null}
                {(t.tags ?? []).slice(0, 2).map((tag) => (
                  <span key={tag} className="max-w-[7rem] truncate rounded border border-surface-border px-1 text-2xs text-ink-muted">{tag}</span>
                ))}
                {(t.tags?.length ?? 0) > 2 && <span className="text-2xs text-ink-muted">+{t.tags.length - 2}</span>}
                {t.waiting_on === 'user' && <span className="text-2xs text-ink-muted">Waiting on customer</span>}
                <span className="ml-auto flex items-center gap-2">
                  {sla && t.waiting_hours !== null && (
                    <span className={cn('num inline-flex items-center gap-1 text-2xs font-medium', SLA_TEXT[sla])} title="Time the customer has been waiting for a staff reply">
                      <Clock size={11} aria-hidden />
                      {formatAgeHours(t.waiting_hours)}
                      <span className="sr-only">{sla === 'breached' ? ' waiting, over response target' : ' waiting'}</span>
                    </span>
                  )}
                  <span className="inline-flex items-center gap-1 text-2xs text-ink-muted" title={t.assigned_to_username ? `Assigned to ${t.assigned_to_username}` : 'Unassigned'}>
                    <UserRound size={11} aria-hidden />
                    {t.assigned_to_username ?? 'Unassigned'}
                  </span>
                </span>
              </div>
            </button>
          </li>
        )
      })}
    </ul>
  )
}
