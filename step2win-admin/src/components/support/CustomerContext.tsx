import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ExternalLink, Lock } from 'lucide-react'
import { cn } from '../../lib/cn'
import { formatDateTime, formatKES, formatNumber } from '../../lib/format'
import { errorMessage } from '../../lib/errors'
import { StatusBadge } from '../StatusBadge'
import { Button } from '../ui/Button'
import { ErrorState } from '../ui/ErrorState'
import { Skeleton, SkeletonText } from '../ui/Skeleton'
import { consoleApi } from '../users/api'
import { Figure, SectionTitle, SignedKES, Timestamp, TrustMeter } from '../users/shared'
import { humanize } from '../users/utils'
import { supportApi } from './api'
import { STATUS_LABEL, STATUS_TONE } from './meta'

interface CustomerContextProps {
  ticketId: number
  userId: number
  onOpenTicket: (id: number) => void
}

/** Who the customer is, their money and recent activity, plus the staff-only note. */
export function CustomerContext({ ticketId, userId, onOpenTicket }: CustomerContextProps) {
  const q = useQuery({ queryKey: ['admin', 'user-overview', userId], queryFn: () => consoleApi.userOverview(userId), staleTime: 30_000 })

  return (
    <div className="space-y-1">
      <InternalNote ticketId={ticketId} />
      {q.isLoading ? (
        <div className="space-y-3 pt-4" aria-busy>
          <Skeleton height={16} width="50%" label="Loading customer" />
          <div className="grid grid-cols-2 gap-2"><Skeleton height={56} /><Skeleton height={56} /></div>
          <SkeletonText lines={4} />
        </div>
      ) : q.error || !q.data ? (
        <ErrorState size="compact" title="Could not load the customer" error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />
      ) : (
        <CustomerBody data={q.data} ticketId={ticketId} onOpenTicket={onOpenTicket} />
      )}
    </div>
  )
}

function CustomerBody({ data, ticketId, onOpenTicket }: { data: Awaited<ReturnType<typeof consoleApi.userOverview>>; ticketId: number; onOpenTicket: (id: number) => void }) {
  const u = data.user
  const otherTickets = data.tickets.filter((t) => t.id !== ticketId).slice(0, 5)
  const accountStatus = u.is_deleted ? 'deleted' : u.is_banned ? 'banned' : u.is_active ? 'active' : 'inactive'
  return (
    <>
      <SectionTitle aside={<Link to={`/users?user=${u.id}`} className="inline-flex items-center gap-1 text-xs font-medium text-brand-text hover:underline">Open profile <ExternalLink size={11} aria-hidden /></Link>}>
        Customer
      </SectionTitle>
      <div className="rounded-md border border-surface-border bg-surface-card px-3 py-2.5">
        <div className="flex items-center justify-between gap-2">
          <p className="truncate text-sm font-semibold text-ink-primary">{u.username}</p>
          <StatusBadge size="sm" status={accountStatus} />
        </div>
        <p className="mt-0.5 truncate text-xs text-ink-muted">{u.email || '—'}</p>
        {u.phone_number && <p className="mono mt-0.5 text-xs text-ink-secondary">{u.phone_number}</p>}
        <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
          <dt className="text-ink-muted">Joined</dt>
          <dd className="text-right text-ink-secondary"><Timestamp value={u.date_joined} /></dd>
          <dt className="text-ink-muted">Last seen</dt>
          <dd className="text-right text-ink-secondary"><Timestamp value={u.last_seen_at ?? u.last_login} /></dd>
          <dt className="text-ink-muted">Device</dt>
          <dd className="text-right text-ink-secondary">{u.device_platform ? humanize(u.device_platform) : '—'}</dd>
        </dl>
        <div className="mt-2 border-t border-surface-border pt-2">
          <TrustMeter score={data.trust.score} status={data.trust.status} />
        </div>
      </div>

      <SectionTitle>Money</SectionTitle>
      <div className="grid grid-cols-2 gap-2">
        <Figure label="Wallet" value={<span className="mono text-sm">{formatKES(data.wallet.available_balance)}</span>} hint="Available to use" />
        <Figure label="In challenges" value={<span className="mono text-sm">{formatKES(data.wallet.locked_balance)}</span>} hint="Locked entry fees" />
        <Figure label="Deposited" value={<span className="mono text-sm">{formatKES(data.wallet.total_deposited)}</span>} />
        <Figure label="Withdrawn" value={<span className="mono text-sm">{formatKES(data.wallet.total_withdrawn)}</span>} />
      </div>

      <SectionTitle aside={<span className="text-2xs text-ink-muted">{formatNumber(data.transactions.length)} latest</span>}>Transactions</SectionTitle>
      {data.transactions.length === 0 ? (
        <p className="text-xs text-ink-muted">No wallet transactions.</p>
      ) : (
        <ul className="divide-y divide-[var(--border)] rounded-md border border-surface-border bg-surface-card">
          {data.transactions.slice(0, 6).map((t) => {
            const debit = ['withdrawal', 'challenge_entry', 'fee'].includes(t.type)
            const n = Math.abs(Number(t.amount)) * (debit ? -1 : 1)
            return (
              <li key={t.id} className="flex items-center justify-between gap-2 px-3 py-2 text-xs">
                <span className="min-w-0">
                  <span className="block truncate font-medium text-ink-primary">{humanize(t.type)}</span>
                  <span className="block text-2xs text-ink-muted" title={formatDateTime(t.created_at)}>{formatDateTime(t.created_at)}</span>
                </span>
                <span className="shrink-0 text-right"><SignedKES value={n} /></span>
              </li>
            )
          })}
        </ul>
      )}

      {data.withdrawals.length > 0 && (
        <>
          <SectionTitle>Withdrawals</SectionTitle>
          <ul className="divide-y divide-[var(--border)] rounded-md border border-surface-border bg-surface-card">
            {data.withdrawals.slice(0, 3).map((w) => (
              <li key={w.id} className="flex items-center justify-between gap-2 px-3 py-2 text-xs">
                <span className="min-w-0">
                  <span className="mono block text-ink-primary">{formatKES(w.amount_kes)}</span>
                  <span className="block text-2xs text-ink-muted">{formatDateTime(w.created_at)}</span>
                </span>
                <StatusBadge size="sm" status={w.status} tone={w.status === 'completed' ? 'success' : undefined} label={w.status === 'completed' ? 'Paid' : undefined} />
              </li>
            ))}
          </ul>
        </>
      )}

      <SectionTitle>Recent challenges</SectionTitle>
      {data.challenges.length === 0 ? (
        <p className="text-xs text-ink-muted">Has not joined a challenge.</p>
      ) : (
        <ul className="divide-y divide-[var(--border)] rounded-md border border-surface-border bg-surface-card">
          {data.challenges.slice(0, 4).map((c) => (
            <li key={c.challenge_id} className="px-3 py-2 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-medium text-ink-primary">{c.name}</span>
                <StatusBadge size="sm" status={c.status} />
              </div>
              <p className="num mt-0.5 text-2xs text-ink-muted">
                Entry <span className="mono">{formatKES(c.entry_fee)}</span> · {formatNumber(c.steps)} / {formatNumber(c.milestone)} steps
                {Number(c.payout) > 0 && <> · won <span className="mono">{formatKES(c.payout)}</span></>}
              </p>
            </li>
          ))}
        </ul>
      )}

      <SectionTitle>Other tickets</SectionTitle>
      {otherTickets.length === 0 ? (
        <p className="text-xs text-ink-muted">No other tickets from this customer.</p>
      ) : (
        <ul className="divide-y divide-[var(--border)] rounded-md border border-surface-border bg-surface-card">
          {otherTickets.map((t) => (
            <li key={t.id}>
              <button type="button" onClick={() => onOpenTicket(t.id)} className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs hover:bg-surface-elevated">
                <span className="min-w-0">
                  <span className="block truncate font-medium text-ink-primary">{t.subject}</span>
                  <span className="block text-2xs text-ink-muted"><span className="mono">#{t.id}</span> · <Timestamp value={t.updated_at} /></span>
                </span>
                <StatusBadge size="sm" tone={STATUS_TONE[t.status as keyof typeof STATUS_TONE]} label={STATUS_LABEL[t.status as keyof typeof STATUS_LABEL] ?? t.status} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

/** Staff-only note stored on the ticket (admin_notes). Never sent to the customer. */
function InternalNote({ ticketId }: { ticketId: number }) {
  const qc = useQueryClient()
  const conv = useQuery({ queryKey: ['support', 'conversation', ticketId], queryFn: () => supportApi.conversation(ticketId), refetchInterval: 20_000 })
  const saved = conv.data?.ticket.admin_notes ?? ''
  const [value, setValue] = useState<string | null>(null)
  const current = value ?? saved
  const dirty = value !== null && value.trim() !== saved.trim()
  const save = useMutation({
    mutationFn: () => supportApi.update(ticketId, { admin_notes: current }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['support', 'conversation', ticketId] })
      setValue(null)
    },
  })

  return (
    <section aria-labelledby={`note-${ticketId}`} className="rounded-md border border-warning-line bg-warning-soft/50 p-3">
      <div className="mb-1.5">
        <h3 id={`note-${ticketId}`} className="inline-flex items-center gap-1.5 text-xs font-semibold text-ink-primary">
          <Lock size={12} className="text-warning" aria-hidden /> Internal note
        </h3>
        <p className="text-2xs text-ink-muted">Staff only. Never sent to the customer.</p>
      </div>
      <label htmlFor={`note-input-${ticketId}`} className="sr-only">Internal note</label>
      <textarea
        id={`note-input-${ticketId}`}
        value={current}
        onChange={(e) => setValue(e.target.value)}
        rows={3}
        maxLength={4000}
        disabled={conv.isLoading}
        placeholder="Context for other staff: what you checked, what is pending."
        className={cn(
          'w-full resize-y rounded-md border border-surface-strong bg-surface-input px-2.5 py-2 text-xs leading-relaxed text-ink-primary outline-none',
          'placeholder:text-ink-muted focus:border-brand focus:ring-2 focus:ring-brand/20',
        )}
      />
      {save.error && <p className="mt-1 text-2xs text-danger">{errorMessage(save.error)}</p>}
      {(dirty || save.isPending) && (
        <div className="mt-2 flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={() => setValue(null)} disabled={save.isPending}>Discard</Button>
          <Button size="sm" variant="primary" onClick={() => save.mutate()} loading={save.isPending} loadingText="Saving…">Save note</Button>
        </div>
      )}
    </section>
  )
}
