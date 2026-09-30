/** Tools for a withdrawal stuck in approved / processing, plus its change history. */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, RotateCcw, SearchCheck } from 'lucide-react'
import { Button } from '../ui/Button'
import { Input, Textarea } from '../ui/Input'
import { ConfirmModal } from '../ConfirmModal'
import { consoleApi } from '../users/api'
import { ActionNotice, ChangeList, Timestamp } from '../users/shared'
import { formatKES } from '../../lib/format'
import { usePermissions } from '../../lib/permissions'
import { Section } from './ui'

export function StuckWithdrawalTools({ id, status, amount, username }: { id: string; status: string; amount: string; username: string }) {
  const qc = useQueryClient()
  const { can } = usePermissions()
  const [resolve, setResolve] = useState<'paid' | 'failed' | null>(null)
  const [reason, setReason] = useState('')
  const [ref, setRef] = useState('')
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null)
  const stuck = status === 'approved' || status === 'processing'
  const check = useMutation({
    mutationFn: () => consoleApi.checkWithdrawalStatus(id),
    onSuccess: (res) => {
      const r = (res.result ?? {}) as { status?: string; transactions?: Array<{ status?: string; mpesa_reference?: string; failed_reason?: string }> }
      const t = r.transactions?.[0]
      setNotice({ tone: 'success', text: `IntaSend says: ${r.status ?? 'unknown'}${t?.mpesa_reference ? ` · M-Pesa ${t.mpesa_reference}` : ''}${t?.failed_reason ? ` · ${t.failed_reason}` : ''}` })
      if (t?.mpesa_reference) setRef(t.mpesa_reference)
    },
    onError: (e) => setNotice({ tone: 'danger', text: e instanceof Error ? e.message : 'Status check failed.' }),
  })
  const m = useMutation({
    mutationFn: () => consoleApi.resolveWithdrawal(id, { outcome: resolve!, reason: reason.trim(), mpesa_reference: ref.trim() || undefined }),
    onSuccess: () => {
      setNotice({ tone: 'success', text: resolve === 'paid' ? 'Marked as paid.' : `Marked as failed; ${formatKES(amount)} was refunded to the wallet.` })
      setResolve(null); setReason('')
      void qc.invalidateQueries({ queryKey: ['admin', 'finance'] })
      void qc.invalidateQueries({ queryKey: ['admin', 'withdrawal-history', id] })
    },
    onError: (e) => { setResolve(null); setNotice({ tone: 'danger', text: e instanceof Error ? e.message : 'Could not resolve.' }) },
  })
  const hist = useQuery({ queryKey: ['admin', 'withdrawal-history', id], queryFn: () => consoleApi.withdrawalHistory(id) })

  return (
    <>
      {notice && <ActionNotice tone={notice.tone} onDismiss={() => setNotice(null)}>{notice.text}</ActionNotice>}
      {stuck && can('finance.withdrawals') && (
        <Section title="Stuck with the gateway?">
          <div className="space-y-2 rounded-md border border-warning-line bg-warning-soft px-3 py-3">
            <p className="text-sm text-ink-primary">If the payout result never arrived, check with IntaSend, then resolve it.</p>
            <div className="flex flex-wrap gap-1.5">
              <Button size="sm" variant="secondary" leftIcon={<SearchCheck size={13} />} loading={check.isPending} onClick={() => check.mutate()}>Check with IntaSend</Button>
              <Button size="sm" variant="secondary" leftIcon={<CheckCircle2 size={13} />} onClick={() => setResolve('paid')}>Mark paid</Button>
              <Button size="sm" variant="danger-soft" leftIcon={<RotateCcw size={13} />} onClick={() => setResolve('failed')}>Mark failed and refund</Button>
            </div>
          </div>
        </Section>
      )}
      <Section title="Change history">
        {hist.isLoading ? <p className="text-sm text-ink-muted">Loading…</p> : !hist.data || (hist.data.history.length === 0 && hist.data.audit.length === 0) ? (
          <p className="text-sm text-ink-muted">No changes recorded.</p>
        ) : (
          <ul className="space-y-2">
            {hist.data.audit.map((a) => <li key={`a${a.id}`} className="text-sm text-ink-primary">{a.description} <span className="text-xs text-ink-muted">· {a.admin_username} · <Timestamp value={a.created_at} /></span></li>)}
            {hist.data.history.map((h) => (
              <li key={`h${h.id}`} className="text-xs">
                <p className="text-ink-muted">{h.action} by {h.actor ?? 'system'} · <Timestamp value={h.timestamp} /></p>
                <ChangeList changes={Object.fromEntries(Object.entries(h.changes ?? {}).map(([k, v]) => [k, Array.isArray(v) ? { old: v[0] === 'None' ? null : v[0], new: v[1] === 'None' ? null : v[1] } : v]))} />
              </li>
            ))}
          </ul>
        )}
      </Section>
      <ConfirmModal open={!!resolve} onClose={() => setResolve(null)} onConfirm={() => m.mutate()} loading={m.isPending}
        variant={resolve === 'paid' ? 'warning' : 'danger'}
        title={resolve === 'paid' ? 'Mark withdrawal as paid' : 'Mark withdrawal as failed'}
        confirmLabel={resolve === 'paid' ? 'Mark paid' : 'Mark failed and refund'} confirmDisabled={reason.trim().length < 5}
        message={resolve === 'paid'
          ? 'Use only when IntaSend or the M-Pesa statement confirms the money reached the user. Nothing is refunded.'
          : `The full ${formatKES(amount)} goes back to ${username}'s wallet through the normal payout-failure refund (once).`}
        details={[{ label: 'User', value: username }, { label: 'Amount', value: formatKES(amount) }, { label: 'Status now', value: status }]}
        consequence="The user gets an in-app notice. Recorded in the audit log.">
        {resolve === 'paid' && <Input label="M-Pesa receipt (optional)" className="mono" value={ref} onChange={(e) => setRef(e.target.value)} />}
        <Textarea label="Reason (kept in the audit log)" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} required />
      </ConfirmModal>
    </>
  )
}
