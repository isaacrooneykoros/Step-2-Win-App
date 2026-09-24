import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Pencil, Star, StarOff, Trash2, Trophy, X } from 'lucide-react'
import { SlideOver } from '../SlideOver'
import { StatusBadge } from '../StatusBadge'
import { DetailRow } from '../DetailRow'
import { ConfirmModal } from '../ConfirmModal'
import { Modal } from '../ui/Modal'
import { Button } from '../ui/Button'
import { Input, Select, Textarea } from '../ui/Input'
import { EmptyState } from '../ui/EmptyState'
import { ErrorState } from '../ui/ErrorState'
import { Skeleton } from '../ui/Skeleton'
import { formatKES, formatNumber } from '../../lib/format'
import { cn } from '../../lib/cn'
import { ApiError, consoleApi } from './api'
import type { ChallengeRow } from './types'
import { ActionNotice, ChangeList, Figure, SectionTitle, Timestamp } from './shared'
import { challengeStatusLabel, formatDay, humanize, MILESTONES, type ChallengeAction } from './utils'


/** Challenge record: money, participants leaderboard, timeline and every supported admin action. */
export function ChallengeDrawer({ challengeId, onClose, initialAction }: { challengeId: number | null; onClose: () => void; initialAction?: ChallengeAction | null }) {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [action, setAction] = useState<ChallengeAction | null>(initialAction ?? null)
  const [notice, setNotice] = useState<string | null>(null)
  const q = useQuery({
    queryKey: ['admin', 'challenge-results', challengeId],
    queryFn: () => consoleApi.challengeResults(challengeId as number),
    enabled: challengeId !== null,
  })
  const c = q.data?.challenge
  const results = q.data?.results ?? []

  const done = (msg: string, closeAfter = false) => {
    setAction(null)
    void qc.invalidateQueries({ queryKey: ['admin', 'challenges'] })
    void qc.invalidateQueries({ queryKey: ['admin', 'challenge-stats'] })
    if (closeAfter) { onClose(); return }
    setNotice(msg)
    void q.refetch()
  }

  const qualified = results.filter((r) => r.qualified).length
  const paid = results.reduce((s, r) => s + Number(r.payout || 0), 0)
  const canFeature = c && !c.is_private && (c.status === 'pending' || c.status === 'active')

  return (
    <SlideOver
      open={challengeId !== null}
      onClose={onClose}
      width={680}
      title={c?.name ?? 'Challenge'}
      subtitle={c ? `#${c.id} · created by ${c.created_by_username} · ${formatDay(c.created_at, true)}` : undefined}
      headerAside={c && (
        <span className="flex flex-wrap items-center gap-1.5">
          <StatusBadge size="sm" status={c.status === 'active' ? 'live' : c.status} label={challengeStatusLabel(c.status)} />
          {c.is_featured && <StatusBadge size="sm" tone="info" label="Featured" />}
        </span>
      )}
      footer={c && (
        <>
          {c.status === 'pending' && (
            <>
              <Button size="sm" variant="secondary" leftIcon={<Pencil size={13} />} onClick={() => setAction('edit')}>Edit</Button>
              <Button size="sm" variant="danger-soft" leftIcon={<X size={13} />} onClick={() => setAction('reject')}>Reject</Button>
              <Button size="sm" variant="primary" leftIcon={<Check size={13} />} onClick={() => setAction('approve')}>Approve</Button>
            </>
          )}
          {canFeature && (
            <Button size="sm" variant="secondary" leftIcon={c.is_featured ? <StarOff size={13} /> : <Star size={13} />} onClick={() => setAction(c.is_featured ? 'unfeature' : 'feature')}>
              {c.is_featured ? 'Unfeature' : 'Feature'}
            </Button>
          )}
          {c.status === 'active' && <Button size="sm" variant="danger-soft" onClick={() => setAction('cancel')}>Cancel challenge</Button>}
          {c.status === 'cancelled' && (
            <Button size="sm" variant="danger-soft" leftIcon={<Trash2 size={13} />} onClick={() => setAction('delete')}>Delete</Button>
          )}
        </>
      )}
    >
      {q.isLoading ? (
        <div className="space-y-3" aria-hidden>
          <div className="grid grid-cols-3 gap-2">{[0, 1, 2].map((i) => <Skeleton key={i} height={64} />)}</div>
          {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} height={18} />)}
        </div>
      ) : q.error || !c ? (
        <ErrorState title="Could not load this challenge" error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <div className="space-y-4">
          {notice && <ActionNotice tone="success" onDismiss={() => setNotice(null)}>{notice}</ActionNotice>}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Figure label="Pool" value={formatKES(c.total_pool)} hint={`${formatNumber(c.current_entries)} × ${formatKES(c.entry_fee)}`} />
            <Figure label="Platform fee" value={formatKES(c.platform_fee)} hint="Current fee setting" />
            <Figure label="Net to winners" value={formatKES(c.net_pool)} hint={humanize(c.win_condition)} />
            <Figure label={c.status === 'completed' ? 'Paid out' : 'Qualified so far'}
              value={c.status === 'completed' ? formatKES(paid) : `${qualified} of ${results.length}`}
              hint={`Milestone ${formatNumber(c.milestone)} steps`} />
          </div>

          <div>
            <SectionTitle>Details</SectionTitle>
            <div className="grid gap-x-6 sm:grid-cols-2">
              <div>
                <DetailRow label="Entry fee" value={formatKES(c.entry_fee)} mono />
                <DetailRow label="Participants" value={`${formatNumber(c.current_entries)} of ${formatNumber(c.max_participants)}`} />
                <DetailRow label="Visibility" value={c.is_private ? 'Private (invite code)' : 'Public'} />
                <DetailRow label="Invite code" value={c.invite_code} mono />
              </div>
              <div>
                <DetailRow label="Starts" value={formatDay(c.start_date, true)} />
                <DetailRow label="Ends" value={formatDay(c.end_date, true)} />
                <DetailRow label="Payout" value={humanize(c.payout_structure)} />
                <DetailRow label="Platform challenge" value={c.is_platform_challenge ? `Yes · bonus ${formatKES(c.platform_bonus_kes)}` : 'No'} />
              </div>
            </div>
            {c.description && <p className="mt-2 text-sm text-ink-secondary">{c.description}</p>}
          </div>

          <div>
            <SectionTitle aside={<span className="text-xs text-ink-muted">Ranked by steps</span>}>Participants</SectionTitle>
            {results.length === 0 ? (
              <EmptyState size="compact" icon={Trophy} title="No participants yet" />
            ) : (
              <div className="max-h-80 overflow-auto rounded-md border border-surface-border">
                <table className="w-full text-sm">
                  <caption className="sr-only">Participants leaderboard</caption>
                  <thead>
                    <tr className="text-left text-xs text-ink-muted">
                      <th scope="col" className="sticky top-0 border-b border-surface-border bg-surface-overlay px-3 py-2 text-right font-medium">#</th>
                      <th scope="col" className="sticky top-0 border-b border-surface-border bg-surface-overlay px-3 py-2 font-medium">User</th>
                      <th scope="col" className="sticky top-0 border-b border-surface-border bg-surface-overlay px-3 py-2 text-right font-medium">Steps</th>
                      <th scope="col" className="sticky top-0 border-b border-surface-border bg-surface-overlay px-3 py-2 font-medium">Milestone</th>
                      <th scope="col" className="sticky top-0 border-b border-surface-border bg-surface-overlay px-3 py-2 text-right font-medium">Payout</th>
                    </tr>
                  </thead>
                  <tbody>
                    {results.map((r) => {
                      const pct = c.milestone ? Math.min(100, (r.steps / c.milestone) * 100) : 0
                      return (
                        <tr key={r.user_id} className="border-b border-surface-border last:border-b-0">
                          <td className="num px-3 py-1.5 text-right text-ink-muted">{r.position}</td>
                          <td className="px-3 py-1.5">
                            <button type="button" className="font-medium text-ink-primary hover:text-brand-text hover:underline" onClick={() => navigate(`/users?user=${r.user_id}`)}>
                              {r.user}
                            </button>
                          </td>
                          <td className="num px-3 py-1.5 text-right">{formatNumber(r.steps)}</td>
                          <td className="px-3 py-1.5">
                            <span className="flex items-center gap-2">
                              <span className="h-1.5 w-16 overflow-hidden rounded-sm bg-surface-elevated" aria-hidden>
                                <span className={cn('block h-full rounded-sm', r.qualified ? 'bg-success' : 'bg-ink-muted')} style={{ width: `${pct}%` }} />
                              </span>
                              <span className={cn('text-xs', r.qualified ? 'font-medium text-success' : 'text-ink-muted')}>
                                {r.qualified ? 'Qualified' : `${Math.round(pct)}%`}
                              </span>
                            </span>
                          </td>
                          <td className="mono px-3 py-1.5 text-right text-[13px]">{Number(r.payout) > 0 ? formatKES(r.payout) : '—'}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div>
            <SectionTitle>Timeline</SectionTitle>
            <ol className="relative border-l border-surface-border pl-4">
              {[
                ...((q.data?.audit ?? []).map((a) => ({ key: `a${a.id}`, at: a.created_at, title: a.description, by: a.admin_username, changes: a.changes }))),
                { key: 'created', at: c.created_at, title: `Created by ${c.created_by_username}`, by: null, changes: null },
              ].sort((a, b) => (a.at < b.at ? 1 : -1)).map((e) => (
                <li key={e.key} className="relative pb-3 last:pb-0">
                  <span className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full border border-surface-strong bg-surface-card" aria-hidden />
                  <p className="text-sm text-ink-primary">{e.title}</p>
                  <p className="text-xs text-ink-muted">{e.by ? <>by <span className="font-medium text-ink-secondary">{e.by}</span> · </> : null}<Timestamp value={e.at} exact /></p>
                  {e.changes && <div className="mt-1 max-w-md"><ChangeList changes={e.changes} /></div>}
                </li>
              ))}
            </ol>
          </div>
        </div>
      )}

      {c && action && <ChallengeActions key={action} challenge={c} action={action} onClose={() => setAction(null)} onDone={done} />}
    </SlideOver>
  )
}

function ChallengeActions({ challenge: c, action, onClose, onDone }: {
  challenge: ChallengeRow; action: ChallengeAction; onClose: () => void; onDone: (msg: string, closeAfter?: boolean) => void
}) {
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [form, setForm] = useState({ name: c.name, milestone: String(c.milestone), max_participants: String(c.max_participants), end_date: c.end_date })
  const [fields, setFields] = useState<Record<string, string>>({})
  const m = useMutation({
    mutationFn: async (): Promise<[string, boolean?]> => {
      switch (action) {
        case 'approve': await consoleApi.approveChallenge(c.id); return [`${c.name} is live.`]
        case 'reject': await consoleApi.rejectChallenge(c.id, reason.trim()); return [paidEntries ? `${c.name} was rejected and entries refunded.` : `${c.name} was rejected.`]
        case 'cancel': await consoleApi.cancelChallenge(c.id, reason.trim()); return [`${c.name} was cancelled.`]
        case 'feature': await consoleApi.setFeatured(c.id, true); return [`${c.name} is featured in discovery.`]
        case 'unfeature': await consoleApi.setFeatured(c.id, false); return [`${c.name} is no longer featured.`]
        case 'delete': await consoleApi.deleteChallenge(c.id); return [`${c.name} was deleted.`, true]
        case 'edit':
          await consoleApi.updateChallenge(c.id, {
            name: form.name.trim(), milestone: Number(form.milestone), max_participants: Number(form.max_participants), end_date: form.end_date,
          })
          return ['Challenge details saved.']
      }
    },
    onSuccess: ([msg, closeAfter]) => onDone(msg, closeAfter),
    onError: (e) => {
      setError(e instanceof Error ? e.message : 'Request failed')
      if (e instanceof ApiError) setFields(e.fields)
    },
  })
  const loading = m.isPending
  const run = () => m.mutate()
  const errorLine = error ? <p role="alert" className="text-sm text-danger">{error}</p> : null
  const paidEntries = Number(c.entry_fee) > 0 && c.current_entries > 0
  const details = [
    { label: 'Challenge', value: c.name },
    { label: 'Participants', value: <span className="num">{formatNumber(c.current_entries)}</span> },
    { label: 'Pool', value: <span className="mono">{formatKES(c.total_pool)}</span> },
  ]
  const refundWarning = paidEntries ? (
    <p className="rounded-md border border-warning-line bg-warning-soft px-3 py-2 text-xs text-warning">
      Every entry is refunded: {formatKES(c.total_pool)} goes back to {c.current_entries} participant
      {c.current_entries === 1 ? "'s wallet" : "s' wallets"}, each with a refund entry in their transaction history.
    </p>
  ) : null

  switch (action) {
    case 'approve':
      return (
        <ConfirmModal open onClose={onClose} onConfirm={run} loading={loading} variant="info" title="Approve challenge" confirmLabel="Approve and go live"
          message={`The challenge becomes live and ${c.is_private ? 'joinable with its invite code' : 'visible in public discovery'}.`}
          details={[...details, { label: 'Runs', value: `${formatDay(c.start_date)} – ${formatDay(c.end_date)}` }, { label: 'Milestone', value: `${formatNumber(c.milestone)} steps` }]}>
          {errorLine}
        </ConfirmModal>
      )
    case 'reject':
      return (
        <ConfirmModal open onClose={onClose} onConfirm={run} loading={loading} variant="danger" title="Reject challenge" confirmLabel="Reject challenge"
          confirmDisabled={!reason.trim()} confirmText={paidEntries ? 'REJECT' : undefined}
          message="The challenge is closed as cancelled and never goes live." details={details}
          consequence={paidEntries ? `Every entry (${formatKES(c.total_pool)} in total) is refunded to the participants' wallets.` : undefined}>
          <Textarea label="Reason (kept in the audit log)" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={500} required />
          {errorLine}
        </ConfirmModal>
      )
    case 'cancel':
      return (
        <ConfirmModal open onClose={onClose} onConfirm={run} loading={loading} variant="danger" title="Cancel live challenge" confirmLabel="Cancel challenge"
          confirmDisabled={!reason.trim()} confirmText={paidEntries ? 'CANCEL' : undefined}
          message="Step counting stops and the challenge will not be finalised or paid out." details={details}
          consequence="This cannot be undone.">
          {refundWarning}
          <Textarea label="Reason (kept in the audit log)" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={500} required />
          {errorLine}
        </ConfirmModal>
      )
    case 'feature':
    case 'unfeature':
      return (
        <ConfirmModal open onClose={onClose} onConfirm={run} loading={loading} variant="info"
          title={action === 'feature' ? 'Feature challenge' : 'Remove from featured'} confirmLabel={action === 'feature' ? 'Feature' : 'Unfeature'}
          message={action === 'feature' ? 'Shows this challenge in the featured section of public discovery.' : 'The challenge stays public but drops out of the featured section.'}
          details={details.slice(0, 2)}>
          {errorLine}
        </ConfirmModal>
      )
    case 'delete':
      return (
        <ConfirmModal open onClose={onClose} onConfirm={run} loading={loading} variant="danger" title="Delete challenge permanently" confirmLabel="Delete"
          confirmText={c.current_entries > 0 ? 'DELETE' : undefined}
          message="Removes the cancelled challenge and its participant rows from the database." details={details} consequence="This cannot be undone.">
          {errorLine}
        </ConfirmModal>
      )
    case 'edit':
      return (
        <Modal open onClose={loading ? () => undefined : onClose} dismissible={!loading} size="sm" title="Edit challenge"
          description="Only challenges awaiting approval can be edited. Changes are saved immediately."
          footer={<>
            <Button variant="secondary" onClick={onClose} disabled={loading}>Cancel</Button>
            <Button variant="primary" onClick={run} loading={loading} disabled={!form.name.trim() || Number(form.max_participants) < c.current_entries}>Save changes</Button>
          </>}>
          <div className="space-y-3">
            <Input label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} error={fields.name} maxLength={200} />
            <Select label="Milestone" value={form.milestone} onChange={(e) => setForm({ ...form, milestone: e.target.value })} error={fields.milestone}>
              {MILESTONES.map((ms) => <option key={ms} value={ms}>{formatNumber(ms)} steps</option>)}
            </Select>
            <div className="grid grid-cols-2 gap-3">
              <Input label="Max participants" type="number" min={Math.max(2, c.current_entries)} value={form.max_participants}
                onChange={(e) => setForm({ ...form, max_participants: e.target.value })}
                error={fields.max_participants ?? (Number(form.max_participants) < c.current_entries ? `At least ${c.current_entries} (already joined)` : undefined)} />
              <Input label="End date" type="date" min={c.start_date} value={form.end_date} onChange={(e) => setForm({ ...form, end_date: e.target.value })} error={fields.end_date} />
            </div>
            {errorLine}
          </div>
        </Modal>
      )
  }
}
