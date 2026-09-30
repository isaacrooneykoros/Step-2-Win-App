/**
 * Wallet corrections on the Transactions page: pending two-person approvals, recent
 * corrections, the approval threshold (owner edits it), and the adjust / reverse forms.
 * Rules live on the server (backend/apps/admin_api/money.py).
 */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Coins, Pencil, Undo2, X } from 'lucide-react'
import { Panel } from '../ui/Card'
import { Button } from '../ui/Button'
import { Input, Textarea } from '../ui/Input'
import { Modal } from '../ui/Modal'
import { ConfirmModal } from '../ConfirmModal'
import { StatusBadge } from '../StatusBadge'
import { EmptyState } from '../ui/EmptyState'
import { Skeleton } from '../ui/Skeleton'
import { consoleApi } from '../users/api'
import { newIdempotencyKey, type WalletCorrection } from '../users/partATypes'
import { SignedKES, Timestamp } from '../users/shared'
import { useDebounced } from '../users/utils'
import { formatKES } from '../../lib/format'
import { usePermissions } from '../../lib/permissions'

const invalidate = (qc: ReturnType<typeof useQueryClient>) => {
  void qc.invalidateQueries({ queryKey: ['admin', 'corrections'] })
  void qc.invalidateQueries({ queryKey: ['admin', 'finance', 'ledger'] })
}

export function CorrectionsPanel({ onNotice }: { onNotice: (tone: 'success' | 'danger', text: string) => void }) {
  const qc = useQueryClient()
  const { can, data: me } = usePermissions()
  const q = useQuery({ queryKey: ['admin', 'corrections'], queryFn: () => consoleApi.corrections({}) })
  const [deciding, setDeciding] = useState<{ c: WalletCorrection; approve: boolean } | null>(null)
  const [note, setNote] = useState('')
  const [editThreshold, setEditThreshold] = useState(false)
  const [threshold, setThreshold] = useState('')

  const decide = useMutation({
    mutationFn: () => (deciding!.approve ? consoleApi.approveCorrection(deciding!.c.id, note) : consoleApi.rejectCorrection(deciding!.c.id, note)),
    onSuccess: () => { onNotice('success', deciding!.approve ? 'Correction approved and written to the ledger.' : 'Correction rejected.'); setDeciding(null); setNote(''); invalidate(qc) },
    onError: (e) => { onNotice('danger', e instanceof Error ? e.message : 'The request failed.'); setDeciding(null) },
  })
  const saveThreshold = useMutation({
    mutationFn: () => consoleApi.updateFinanceControls(threshold),
    onSuccess: () => { setEditThreshold(false); onNotice('success', 'Approval threshold updated.'); void qc.invalidateQueries({ queryKey: ['admin', 'corrections'] }) },
    onError: (e) => onNotice('danger', e instanceof Error ? e.message : 'Could not save.'),
  })
  const rows = q.data?.results ?? []
  const pending = rows.filter((r) => r.status === 'pending')
  const recent = rows.filter((r) => r.status !== 'pending').slice(0, 6)

  return (
    <Panel
      padding="none"
      title="Wallet corrections"
      description={q.data ? `Adjustments and reversals above ${formatKES(q.data.threshold_kes)} need a second finance approver.` : 'Adjustments and reversals written as new ledger rows.'}
      actions={can('owner.finance_controls') && (
        <Button size="sm" variant="ghost" leftIcon={<Pencil size={12} />} onClick={() => { setThreshold(q.data?.threshold_kes ?? ''); setEditThreshold(true) }}>Threshold</Button>
      )}
    >
      {q.isLoading ? <div className="p-4"><Skeleton height={60} /></div> : rows.length === 0 ? (
        <EmptyState size="compact" icon={Coins} title="No corrections yet" description="Use Adjust balance, or Reverse on a ledger entry." />
      ) : (
        <ul className="divide-y divide-[var(--border)]">
          {[...pending, ...recent].map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-4 py-2.5 text-sm">
              <span className="w-28 shrink-0 text-right"><SignedKES value={c.amount} /></span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-ink-primary">{c.kind === 'reversal' ? `Reversal of #${c.target_transaction_id}` : 'Adjustment'} · {c.username}</span>
                <span className="block truncate text-xs text-ink-muted" title={c.reason}>{c.reason} · requested by {c.requested_by} <Timestamp value={c.requested_at} /></span>
              </span>
              {c.status === 'pending' ? (
                <span className="flex items-center gap-1.5">
                  <StatusBadge size="sm" tone="warning" label="Needs second approver" />
                  {can('finance.approve_adjustment') && (
                    c.requested_by_id === me?.user_id
                      ? <span className="text-xs text-ink-muted">Another person must approve</span>
                      : <>
                        <Button size="sm" variant="danger-soft" leftIcon={<X size={12} />} onClick={() => { setNote(''); setDeciding({ c, approve: false }) }}>Reject</Button>
                        <Button size="sm" variant="primary" leftIcon={<Check size={12} />} onClick={() => { setNote(''); setDeciding({ c, approve: true }) }}>Approve</Button>
                      </>
                  )}
                </span>
              ) : (
                <StatusBadge size="sm" status={c.status === 'applied' ? 'completed' : c.status} label={c.status === 'applied' ? `Applied${c.decided_by && c.needs_second_approval ? ` · ${c.decided_by}` : ''}` : c.status === 'failed' ? `Failed: ${c.error}` : 'Rejected'} />
              )}
            </li>
          ))}
        </ul>
      )}

      <ConfirmModal open={!!deciding} onClose={() => setDeciding(null)} onConfirm={() => decide.mutate()} loading={decide.isPending}
        variant={deciding?.approve ? 'warning' : 'danger'}
        title={deciding?.approve ? 'Approve wallet correction' : 'Reject wallet correction'}
        confirmLabel={deciding?.approve ? 'Approve and apply' : 'Reject'}
        confirmDisabled={!deciding?.approve && note.trim().length < 5}
        message={deciding?.approve ? 'A new ledger row is written and the balance changes now. It is refused if the balance would go below zero.' : 'Nothing is written to the ledger.'}
        details={deciding ? [
          { label: 'User', value: deciding.c.username },
          { label: 'Amount', value: <SignedKES value={deciding.c.amount} /> },
          { label: 'Reason', value: deciding.c.reason },
          { label: 'Requested by', value: deciding.c.requested_by },
        ] : []}>
        <Textarea label={deciding?.approve ? 'Note (optional)' : 'Why it is rejected (required)'} rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
      </ConfirmModal>

      <Modal open={editThreshold} onClose={() => setEditThreshold(false)} size="sm" title="Two-person approval threshold"
        description="Adjustments and reversals above this amount (KES) wait for a second finance or owner approver. 0 = every correction needs two people."
        footer={<>
          <Button variant="secondary" onClick={() => setEditThreshold(false)}>Cancel</Button>
          <Button variant="primary" loading={saveThreshold.isPending} disabled={threshold.trim() === '' || Number(threshold) < 0} onClick={() => saveThreshold.mutate()}>Save</Button>
        </>}>
        <Input label="Threshold (KES)" inputMode="decimal" className="mono" value={threshold} onChange={(e) => setThreshold(e.target.value)} />
      </Modal>
    </Panel>
  )
}

/** Adjust a user's balance from the Transactions page (user chosen by search). */
export function AdjustBalanceModal({ open, onClose, onNotice }: { open: boolean; onClose: () => void; onNotice: (tone: 'success' | 'danger', text: string) => void }) {
  const qc = useQueryClient()
  const [search, setSearch] = useState('')
  const [userId, setUserId] = useState<number | null>(null)
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')
  const [reference, setReference] = useState('')
  const [key, setKey] = useState(newIdempotencyKey)
  const [error, setError] = useState<string | null>(null)
  const term = useDebounced(search.trim(), 300)
  const users = useQuery({
    queryKey: ['admin', 'users', 'pick', term],
    queryFn: () => consoleApi.listUsers({ page: 1, page_size: 6, search: term }),
    enabled: open && term.length >= 2,
  })
  const picked = users.data?.results.find((u) => u.id === userId)
  const n = Number(amount)
  const valid = !!picked && amount.trim() !== '' && Number.isFinite(n) && n !== 0 && reason.trim().length >= 5
  const reset = () => { setSearch(''); setUserId(null); setAmount(''); setReason(''); setReference(''); setError(null); setKey(newIdempotencyKey()) }
  const m = useMutation({
    mutationFn: () => consoleApi.adjustBalance({ user_id: userId!, amount: amount.trim(), reason: reason.trim(), reference: reference.trim() || undefined, idempotency_key: key }),
    onSuccess: (res) => {
      onNotice('success', res.correction.status === 'pending'
        ? `Adjustment of ${formatKES(amount)} for ${picked?.username} is waiting for a second approver.`
        : `Adjusted ${picked?.username}'s balance by ${formatKES(amount)}. New balance ${formatKES(res.wallet_balance)}.`)
      invalidate(qc)
      reset()
      onClose()
    },
    onError: (e) => setError(e instanceof Error ? e.message : 'The request failed.'),
  })
  return (
    <Modal open={open} onClose={() => !m.isPending && onClose()} size="md" title="Adjust a wallet balance"
      description="Adds a new adjustment row to the ledger with the reason; existing rows are never changed. The balance can never go below zero."
      footer={<>
        <Button variant="secondary" onClick={onClose} disabled={m.isPending}>Cancel</Button>
        <Button variant="primary" loading={m.isPending} disabled={!valid} onClick={() => m.mutate()}>Adjust balance</Button>
      </>}>
      <div className="space-y-3">
        <Input label="User" value={search} onChange={(e) => { setSearch(e.target.value); setUserId(null) }} placeholder="Username, email or phone" />
        {term.length >= 2 && !picked && (
          <ul className="divide-y divide-[var(--border)] rounded-md border border-surface-border">
            {users.isLoading ? <li className="px-3 py-2"><Skeleton width="50%" /></li> : (users.data?.results ?? []).length === 0 ? <li className="px-3 py-2 text-sm text-ink-muted">No users found</li> :
              users.data!.results.map((u) => (
                <li key={u.id}>
                  <button type="button" className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-surface-elevated" onClick={() => setUserId(u.id)}>
                    <span className="font-medium text-ink-primary">{u.username} <span className="text-xs font-normal text-ink-muted">{u.email}</span></span>
                    <span className="mono text-xs text-ink-secondary">{formatKES(u.wallet_balance)}</span>
                  </button>
                </li>
              ))}
          </ul>
        )}
        {picked && <p className="text-sm text-ink-secondary">{picked.username} · balance <span className="mono font-medium text-ink-primary">{formatKES(picked.wallet_balance)}</span></p>}
        <Input label="Amount in KES (negative to debit)" inputMode="decimal" className="mono" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 250 or -250"
          hint={picked && Number.isFinite(n) && n !== 0 ? `New balance ${formatKES(Number(picked.wallet_balance) + n)}` : undefined} />
        <Input label="Reference (optional)" value={reference} onChange={(e) => setReference(e.target.value)} maxLength={100} placeholder="Ticket, M-Pesa ref…" />
        <Textarea label="Reason (kept in the ledger and audit log)" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} required />
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      </div>
    </Modal>
  )
}

/** Reverse one ledger row (creates the opposite row once). */
export function ReverseModal({ row, onClose, onNotice }: {
  row: { id: number; amount: string; type: string; user_username: string | null; description: string } | null
  onClose: () => void
  onNotice: (tone: 'success' | 'danger', text: string) => void
}) {
  const qc = useQueryClient()
  const [reason, setReason] = useState('')
  const [key] = useState(newIdempotencyKey)
  const m = useMutation({
    mutationFn: () => consoleApi.reverseTransaction(row!.id, reason.trim(), key),
    onSuccess: (res) => {
      onNotice('success', res.correction.status === 'pending' ? 'Reversal is waiting for a second approver.' : `Entry #${row?.id} reversed.`)
      invalidate(qc)
      onClose()
    },
    onError: (e) => { onNotice('danger', e instanceof Error ? e.message : 'The request failed.'); onClose() },
  })
  return (
    <ConfirmModal open={!!row} onClose={onClose} onConfirm={() => m.mutate()} loading={m.isPending} variant="danger"
      title="Reverse ledger entry" confirmLabel="Reverse entry" confirmDisabled={reason.trim().length < 5}
      message="Writes the opposite row and links it to this one. The original stays. An entry can be reversed only once."
      details={row ? [
        { label: 'Entry', value: <span className="mono">#{row.id}</span> },
        { label: 'User', value: row.user_username ?? '—' },
        { label: 'Amount', value: <SignedKES value={row.amount} /> },
        { label: 'Reversal', value: <SignedKES value={String(-Number(row.amount))} /> },
      ] : []}
      consequence="Refused if it would take the balance below zero. Large reversals wait for a second approver.">
      <Textarea label="Reason (kept in the ledger and audit log)" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} required />
    </ConfirmModal>
  )
}

export const REVERSIBLE = new Set(['deposit', 'payout', 'refund', 'adjustment'])
export { Undo2 as ReverseIcon }
