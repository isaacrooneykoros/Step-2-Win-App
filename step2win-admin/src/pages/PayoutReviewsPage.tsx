import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, Clock, Inbox, RefreshCw, Scale, XCircle } from 'lucide-react'
import { PageHeader } from '../components/PageHeader'
import { StatCard } from '../components/StatCard'
import { StatusBadge, type BadgeTone } from '../components/StatusBadge'
import { AdminTable, type Column } from '../components/AdminTable'
import { ConfirmModal } from '../components/ConfirmModal'
import { SlideOver } from '../components/SlideOver'
import { DetailRow } from '../components/DetailRow'
import { Button } from '../components/ui/Button'
import { SearchInput, Textarea } from '../components/ui/Input'
import { Tabs } from '../components/ui/Tabs'
import { Toolbar } from '../components/ui/Toolbar'
import { EmptyState } from '../components/ui/EmptyState'
import { ErrorState } from '../components/ui/ErrorState'
import { Skeleton } from '../components/ui/Skeleton'
import { cn } from '../lib/cn'
import { formatAgeHours, formatDateTime, formatKES, formatNumber } from '../lib/format'
import { useLiveRefetchInterval } from '../lib/realtime/useAdminRealtime'
import { ApiError, financeApi } from '../components/finance/api'
import { useDebounced } from '../components/finance/hooks'
import { AgeIndicator, Money, Section, When, toNum } from '../components/finance/ui'
import type { PayoutReviewDetail, PayoutReviewRow, PayoutReviewStatus } from '../components/finance/payoutReviewTypes'

const REFRESH_MS = 30_000
const NOTE_MIN = 5

const STATUS_LABEL: Record<PayoutReviewStatus, string> = { held: 'Held', released: 'Released', forfeited: 'Forfeited' }
const STATUS_TONE: Record<PayoutReviewStatus, BadgeTone> = { held: 'warning', released: 'success', forfeited: 'neutral' }

const REASON_SHORT: Record<string, string> = {
  trust_banned: 'Banned',
  account_closed: 'Account closed',
  trust_status: 'Low trust',
  open_high_flags: 'High flags',
  suspicious_days: 'Suspicious days',
  large_win_with_flags: 'Large win + flags',
}

function reasonTone(code: string): BadgeTone {
  return code === 'trust_banned' || code === 'account_closed' ? 'danger' : 'warning'
}

function describeError(err: unknown): string {
  if (err instanceof ApiError) return err.message
  return err instanceof Error ? err.message : 'Unknown error.'
}

function ReasonBadges({ row, max = 3 }: { row: PayoutReviewRow; max?: number }) {
  const shown = row.reasons.slice(0, max)
  return (
    <span className="flex flex-wrap gap-1">
      {shown.map((r) => (
        <StatusBadge key={r.code} size="sm" tone={reasonTone(r.code)} label={REASON_SHORT[r.code] ?? r.label} />
      ))}
      {row.reasons.length > max && <span className="text-xs text-ink-muted">+{row.reasons.length - max}</span>}
    </span>
  )
}

function reasonDetail(detail: Record<string, unknown>): string {
  const parts: string[] = []
  if (typeof detail.score === 'number') parts.push(`score ${detail.score}${detail.status ? ` (${String(detail.status)})` : ''}`)
  if (typeof detail.count === 'number') parts.push(`${detail.count}`)
  if (Array.isArray(detail.types) && detail.types.length) parts.push((detail.types as string[]).join(', '))
  if (Array.isArray(detail.dates) && detail.dates.length) parts.push((detail.dates as string[]).join(', '))
  if (detail.threshold !== undefined && detail.amount !== undefined) parts.push(`KSh ${String(detail.amount)} ≥ ${String(detail.threshold)}`)
  if (typeof detail.open_flags === 'number') parts.push(`${detail.open_flags} open flag(s)`)
  return parts.join(' · ')
}

function ReviewDetail({ id }: { id: number }) {
  const q = useQuery({ queryKey: ['admin', 'payout-reviews', 'detail', id], queryFn: () => financeApi.payoutReview(id) })
  if (q.isLoading) {
    return (
      <div className="space-y-3" aria-hidden>
        <Skeleton height={80} />
        <Skeleton height={160} />
      </div>
    )
  }
  if (q.error || !q.data) return <ErrorState size="compact" error={q.error} onRetry={() => void q.refetch()} />
  const d: PayoutReviewDetail = q.data
  const ev = d.evidence
  const maxSteps = Math.max(1, ...ev.daily_steps.days.map((x) => x.steps), ev.daily_steps.baseline_avg ?? 0)
  return (
    <div className="space-y-6">
      <Section title="Payout">
        <div>
          <DetailRow label="Amount" value={formatKES(toNum(d.amount))} mono />
          <DetailRow label="Status" value={<StatusBadge size="sm" tone={STATUS_TONE[d.status]} label={STATUS_LABEL[d.status]} />} />
          <DetailRow label="Challenge" value={d.challenge.name} />
          <DetailRow label="Window" value={`${d.challenge.start_date} to ${d.challenge.end_date}`} />
          <DetailRow
            label="Result"
            value={d.result ? `${formatNumber(d.result.final_steps)} steps${d.result.final_rank ? ` · rank ${d.result.final_rank}` : ''} · ${d.result.payout_method}` : null}
          />
          <DetailRow label="Held" value={formatDateTime(d.created_at)} />
          {d.decided_at && <DetailRow label="Decided" value={`${formatDateTime(d.decided_at)} by ${d.decided_by ?? '—'}`} />}
          {d.note && <DetailRow label="Staff note" value={d.note} stacked />}
        </div>
      </Section>

      <Section title="Why it was held">
        <ul className="space-y-2">
          {d.reasons.map((r) => (
            <li key={r.code} className="rounded-md border border-surface-border px-3 py-2">
              <div className="flex items-center gap-2">
                <StatusBadge size="sm" tone={reasonTone(r.code)} label={REASON_SHORT[r.code] ?? r.code} />
                <span className="text-sm text-ink-primary">{r.label}</span>
              </div>
              {reasonDetail(r.detail) && <p className="mt-1 break-words text-xs text-ink-muted">{reasonDetail(r.detail)}</p>}
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Trust">
        <div>
          <DetailRow label="Trust score" value={`${ev.trust.score} (${ev.trust.status})`} />
          <DetailRow label="Flags on record" value={formatNumber(ev.trust.flags_total)} />
          <DetailRow
            label="Admin lock"
            value={ev.trust.admin_lock ? `${ev.trust.admin_lock.status} · max ${ev.trust.admin_lock.ceiling}${ev.trust.admin_lock.until ? ` until ${formatDateTime(ev.trust.admin_lock.until)}` : ' until lifted'}` : null}
          />
        </div>
        {ev.trust.actions.length > 0 && (
          <ul className="mt-2 space-y-1">
            {ev.trust.actions.map((a) => (
              <li key={a.id} className="text-xs text-ink-secondary">
                <When value={a.created_at} /> · {a.admin}: {a.description}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Flags in the challenge window" aside={<span className="text-xs text-ink-muted">{ev.flags_open_in_window} open</span>}>
        {ev.flags_in_window.length === 0 ? (
          <p className="text-sm text-ink-muted">No flags dated inside the window.</p>
        ) : (
          <ul className="divide-y divide-surface-border rounded-md border border-surface-border">
            {ev.flags_in_window.map((f) => (
              <li key={f.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                <span className="min-w-0">
                  <span className="block truncate text-ink-primary">{f.type}</span>
                  <span className="block text-xs text-ink-muted">{f.date}{f.reviewed ? (f.actioned ? ' · actioned' : ' · dismissed') : ' · open'}</span>
                </span>
                <StatusBadge size="sm" status={f.severity} />
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        title="Daily steps vs history"
        aside={<span className="text-xs text-ink-muted">Baseline {ev.daily_steps.baseline_avg !== null ? formatNumber(ev.daily_steps.baseline_avg) : '—'} / day</span>}
      >
        <p className="text-xs text-ink-muted">Baseline: average of the {ev.daily_steps.baseline_window} ({ev.daily_steps.baseline_days} day(s) recorded).</p>
        <ul className="mt-2 space-y-1.5">
          {ev.daily_steps.days.map((day) => (
            <li key={day.date} className="grid grid-cols-[5.5rem_minmax(0,1fr)_4.5rem] items-center gap-2 text-xs">
              <span className="num text-ink-secondary">{day.date.slice(5)}</span>
              <span className="h-2 rounded-sm bg-surface-elevated" aria-hidden>
                <span
                  className={cn('block h-2 rounded-sm', day.suspicious ? 'bg-warning' : 'bg-brand')}
                  style={{ width: `${Math.min(100, (day.steps / maxSteps) * 100)}%` }}
                />
              </span>
              <span className="num text-right text-ink-primary">
                {day.recorded ? formatNumber(day.steps) : '—'}
                {day.vs_baseline !== null && day.recorded && <span className="text-ink-muted"> ×{day.vs_baseline}</span>}
                {day.suspicious && <span className="sr-only"> (marked suspicious)</span>}
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-1 text-2xs text-ink-muted">Amber bars are days marked suspicious (excluded from the challenge total).</p>
      </Section>

      {d.forfeit_preview && (
        <Section title="If forfeited">
          {d.forfeit_preview.to_platform ? (
            <p className="text-sm text-ink-secondary">No other clear qualifier and no other eligible participant: the amount is recorded as platform revenue with an audit trail.</p>
          ) : (
            <>
              <p className="mb-2 text-xs text-ink-muted">
                {d.forfeit_preview.mode === 'refund'
                  ? 'No other clear qualifier: the amount is refunded to the other participants in proportion to their entry fees (entry fee + refund share).'
                  : "Shared among the challenge's other clear qualifiers in proportion to their payouts (payout + extra share)."}
              </p>
              <ul className="divide-y divide-surface-border rounded-md border border-surface-border">
                {d.forfeit_preview.recipients.map((r) => (
                  <li key={r.user_id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                    <span className="truncate">{r.username ?? `User ${r.user_id}`}</span>
                    <span className="mono text-xs text-ink-secondary">
                      {formatKES(toNum(d.forfeit_preview?.mode === 'refund' ? r.entry_fee : r.original_payout))} + <span className="text-ink-primary">{formatKES(toNum(r.share))}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Section>
      )}
    </div>
  )
}

export function PayoutReviewsPage() {
  const qc = useQueryClient()
  const [tab, setTab] = useState<PayoutReviewStatus>('held')
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<PayoutReviewRow | null>(null)
  const [decision, setDecision] = useState<{ kind: 'release' | 'forfeit'; row: PayoutReviewRow } | null>(null)
  const [note, setNote] = useState('')
  const [banner, setBanner] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null)
  const q = useDebounced(search)
  const refetchInterval = useLiveRefetchInterval(REFRESH_MS)

  const listQ = useQuery({
    queryKey: ['admin', 'payout-reviews', 'list', tab, q],
    queryFn: () => financeApi.payoutReviews(tab, q),
    refetchInterval,
    placeholderData: (prev) => prev,
  })
  const detailQ = useQuery({
    queryKey: ['admin', 'payout-reviews', 'detail', selected?.id],
    queryFn: () => financeApi.payoutReview(selected!.id),
    enabled: !!selected,
  })
  const rows = useMemo(() => listQ.data?.results ?? [], [listQ.data])
  const counts = listQ.data?.counts
  const oldest = tab === 'held' && rows.length ? Math.max(...rows.map((r) => r.age_hours)) : null

  const decide = useMutation({
    mutationFn: ({ kind, row, text }: { kind: 'release' | 'forfeit'; row: PayoutReviewRow; text: string }) =>
      kind === 'release' ? financeApi.releasePayout(row.id, text) : financeApi.forfeitPayout(row.id, text),
    onSuccess: (res, { kind, row }) => {
      const amount = formatKES(toNum(row.amount))
      setBanner({
        tone: 'success',
        text: res.already_decided
          ? `This payout was already ${res.status}. Nothing changed.`
          : kind === 'release'
            ? `Released ${amount} to ${row.user.username}'s wallet. The user was notified.`
            : res.redistributed && res.redistributed.length
              ? res.mode === 'refund'
                ? `Forfeited ${amount}: refunded to ${res.redistributed.length} other participant(s) by entry fee (no other clear qualifier). The user was notified.`
                : `Forfeited ${amount}: shared among ${res.redistributed.length} qualifier(s). The user was notified.`
              : `Forfeited ${amount}: recorded as platform revenue (no other eligible participant). The user was notified.`,
      })
      setSelected(null)
    },
    onError: (err) => setBanner({ tone: 'danger', text: describeError(err) }),
    onSettled: () => {
      setDecision(null)
      setNote('')
      void qc.invalidateQueries({ queryKey: ['admin', 'payout-reviews'] })
      void qc.invalidateQueries({ queryKey: ['admin', 'finance'] })
    },
  })

  const columns: Column<PayoutReviewRow>[] = [
    {
      key: 'user', label: 'User', sortable: true, sortValue: (r) => r.user.username.toLowerCase(),
      render: (r) => (
        <span className="block min-w-0">
          <span className="block truncate font-medium">{r.user.username}</span>
          <span className="block truncate text-xs text-ink-muted">Trust {r.user.trust_score} · {r.user.trust_status}{r.user_deleted ? ' · deleted' : ''}</span>
        </span>
      ),
    },
    {
      key: 'challenge', label: 'Challenge', hideBelow: 'md',
      render: (r) => (
        <span className="block min-w-0">
          <span className="block truncate">{r.challenge.name}</span>
          <span className="block truncate text-xs text-ink-muted">{r.challenge.start_date} to {r.challenge.end_date}</span>
        </span>
      ),
    },
    { key: 'amount', label: 'Amount', numeric: true, sortable: true, sortValue: (r) => toNum(r.amount), render: (r) => <Money value={r.amount} /> },
    { key: 'reasons', label: 'Reasons', hideBelow: 'lg', render: (r) => <ReasonBadges row={r} /> },
    tab === 'held'
      ? { key: 'age', label: 'Waiting', align: 'right', sortable: true, sortValue: (r) => r.age_hours, render: (r) => <AgeIndicator hours={r.age_hours} /> }
      : { key: 'decided', label: 'Decided', align: 'right', render: (r) => <span className="text-ink-secondary"><When value={r.decided_at} /></span> },
  ]

  const current = detailQ.data
  const noteOk = note.trim().length >= NOTE_MIN

  const footer = selected && selected.status === 'held' ? (
    <div className="flex w-full items-center justify-end gap-2">
      {current && !current.can_release && current.release_blocked_reason && (
        <span className="mr-auto text-xs text-ink-muted">{current.release_blocked_reason}</span>
      )}
      <Button variant="danger-soft" disabled={decide.isPending} onClick={() => setDecision({ kind: 'forfeit', row: selected })}>
        Forfeit
      </Button>
      <Button
        variant="primary"
        disabled={decide.isPending || !current?.can_release}
        onClick={() => setDecision({ kind: 'release', row: selected })}
      >
        Release to wallet
      </Button>
    </div>
  ) : undefined

  return (
    <div className="space-y-5">
      <PageHeader
        title="Payout reviews"
        description="Challenge payouts held at settlement for a second look. Release credits the winner's wallet; forfeit shares the amount among the challenge's other clear qualifiers, or refunds it to the other participants when there is none."
        actions={
          <Button size="sm" variant="secondary" leftIcon={<RefreshCw size={13} />} loading={listQ.isFetching} onClick={() => void listQ.refetch()}>
            Refresh
          </Button>
        }
      />

      <section aria-label="Queue summary" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Awaiting review"
          icon={Inbox}
          loading={listQ.isLoading}
          value={formatNumber(counts?.held)}
          hint={listQ.data ? `${formatKES(toNum(listQ.data.held_total))} held` : undefined}
          tone={counts?.held ? 'warning' : 'default'}
          onClick={() => setTab('held')}
        />
        <StatCard
          label="Oldest held"
          icon={Clock}
          loading={listQ.isLoading}
          value={tab !== 'held' ? '—' : oldest === null ? 'None' : formatAgeHours(oldest)}
          hint="Target: decided within 48h"
          tone={oldest !== null && oldest >= 48 ? 'danger' : oldest !== null && oldest >= 24 ? 'warning' : 'default'}
        />
        <StatCard label="Released" icon={CheckCircle2} loading={listQ.isLoading} value={formatNumber(counts?.released)} onClick={() => setTab('released')} />
        <StatCard label="Forfeited" icon={XCircle} loading={listQ.isLoading} value={formatNumber(counts?.forfeited)} onClick={() => setTab('forfeited')} />
      </section>

      {banner && (
        <div
          role={banner.tone === 'danger' ? 'alert' : 'status'}
          className={cn(
            'flex items-start justify-between gap-3 rounded-lg border px-4 py-3 text-sm',
            banner.tone === 'success' ? 'border-success-line bg-success-soft text-ink-primary' : 'border-danger-line bg-danger-soft text-ink-primary',
          )}
        >
          <span>{banner.text}</span>
          <button type="button" className="text-xs font-medium text-ink-secondary hover:underline" onClick={() => setBanner(null)}>
            Dismiss
          </button>
        </div>
      )}

      <Tabs
        label="Payout review views"
        value={tab}
        onChange={(v) => { setTab(v); setSelected(null) }}
        idPrefix="pr"
        items={[
          { value: 'held', label: 'Held', count: counts?.held },
          { value: 'released', label: 'Released' },
          { value: 'forfeited', label: 'Forfeited' },
        ]}
      />

      <div role="tabpanel" id={`pr-panel-${tab}`} aria-labelledby={`pr-tab-${tab}`}>
        <AdminTable
          columns={columns}
          data={rows}
          rowKey={(r) => r.id}
          isLoading={listQ.isLoading}
          error={listQ.error}
          onRetry={() => void listQ.refetch()}
          onRowClick={setSelected}
          isRowActive={(r) => r.id === selected?.id}
          density="compact"
          toolbar={
            <Toolbar actions={<span className="hidden text-xs text-ink-muted sm:inline">{tab === 'held' ? 'Oldest first' : 'Newest decisions first'}</span>}>
              <SearchInput size="sm" value={search} onChange={setSearch} placeholder="User, email, challenge or ID" />
            </Toolbar>
          }
          emptyState={
            <EmptyState
              size="compact"
              icon={tab === 'held' ? CheckCircle2 : Scale}
              title={tab === 'held' ? 'No payouts waiting for review' : `No ${STATUS_LABEL[tab].toLowerCase()} payouts`}
              description={tab === 'held' ? 'Held payouts appear here when a challenge settles and a winner matches a hold rule.' : undefined}
            />
          }
          skeletonRows={5}
          maxHeight="70vh"
        />
      </div>

      <SlideOver
        open={!!selected}
        onClose={() => setSelected(null)}
        title={selected ? `${selected.user.username} · ${formatKES(toNum(selected.amount))}` : ''}
        subtitle={selected?.challenge.name}
        headerAside={selected && <StatusBadge size="sm" tone={STATUS_TONE[selected.status]} label={STATUS_LABEL[selected.status]} />}
        width={560}
        footer={footer}
      >
        {selected && <ReviewDetail key={selected.id} id={selected.id} />}
      </SlideOver>

      <ConfirmModal
        key={`${decision?.kind ?? 'none'}-${decision?.row.id ?? 0}`}
        open={!!decision}
        onClose={() => { if (!decide.isPending) { setDecision(null); setNote('') } }}
        onConfirm={() => decision && noteOk && decide.mutate({ kind: decision.kind, row: decision.row, text: note.trim() })}
        loading={decide.isPending}
        variant={decision?.kind === 'forfeit' ? 'danger' : 'warning'}
        title={decision?.kind === 'forfeit' ? 'Forfeit held payout' : 'Release held payout'}
        confirmLabel={decision?.kind === 'forfeit' ? 'Forfeit payout' : `Release ${decision ? formatKES(toNum(decision.row.amount)) : ''}`}
        confirmDisabled={!noteOk}
        message={
          decision?.kind === 'forfeit'
            ? current?.forfeit_preview?.to_platform
              ? 'The user is not paid. With no other clear qualifier and no other eligible participant, the amount is recorded as platform revenue.'
              : current?.forfeit_preview?.mode === 'refund'
                ? 'The user is not paid. With no other clear qualifier, the amount is refunded to the other participants in proportion to their entry fees.'
                : "The user is not paid. The amount is shared among the challenge's other clear qualifiers in proportion to their payouts."
            : "The amount is credited to the user's wallet now, like a normal challenge payout."
        }
        details={
          decision
            ? [
                { label: 'User', value: decision.row.user.username },
                { label: 'Amount', value: <span className="mono">{formatKES(toNum(decision.row.amount))}</span> },
                { label: 'Challenge', value: decision.row.challenge.name },
              ]
            : undefined
        }
        consequence="The user gets a neutral message in their Support inbox. This decision cannot be undone from the console."
      >
        <Textarea
          label="Note (internal, required)"
          required
          value={note}
          onChange={(e) => setNote(e.target.value)}
          disabled={decide.isPending}
          maxLength={1000}
          hint={noteOk ? `${note.trim().length}/1000` : `At least ${NOTE_MIN} characters.`}
        />
      </ConfirmModal>
    </div>
  )
}

export default PayoutReviewsPage
