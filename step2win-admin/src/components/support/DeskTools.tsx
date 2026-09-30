/**
 * Support desk tools: open a ticket to a customer (outbound), manage tags
 * (rename / delete), and bulk actions on the current queue page (assign,
 * close, resolve, reopen, merge duplicates from the same customer).
 * Every action is audited server-side.
 */
import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, GitMerge, Pencil, Send, Trash2, X } from 'lucide-react'
import { Modal } from '../ui/Modal'
import { Button, IconButton } from '../ui/Button'
import { Input, SearchInput, Select, Textarea } from '../ui/Input'
import { EmptyState } from '../ui/EmptyState'
import { ErrorState } from '../ui/ErrorState'
import { ConfirmModal } from '../ConfirmModal'
import { StatusBadge } from '../StatusBadge'
import { consoleApi } from '../users/api'
import { consoleB } from '../consoleb/api'
import { supportApi, type QueueTicket, type TicketCategory, type TicketPriority } from './api'
import { TAGS_KEY, useTags } from './queries'
import { CATEGORY_LABEL, PRIORITY_LABEL, STATUS_LABEL, STATUS_TONE } from './meta'
import { useDebounced } from '../finance/hooks'
import { ApiError } from '../system/http'
import { cn } from '../../lib/cn'
import { formatNumber } from '../../lib/format'
import { errorMessage } from '../../lib/errors'
import type { SupportAdminUser } from '../../types/admin'

// ── Outbound ticket ─────────────────────────────────────────────────────────

export function OutboundTicketModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: number) => void }) {
  const [search, setSearch] = useState('')
  const [user, setUser] = useState<{ id: number; username: string; email?: string } | null>(null)
  const [subject, setSubject] = useState('')
  const [message, setMessage] = useState('')
  const [category, setCategory] = useState<TicketCategory>('general')
  const [priority, setPriority] = useState<TicketPriority>('medium')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const q = useDebounced(search.trim(), 300)
  const users = useQuery({
    queryKey: ['admin', 'users', 'outbound-picker', q],
    queryFn: () => consoleApi.listUsers({ page: 1, page_size: 6, search: q }),
    enabled: open && !user && q.length >= 2,
  })
  const reset = () => { setSearch(''); setUser(null); setSubject(''); setMessage(''); setErrors({}); setCategory('general'); setPriority('medium') }
  const send = useMutation({
    mutationFn: () => consoleB.outboundTicket({ user_id: user!.id, subject: subject.trim(), message: message.trim(), category, priority }),
    onSuccess: (t) => { reset(); onCreated(t.id) },
    onError: (e) => setErrors(e instanceof ApiError ? { ...e.fields, _: e.message } : { _: errorMessage(e) ?? 'Not sent.' }),
  })
  const close = () => { if (!send.isPending) { reset(); onClose() } }
  return (
    <Modal open={open} onClose={close} dismissible={!send.isPending} size="lg" title="Message a customer"
      description="Opens a ticket in the customer’s in-app Support inbox, assigned to you and waiting on their reply."
      footer={<>
        <Button variant="secondary" onClick={close} disabled={send.isPending}>Cancel</Button>
        <Button variant="primary" leftIcon={<Send size={13} />} loading={send.isPending}
          disabled={!user || !subject.trim() || !message.trim()} onClick={() => send.mutate()}>Send</Button>
      </>}>
      <div className="space-y-3">
        {errors._ && <p role="alert" className="rounded-md border border-danger-line bg-danger-soft px-3 py-2 text-sm text-danger">{errors._}</p>}
        {user ? (
          <div className="flex items-center justify-between rounded-md border border-surface-border px-3 py-2">
            <span className="text-sm"><span className="font-medium text-ink-primary">{user.username}</span>{user.email && <span className="text-ink-muted"> · {user.email}</span>}</span>
            <Button size="sm" variant="ghost" onClick={() => setUser(null)}>Change</Button>
          </div>
        ) : (
          <div>
            <SearchInput size="sm" value={search} onChange={setSearch} placeholder="Find the customer by name, email or phone" containerClassName="sm:w-full" />
            {q.length >= 2 && (
              <div className="mt-2 rounded-md border border-surface-border">
                {users.isLoading ? <p className="px-3 py-2 text-xs text-ink-muted">Searching…</p>
                  : users.error ? <ErrorState size="compact" error={users.error} onRetry={() => void users.refetch()} />
                    : !users.data?.results.length ? <p className="px-3 py-2 text-xs text-ink-muted">No customers found.</p> : (
                      <ul className="divide-y divide-[var(--border)]">
                        {users.data.results.map((u) => (
                          <li key={u.id}>
                            <button type="button" className="flex w-full items-center justify-between px-3 py-1.5 text-left text-sm hover:bg-surface-elevated"
                              onClick={() => setUser({ id: u.id, username: u.username, email: u.email })}>
                              <span className="font-medium text-ink-primary">{u.username}</span>
                              <span className="text-xs text-ink-muted">{u.email}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
              </div>
            )}
            {errors.user_id && <p className="mt-1 text-xs text-danger">{errors.user_id}</p>}
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Select label="Category" value={category} onChange={(e) => setCategory(e.target.value as TicketCategory)}>
            {(Object.keys(CATEGORY_LABEL) as TicketCategory[]).map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
          </Select>
          <Select label="Priority" value={priority} onChange={(e) => setPriority(e.target.value as TicketPriority)}>
            {(Object.keys(PRIORITY_LABEL) as TicketPriority[]).map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
          </Select>
        </div>
        <Input label="Subject" value={subject} maxLength={255} onChange={(e) => setSubject(e.target.value)} error={errors.subject} />
        <Textarea label="Message" rows={6} maxLength={5000} value={message} onChange={(e) => setMessage(e.target.value)} error={errors.message}
          hint="The customer sees this in the app and can reply. Be kind and specific." />
      </div>
    </Modal>
  )
}

// ── Tags ────────────────────────────────────────────────────────────────────

export function TagManager() {
  const qc = useQueryClient()
  const tags = useTags()
  const [editing, setEditing] = useState<number | null>(null)
  const [name, setName] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [del, setDel] = useState<{ id: number; name: string; total: number } | null>(null)
  const done = () => { void qc.invalidateQueries({ queryKey: TAGS_KEY }); void qc.invalidateQueries({ queryKey: ['support', 'queue'] }) }
  const rename = useMutation({
    mutationFn: () => consoleB.renameTag(editing!, name.trim()),
    onSuccess: () => { setEditing(null); setErr(null); done() },
    onError: (e) => setErr(errorMessage(e)),
  })
  const remove = useMutation({
    mutationFn: (id: number) => supportApi.deleteTag(id),
    onSuccess: () => { setDel(null); done() },
    onError: (e) => { setDel(null); setErr(errorMessage(e)) },
  })
  const rows = tags.data?.results ?? []
  if (tags.isLoading) return <p className="text-sm text-ink-muted">Loading tags…</p>
  if (tags.error) return <ErrorState size="compact" error={tags.error} onRetry={() => void tags.refetch()} />
  if (!rows.length) return <EmptyState size="compact" title="No tags yet" description="Tags are created when you add them to a ticket." />
  return (
    <div className="space-y-2">
      {err && <p role="alert" className="text-sm text-danger">{err}</p>}
      <ul className="divide-y divide-[var(--border)] rounded-md border border-surface-border">
        {rows.map((t) => (
          <li key={t.id} className="flex items-center gap-2 px-3 py-1.5">
            {editing === t.id ? (
              <>
                <Input size="sm" aria-label={`New name for ${t.name}`} value={name} maxLength={40} onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') rename.mutate(); if (e.key === 'Escape') setEditing(null) }} containerClassName="flex-1" autoFocus />
                <IconButton size="sm" label="Save name" disabled={!name.trim() || rename.isPending} onClick={() => rename.mutate()}><Check size={13} /></IconButton>
                <IconButton size="sm" label="Cancel" onClick={() => setEditing(null)}><X size={13} /></IconButton>
              </>
            ) : (
              <>
                <span className="min-w-0 flex-1 truncate text-sm text-ink-primary">{t.name}</span>
                <span className="num text-xs text-ink-muted">{formatNumber(t.open_count)} open · {formatNumber(t.total_count)} total</span>
                <IconButton size="sm" label={`Rename ${t.name}`} onClick={() => { setEditing(t.id); setName(t.name); setErr(null) }}><Pencil size={13} /></IconButton>
                <IconButton size="sm" label={`Delete ${t.name}`} onClick={() => setDel({ id: t.id, name: t.name, total: t.total_count })}><Trash2 size={13} /></IconButton>
              </>
            )}
          </li>
        ))}
      </ul>
      <ConfirmModal open={!!del} onClose={() => setDel(null)} onConfirm={() => del && remove.mutate(del.id)} loading={remove.isPending}
        variant="warning" title="Delete tag" confirmLabel="Delete tag"
        message={`The tag is removed from ${formatNumber(del?.total ?? 0)} ticket(s). The tickets themselves are not changed.`}
        details={del ? [{ label: 'Tag', value: del.name }] : []} />
    </div>
  )
}

// ── Bulk actions + merge ─────────────────────────────────────────────────────

type BulkAction = 'assign' | 'unassign' | 'close' | 'resolve' | 'reopen'
const ACTION_LABEL: Record<BulkAction, string> = {
  assign: 'Assign', unassign: 'Unassign', close: 'Close', resolve: 'Mark resolved', reopen: 'Reopen',
}

export function BulkTickets({ rows, admins, onDone }: { rows: QueueTicket[]; admins: SupportAdminUser[]; onDone: (text: string) => void }) {
  const qc = useQueryClient()
  const [picked, setPicked] = useState<number[]>([])
  const [action, setAction] = useState<BulkAction>('assign')
  const [assignee, setAssignee] = useState('')
  const [confirm, setConfirm] = useState<'bulk' | 'merge' | null>(null)
  const [target, setTarget] = useState<number | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const selected = rows.filter((r) => picked.includes(r.id))
  const sameCustomer = selected.length >= 2 && selected.every((r) => r.user === selected[0].user)
  const oldest = useMemo(() => [...selected].sort((a, b) => a.created_at.localeCompare(b.created_at))[0], [selected])
  const mergeTarget = target && picked.includes(target) ? target : oldest?.id ?? null
  const refresh = () => { setPicked([]); void qc.invalidateQueries({ queryKey: ['support'] }) }

  const bulk = useMutation({
    mutationFn: () => consoleB.bulkTickets(picked, action, action === 'assign' ? Number(assignee) : undefined),
    onSuccess: (r) => { setConfirm(null); onDone(`${ACTION_LABEL[action]}: ${r.updated.length} ticket(s) updated.`); refresh() },
    onError: (e) => { setConfirm(null); setErr(errorMessage(e)) },
  })
  const merge = useMutation({
    mutationFn: () => consoleB.mergeTickets(mergeTarget!, picked.filter((id) => id !== mergeTarget)),
    onSuccess: (r) => { setConfirm(null); onDone(`Merged ${r.merged.length} ticket(s) into #${r.id}; ${r.messages_moved} message(s) moved.`); refresh() },
    onError: (e) => { setConfirm(null); setErr(errorMessage(e)) },
  })
  const toggle = (id: number) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]))

  return (
    <div className="space-y-3">
      <p className="text-xs text-ink-muted">Tickets on the current queue page. Pick some, then choose an action.</p>
      {err && <p role="alert" className="text-sm text-danger">{err}</p>}
      <div className="flex flex-wrap items-end gap-2">
        <Select size="sm" label="Action" value={action} onChange={(e) => setAction(e.target.value as BulkAction)} containerClassName="w-40">
          {(Object.keys(ACTION_LABEL) as BulkAction[]).map((a) => <option key={a} value={a}>{ACTION_LABEL[a]}</option>)}
        </Select>
        {action === 'assign' && (
          <Select size="sm" label="To" value={assignee} onChange={(e) => setAssignee(e.target.value)} containerClassName="w-40">
            <option value="">Choose staff</option>
            {admins.map((a) => <option key={a.id} value={a.id}>{a.username}</option>)}
          </Select>
        )}
        <Button size="sm" variant="primary" disabled={!picked.length || (action === 'assign' && !assignee)} onClick={() => setConfirm('bulk')}>
          Apply to {picked.length}
        </Button>
        <Button size="sm" variant="secondary" leftIcon={<GitMerge size={13} />} disabled={!sameCustomer}
          title={sameCustomer ? undefined : 'Pick two or more tickets from the same customer'} onClick={() => setConfirm('merge')}>Merge</Button>
      </div>
      {rows.length === 0 ? <EmptyState size="compact" title="No tickets on this page" /> : (
        <ul className="divide-y divide-[var(--border)] rounded-md border border-surface-border">
          {rows.map((r) => (
            <li key={r.id}>
              <label className={cn('flex cursor-pointer items-start gap-2 px-3 py-2', picked.includes(r.id) && 'bg-brand-soft')}>
                <input type="checkbox" className="mt-1 h-4 w-4 accent-[var(--brand)]" checked={picked.includes(r.id)} onChange={() => toggle(r.id)} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-ink-primary">{r.subject}</span>
                  <span className="block text-xs text-ink-muted">{r.user_username} · <span className="mono">#{r.id}</span> · {r.assigned_to_username ?? 'Unassigned'}</span>
                </span>
                <StatusBadge size="sm" tone={STATUS_TONE[r.status]} label={STATUS_LABEL[r.status]} />
              </label>
            </li>
          ))}
        </ul>
      )}
      <ConfirmModal open={confirm === 'bulk'} onClose={() => setConfirm(null)} onConfirm={() => bulk.mutate()} loading={bulk.isPending}
        variant={action === 'close' ? 'warning' : 'info'} title={`${ACTION_LABEL[action]} ${picked.length} ticket(s)?`} confirmLabel={ACTION_LABEL[action]}
        message={action === 'close' ? 'Closed tickets leave the working queue. Customers can still reply, which reopens them.' : 'Each ticket is updated and the change is recorded in its activity.'}
        details={[{ label: 'Tickets', value: picked.map((id) => `#${id}`).join(', ') }, ...(action === 'assign' ? [{ label: 'Assign to', value: admins.find((a) => String(a.id) === assignee)?.username ?? '—' }] : [])]} />
      <ConfirmModal open={confirm === 'merge'} onClose={() => setConfirm(null)} onConfirm={() => merge.mutate()} loading={merge.isPending}
        variant="warning" title="Merge duplicate tickets" confirmLabel="Merge"
        message="Messages and tags move into the ticket you keep. The others are closed with a note pointing to it."
        details={[{ label: 'Customer', value: selected[0]?.user_username }, { label: 'Closed', value: picked.filter((id) => id !== mergeTarget).map((id) => `#${id}`).join(', ') }]}>
        <Select label="Keep ticket" value={String(mergeTarget ?? '')} onChange={(e) => setTarget(Number(e.target.value))}>
          {selected.map((r) => <option key={r.id} value={r.id}>#{r.id} · {r.subject}</option>)}
        </Select>
      </ConfirmModal>
    </div>
  )
}
