import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Users } from 'lucide-react'
import { StatusBadge, type BadgeTone } from '../StatusBadge'
import { Button } from '../ui/Button'
import { EmptyState } from '../ui/EmptyState'
import { ErrorState } from '../ui/ErrorState'
import { Textarea } from '../ui/Input'
import { Modal } from '../ui/Modal'
import { Skeleton } from '../ui/Skeleton'
import { formatKES } from '../../lib/format'
import { consoleApi } from './api'
import type { LinkEdgeRow, LinkedAccountsResponse, LinkPair, LinkStrength } from './linkageTypes'
import { SectionTitle, Timestamp } from './shared'
import { formatDay } from './utils'

const STRENGTH_TONE: Record<LinkStrength, BadgeTone> = { strong: 'danger', medium: 'warning', weak: 'neutral' }
const STRENGTH_LABEL: Record<LinkStrength, string> = { strong: 'Strong', medium: 'Medium', weak: 'Weak (context)' }
const NOTE_MIN = 5

function pairKey(a: number, b: number) {
  return a < b ? `${a}-${b}` : `${b}-${a}`
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : 'The request failed.'
}

function PairStatus({ pair }: { pair: LinkPair | undefined }) {
  if (!pair) return <StatusBadge size="sm" tone="neutral" label="Via cluster" />
  if (pair.household) return <StatusBadge size="sm" tone="info" label="Known household" />
  if (pair.linked) return <StatusBadge size="sm" tone={pair.strong ? 'danger' : 'warning'} label={pair.strong ? 'Linked · strong' : 'Linked · combined'} />
  return <StatusBadge size="sm" tone="neutral" label="Context only" />
}

function EdgeItem({ e }: { e: LinkEdgeRow }) {
  return (
    <li className="py-2">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge size="sm" tone={STRENGTH_TONE[e.strength]} label={STRENGTH_LABEL[e.strength]} />
        <span className="text-sm font-medium text-ink-primary">{e.label}</span>
        {e.household && <StatusBadge size="sm" tone="info" label="Household" />}
        {!e.active && <StatusBadge size="sm" tone="neutral" label="No longer seen" />}
      </div>
      {e.explanation && <p className="mt-1 text-sm text-ink-secondary">{e.explanation}</p>}
      <p className="mt-0.5 text-2xs text-ink-muted">
        Detected <Timestamp value={e.first_detected_at} />
        {e.evidence_last_at && <> · last evidence <Timestamp value={e.evidence_last_at} /></>}
        {' '}· weight <span className="num">{e.weight.toFixed(2)}</span>
      </p>
    </li>
  )
}

function HouseholdModal({ data, userId, onClose }: { data: LinkedAccountsResponse; userId: number; onClose: () => void }) {
  const qc = useQueryClient()
  const linkedToUser = useMemo(() => {
    const ids = new Set<number>([userId])
    for (const p of data.pairs) {
      if (!p.linked || p.household) continue
      if (p.user_a === userId) ids.add(p.user_b)
      if (p.user_b === userId) ids.add(p.user_a)
    }
    return ids
  }, [data, userId])
  const [selected, setSelected] = useState<Set<number>>(linkedToUser)
  const [note, setNote] = useState('')
  const m = useMutation({
    mutationFn: () => consoleApi.markHousehold([...selected], note.trim()),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'user-linkage'] })
      void qc.invalidateQueries({ queryKey: ['admin', 'user-timeline'] })
      onClose()
    },
  })
  const toggle = (id: number) => {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelected(next)
  }
  const valid = selected.size >= 2 && note.trim().length >= NOTE_MIN
  return (
    <Modal
      open
      onClose={onClose}
      dismissible={!m.isPending}
      title="Mark as a known household"
      description="Use this when the accounts belong to one family or home that shares a phone or an M-Pesa number. Future payouts will not be held because of the links between these accounts. Links to any other account still count. The decision is kept in the audit log."
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose} disabled={m.isPending}>Cancel</Button>
          <Button size="sm" onClick={() => m.mutate()} disabled={!valid} loading={m.isPending} loadingText="Saving">Mark household</Button>
        </>
      }
    >
      <fieldset className="space-y-1.5">
        <legend className="mb-1 text-xs font-medium text-ink-secondary">Accounts in the household</legend>
        {data.accounts.map((a) => (
          <label key={a.user_id} className="flex items-center gap-2 text-sm text-ink-primary">
            <input type="checkbox" checked={selected.has(a.user_id)} onChange={() => toggle(a.user_id)} />
            <span>{a.username}</span>
            <span className="text-xs text-ink-muted">#{a.user_id} · joined {formatDay(a.joined, true)}</span>
          </label>
        ))}
      </fieldset>
      <Textarea
        containerClassName="mt-3"
        label="Why (kept in the audit log)"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={2}
        maxLength={1000}
        required
        placeholder="For example: mother and son, confirmed by phone call"
      />
      {m.isError && <p role="alert" className="mt-2 text-sm text-danger">{describeError(m.error)}</p>}
    </Modal>
  )
}

function RevokeModal({ markId, names, onClose }: { markId: number; names: string; onClose: () => void }) {
  const qc = useQueryClient()
  const [note, setNote] = useState('')
  const m = useMutation({
    mutationFn: () => consoleApi.revokeHousehold(markId, note.trim()),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'user-linkage'] })
      void qc.invalidateQueries({ queryKey: ['admin', 'user-timeline'] })
      onClose()
    },
  })
  return (
    <Modal
      open
      onClose={onClose}
      dismissible={!m.isPending}
      title="Remove household mark"
      description={`Links between ${names} will count toward payout holds again.`}
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose} disabled={m.isPending}>Cancel</Button>
          <Button variant="danger" size="sm" onClick={() => m.mutate()} disabled={note.trim().length < NOTE_MIN} loading={m.isPending} loadingText="Removing">Remove mark</Button>
        </>
      }
    >
      <Textarea label="Why (kept in the audit log)" value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={1000} required />
      {m.isError && <p role="alert" className="mt-2 text-sm text-danger">{describeError(m.error)}</p>}
    </Modal>
  )
}

/**
 * "Linked accounts" for the user drawer: the account's cluster, how each account is
 * connected (with the evidence), known-household marks and linked payout holds.
 * Links only hold payouts for review; nothing here bans or changes steps.
 */
export function LinkedAccountsPanel({ userId }: { userId: number }) {
  const q = useQuery({
    queryKey: ['admin', 'user-linkage', userId],
    queryFn: () => consoleApi.linkedAccounts(userId),
    staleTime: 60_000,
  })
  const [markOpen, setMarkOpen] = useState(false)
  const [revoke, setRevoke] = useState<{ id: number; names: string } | null>(null)
  const d = q.data

  const names = useMemo(() => new Map((d?.accounts ?? []).map((a) => [a.user_id, a.username])), [d])
  const pairs = useMemo(() => new Map((d?.pairs ?? []).map((p) => [pairKey(p.user_a, p.user_b), p])), [d])
  const edgeGroups = useMemo(() => {
    const groups = new Map<string, LinkEdgeRow[]>()
    for (const e of d?.edges ?? []) {
      const k = pairKey(e.user_a, e.user_b)
      groups.set(k, [...(groups.get(k) ?? []), e])
    }
    return [...groups.entries()].sort((a, b) => {
      const pa = pairs.get(a[0])
      const pb = pairs.get(b[0])
      return (Number(pb?.linked ?? 0) - Number(pa?.linked ?? 0)) || ((pb?.score ?? 0) - (pa?.score ?? 0))
    })
  }, [d, pairs])
  const others = (d?.accounts ?? []).filter((a) => a.user_id !== userId)
  const activeMarks = (d?.households ?? []).filter((h) => h.active)

  return (
    <section aria-labelledby="linked-accounts-title">
      <SectionTitle
        aside={
          <span className="flex items-center gap-2">
            {d?.last_run && <span className="text-xs text-ink-muted">Graph updated <Timestamp value={d.last_run.finished_at} /></span>}
            {d && others.length > 0 && <Button size="sm" variant="secondary" onClick={() => setMarkOpen(true)}>Mark known household</Button>}
          </span>
        }
      >
        <span id="linked-accounts-title">Linked accounts</span>
      </SectionTitle>
      {q.isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : q.isError ? (
        <ErrorState variant="inline" error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />
      ) : !d || others.length === 0 ? (
        <EmptyState
          size="compact"
          icon={Users}
          title="No linked accounts"
          description="No other account shares a phone, payout number, network or activity pattern with this one."
        />
      ) : (
        <div className="space-y-3">
          <div className="rounded-md border border-surface-border px-3 py-3">
            {d.cluster ? (
              <p className="text-sm text-ink-primary">
                In a group of <span className="num font-medium">{d.cluster.size}</span> linked accounts
                {' '}(<span className="num">{d.cluster.strong_pairs}</span> strong, <span className="num">{d.cluster.medium_pairs}</span> combined links).
                {' '}When several of them win the same paid challenge, only the first-registered account is paid straight away.
              </p>
            ) : (
              <p className="text-sm text-ink-primary">Not in a linked group: the connections below are context only, or marked as a household.</p>
            )}
            <p className="mt-1 text-2xs text-ink-muted">{d.policy_note}</p>
          </div>

          <ul className="divide-y divide-surface-border rounded-md border border-surface-border" aria-label="Accounts">
            {d.accounts.map((a) => {
              const pair = a.user_id === userId ? undefined : pairs.get(pairKey(a.user_id, userId))
              return (
                <li key={a.user_id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-ink-primary">
                      {a.username} <span className="text-xs font-normal text-ink-muted">#{a.user_id}</span>
                      {a.user_id === userId && <span className="ml-2 text-xs font-normal text-ink-muted">this account</span>}
                    </p>
                    <p className="text-2xs text-ink-muted">
                      Joined {formatDay(a.joined, true)}
                      {a.trust_status && <> · trust {a.trust_status}</>}
                      {!a.is_active && <> · inactive</>}
                      {a.cluster && d.cluster && a.cluster === d.cluster.key && <> · same group</>}
                    </p>
                  </div>
                  {a.user_id !== userId && <PairStatus pair={pair} />}
                </li>
              )
            })}
          </ul>

          <div>
            <p className="mb-1 text-xs font-medium text-ink-secondary">Evidence by pair</p>
            <ul className="space-y-2">
              {edgeGroups.map(([k, edges]) => {
                const [a, b] = k.split('-').map(Number)
                return (
                  <li key={k} className="rounded-md border border-surface-border px-3 py-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-sm font-medium text-ink-primary">{names.get(a) ?? `#${a}`} and {names.get(b) ?? `#${b}`}</span>
                      <PairStatus pair={pairs.get(k)} />
                    </div>
                    <ul className="divide-y divide-surface-border">
                      {edges.map((e) => <EdgeItem key={e.id} e={e} />)}
                    </ul>
                  </li>
                )
              })}
            </ul>
          </div>

          {activeMarks.length > 0 && (
            <div>
              <p className="mb-1 text-xs font-medium text-ink-secondary">Known households</p>
              <ul className="divide-y divide-surface-border rounded-md border border-surface-border">
                {activeMarks.map((h) => {
                  const pairNames = h.usernames.map((n, i) => n ?? `#${i ? h.user_b : h.user_a}`).join(' and ')
                  return (
                    <li key={h.id} className="flex flex-wrap items-start justify-between gap-2 px-3 py-2">
                      <div className="min-w-0">
                        <p className="text-sm text-ink-primary">{pairNames}</p>
                        <p className="text-xs text-ink-secondary">{h.note}</p>
                        <p className="text-2xs text-ink-muted">By {h.created_by ?? 'unknown'} · <Timestamp value={h.created_at} /></p>
                      </div>
                      <Button size="sm" variant="ghost" onClick={() => setRevoke({ id: h.id, names: pairNames })}>Remove</Button>
                    </li>
                  )
                })}
              </ul>
            </div>
          )}

          {d.holds.length > 0 && (
            <div>
              <p className="mb-1 text-xs font-medium text-ink-secondary">Payout holds in this group</p>
              <ul className="divide-y divide-surface-border rounded-md border border-surface-border">
                {d.holds.map((h) => (
                  <li key={h.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                    <span className="min-w-0 text-ink-primary">
                      {h.username} · {h.challenge_name} · <span className="num">{formatKES(h.amount)}</span>
                    </span>
                    <span className="flex items-center gap-2">
                      {h.linked_reason && <StatusBadge size="sm" tone="warning" label="Linked accounts" />}
                      <StatusBadge size="sm" tone={h.status === 'held' ? 'warning' : h.status === 'released' ? 'success' : 'neutral'} label={h.status} />
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      {markOpen && d && <HouseholdModal data={d} userId={userId} onClose={() => setMarkOpen(false)} />}
      {revoke && <RevokeModal markId={revoke.id} names={revoke.names} onClose={() => setRevoke(null)} />}
    </section>
  )
}
