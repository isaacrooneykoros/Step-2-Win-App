import { useLiveRefetchInterval } from '../../lib/realtime/useAdminRealtime'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, CheckCircle2, Flag, Megaphone, PanelRightOpen, RefreshCw, Send, UserPlus } from 'lucide-react'
import { cn } from '../../lib/cn'
import { formatAgeHours, formatDateTime, formatRelative } from '../../lib/format'
import { errorMessage } from '../../lib/errors'
import { StatusBadge } from '../StatusBadge'
import { Button, IconButton } from '../ui/Button'
import { Select } from '../ui/Input'
import { ErrorState } from '../ui/ErrorState'
import { Skeleton } from '../ui/Skeleton'
import type { SupportAdminUser, SupportTicketMessage } from '../../types/admin'
import { supportApi, type Conversation, type ReplyTemplate, type TicketEvent, type TicketPriority, type TicketStatus } from './api'
import { CATEGORY_LABEL, PRIORITY_LABEL, SLA_TEXT, STATUS_LABEL, fillTemplate, slaState } from './meta'
import { TemplatePicker } from './SavedReplies'
import { TEMPLATES_KEY } from './queries'
import { TagEditor } from './TagEditor'

interface ConversationPaneProps {
  ticketId: number
  admins: SupportAdminUser[]
  meId: number | null
  /** Narrow layouts: go back to the queue. */
  onBack?: () => void
  /** When the customer panel is not visible beside the thread. */
  onOpenCustomer?: () => void
  /** Called after any change so the queue can refresh. */
  onChanged: () => void
}

type ThreadItem =
  | { kind: 'message'; at: string; message: SupportTicketMessage }
  | { kind: 'event'; at: string; event: TicketEvent }

const FIELD_LABEL: Record<string, string> = { status: 'status', priority: 'priority', assigned_to: 'assignee', admin_notes: 'internal note', tags: 'tags' }

function describeEvent(e: TicketEvent): string | null {
  const changes = e.changes ? Object.entries(e.changes) : []
  if (!changes.length) return null
  return changes
    .map(([field, c]) => {
      if (field === 'admin_notes') return 'updated the internal note'
      if (field === 'escalated') return `escalated the ticket (${String(c.new ?? 'over target')})`
      const fmt = (v: unknown) => {
        if (v === null || v === undefined || v === '') return field === 'assigned_to' ? 'unassigned' : field === 'tags' ? 'none' : '—'
        const s = String(v)
        if (field === 'status') return STATUS_LABEL[s as TicketStatus] ?? s
        if (field === 'priority') return PRIORITY_LABEL[s as TicketPriority] ?? s
        return s
      }
      return `changed ${FIELD_LABEL[field] ?? field} ${fmt(c.old)} → ${fmt(c.new)}`
    })
    .join(', ')
}

export function ConversationPane({ ticketId, admins, meId, onBack, onOpenCustomer, onChanged }: ConversationPaneProps) {
  const qc = useQueryClient()
  const key = ['support', 'conversation', ticketId]
  const refetchInterval = useLiveRefetchInterval(20_000)
  const q = useQuery({
    queryKey: key,
    queryFn: () => supportApi.conversation(ticketId),
    refetchInterval,
  })
  const [draft, setDraft] = useState('')
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null)
  const threadRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<HTMLTextAreaElement>(null)

  const refreshAll = () => {
    void qc.invalidateQueries({ queryKey: key })
    onChanged()
  }

  const update = useMutation({
    mutationFn: (data: Parameters<typeof supportApi.update>[1]) => supportApi.update(ticketId, data),
    onSuccess: (_r, data) => {
      const what = Object.keys(data).map((k) => FIELD_LABEL[k] ?? k).join(' and ')
      setNotice({ tone: 'success', text: `Updated ${what}.` })
      refreshAll()
    },
    onError: (err) => setNotice({ tone: 'danger', text: errorMessage(err) ?? 'Update failed.' }),
  })

  const reply = useMutation({
    mutationFn: async ({ text, resolve }: { text: string; resolve: boolean }) => {
      await supportApi.reply(ticketId, text)
      if (resolve) await supportApi.update(ticketId, { status: 'resolved' })
    },
    onSuccess: (_r, v) => {
      setDraft('')
      setNotice({ tone: 'success', text: v.resolve ? 'Reply sent and ticket resolved.' : 'Reply sent to the customer.' })
      refreshAll()
    },
    onError: (err) => setNotice({ tone: 'danger', text: errorMessage(err) ?? 'Reply failed.' }),
  })

  const data: Conversation | undefined = q.data
  const t = data?.ticket

  const items = useMemo<ThreadItem[]>(() => {
    if (!data) return []
    const msgs: ThreadItem[] = data.messages.map((m) => ({ kind: 'message', at: m.created_at, message: m }))
    // Tickets created before the message table existed only have ticket.message.
    if (msgs.length === 0 && data.ticket.message) {
      msgs.push({
        kind: 'message', at: data.ticket.created_at,
        message: { id: -1, ticket: data.ticket.id, sender: data.ticket.user, sender_username: data.ticket.user_username, is_admin: false, message: data.ticket.message, created_at: data.ticket.created_at },
      })
    }
    const evs: ThreadItem[] = data.events.filter((e) => describeEvent(e)).map((e) => ({ kind: 'event', at: e.created_at, event: e }))
    return [...msgs, ...evs].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())
  }, [data])

  // Keep the newest message in view when the thread grows.
  const count = items.length
  useEffect(() => {
    const el = threadRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [count, ticketId])

  useEffect(() => {
    if (!notice || notice.tone === 'danger') return
    const id = window.setTimeout(() => setNotice(null), 4000)
    return () => window.clearTimeout(id)
  }, [notice])

  if (q.isLoading) {
    return (
      <div className="space-y-4 p-4" aria-busy>
        <Skeleton height={20} width="60%" label="Loading conversation" />
        <Skeleton height={14} width="40%" />
        <div className="space-y-3 pt-4">
          <Skeleton height={64} width="70%" />
          <Skeleton height={48} width="55%" className="ml-auto" />
          <Skeleton height={64} width="65%" />
        </div>
      </div>
    )
  }
  if (q.error || !t) {
    return <ErrorState title="Could not load this conversation" error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />
  }

  const sla = slaState(t)
  const done = t.status === 'resolved' || t.status === 'closed'
  const text = draft.trim()
  const busy = reply.isPending || update.isPending

  const effects = [
    t.status === 'open' && 'moves the ticket to In progress',
    !t.assigned_to && 'assigns it to you',
  ].filter(Boolean)
  const replyEffect = done
    ? `The ticket stays ${STATUS_LABEL[t.status].toLowerCase()}.`
    : effects.length ? `Sending ${effects.join(' and ')}.` : ''

  const insertTemplate = (tpl: ReplyTemplate) => {
    const me = admins.find((a) => a.id === meId)?.username
    const text = fillTemplate(tpl.body, { username: t.user_username, ticket_id: t.id, subject: t.subject, agent: me })
    const el = composerRef.current
    const start = el?.selectionStart ?? draft.length
    const end = el?.selectionEnd ?? draft.length
    const next = draft.slice(0, start) + text + draft.slice(end)
    setDraft(next)
    void supportApi.templateUsed(tpl.id).then(() => qc.invalidateQueries({ queryKey: TEMPLATES_KEY })).catch(() => undefined)
    window.requestAnimationFrame(() => {
      el?.focus()
      const pos = start + text.length
      el?.setSelectionRange(pos, pos)
    })
  }

  const send = (resolve: boolean) => {
    if (!text || busy) return
    reply.mutate({ text, resolve })
  }
  const onComposerKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      send(false)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <div className="shrink-0 border-b border-surface-border px-4 py-3">
        <div className="flex items-start gap-2">
          {onBack && (
            <IconButton label="Back to queue" size="sm" onClick={onBack} className="-ml-1.5">
              <ArrowLeft size={16} />
            </IconButton>
          )}
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold leading-snug text-ink-primary">{t.subject}</h2>
            <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-ink-muted">
              <span className="mono">#{t.id}</span>
              <span aria-hidden>·</span>
              <span className="font-medium text-ink-secondary">{t.user_username}</span>
              <span aria-hidden>·</span>
              <span>{CATEGORY_LABEL[t.category] ?? t.category}</span>
              <span aria-hidden>·</span>
              <span>
                Opened <time dateTime={t.created_at} title={formatDateTime(t.created_at)}>{formatDateTime(t.created_at)}</time>
                <span className="text-ink-muted"> ({formatRelative(t.created_at)})</span>
              </span>
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <IconButton label="Refresh conversation" size="sm" onClick={() => void q.refetch()} disabled={q.isFetching}>
              <RefreshCw size={14} className={q.isFetching ? 'animate-spin' : undefined} />
            </IconButton>
            {onOpenCustomer && (
              <Button size="sm" variant="secondary" leftIcon={<PanelRightOpen size={13} />} onClick={onOpenCustomer}>
                Customer
              </Button>
            )}
          </div>
        </div>

        {/* Controls */}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Select
            size="sm" aria-label="Status" value={t.status} disabled={busy} containerClassName="w-44"
            onChange={(e) => update.mutate({ status: e.target.value as TicketStatus })}
          >
            {(Object.keys(STATUS_LABEL) as TicketStatus[]).map((s) => <option key={s} value={s}>Status: {STATUS_LABEL[s]}</option>)}
          </Select>
          <Select
            size="sm" aria-label="Priority" value={t.priority} disabled={busy} containerClassName="w-40"
            onChange={(e) => update.mutate({ priority: e.target.value as TicketPriority })}
          >
            {(Object.keys(PRIORITY_LABEL) as TicketPriority[]).map((p) => <option key={p} value={p}>Priority: {PRIORITY_LABEL[p]}</option>)}
          </Select>
          <Select
            size="sm" aria-label="Assignee" value={t.assigned_to ?? ''} disabled={busy} containerClassName="w-40"
            onChange={(e) => update.mutate({ assigned_to: e.target.value ? Number(e.target.value) : null })}
          >
            <option value="">Unassigned</option>
            {admins.map((a) => <option key={a.id} value={a.id}>{a.username}{a.id === meId ? ' (you)' : ''}</option>)}
          </Select>
          {meId !== null && t.assigned_to !== meId && (
            <Button size="sm" variant="ghost" leftIcon={<UserPlus size={13} />} disabled={busy} onClick={() => update.mutate({ assigned_to: meId })}>
              Assign to me
            </Button>
          )}
        </div>
        {sla && t.waiting_hours !== null && (
          <p className={cn('mt-2 text-xs', SLA_TEXT[sla])}>
            Customer waiting {formatAgeHours(t.waiting_hours)} for a reply · response target {t.sla_target_hours}h for {PRIORITY_LABEL[t.priority].toLowerCase()} priority
            {sla === 'breached' ? ' · over target' : ''}
            {t.escalated && (
              <span className="ml-1.5 inline-flex items-center gap-1 font-semibold">
                <Flag size={11} aria-hidden />Escalated{t.escalated_at ? ` ${formatRelative(t.escalated_at)}` : ''}
              </span>
            )}
          </p>
        )}
        <TagEditor ticketId={t.id} tags={t.tags ?? []} onChanged={refreshAll} />
        {t.waiting_on === 'user' && <p className="mt-2 text-xs text-ink-muted">Staff replied last · waiting on the customer.</p>}
      </div>

      {t.is_notice && (
        <div className="flex shrink-0 gap-2 border-b border-surface-border bg-violet-soft px-4 py-2.5 text-xs text-ink-secondary">
          <Megaphone size={14} className="mt-0.5 shrink-0 text-violet" aria-hidden />
          <p>
            <span className="font-semibold text-violet">Notice sent to the customer.</span> Created by a Trust &amp; Safety decision and
            delivered to their Support inbox as a resolved ticket. It is not a support request and stays out of the queue unless the customer replies.
          </p>
        </div>
      )}

      {notice && (
        <div role="status" className={cn('shrink-0 border-b px-4 py-2 text-xs font-medium', notice.tone === 'success' ? 'border-success-line bg-success-soft text-success' : 'border-danger-line bg-danger-soft text-danger')}>
          {notice.text}
          {notice.tone === 'danger' && (
            <button type="button" className="ml-2 underline" onClick={() => setNotice(null)}>Dismiss</button>
          )}
        </div>
      )}

      {/* Thread */}
      <div ref={threadRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto bg-surface-base px-4 py-4" aria-label="Conversation" role="log">
        {items.map((item) =>
          item.kind === 'event' ? (
            <p key={`e${item.event.id}`} className="text-center text-2xs text-ink-muted">
              <span className="font-medium text-ink-secondary">{item.event.admin_username}</span> {describeEvent(item.event)} ·{' '}
              <time dateTime={item.at} title={formatDateTime(item.at)}>{formatRelative(item.at)}</time>
            </p>
          ) : (
            <MessageBubble key={`m${item.message.id}`} m={item.message} />
          ),
        )}
      </div>

      {/* Composer */}
      <div className="shrink-0 border-t border-surface-border bg-surface-card px-4 py-3">
        <label htmlFor={`reply-${ticketId}`} className="sr-only">Reply to {t.user_username}</label>
        <textarea
          id={`reply-${ticketId}`}
          ref={composerRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onComposerKey}
          rows={3}
          maxLength={5000}
          placeholder={`Reply to ${t.user_username}…`}
          className="w-full resize-y rounded-md border border-surface-strong bg-surface-input px-3 py-2 text-sm leading-relaxed text-ink-primary outline-none placeholder:text-ink-muted focus:border-brand focus:ring-2 focus:ring-brand/20"
        />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <TemplatePicker category={t.category} onPick={insertTemplate} disabled={reply.isPending} />
          <p className="min-w-[12rem] flex-1 text-2xs text-ink-muted">
            Visible to the customer in the app. {replyEffect}
            <span className="hidden sm:inline"> Ctrl+Enter to send.</span>
          </p>
          {!done && (
            <Button size="sm" variant="secondary" leftIcon={<CheckCircle2 size={13} />} disabled={!text || busy} onClick={() => send(true)}>
              Send &amp; resolve
            </Button>
          )}
          <Button size="sm" variant="primary" leftIcon={<Send size={13} />} disabled={!text} loading={reply.isPending} loadingText="Sending…" onClick={() => send(false)}>
            Send reply
          </Button>
        </div>
      </div>
    </div>
  )
}

function MessageBubble({ m }: { m: SupportTicketMessage }) {
  const staff = m.is_admin
  return (
    <div className={cn('flex', staff ? 'justify-end' : 'justify-start')}>
      <div className={cn('max-w-[85%] sm:max-w-[75%]')}>
        <p className={cn('mb-1 flex items-center gap-1.5 text-2xs text-ink-muted', staff && 'justify-end')}>
          <span className="font-medium text-ink-secondary">{m.sender_username}</span>
          {staff && <StatusBadge size="sm" tone="violet" label="Staff" />}
          <span aria-hidden>·</span>
          <time dateTime={m.created_at} title={formatDateTime(m.created_at)}>{formatDateTime(m.created_at)}</time>
        </p>
        <div
          className={cn(
            'whitespace-pre-wrap break-words rounded-lg border px-3 py-2 text-sm leading-relaxed text-ink-primary',
            staff ? 'rounded-tr-sm border-brand/25 bg-brand-soft' : 'rounded-tl-sm border-surface-border bg-surface-card',
          )}
        >
          {m.message}
        </div>
      </div>
    </div>
  )
}
