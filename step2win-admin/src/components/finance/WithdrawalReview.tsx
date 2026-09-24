import { useState, type ElementType } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2, Eye, EyeOff, Info, ShieldAlert } from 'lucide-react'
import { cn } from '../../lib/cn'
import { formatDateTime, formatKES, formatNumber, formatRelative } from '../../lib/format'
import { DetailRow } from '../DetailRow'
import { StatusBadge } from '../StatusBadge'
import { ErrorState } from '../ui/ErrorState'
import { Skeleton } from '../ui/Skeleton'
import { financeApi } from './api'
import type { WithdrawalDetail, WithdrawalRow } from './types'
import {
  AgeIndicator, CopyButton, METHOD_LABEL, Money, Section, WithdrawalStatusBadge, When, fullDestination, maskedDestination, toNum,
} from './ui'

type SignalTone = 'danger' | 'warning' | 'ok' | 'info'
interface Signal { key: string; tone: SignalTone; label: string; detail?: string }

const RANK: Record<SignalTone, number> = { danger: 0, warning: 1, info: 2, ok: 3 }
const ICON: Record<SignalTone, ElementType> = { danger: ShieldAlert, warning: AlertTriangle, info: Info, ok: CheckCircle2 }
const ICON_CLS: Record<SignalTone, string> = {
  danger: 'text-danger', warning: 'text-warning', info: 'text-notice', ok: 'text-success',
}

/** Decision signals derived only from values the API returned. */
function buildSignals(d: WithdrawalDetail): Signal[] {
  const w = d.withdrawal
  const amount = toNum(w.amount_kes)
  const t = d.ledger.totals_by_type
  const deposited = toNum(t.deposit?.amount_kes)
  const won = toNum(t.payout?.amount_kes)
  const paid = d.history.by_status.completed
  const rejected = d.history.by_status.rejected?.count ?? 0
  const ageDays = (Date.now() - new Date(d.user.joined_at).getTime()) / 86400000
  const s: Signal[] = []

  if (!d.user.is_active) s.push({ key: 'inactive', tone: 'danger', label: 'Account is disabled', detail: 'The user cannot sign in.' })

  if (toNum(d.user.wallet_balance) < 0) {
    s.push({ key: 'bal', tone: 'danger', label: 'Wallet balance is negative', detail: formatKES(toNum(d.user.wallet_balance)) })
  }

  if (amount > deposited + won) {
    s.push({
      key: 'funding', tone: 'warning', label: 'Amount is more than the user has deposited or won',
      detail: `Deposited ${formatKES(deposited)} · won ${formatKES(won)} (all time, ledger)`,
    })
  } else {
    s.push({
      key: 'funding', tone: 'ok', label: 'Covered by deposits and winnings',
      detail: `Deposited ${formatKES(deposited)} · won ${formatKES(won)} (all time, ledger)`,
    })
  }

  const { score, status } = d.trust
  if (score === null) s.push({ key: 'trust', tone: 'info', label: 'No anti-cheat trust score yet' })
  else {
    const tone: SignalTone = score <= 40 ? 'danger' : score <= 80 ? 'warning' : 'ok'
    s.push({ key: 'trust', tone, label: `Trust score ${score} / 100`, detail: status ? `Status ${status.toLowerCase()}${d.trust.flags_total ? ` · ${d.trust.flags_total} flags all time` : ''}` : undefined })
  }

  if (d.trust.open_high_or_critical > 0) {
    s.push({ key: 'flags', tone: 'danger', label: `${d.trust.open_high_or_critical} high or critical anti-cheat flag${d.trust.open_high_or_critical === 1 ? '' : 's'} open`, detail: `${d.trust.open_flags} open in total` })
  } else if (d.trust.open_flags > 0) {
    s.push({ key: 'flags', tone: 'warning', label: `${d.trust.open_flags} open anti-cheat flag${d.trust.open_flags === 1 ? '' : 's'}` })
  } else {
    s.push({ key: 'flags', tone: 'ok', label: 'No open anti-cheat flags' })
  }

  if (ageDays < 7) s.push({ key: 'age', tone: 'warning', label: 'New account', detail: `Joined ${formatRelative(d.user.joined_at)}` })
  else s.push({ key: 'age', tone: 'ok', label: `Account ${Math.floor(ageDays)} days old`, detail: `Joined ${formatDateTime(d.user.joined_at)}` })

  if (paid?.count) {
    s.push({ key: 'history', tone: 'ok', label: `${paid.count} earlier withdrawal${paid.count === 1 ? '' : 's'} paid`, detail: `${formatKES(toNum(paid.amount_kes))} in total` })
  } else {
    s.push({ key: 'history', tone: 'info', label: 'No earlier paid withdrawals', detail: 'First payout to this user' })
  }
  if (rejected > 0) s.push({ key: 'rejected', tone: 'warning', label: `${rejected} earlier request${rejected === 1 ? '' : 's'} rejected` })

  return s.sort((a, b) => RANK[a.tone] - RANK[b.tone])
}

function SignalList({ signals }: { signals: Signal[] }) {
  return (
    <ul className="divide-y divide-[var(--border)] rounded-md border border-surface-border">
      {signals.map((s) => {
        const Icon = ICON[s.tone]
        return (
          <li key={s.key} className="flex items-start gap-2.5 px-3 py-2">
            <Icon size={15} className={cn('mt-0.5 shrink-0', ICON_CLS[s.tone])} aria-hidden />
            <span className="min-w-0">
              <span className="block text-sm text-ink-primary">
                <span className="sr-only">{s.tone === 'ok' ? 'OK: ' : s.tone === 'info' ? 'Note: ' : s.tone === 'warning' ? 'Warning: ' : 'Risk: '}</span>
                {s.label}
              </span>
              {s.detail && <span className="block text-xs text-ink-muted">{s.detail}</span>}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

function ReviewSkeleton() {
  return (
    <div className="space-y-4" aria-hidden>
      <Skeleton height={64} />
      <Skeleton height={140} />
      <Skeleton height={100} />
    </div>
  )
}

/**
 * Everything an operator needs to decide on one withdrawal. The summary row
 * renders immediately; context (balance, trust, history) loads alongside.
 */
export function WithdrawalReview({ row }: { row: WithdrawalRow }) {
  const [reveal, setReveal] = useState(false)
  const q = useQuery({
    queryKey: ['admin', 'finance', 'withdrawal', row.id],
    queryFn: () => financeApi.withdrawal(row.id),
    staleTime: 15_000,
  })
  const d = q.data
  const w = d?.withdrawal ?? row

  return (
    <div className="space-y-5">
      {/* Amount + destination */}
      <div className="rounded-md border border-surface-border bg-surface-sunken/50 px-4 py-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs text-ink-muted">Amount requested</p>
            <p className="mono mt-0.5 text-2xl font-semibold tracking-tight text-ink-primary">{formatKES(toNum(w.amount_kes))}</p>
          </div>
          <WithdrawalStatusBadge status={w.status} size="md" />
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <span className="text-ink-muted">To</span>
          <span className="font-medium text-ink-primary">{METHOD_LABEL[w.method] ?? w.method}</span>
          <span className="mono text-ink-primary">{reveal ? fullDestination(w) : maskedDestination(w)}</span>
          <button
            type="button"
            onClick={() => setReveal((v) => !v)}
            className="inline-flex items-center gap-1 rounded px-1 text-xs font-medium text-brand-text hover:underline"
            aria-pressed={reveal}
          >
            {reveal ? <EyeOff size={12} aria-hidden /> : <Eye size={12} aria-hidden />}
            {reveal ? 'Hide' : 'Show full'}
          </button>
          {reveal && <CopyButton value={fullDestination(w)} label="Copy destination" />}
        </div>
        {w.method === 'mpesa' && d && d.user.phone_number && d.user.phone_number !== w.phone_number && (
          <p className="mt-2 flex items-start gap-1.5 text-xs text-warning">
            <AlertTriangle size={13} className="mt-px shrink-0" aria-hidden />
            Destination differs from the phone number on the account.
          </p>
        )}
      </div>

      {/* Outcome for decided requests */}
      {(w.fail_reason || w.rejection_reason || w.tracking_reference || w.mpesa_reference) && (
        <Section title="Outcome">
          <div className="rounded-md border border-surface-border px-3">
            {w.rejection_reason && <DetailRow label="Rejection reason" value={w.rejection_reason} stacked />}
            {w.fail_reason && (
              <DetailRow
                label="Failure"
                stacked
                value={
                  <span>
                    <span className="text-danger">{w.fail_reason}</span>
                    <span className="mt-1 block text-xs text-ink-muted">
                      When a payout fails the backend returns the amount to the user's wallet.
                    </span>
                  </span>
                }
              />
            )}
            {w.tracking_reference && <DetailRow label="Gateway tracking ID" value={<span className="inline-flex items-center gap-1">{w.tracking_reference}<CopyButton value={w.tracking_reference} /></span>} mono />}
            {w.mpesa_reference && <DetailRow label="M-Pesa receipt" value={<span className="inline-flex items-center gap-1">{w.mpesa_reference}<CopyButton value={w.mpesa_reference} /></span>} mono />}
          </div>
        </Section>
      )}

      {q.isLoading ? (
        <ReviewSkeleton />
      ) : q.error || !d ? (
        <ErrorState size="compact" title="Could not load the user's context" error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />
      ) : (
        <>
          <Section title="Decision signals">
            <SignalList signals={buildSignals(d)} />
          </Section>

          <Section title="Wallet now">
            <div className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-surface-border bg-[var(--border)]">
              <div className="bg-surface-overlay px-3 py-2">
                <p className="text-xs text-ink-muted">Wallet balance</p>
                <p className="mt-0.5 text-sm font-semibold"><Money value={d.user.wallet_balance} /></p>
                <p className="text-2xs text-ink-muted">already excludes this request</p>
              </div>
              <div className="bg-surface-overlay px-3 py-2">
                <p className="text-xs text-ink-muted">In challenge entries</p>
                <p className="mt-0.5 text-sm font-semibold"><Money value={d.user.locked_balance} /></p>
                <p className="text-2xs text-ink-muted">locked, not withdrawable</p>
              </div>
            </div>
          </Section>

          <Section title="Request">
            <div className="rounded-md border border-surface-border px-3">
              <DetailRow label="User" value={<span>{d.user.username} <span className="text-ink-muted">· {d.user.email}</span></span>} />
              <DetailRow label="Requested" value={<When value={w.created_at} stacked />} />
              {w.status === 'pending_review' && <DetailRow label="Waiting" value={<AgeIndicator hours={w.age_hours} />} />}
              {w.reviewed_at && <DetailRow label="Reviewed" value={`${formatDateTime(w.reviewed_at)}${w.reviewed_by ? ` by ${w.reviewed_by}` : ''}`} />}
              <DetailRow label="Request ID" value={<span className="inline-flex items-center gap-1 break-all">{w.id}<CopyButton value={w.id} /></span>} mono />
              {d.payout_transaction && (
                <DetailRow
                  label="Gateway payout"
                  value={<span className="inline-flex items-center gap-2"><StatusBadge size="sm" status={d.payout_transaction.status} />{formatRelative(d.payout_transaction.updated_at)}</span>}
                />
              )}
            </div>
          </Section>

          <Section title="Earlier withdrawals" aside={<span className="text-xs text-ink-muted">{formatNumber(d.history.previous.length)} shown</span>}>
            {d.history.previous.length === 0 ? (
              <p className="rounded-md border border-dashed border-surface-border px-3 py-3 text-sm text-ink-muted">No earlier withdrawal requests.</p>
            ) : (
              <table className="w-full text-sm">
                <caption className="sr-only">Earlier withdrawals by this user</caption>
                <thead>
                  <tr className="border-b border-surface-border text-left text-xs text-ink-muted">
                    <th scope="col" className="py-1.5 pr-2 font-medium">Requested</th>
                    <th scope="col" className="py-1.5 pr-2 text-right font-medium">Amount</th>
                    <th scope="col" className="py-1.5 text-right font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {d.history.previous.map((p) => (
                    <tr key={p.id} className="border-b border-surface-border last:border-b-0">
                      <td className="py-1.5 pr-2 text-ink-secondary"><When value={p.created_at} /></td>
                      <td className="py-1.5 pr-2 text-right"><Money value={p.amount_kes} /></td>
                      <td className="py-1.5 text-right"><WithdrawalStatusBadge status={p.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>

          {d.trust.recent_flags.length > 0 && (
            <Section title="Recent anti-cheat flags">
              <ul className="divide-y divide-[var(--border)] rounded-md border border-surface-border">
                {d.trust.recent_flags.map((f) => (
                  <li key={f.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                    <span className="min-w-0 truncate text-ink-primary">{f.flag_type.replace(/_/g, ' ')}</span>
                    <span className="flex shrink-0 items-center gap-2">
                      <StatusBadge size="sm" status={f.severity} />
                      <span className="text-xs text-ink-muted">{f.reviewed ? 'Reviewed' : 'Open'} · {formatRelative(f.created_at)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </Section>
          )}
        </>
      )}
    </div>
  )
}
