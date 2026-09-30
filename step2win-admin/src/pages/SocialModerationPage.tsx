import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Ban, CheckCircle2, Flag, Pencil, PlayCircle, RefreshCw, Users, XCircle } from 'lucide-react'
import { PageHeader } from '../components/PageHeader'
import { StatCard } from '../components/StatCard'
import { AdminTable, type Column } from '../components/AdminTable'
import { StatusBadge } from '../components/StatusBadge'
import { Panel } from '../components/ui/Card'
import { Button } from '../components/ui/Button'
import { Input, Textarea } from '../components/ui/Input'
import { Modal } from '../components/ui/Modal'
import { Tabs } from '../components/ui/Tabs'
import { ContentModerationTab, ReportFollowUp, TeamMembersDrawer, type FollowUp } from '../components/social/ModerationTools'
import { consoleB } from '../components/consoleb/api'
import { ErrorState } from '../components/ui/ErrorState'
import { Skeleton } from '../components/ui/Skeleton'
import { formatDateTime, formatNumber } from '../lib/format'
import {
  SocialApiError, socialAdminApi, type ReportStatus, type SocialReport, type SocialSettings, type SocialTeam,
} from '../components/social/api'

type Tab = 'reports' | 'content' | 'teams' | 'settings'

function describe(err: unknown): string {
  if (err instanceof SocialApiError) return err.message
  return err instanceof Error ? err.message : 'Unknown error.'
}

function Banner({ message, tone }: { message: string; tone: 'success' | 'danger' }) {
  return (
    <div role="status" className={`mb-4 rounded-md border px-3 py-2 text-sm ${tone === 'success' ? 'border-success/30 bg-success-soft text-success' : 'border-danger-line bg-danger-soft text-danger'}`}>
      {message}
    </div>
  )
}

/* ─────────────── Reports ─────────────── */

function ReportsTab({ onResult }: { onResult: (m: { message: string; tone: 'success' | 'danger' }) => void }) {
  const qc = useQueryClient()
  const [status, setStatus] = useState<ReportStatus>('open')
  const [targetType, setTargetType] = useState<'all' | 'user' | 'team'>('all')
  const [open, setOpen] = useState<SocialReport | null>(null)
  const [note, setNote] = useState('')
  const [followUp, setFollowUp] = useState<FollowUp>('')
  const [feedEventId, setFeedEventId] = useState<number | null>(null)
  const query = useQuery({
    queryKey: ['social-admin', 'reports', status, targetType],
    queryFn: () => socialAdminApi.reports(status, targetType === 'all' ? undefined : targetType),
    refetchInterval: 60_000,
  })
  const resolve = useMutation({
    mutationFn: async ({ id, next }: { id: number; next: 'actioned' | 'dismissed' }): Promise<{ status: string }> =>
      next === 'actioned' && followUp
        ? consoleB.resolveReport(id, { status: next, note, action: followUp, feed_event_id: feedEventId ?? undefined }).then(() => ({ status: next }))
        : socialAdminApi.resolve(id, next, note),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['social-admin'] })
      setOpen(null)
      onResult({ message: `Report ${r.status === 'actioned' ? 'marked as actioned' : 'dismissed'} (all open reports on the same target closed).`, tone: 'success' })
    },
    onError: (e) => onResult({ message: describe(e), tone: 'danger' }),
  })

  const target = (r: SocialReport) => (r.target_type === 'user' ? r.target_user?.username ?? 'Deleted user' : r.target_team?.name ?? 'Deleted team')
  const columns: Column<SocialReport>[] = [
    { key: 'created', label: 'Reported', render: (r) => formatDateTime(r.created_at), sortable: true, sortValue: (r) => r.created_at },
    { key: 'target', label: 'Target', render: (r) => (
      <span className="inline-flex items-center gap-2">
        <StatusBadge tone={r.target_type === 'team' ? 'violet' : 'info'} label={r.target_type === 'team' ? 'Team' : 'User'} size="sm" />
        <span className="font-medium text-ink-primary">{target(r)}</span>
      </span>
    ) },
    { key: 'reason', label: 'Reason', render: (r) => r.reason_label },
    { key: 'count', label: 'Open reports', numeric: true, align: 'right', render: (r) => formatNumber(r.target_open_reports), sortable: true, sortValue: (r) => r.target_open_reports },
    { key: 'reporter', label: 'Reporter', hideBelow: 'md', render: (r) => r.reporter?.username ?? '—' },
    { key: 'status', label: 'Status', render: (r) => <StatusBadge status={r.status} tone={r.status === 'open' ? 'warning' : r.status === 'actioned' ? 'success' : 'neutral'} /> },
  ]

  return (
    <>
      <AdminTable
        columns={columns}
        data={query.data?.results ?? []}
        isLoading={query.isLoading}
        error={query.error}
        onRetry={() => query.refetch()}
        rowKey={(r) => r.id}
        onRowClick={(r) => { setOpen(r); setNote(r.resolution_note ?? ''); setFollowUp(''); setFeedEventId(null) }}
        emptyMessage={status === 'open' ? 'No open reports' : 'No reports here'}
        emptyDescription="Reports from the app's Friends and Teams screens appear here."
        toolbar={
          <div className="flex flex-wrap items-center gap-2">
            <Tabs<ReportStatus>
              label="Report status" variant="segmented" size="sm" value={status} onChange={setStatus}
              items={[
                { value: 'open', label: 'Open', count: query.data?.counts.open },
                { value: 'actioned', label: 'Actioned' },
                { value: 'dismissed', label: 'Dismissed' },
              ]}
            />
            <Tabs<'all' | 'user' | 'team'>
              label="Target" variant="segmented" size="sm" value={targetType} onChange={setTargetType}
              items={[{ value: 'all', label: 'All' }, { value: 'user', label: 'People' }, { value: 'team', label: 'Teams' }]}
            />
          </div>
        }
      />
      <Modal
        open={open !== null}
        onClose={() => !resolve.isPending && setOpen(null)}
        title={open ? `Report: ${target(open)}` : ''}
        description={open ? `${open.reason_label} · ${formatDateTime(open.created_at)}` : undefined}
        footer={open?.status === 'open' ? (
          <>
            <Button variant="secondary" onClick={() => resolve.mutate({ id: open.id, next: 'dismissed' })} loading={resolve.isPending} leftIcon={<XCircle size={14} />}>Dismiss</Button>
            <Button onClick={() => resolve.mutate({ id: open.id, next: 'actioned' })} loading={resolve.isPending} leftIcon={<CheckCircle2 size={14} />}
              disabled={!!followUp && (note.trim().length < 5 || (followUp === 'hide_feed_event' && !feedEventId))}
              title={followUp && note.trim().length < 5 ? 'Add a note of at least 5 characters' : undefined}>Mark actioned</Button>
          </>
        ) : undefined}
      >
        {open && (
          <div className="space-y-3 text-sm">
            <p className="text-ink-secondary">{open.details || 'No details given.'}</p>
            <dl className="grid grid-cols-2 gap-2 text-xs">
              <dt className="text-ink-muted">Reporter</dt><dd>{open.reporter?.username ?? 'Deleted account'}</dd>
              <dt className="text-ink-muted">Open reports on this target</dt><dd className="num">{open.target_open_reports}</dd>
              {open.target_team && (<><dt className="text-ink-muted">Team owner</dt><dd>{open.target_team.owner?.username ?? '—'}</dd></>)}
              {open.reviewed_by && (<><dt className="text-ink-muted">Reviewed by</dt><dd>{open.reviewed_by} · {formatDateTime(open.reviewed_at)}</dd></>)}
            </dl>
            {open.target_type === 'team' && <p className="text-xs text-ink-muted">To rename or pause the team, use the Teams tab. Then mark this report actioned.</p>}
            {open.target_type === 'user' && <p className="text-xs text-ink-muted">To restrict the account, open the user in Users or Moderation. Reports for suspected cheating feed the anti-cheat review; social never changes money.</p>}
            {open.status === 'open' && (
              <ReportFollowUp targetType={open.target_type} userId={open.target_user?.id ?? null} value={followUp} onChange={setFollowUp}
                feedEventId={feedEventId} onFeedEvent={setFeedEventId} />
            )}
            {open.status === 'open' ? (
              <Textarea label={followUp ? 'Resolution note (required; shown to team members when pausing)' : 'Resolution note (internal)'} value={note} maxLength={500} rows={2} onChange={(e) => setNote(e.target.value)} />
            ) : open.resolution_note ? (
              <p className="rounded-md bg-surface-elevated p-2 text-xs">{open.resolution_note}</p>
            ) : null}
          </div>
        )}
      </Modal>
    </>
  )
}

/* ─────────────── Teams ─────────────── */

type TeamAction = { kind: 'rename' | 'disable' | 'enable'; team: SocialTeam } | null

function TeamsTab({ onResult }: { onResult: (m: { message: string; tone: 'success' | 'danger' }) => void }) {
  const qc = useQueryClient()
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<'all' | 'reported' | 'disabled'>('all')
  const [action, setAction] = useState<TeamAction>(null)
  const [name, setName] = useState('')
  const [reason, setReason] = useState('')
  const [membersOf, setMembersOf] = useState<SocialTeam | null>(null)
  const query = useQuery({
    queryKey: ['social-admin', 'teams', q, filter],
    queryFn: () => socialAdminApi.teams(q, filter === 'all' ? undefined : filter),
  })
  const moderate = useMutation({
    mutationFn: (a: NonNullable<TeamAction>) => socialAdminApi.moderateTeam(a.team.id, { action: a.kind, name: a.kind === 'rename' ? name : undefined, reason }),
    onSuccess: (team, a) => {
      qc.invalidateQueries({ queryKey: ['social-admin'] })
      setAction(null)
      onResult({ message: a.kind === 'rename' ? `Team renamed to ${team.name}.` : a.kind === 'disable' ? `${team.name} is paused.` : `${team.name} is active again.`, tone: 'success' })
    },
    onError: (e) => onResult({ message: describe(e), tone: 'danger' }),
  })

  const columns: Column<SocialTeam>[] = [
    { key: 'name', label: 'Team', render: (t) => <span className="font-medium text-ink-primary">{t.name}</span>, sortable: true, sortValue: (t) => t.name },
    { key: 'owner', label: 'Owner', hideBelow: 'md', render: (t) => t.owner?.username ?? '—' },
    { key: 'members', label: 'Members', numeric: true, align: 'right', render: (t) => formatNumber(t.member_count), sortable: true, sortValue: (t) => t.member_count },
    { key: 'week', label: 'Steps this week', numeric: true, align: 'right', hideBelow: 'lg', render: (t) => formatNumber(t.week_steps ?? 0) },
    { key: 'reports', label: 'Open reports', numeric: true, align: 'right', render: (t) => (t.open_reports ? <span className="font-semibold text-warning">{t.open_reports}</span> : '0'), sortable: true, sortValue: (t) => t.open_reports ?? 0 },
    { key: 'status', label: 'Status', render: (t) => (t.is_disabled ? <StatusBadge tone="danger" label="Paused" /> : <StatusBadge tone="success" label={t.visibility === 'public' ? 'Public' : 'Invite only'} />) },
  ]

  return (
    <>
      <AdminTable
        columns={columns}
        data={query.data?.results ?? []}
        isLoading={query.isLoading}
        error={query.error}
        onRetry={() => query.refetch()}
        rowKey={(t) => t.id}
        onRowClick={setMembersOf}
        isRowActive={(t) => t.id === membersOf?.id}
        searchValue={q}
        onSearchChange={setQ}
        searchPlaceholder="Team name or code"
        emptyMessage="No teams match"
        toolbar={
          <Tabs<'all' | 'reported' | 'disabled'>
            label="Filter teams" variant="segmented" size="sm" value={filter} onChange={setFilter}
            items={[{ value: 'all', label: 'All' }, { value: 'reported', label: 'Reported' }, { value: 'disabled', label: 'Paused' }]}
          />
        }
        rowActions={(t) => (
          <div className="flex justify-end gap-1">
            <Button size="sm" variant="ghost" leftIcon={<Pencil size={13} />} onClick={(e) => { e.stopPropagation(); setName(t.name); setReason(''); setAction({ kind: 'rename', team: t }) }}>Rename</Button>
            {t.is_disabled ? (
              <Button size="sm" variant="secondary" leftIcon={<PlayCircle size={13} />} onClick={(e) => { e.stopPropagation(); setReason(''); setAction({ kind: 'enable', team: t }) }}>Enable</Button>
            ) : (
              <Button size="sm" variant="danger-soft" leftIcon={<Ban size={13} />} onClick={(e) => { e.stopPropagation(); setReason(''); setAction({ kind: 'disable', team: t }) }}>Pause</Button>
            )}
          </div>
        )}
      />
      <Modal
        open={action !== null}
        role="alertdialog"
        onClose={() => !moderate.isPending && setAction(null)}
        title={action?.kind === 'rename' ? `Rename ${action.team.name}` : action?.kind === 'disable' ? `Pause ${action.team.name}?` : `Enable ${action?.team.name ?? ''}?`}
        description={
          action?.kind === 'disable'
            ? 'The team disappears from discovery and rankings, and members can’t edit it or invite anyone. Members see your reason.'
            : action?.kind === 'enable'
              ? 'The team becomes visible and usable again.'
              : 'Names must be 3–40 characters and unique.'
        }
        footer={
          <>
            <Button variant="secondary" onClick={() => setAction(null)} disabled={moderate.isPending}>Cancel</Button>
            <Button
              variant={action?.kind === 'disable' ? 'danger' : 'primary'}
              loading={moderate.isPending}
              disabled={(action?.kind === 'disable' && reason.trim().length < 3) || (action?.kind === 'rename' && name.trim().length < 3)}
              onClick={() => action && moderate.mutate(action)}
            >
              {action?.kind === 'rename' ? 'Rename' : action?.kind === 'disable' ? 'Pause team' : 'Enable team'}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          {action?.kind === 'rename' && <Input label="New name" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />}
          {action?.kind !== 'enable' && (
            <Textarea
              label={action?.kind === 'disable' ? 'Reason shown to members' : 'Reason (audit log)'}
              value={reason}
              maxLength={255}
              rows={2}
              onChange={(e) => setReason(e.target.value)}
            />
          )}
        </div>
      </Modal>
      <TeamMembersDrawer team={membersOf} onClose={() => setMembersOf(null)} onResult={onResult} />
    </>
  )
}

/* ─────────────── Settings ─────────────── */

const NUMBER_FIELDS: Array<{ key: keyof SocialSettings; label: string; hint: string; min: number; max: number }> = [
  { key: 'max_team_members', label: 'Max members per team', hint: '2–500', min: 2, max: 500 },
  { key: 'max_teams_per_user', label: 'Teams per person', hint: '1–20', min: 1, max: 20 },
  { key: 'max_friends', label: 'Max friends per person', hint: '10–5000', min: 10, max: 5000 },
  { key: 'friend_requests_per_day', label: 'Friend requests per day', hint: 'Per person, rolling 24 h (1–500)', min: 1, max: 500 },
]
const SWITCHES: Array<{ key: 'social_enabled' | 'teams_enabled' | 'feed_enabled'; label: string; hint: string }> = [
  { key: 'social_enabled', label: 'Social features', hint: 'Master switch: friends, teams, rankings and activity. Data is kept while off.' },
  { key: 'teams_enabled', label: 'Teams', hint: 'Creating, joining and team rankings.' },
  { key: 'feed_enabled', label: 'Activity feed', hint: 'Friends’ milestones and reactions.' },
]

function SettingsTab({ onResult }: { onResult: (m: { message: string; tone: 'success' | 'danger' }) => void }) {
  const qc = useQueryClient()
  const query = useQuery({ queryKey: ['social-admin', 'settings'], queryFn: socialAdminApi.settings })
  // Unsaved edits over the server copy (no effect needed to seed a draft).
  const [edits, setEdits] = useState<Partial<SocialSettings>>({})
  const draft: SocialSettings | null = query.data ? { ...query.data, ...edits } : null
  const setDraft = (next: SocialSettings | null) => setEdits(next && query.data ? next : {})
  const save = useMutation({
    mutationFn: (patch: Partial<SocialSettings>) => socialAdminApi.updateSettings(patch),
    onSuccess: (s) => {
      qc.setQueryData(['social-admin', 'settings'], s)
      setEdits({})
      qc.invalidateQueries({ queryKey: ['social-admin', 'overview'] })
      onResult({ message: 'Social settings saved.', tone: 'success' })
    },
    onError: (e) => onResult({ message: describe(e), tone: 'danger' }),
  })

  if (query.isLoading || !draft) return query.isError ? <ErrorState error={query.error} onRetry={() => query.refetch()} /> : <Skeleton height={240} />
  const dirty = JSON.stringify(draft) !== JSON.stringify(query.data)
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Panel title="Features" description="Bragging rights only: social never involves money, fees or prizes.">
        <div className="divide-y divide-surface-border">
          {SWITCHES.map((s) => (
            <label key={s.key} className="flex cursor-pointer items-start justify-between gap-4 py-3 first:pt-0 last:pb-0">
              <span>
                <span className="block text-sm font-medium text-ink-primary">{s.label}</span>
                <span className="block text-xs text-ink-muted">{s.hint}</span>
              </span>
              <input
                type="checkbox"
                role="switch"
                checked={draft[s.key]}
                onChange={(e) => setDraft({ ...draft, [s.key]: e.target.checked })}
                className="mt-1 h-4 w-4 accent-[var(--brand,currentColor)]"
              />
            </label>
          ))}
        </div>
      </Panel>
      <Panel title="Limits" description="Applied to new actions; existing teams and friendships aren’t cut.">
        <div className="grid gap-3 sm:grid-cols-2">
          {NUMBER_FIELDS.map((f) => (
            <Input
              key={f.key}
              type="number"
              label={f.label}
              hint={f.hint}
              min={f.min}
              max={f.max}
              value={String(draft[f.key])}
              onChange={(e) => setDraft({ ...draft, [f.key]: Number(e.target.value) })}
            />
          ))}
        </div>
      </Panel>
      <div className="flex items-center justify-end gap-2 lg:col-span-2">
        {query.data?.updated_at && <span className="mr-auto text-xs text-ink-muted">Last changed {formatDateTime(query.data.updated_at)}</span>}
        <Button variant="secondary" disabled={!dirty || save.isPending} onClick={() => setDraft(query.data ?? null)}>Reset</Button>
        <Button disabled={!dirty} loading={save.isPending} onClick={() => {
          const { updated_at: _ignored, ...patch } = draft
          void _ignored
          save.mutate(patch)
        }}>Save settings</Button>
      </div>
    </div>
  )
}

/* ─────────────── Page ─────────────── */

export default function SocialModerationPage() {
  const [tab, setTab] = useState<Tab>('reports')
  const [result, setResult] = useState<{ message: string; tone: 'success' | 'danger' } | null>(null)
  const overview = useQuery({ queryKey: ['social-admin', 'overview'], queryFn: socialAdminApi.overview, refetchInterval: 60_000 })
  const o = overview.data

  return (
    <div>
      <PageHeader
        title="Social"
        description="Friends, teams, weekly rankings and challenge chat: reports queue, hiding content, team moderation and settings. No money is attached to social."
        actions={<Button variant="secondary" size="sm" leftIcon={<RefreshCw size={13} />} onClick={() => overview.refetch()}>Refresh</Button>}
      />
      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Open reports" value={o?.open_reports ?? '—'} icon={Flag} loading={overview.isLoading} />
        <StatCard label="Active teams" value={o?.teams ?? '—'} icon={Users} hint={o ? `${o.disabled_teams} paused` : undefined} loading={overview.isLoading} />
        <StatCard label="Friendships" value={o?.friendships ?? '—'} loading={overview.isLoading} />
        <StatCard label="Ranked this week" value={o?.ranked_this_week ?? '—'} hint={o ? `Week of ${o.week_start}` : undefined} loading={overview.isLoading} />
      </div>
      {result && <Banner {...result} />}
      <Tabs<Tab>
        label="Social sections"
        value={tab}
        onChange={(v) => { setTab(v); setResult(null) }}
        className="mb-4"
        items={[
          { value: 'reports', label: 'Reports', count: o?.open_reports },
          { value: 'content', label: 'Chat and feed' },
          { value: 'teams', label: 'Teams' },
          { value: 'settings', label: 'Settings' },
        ]}
      />
      {tab === 'reports' && <ReportsTab onResult={setResult} />}
      {tab === 'content' && <ContentModerationTab onResult={setResult} />}
      {tab === 'teams' && <TeamsTab onResult={setResult} />}
      {tab === 'settings' && <SettingsTab onResult={setResult} />}
    </div>
  )
}
