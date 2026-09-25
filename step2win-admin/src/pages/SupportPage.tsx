import { useLiveRefetchInterval } from '../lib/realtime/useAdminRealtime'
import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, ChevronLeft, ChevronRight, Clock, Inbox, MessageSquareQuote, MessageSquareText, RefreshCw, UserX } from 'lucide-react'
import { PageHeader } from '../components/PageHeader'
import { StatCard } from '../components/StatCard'
import { SlideOver } from '../components/SlideOver'
import { Button, IconButton } from '../components/ui/Button'
import { SearchInput, Select } from '../components/ui/Input'
import { Tabs } from '../components/ui/Tabs'
import { FilterChip, Toolbar } from '../components/ui/Toolbar'
import { EmptyState } from '../components/ui/EmptyState'
import { ErrorState } from '../components/ui/ErrorState'
import { Skeleton } from '../components/ui/Skeleton'
import { useDebounced, useMediaQuery } from '../components/finance/hooks'
import { useAdminRole } from '../components/users/utils'
import { supportApi, type QueueTicket, type QueueView, type TicketCategory, type TicketPriority } from '../components/support/api'
import { QueueList } from '../components/support/QueueList'
import { ConversationPane } from '../components/support/ConversationPane'
import { CustomerContext } from '../components/support/CustomerContext'
import { CATEGORY_LABEL, DEFAULT_TARGET_HOURS, PRIORITY_LABEL, VIEW_EMPTY, VIEW_LABEL } from '../components/support/meta'
import { TemplatesManager } from '../components/support/SavedReplies'
import { useTags } from '../components/support/queries'
import { formatAgeHours, formatNumber } from '../lib/format'

const PAGE_SIZE = 40
const VIEWS: QueueView[] = ['awaiting', 'overdue', 'active', 'mine', 'unassigned', 'resolved', 'notices', 'all']
const SORT_LABEL: Record<string, string> = {
  priority: 'Priority, then longest waiting',
  oldest: 'Longest waiting first',
  newest: 'Newest first',
  updated: 'Recently updated',
}

export function SupportPage() {
  const qc = useQueryClient()
  const [params, setParams] = useSearchParams()
  const view = (VIEWS.includes(params.get('view') as QueueView) ? params.get('view') : 'awaiting') as QueueView
  const ticketParam = Number(params.get('ticket')) || null

  const [search, setSearch] = useState('')
  const [priority, setPriority] = useState('')
  const [category, setCategory] = useState('')
  const [tag, setTag] = useState('')
  const [assignee, setAssignee] = useState('')
  const [sort, setSort] = useState('')
  const [page, setPage] = useState(1)
  const [customerOpen, setCustomerOpen] = useState(false)
  const debounced = useDebounced(search.trim(), 300)

  const lg = useMediaQuery('(min-width: 1024px)')
  const xl = useMediaQuery('(min-width: 1280px)')
  const { id: meId } = useAdminRole()

  const queueParams = {
    view, q: debounced, priority, category, tag, assigned_to: assignee, sort,
    limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE,
  }
  const queueRefetch = useLiveRefetchInterval(30_000)
  const queueQ = useQuery({
    queryKey: ['support', 'queue', queueParams],
    queryFn: () => supportApi.queue(queueParams),
    placeholderData: keepPreviousData,
    refetchInterval: queueRefetch,
  })
  const adminsQ = useQuery({ queryKey: ['support', 'admins'], queryFn: supportApi.admins, staleTime: 5 * 60_000 })
  const admins = adminsQ.data?.results ?? []
  const tagsQ = useTags()
  const repliesOpen = params.get('panel') === 'replies'

  const rows = useMemo(() => queueQ.data?.results ?? [], [queueQ.data])
  const counts = queueQ.data?.counts
  // Wide screens always show a conversation: the one in the URL, else the first in the queue.
  const selectedId = ticketParam ?? (lg ? rows[0]?.id ?? null : null)
  const selectedRow = rows.find((r) => r.id === selectedId) ?? null
  // A deep-linked ticket may not be on this queue page; its conversation (shared cache) names the customer.
  const convQ = useQuery({
    queryKey: ['support', 'conversation', selectedId],
    queryFn: () => supportApi.conversation(selectedId as number),
    enabled: !!selectedId && !selectedRow,
  })
  const selectedUserId = selectedRow?.user ?? convQ.data?.ticket.user ?? null

  const setParam = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params)
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) next.delete(k)
      else next.set(k, v)
    }
    setParams(next, { replace: true })
  }
  const selectTicket = (row: QueueTicket | number) => {
    const id = typeof row === 'number' ? row : row.id
    setParam({ ticket: String(id) })
  }
  const changeView = (v: QueueView) => {
    setPage(1)
    setParam({ view: v, ticket: null })
  }
  const resetPage = <T,>(fn: (v: T) => void) => (v: T) => { fn(v); setPage(1) }

  const onChanged = () => { void qc.invalidateQueries({ queryKey: ['support', 'queue'] }) }

  const chips = [
    priority && { key: 'priority', label: `Priority: ${PRIORITY_LABEL[priority as TicketPriority]}`, clear: () => setPriority('') },
    category && { key: 'category', label: `Category: ${CATEGORY_LABEL[category as TicketCategory]}`, clear: () => setCategory('') },
    tag && { key: 'tag', label: `Tag: ${tag}`, clear: () => setTag('') },
    assignee && {
      key: 'assignee',
      label: `Assignee: ${assignee === 'unassigned' ? 'Unassigned' : admins.find((a) => String(a.id) === assignee)?.username ?? assignee}`,
      clear: () => setAssignee(''),
    },
    debounced && { key: 'q', label: `Search: “${debounced}”`, clear: () => setSearch('') },
  ].filter(Boolean) as Array<{ key: string; label: string; clear: () => void }>
  const clearAll = () => { setPriority(''); setCategory(''); setTag(''); setAssignee(''); setSearch(''); setPage(1) }

  const total = queueQ.data?.total ?? 0
  const firstIdx = total ? (page - 1) * PAGE_SIZE + 1 : 0
  const lastIdx = Math.min(total, page * PAGE_SIZE)
  const oldest = queueQ.data?.oldest_waiting_hours ?? null
  const targets = queueQ.data?.sla_hours ?? DEFAULT_TARGET_HOURS

  // Narrow screens: list OR conversation.
  const showListOnly = !lg && !ticketParam
  const showConversationOnly = !lg && !!ticketParam

  const queuePanel = (
    <section aria-label="Ticket queue" className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-surface-border bg-surface-card shadow-card">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-surface-border px-4 py-2.5">
        <h2 className="text-sm font-semibold text-ink-primary">{VIEW_LABEL[view]}</h2>
        <span className="num text-xs text-ink-muted">{queueQ.data ? `${formatNumber(total)} ticket${total === 1 ? '' : 's'}` : ''}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {queueQ.isLoading ? (
          <div className="space-y-4 p-4" aria-busy>
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="space-y-2">
                <Skeleton height={14} width="80%" label={i === 0 ? 'Loading tickets' : undefined} />
                <Skeleton height={10} width="50%" />
                <Skeleton height={16} width="40%" />
              </div>
            ))}
          </div>
        ) : queueQ.error && !queueQ.data ? (
          <ErrorState size="compact" title="Could not load tickets" error={queueQ.error} onRetry={() => void queueQ.refetch()} retrying={queueQ.isFetching} />
        ) : rows.length === 0 ? (
          chips.length ? (
            <EmptyState size="compact" title="No tickets match these filters" action={<Button size="sm" variant="secondary" onClick={clearAll}>Clear filters</Button>} />
          ) : (
            <EmptyState size="compact" icon={Inbox} title={VIEW_EMPTY[view].title} description={VIEW_EMPTY[view].description} />
          )
        ) : (
          <QueueList rows={rows} selectedId={selectedId} onSelect={selectTicket} label={`${VIEW_LABEL[view]} tickets`} />
        )}
      </div>
      {total > PAGE_SIZE && (
        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-surface-border px-3 py-2">
          <span className="num text-xs text-ink-muted">{firstIdx}–{lastIdx} of {formatNumber(total)}</span>
          <span className="flex gap-1">
            <IconButton label="Previous page" size="sm" variant="secondary" disabled={page === 1} onClick={() => setPage((p) => p - 1)}><ChevronLeft size={14} /></IconButton>
            <IconButton label="Next page" size="sm" variant="secondary" disabled={lastIdx >= total} onClick={() => setPage((p) => p + 1)}><ChevronRight size={14} /></IconButton>
          </span>
        </div>
      )}
    </section>
  )

  const conversation = selectedId ? (
    <ConversationPane
      key={selectedId}
      ticketId={selectedId}
      admins={admins}
      meId={meId ?? null}
      onBack={!lg ? () => setParam({ ticket: null }) : undefined}
      onOpenCustomer={!xl && selectedUserId ? () => setCustomerOpen(true) : undefined}
      onChanged={onChanged}
    />
  ) : (
    <EmptyState icon={MessageSquareText} title="Select a ticket" description="The conversation, status controls and reply box open here." />
  )

  return (
    <div className="space-y-5">
      <PageHeader
        title="Support"
        description="Answer customer tickets, keep them moving and see who you are talking to."
        actions={
          <>
            <Button size="sm" variant="secondary" leftIcon={<MessageSquareQuote size={13} />} onClick={() => setParam({ panel: 'replies' })}>
              Saved replies
            </Button>
            <Button size="sm" variant="secondary" leftIcon={<RefreshCw size={13} />} loading={queueQ.isFetching && !queueQ.isLoading}
              onClick={() => { void qc.invalidateQueries({ queryKey: ['support'] }) }}>
              Refresh
            </Button>
          </>
        }
      />

      {!showConversationOnly && (
        <>
          <section aria-label="Queue summary" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label="Needs a reply" icon={MessageSquareText} loading={queueQ.isLoading} value={formatNumber(counts?.awaiting)}
              hint="Customer wrote last" tone={counts?.awaiting ? 'warning' : 'default'} onClick={() => changeView('awaiting')} />
            <StatCard label="Overdue" icon={AlertTriangle} loading={queueQ.isLoading} value={formatNumber(counts?.overdue)}
              hint={`Past reply target · ${formatNumber(queueQ.data?.urgent_active)} urgent or high open`}
              tone={counts?.overdue ? 'danger' : 'default'} onClick={() => changeView('overdue')} />
            <StatCard label="Longest wait" icon={Clock} loading={queueQ.isLoading} value={oldest === null ? 'None' : formatAgeHours(oldest)}
              hint={`Reply targets ${targets.urgent}h–${targets.low}h by priority`}
              tone={oldest !== null && oldest >= targets.medium ? 'danger' : oldest !== null && oldest >= targets.high ? 'warning' : 'default'} />
            <StatCard label="Unassigned, open" icon={UserX} loading={queueQ.isLoading} value={formatNumber(counts?.unassigned)}
              hint="Replying assigns to you" onClick={() => changeView('unassigned')} />
          </section>

          <Tabs
            label="Ticket views"
            value={view}
            onChange={changeView}
            items={VIEWS.map((v) => ({ value: v, label: VIEW_LABEL[v], count: counts?.[v] }))}
          />

          <div className="space-y-2">
            <Toolbar actions={<span className="hidden text-xs text-ink-muted xl:inline">Refreshes every 30s</span>}>
              <SearchInput size="sm" value={search} onChange={resetPage(setSearch)} placeholder="Subject, customer, email or #id" />
              <Select size="sm" aria-label="Priority" value={priority} onChange={(e) => { setPriority(e.target.value); setPage(1) }} containerClassName="w-[calc(50%-0.25rem)] sm:w-32">
                <option value="">All priorities</option>
                {(Object.keys(PRIORITY_LABEL) as TicketPriority[]).map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
              </Select>
              <Select size="sm" aria-label="Category" value={category} onChange={(e) => { setCategory(e.target.value); setPage(1) }} containerClassName="w-[calc(50%-0.25rem)] sm:w-36">
                <option value="">All categories</option>
                {(Object.keys(CATEGORY_LABEL) as TicketCategory[]).map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
              </Select>
              <Select size="sm" aria-label="Tag" value={tag} onChange={(e) => { setTag(e.target.value); setPage(1) }} containerClassName="w-[calc(50%-0.25rem)] sm:w-36">
                <option value="">Any tag</option>
                {(tagsQ.data?.results ?? []).map((t) => <option key={t.id} value={t.name}>{t.name}{t.open_count ? ` (${t.open_count} open)` : ''}</option>)}
              </Select>
              <Select size="sm" aria-label="Assignee" value={assignee} onChange={(e) => { setAssignee(e.target.value); setPage(1) }} containerClassName="w-[calc(50%-0.25rem)] sm:w-36">
                <option value="">Any assignee</option>
                <option value="unassigned">Unassigned</option>
                {admins.map((a) => <option key={a.id} value={a.id}>{a.username}</option>)}
              </Select>
              <Select size="sm" aria-label="Sort" value={sort} onChange={(e) => { setSort(e.target.value); setPage(1) }} containerClassName="w-[calc(50%-0.25rem)] sm:w-52">
                <option value="">Default order</option>
                {Object.entries(SORT_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </Select>
            </Toolbar>
            {chips.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                {chips.map((c) => <FilterChip key={c.key} label={c.label} onRemove={() => { c.clear(); setPage(1) }} />)}
                <button type="button" className="text-xs font-medium text-brand-text hover:underline" onClick={clearAll}>Clear all</button>
              </div>
            )}
            {queueQ.error && queueQ.data && <ErrorState variant="inline" title="Could not refresh the queue" error={queueQ.error} onRetry={() => void queueQ.refetch()} />}
          </div>
        </>
      )}

      {showListOnly ? (
        <div className="max-h-[75vh] min-h-[320px] [&>section]:max-h-[75vh]">{queuePanel}</div>
      ) : showConversationOnly ? (
        <section aria-label="Conversation" className="flex h-[calc(100dvh-7.5rem)] min-h-[480px] flex-col overflow-hidden rounded-lg border border-surface-border bg-surface-card shadow-card">
          {conversation}
        </section>
      ) : (
        <div className="grid h-[calc(100vh-7rem)] min-h-[560px] grid-cols-[20rem_minmax(0,1fr)] gap-4 xl:grid-cols-[22rem_minmax(0,1fr)_20rem] 2xl:grid-cols-[24rem_minmax(0,1fr)_22rem]">
          {queuePanel}
          <section aria-label="Conversation" className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-surface-border bg-surface-card shadow-card">
            {conversation}
          </section>
          {xl && (
            <aside aria-label="Customer" className="min-h-0 overflow-y-auto rounded-lg border border-surface-border bg-surface-card p-3 shadow-card">
              {selectedId && selectedUserId ? (
                <CustomerContext key={selectedId} ticketId={selectedId} userId={selectedUserId} onOpenTicket={(id) => selectTicket(id)} />
              ) : selectedId ? (
                convQ.error ? <ErrorState size="compact" error={convQ.error} onRetry={() => void convQ.refetch()} /> : <Skeleton height={120} label="Loading customer" />
              ) : (
                <EmptyState size="compact" title="No customer selected" description="Pick a ticket to see the customer's account and money." />
              )}
            </aside>
          )}
        </div>
      )}

      <SlideOver open={repliesOpen} onClose={() => setParam({ panel: null })} title="Saved replies" width={440}
        subtitle="Answers staff can insert from the reply box. Placeholders are filled for each ticket."
        headerAside={<Link to="/settings#section-support" className="text-xs font-medium text-brand-text hover:underline">Desk settings</Link>}>
        <TemplatesManager />
      </SlideOver>

      <SlideOver open={!xl && customerOpen && !!selectedId && !!selectedUserId} onClose={() => setCustomerOpen(false)} title="Customer" width={400}>
        {selectedId && selectedUserId && (
          <CustomerContext ticketId={selectedId} userId={selectedUserId} onOpenTicket={(id) => { setCustomerOpen(false); selectTicket(id) }} />
        )}
      </SlideOver>
    </div>
  )
}

