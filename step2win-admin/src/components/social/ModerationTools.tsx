/**
 * Social moderation tools: hide / restore feed items and challenge chat messages
 * (customers never see hidden items), team members (remove, transfer ownership,
 * delete an empty paused team) and the follow-up picker used when resolving a report.
 * Every action needs a reason and is audited server-side.
 */
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Crown, Eye, EyeOff, Trash2, UserMinus } from 'lucide-react'
import { AdminTable, type Column } from '../AdminTable'
import { StatusBadge } from '../StatusBadge'
import { SlideOver } from '../SlideOver'
import { ConfirmModal } from '../ConfirmModal'
import { Button } from '../ui/Button'
import { Select, Textarea } from '../ui/Input'
import { Tabs } from '../ui/Tabs'
import { ErrorState } from '../ui/ErrorState'
import { Skeleton } from '../ui/Skeleton'
import { consoleB, type ChatMessage, type FeedItem, type TeamMember } from '../consoleb/api'
import { formatDateTime, formatRelative } from '../../lib/format'
import { errorMessage } from '../../lib/errors'
import type { SocialTeam } from './api'
import { usePermissions } from '../../lib/permissions'

type Notify = (m: { message: string; tone: 'success' | 'danger' }) => void

function feedText(f: FeedItem): string {
  const d = f.data ?? {}
  const bits = Object.entries(d).filter(([, v]) => typeof v === 'string' || typeof v === 'number').map(([k, v]) => `${k.replace(/_/g, ' ')}: ${String(v)}`)
  return bits.join(' · ') || '—'
}

export function ContentModerationTab({ onResult }: { onResult: Notify }) {
  const qc = useQueryClient()
  const [kind, setKind] = useState<'feed' | 'chat'>('chat')
  const [q, setQ] = useState('')
  const [hiddenOnly, setHiddenOnly] = useState(false)
  const [pending, setPending] = useState<{ kind: 'feed' | 'chat'; id: number; hide: boolean; label: string } | null>(null)
  const canAct = usePermissions().can('trust.act')
  const [reason, setReason] = useState('')
  const feed = useQuery({ queryKey: ['social-admin', 'feed', q, hiddenOnly], queryFn: () => consoleB.feed(q.trim() || undefined, hiddenOnly), enabled: kind === 'feed' })
  const chat = useQuery({ queryKey: ['social-admin', 'chat', q, hiddenOnly], queryFn: () => consoleB.chatMessages(q.trim() || undefined, hiddenOnly), enabled: kind === 'chat' })
  const act = useMutation({
    mutationFn: async (p: NonNullable<typeof pending>): Promise<unknown> =>
      p.kind === 'feed' ? consoleB.setFeedHidden(p.id, p.hide, reason.trim()) : consoleB.setChatHidden(p.id, p.hide, reason.trim()),
    onSuccess: (_r, p) => {
      setPending(null); setReason('')
      void qc.invalidateQueries({ queryKey: ['social-admin'] })
      onResult({ message: p.hide ? 'Hidden. Customers no longer see it.' : 'Restored. Customers can see it again.', tone: 'success' })
    },
    onError: (e) => { setPending(null); onResult({ message: errorMessage(e) ?? 'Request failed.', tone: 'danger' }) },
  })

  const hiddenBadge = (r: { hidden: boolean; hidden_by: string | null; hidden_reason: string | null }) =>
    r.hidden ? <span title={r.hidden_reason ?? undefined}><StatusBadge size="sm" tone="danger" label={`Hidden${r.hidden_by ? ` by ${r.hidden_by}` : ''}`} /></span> : <StatusBadge size="sm" tone="success" label="Visible" />
  const toggleBtn = (k: 'feed' | 'chat', id: number, hidden: boolean, label: string) => !canAct ? null : (
    <Button size="sm" variant={hidden ? 'secondary' : 'danger-soft'} leftIcon={hidden ? <Eye size={13} /> : <EyeOff size={13} />}
      onClick={(e) => { e.stopPropagation(); setReason(''); setPending({ kind: k, id, hide: !hidden, label }) }}>
      {hidden ? 'Restore' : 'Hide'}
    </Button>
  )

  const chatCols: Column<ChatMessage>[] = [
    { key: 'when', label: 'Sent', render: (m) => <span className="text-xs text-ink-muted" title={formatDateTime(m.created_at)}>{formatRelative(m.created_at)}</span> },
    { key: 'user', label: 'From', render: (m) => m.user ? <Link to={`/users?user=${m.user.id}`} className="font-medium text-ink-primary hover:underline">{m.user.username}</Link> : 'Step2Win' },
    { key: 'msg', label: 'Message', render: (m) => <span className="line-clamp-2 text-sm text-ink-secondary">{m.message}</span> },
    { key: 'challenge', label: 'Challenge', hideBelow: 'lg', render: (m) => <span className="text-xs text-ink-secondary">{m.challenge_name}</span> },
    { key: 'state', label: 'Status', render: hiddenBadge },
  ]
  const feedCols: Column<FeedItem>[] = [
    { key: 'when', label: 'Posted', render: (f) => <span className="text-xs text-ink-muted" title={formatDateTime(f.created_at)}>{formatRelative(f.created_at)}</span> },
    { key: 'user', label: 'Customer', render: (f) => f.user ? <Link to={`/users?user=${f.user.id}`} className="font-medium text-ink-primary hover:underline">{f.user.username}</Link> : '—' },
    { key: 'kind', label: 'Update', render: (f) => <span className="text-sm text-ink-primary">{f.kind_label}</span> },
    { key: 'data', label: 'Details', hideBelow: 'md', render: (f) => <span className="line-clamp-1 text-xs text-ink-muted">{feedText(f)}</span> },
    { key: 'state', label: 'Status', render: hiddenBadge },
  ]
  const toolbar = (
    <div className="flex flex-wrap items-center gap-2">
      <Tabs<'feed' | 'chat'> label="Content type" variant="segmented" size="sm" value={kind} onChange={setKind}
        items={[{ value: 'chat', label: 'Challenge chat' }, { value: 'feed', label: 'Activity feed' }]} />
      <Tabs<'all' | 'hidden'> label="Visibility" variant="segmented" size="sm" value={hiddenOnly ? 'hidden' : 'all'} onChange={(v) => setHiddenOnly(v === 'hidden')}
        items={[{ value: 'all', label: 'Latest' }, { value: 'hidden', label: 'Hidden' }]} />
    </div>
  )

  return (
    <>
      {kind === 'chat' ? (
        <AdminTable columns={chatCols} data={chat.data?.results ?? []} rowKey={(m) => m.id} density="compact"
          isLoading={chat.isLoading} error={chat.error} onRetry={() => void chat.refetch()}
          searchValue={q} onSearchChange={setQ} searchPlaceholder="Words, customer or challenge" toolbar={toolbar}
          rowActions={(m) => toggleBtn('chat', m.id, m.hidden, `message from ${m.user?.username ?? 'Step2Win'}`)}
          emptyMessage={hiddenOnly ? 'No hidden messages' : 'No chat messages'} emptyDescription="Private challenge chat messages appear here, newest first." />
      ) : (
        <AdminTable columns={feedCols} data={feed.data?.results ?? []} rowKey={(f) => f.id} density="compact"
          isLoading={feed.isLoading} error={feed.error} onRetry={() => void feed.refetch()}
          searchValue={q} onSearchChange={setQ} searchPlaceholder="Customer username" toolbar={toolbar}
          rowActions={(f) => toggleBtn('feed', f.id, f.hidden, `${f.kind_label.toLowerCase()} by ${f.user?.username ?? 'a customer'}`)}
          emptyMessage={hiddenOnly ? 'No hidden feed items' : 'No feed items'} emptyDescription="Friends’ milestones (goals, streaks, badges) appear here." />
      )}
      <ConfirmModal open={!!pending} onClose={() => setPending(null)} onConfirm={() => pending && act.mutate(pending)} loading={act.isPending}
        variant={pending?.hide ? 'warning' : 'info'} title={pending?.hide ? 'Hide this item?' : 'Restore this item?'}
        confirmLabel={pending?.hide ? 'Hide' : 'Restore'}
        message={pending?.hide ? `The ${pending.label} disappears for every customer at once. It is kept for the record and can be restored.` : 'Customers can see it again.'}
        confirmDisabled={pending?.hide ? reason.trim().length < 5 : false}>
        <Textarea label={pending?.hide ? 'Reason (audit log)' : 'Note (optional)'} rows={2} maxLength={255} value={reason} onChange={(e) => setReason(e.target.value)} />
      </ConfirmModal>
    </>
  )
}

export function TeamMembersDrawer({ team, onClose, onResult }: { team: SocialTeam | null; onClose: () => void; onResult: Notify }) {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['social-admin', 'team-members', team?.id], queryFn: () => consoleB.teamMembers(team!.id), enabled: !!team })
  const [pending, setPending] = useState<{ kind: 'remove' | 'transfer'; m: TeamMember } | 'delete' | null>(null)
  const canAct = usePermissions().can('trust.act')
  const [reason, setReason] = useState('')
  const act = useMutation({
    mutationFn: async () => {
      if (!team || !pending) return
      if (pending === 'delete') return consoleB.deleteTeam(team.id)
      if (pending.kind === 'remove') return consoleB.removeTeamMember(team.id, pending.m.user!.id, reason.trim())
      return consoleB.transferTeam(team.id, pending.m.user!.id, reason.trim())
    },
    onSuccess: () => {
      let text = `Team ${team?.name} deleted.`
      if (pending && pending !== 'delete') {
        text = pending.kind === 'remove' ? `${pending.m.user?.username} removed from the team.` : `${pending.m.user?.username} is now the owner.`
      }
      const wasDelete = pending === 'delete'
      setPending(null); setReason('')
      void qc.invalidateQueries({ queryKey: ['social-admin'] })
      onResult({ message: text, tone: 'success' })
      if (wasDelete) onClose()
    },
    onError: (e) => { setPending(null); onResult({ message: errorMessage(e) ?? 'Request failed.', tone: 'danger' }) },
  })
  const members = q.data?.members ?? []
  const canDelete = !!team && team.is_disabled && members.length === 0
  return (
    <SlideOver open={!!team} onClose={onClose} width={480} title={team?.name ?? ''}
      subtitle={team ? `${team.member_count} member${team.member_count === 1 ? '' : 's'} · ${team.is_disabled ? 'paused' : team.visibility === 'public' ? 'public' : 'invite only'}` : undefined}
      footer={team && canAct && (
        <Button size="sm" variant="danger-soft" leftIcon={<Trash2 size={13} />} disabled={!canDelete}
          title={canDelete ? undefined : 'Only a paused team with no members can be deleted'} onClick={() => setPending('delete')}>Delete team</Button>
      )}>
      {q.isLoading ? <Skeleton height={120} /> : q.error ? <ErrorState size="compact" error={q.error} onRetry={() => void q.refetch()} /> : (
        <div className="space-y-3">
          {team?.disabled_reason && <p className="rounded-md border border-danger-line bg-danger-soft px-3 py-2 text-xs text-danger">Paused: {team.disabled_reason}</p>}
          {members.length === 0 ? <p className="text-sm text-ink-muted">No members. Pause the team first, then it can be deleted.</p> : (
            <ul className="divide-y divide-[var(--border)] rounded-md border border-surface-border">
              {members.map((m) => (
                <li key={m.user?.id ?? m.joined_at} className="flex items-center gap-2 px-3 py-2">
                  <span className="min-w-0 flex-1">
                    {m.user ? <Link to={`/users?user=${m.user.id}`} className="block truncate text-sm font-medium text-ink-primary hover:underline">{m.user.username}</Link> : <span className="text-sm">Deleted account</span>}
                    <span className="block text-2xs text-ink-muted">Joined {formatRelative(m.joined_at)}</span>
                  </span>
                  <StatusBadge size="sm" tone={m.role === 'owner' ? 'violet' : 'neutral'} label={m.role === 'owner' ? 'Owner' : m.role === 'admin' ? 'Admin' : 'Member'} />
                  {canAct && m.user && m.role !== 'owner' && (
                    <Button size="sm" variant="ghost" leftIcon={<Crown size={13} />} onClick={() => { setReason(''); setPending({ kind: 'transfer', m }) }}>Make owner</Button>
                  )}
                  {canAct && m.user && (
                    <Button size="sm" variant="ghost" leftIcon={<UserMinus size={13} />} disabled={m.role === 'owner' && members.length > 1}
                      title={m.role === 'owner' && members.length > 1 ? 'Make someone else the owner first' : undefined}
                      onClick={() => { setReason(''); setPending({ kind: 'remove', m }) }}>Remove</Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <ConfirmModal open={!!pending} onClose={() => setPending(null)} onConfirm={() => act.mutate()} loading={act.isPending}
        variant={pending === 'delete' || (pending && pending.kind === 'remove') ? 'danger' : 'warning'}
        title={pending === 'delete' ? 'Delete this team?' : pending?.kind === 'remove' ? 'Remove from team?' : 'Transfer ownership?'}
        confirmLabel={pending === 'delete' ? 'Delete team' : pending?.kind === 'remove' ? 'Remove' : 'Make owner'}
        message={pending === 'delete' ? 'The paused, empty team and its weekly totals are deleted. The audit log keeps a record.'
          : pending?.kind === 'remove' ? `${pending.m.user?.username} leaves the team and is notified. Their steps stop counting for it.`
            : pending ? `${pending.m.user?.username} becomes the owner; the current owner becomes an admin. Both keep their membership.` : ''}
        consequence={pending === 'delete' ? 'This cannot be undone.' : undefined}
        confirmDisabled={pending !== 'delete' && reason.trim().length < 5}>
        {pending !== 'delete' && <Textarea label="Reason (audit log)" rows={2} maxLength={255} value={reason} onChange={(e) => setReason(e.target.value)} />}
      </ConfirmModal>
    </SlideOver>
  )
}

export type FollowUp = '' | 'disable_team' | 'open_trust_case' | 'hide_feed_event'

/** Follow-up action when a report is marked actioned. */
export function ReportFollowUp({ targetType, userId, value, onChange, feedEventId, onFeedEvent }: {
  targetType: 'user' | 'team'; userId: number | null; value: FollowUp; onChange: (v: FollowUp) => void
  feedEventId: number | null; onFeedEvent: (id: number | null) => void
}) {
  const feed = useQuery({
    queryKey: ['social-admin', 'report-feed', userId],
    queryFn: () => consoleB.feed(undefined, false),
    enabled: value === 'hide_feed_event' && !!userId,
    select: (d) => d.results.filter((f) => f.user?.id === userId && !f.hidden),
  })
  return (
    <div className="space-y-2">
      <Select label="When marked actioned, also" value={value} onChange={(e) => onChange(e.target.value as FollowUp)}>
        <option value="">Nothing else (I handled it elsewhere)</option>
        {targetType === 'team' && <option value="disable_team">Pause the team (the note is shown to members)</option>}
        {targetType === 'user' && <option value="open_trust_case">Open an anti-cheat case for review</option>}
        {targetType === 'user' && <option value="hide_feed_event">Hide one of their feed items</option>}
      </Select>
      {value === 'hide_feed_event' && (
        feed.isLoading ? <Skeleton height={32} /> : (feed.data?.length ?? 0) === 0 ? <p className="text-xs text-ink-muted">This person has no visible feed items.</p> : (
          <Select label="Feed item to hide" value={feedEventId ?? ''} onChange={(e) => onFeedEvent(e.target.value ? Number(e.target.value) : null)}>
            <option value="">Choose</option>
            {feed.data!.map((f) => <option key={f.id} value={f.id}>{f.kind_label} · {formatRelative(f.created_at)} · {feedText(f).slice(0, 60)}</option>)}
          </Select>
        )
      )}
    </div>
  )
}
