import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2, Copy, Info, Megaphone, Plus, RefreshCw, X } from 'lucide-react'
import { PageHeader } from '../components/PageHeader'
import { AdminTable, type Column } from '../components/AdminTable'
import { StatusBadge } from '../components/StatusBadge'
import { SlideOver } from '../components/SlideOver'
import { ConfirmModal } from '../components/ConfirmModal'
import { Button } from '../components/ui/Button'
import { Input, Select, Textarea } from '../components/ui/Input'
import { Tabs } from '../components/ui/Tabs'
import { SafeText } from '../components/consoleb/SafeText'
import { plainText as plain } from '../components/consoleb/text'
import {
  AUDIENCES, consoleB, SEGMENTS, type Announcement, type AnnouncementInput, type AnnouncementState, type Severity,
} from '../components/consoleb/api'
import { ApiError } from '../components/system/http'
import { cn } from '../lib/cn'
import { formatDateTime, formatNumber, formatRelative } from '../lib/format'
import { errorMessage } from '../lib/errors'

type Tab = 'all' | AnnouncementState
const STATE_TONE: Record<AnnouncementState, 'success' | 'warning' | 'neutral' | 'info'> = {
  live: 'success', scheduled: 'info', draft: 'neutral', ended: 'neutral', archived: 'neutral',
}

interface Draft {
  title: string
  body: string
  severity: Severity
  audience: string
  segment: string
  link_url: string
  link_label: string
  starts_at: string
  ends_at: string
  dismissible: boolean
  priority: string
}

/** ISO -> value for <input type="datetime-local"> in the browser's zone. */
function toLocalInput(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
const fromLocalInput = (v: string): string | null => (v ? new Date(v).toISOString() : null)

function toDraft(a?: Announcement): Draft {
  return {
    title: a?.title ?? '',
    body: a?.body ?? '',
    severity: a?.severity ?? 'info',
    audience: a?.audience ?? 'all',
    segment: a?.segment ?? '',
    link_url: a?.link_url ?? '',
    link_label: a?.link_label ?? '',
    starts_at: toLocalInput(a?.starts_at ?? new Date().toISOString()),
    ends_at: toLocalInput(a?.ends_at ?? null),
    dismissible: a?.dismissible ?? true,
    priority: String(a?.priority ?? 0),
  }
}

function toInput(d: Draft): AnnouncementInput {
  return {
    title: d.title.trim(),
    body: d.body.trim(),
    severity: d.severity,
    audience: d.audience as AnnouncementInput['audience'],
    segment: (d.audience === 'segment' ? d.segment : null) as AnnouncementInput['segment'],
    link_url: d.link_url.trim() || null,
    link_label: d.link_label.trim() || null,
    starts_at: fromLocalInput(d.starts_at) ?? new Date().toISOString(),
    ends_at: fromLocalInput(d.ends_at),
    dismissible: d.dismissible,
    priority: Number.parseInt(d.priority || '0', 10) || 0,
  }
}

/** Body preview without the markdown markers. */
const shortDate = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

function audienceLabel(a: Pick<Announcement, 'audience' | 'segment'>): string {
  if (a.audience === 'segment') return SEGMENTS.find((s) => s.value === a.segment)?.label ?? 'A group'
  return AUDIENCES.find((x) => x.value === a.audience)?.label ?? a.audience
}

const SEVERITY_STYLE: Record<Severity, { box: string; icon: typeof Info }> = {
  info: { box: 'border-notice-line bg-notice-soft text-ink-primary', icon: Info },
  warning: { box: 'border-warning-line bg-warning-soft text-ink-primary', icon: AlertTriangle },
  success: { box: 'border-success-line bg-success-soft text-ink-primary', icon: CheckCircle2 },
}

/** Approximation of the customer app's Home banner. */
function BannerPreview({ d }: { d: Draft }) {
  const s = SEVERITY_STYLE[d.severity]
  const Icon = s.icon
  const tone = d.severity === 'info' ? 'text-notice' : d.severity === 'warning' ? 'text-warning' : 'text-success'
  return (
    <div className={cn('flex gap-3 rounded-xl border p-3.5', s.box)}>
      <Icon size={18} className={cn('mt-0.5 shrink-0', tone)} aria-hidden />
      <div className="min-w-0 flex-1 text-sm">
        <p className="font-semibold">{d.title || 'Title'}</p>
        {d.body.trim() && <SafeText text={d.body} className="mt-0.5 text-ink-secondary" />}
        {d.link_url && <p className={cn('mt-2 text-sm font-semibold', tone)}>{d.link_label || 'Learn more'}</p>}
      </div>
      {d.dismissible && <X size={16} className="mt-0.5 shrink-0 text-ink-muted" aria-hidden />}
    </div>
  )
}

export function AnnouncementsPage() {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['admin', 'announcements'], queryFn: () => consoleB.announcements() })
  const [tab, setTab] = useState<Tab>('all')
  const [editing, setEditing] = useState<Announcement | 'new' | null>(null)
  const [draft, setDraft] = useState<Draft>(toDraft())
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [confirm, setConfirm] = useState<null | 'publish' | 'archive' | 'delete'>(null)
  const [banner, setBanner] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null)

  const rows = useMemo(() => q.data?.results ?? [], [q.data])
  const counts = useMemo(() => {
    const c: Record<string, number> = {}
    for (const r of rows) c[r.state] = (c[r.state] ?? 0) + 1
    return c
  }, [rows])
  const visible = tab === 'all' ? rows : rows.filter((r) => r.state === tab)
  const current = editing && editing !== 'new' ? rows.find((r) => r.id === editing.id) ?? editing : null
  const readOnly = current?.status === 'archived'

  const open = (a: Announcement | 'new') => {
    setEditing(a); setDraft(toDraft(a === 'new' ? undefined : a)); setFieldErrors({})
  }
  const done = (text: string) => {
    setBanner({ tone: 'success', text })
    void qc.invalidateQueries({ queryKey: ['admin', 'announcements'] })
  }
  const failed = (err: unknown) => {
    if (err instanceof ApiError) setFieldErrors(err.fields)
    setBanner({ tone: 'danger', text: errorMessage(err) ?? 'Something went wrong.' })
  }

  const save = useMutation({
    mutationFn: () => (editing === 'new' ? consoleB.createAnnouncement(toInput(draft)) : consoleB.updateAnnouncement(current!.id, toInput(draft))),
    onSuccess: (a) => { setEditing(a); setFieldErrors({}); done(editing === 'new' ? 'Draft saved. Publish it when it is ready.' : 'Changes saved.') },
    onError: failed,
  })
  const act = useMutation({
    mutationFn: async (kind: 'publish' | 'archive' | 'delete' | 'duplicate') => {
      if (!current) throw new Error('Nothing selected')
      if (kind === 'publish') {
        // Save pending edits first so what is published is what is on screen.
        await consoleB.updateAnnouncement(current.id, toInput(draft))
        return consoleB.publishAnnouncement(current.id)
      }
      if (kind === 'archive') return consoleB.archiveAnnouncement(current.id)
      if (kind === 'duplicate') return consoleB.duplicateAnnouncement(current.id)
      await consoleB.deleteAnnouncement(current.id)
      return null
    },
    onSuccess: (a, kind) => {
      setConfirm(null)
      if (kind === 'delete') { setEditing(null); done('Draft deleted.'); return }
      if (a) open(a)
      done(kind === 'publish' ? 'Published. Customers see it from its start time.' : kind === 'archive' ? 'Archived. Customers no longer see it.' : 'Copied as a new draft.')
    },
    onError: (err) => { setConfirm(null); failed(err) },
  })

  const columns: Column<Announcement>[] = [
    { key: 'title', label: 'Announcement', render: (r) => (
      <span className="block min-w-0 max-w-[16rem] xl:max-w-[26rem] 2xl:max-w-[36rem]">
        <span className="block truncate font-medium text-ink-primary">{r.title}</span>
        <span className="block truncate text-xs text-ink-muted">{plain(r.body) || '—'}</span>
      </span>
    ), sortable: true, sortValue: (r) => r.title },
    { key: 'state', label: 'State', render: (r) => <StatusBadge size="sm" tone={STATE_TONE[r.state]} label={r.state.charAt(0).toUpperCase() + r.state.slice(1)} showDot={r.state === 'live'} /> },
    { key: 'severity', label: 'Tone', hideBelow: 'md', render: (r) => <StatusBadge size="sm" status={r.severity} /> },
    { key: 'audience', label: 'Audience', hideBelow: 'lg', render: (r) => <span className="text-xs text-ink-secondary">{audienceLabel(r)}</span> },
    { key: 'window', label: 'Shown', hideBelow: 'lg', render: (r) => (
      <span className="whitespace-nowrap text-xs text-ink-secondary" title={`${formatDateTime(r.starts_at)}${r.ends_at ? ` – ${formatDateTime(r.ends_at)}` : ''}`}>
        {shortDate(r.starts_at)}{r.ends_at ? ` – ${shortDate(r.ends_at)}` : ' onwards'}
      </span>
    ), sortable: true, sortValue: (r) => r.starts_at },
    { key: 'reach', label: 'Reach', numeric: true, hideBelow: 'xl', render: (r) => (r.reach === null ? <span className="text-xs text-ink-muted">By device</span> : formatNumber(r.reach)) },
    { key: 'dismissals', label: 'Dismissed', numeric: true, hideBelow: 'xl', render: (r) => formatNumber(r.dismissals) },
    { key: 'updated', label: 'Updated', numeric: true, render: (r) => <span title={formatDateTime(r.updated_at)} className="text-xs text-ink-muted">{formatRelative(r.updated_at)}</span>, sortable: true, sortValue: (r) => r.updated_at },
  ]

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }))

  return (
    <div className="space-y-5">
      <PageHeader
        title="Announcements"
        description="Banners on the customer app’s Home screen: maintenance notices, M-Pesa delays, new features. Schedule them, target a platform or a group, and archive them when they are done."
        actions={
          <>
            <Button size="sm" variant="secondary" leftIcon={<RefreshCw size={13} />} loading={q.isFetching} onClick={() => void q.refetch()}>Refresh</Button>
            <Button size="sm" variant="primary" leftIcon={<Plus size={13} />} onClick={() => open('new')}>New announcement</Button>
          </>
        }
      />
      {banner && (
        <div role={banner.tone === 'danger' ? 'alert' : 'status'} className={cn('flex items-center gap-3 rounded-md border px-3 py-2 text-sm',
          banner.tone === 'success' ? 'border-success-line bg-success-soft text-success' : 'border-danger-line bg-danger-soft text-danger')}>
          <span className="flex-1 font-medium">{banner.text}</span>
          <button type="button" className="text-xs underline" onClick={() => setBanner(null)}>Dismiss</button>
        </div>
      )}
      <Tabs label="Announcement state" value={tab} onChange={setTab} items={[
        { value: 'all', label: 'All', count: rows.length },
        { value: 'live', label: 'Live', count: counts.live ?? 0 },
        { value: 'scheduled', label: 'Scheduled', count: counts.scheduled ?? 0 },
        { value: 'draft', label: 'Drafts', count: counts.draft ?? 0 },
        { value: 'ended', label: 'Ended', count: counts.ended ?? 0 },
        { value: 'archived', label: 'Archived', count: counts.archived ?? 0 },
      ]} />
      <AdminTable
        columns={columns} data={visible} rowKey={(r) => r.id} density="compact"
        isLoading={q.isLoading} error={q.error} onRetry={() => void q.refetch()}
        onRowClick={open} isRowActive={(r) => current?.id === r.id}
        emptyMessage={tab === 'all' ? 'No announcements yet' : `No ${tab} announcements`}
        emptyDescription="Create one to tell customers about maintenance, payment delays or new features."
      />

      <SlideOver
        open={!!editing}
        onClose={() => setEditing(null)}
        width={560}
        title={editing === 'new' ? 'New announcement' : current?.title ?? ''}
        subtitle={current ? `${audienceLabel(current)} · updated ${formatRelative(current.updated_at)}${current.updated_by ? ` by ${current.updated_by}` : ''}` : 'Saved as a draft first; customers see nothing until you publish.'}
        headerAside={current && <StatusBadge size="sm" tone={STATE_TONE[current.state]} label={current.state.charAt(0).toUpperCase() + current.state.slice(1)} />}
        footer={
          readOnly ? (
            <Button variant="secondary" leftIcon={<Copy size={13} />} loading={act.isPending} onClick={() => act.mutate('duplicate')}>Copy as new draft</Button>
          ) : (
            <>
              {current?.status === 'draft' && !current.published_at && (
                <Button variant="danger-soft" onClick={() => setConfirm('delete')}>Delete draft</Button>
              )}
              {current && current.status === 'published' && (
                <Button variant="danger-soft" onClick={() => setConfirm('archive')}>Archive</Button>
              )}
              {current && <Button variant="ghost" leftIcon={<Copy size={13} />} onClick={() => act.mutate('duplicate')} disabled={act.isPending}>Copy</Button>}
              <Button variant="secondary" loading={save.isPending} onClick={() => save.mutate()}>{current?.status === 'published' ? 'Save changes' : 'Save draft'}</Button>
              {current && current.status === 'draft' && (
                <Button variant="primary" leftIcon={<Megaphone size={13} />} onClick={() => setConfirm('publish')}>Publish</Button>
              )}
            </>
          )
        }
      >
        <div className="space-y-4">
          {readOnly && <p className="rounded-md border border-surface-border bg-surface-base px-3 py-2 text-xs text-ink-secondary">Archived announcements are kept for the record and can’t be edited. Copy it to reuse the text.</p>}
          <fieldset disabled={readOnly} className="space-y-4">
            <Input label="Title" value={draft.title} maxLength={120} onChange={(e) => set('title', e.target.value)} error={fieldErrors.title} required />
            <Textarea label="Message" rows={4} maxLength={1000} value={draft.body} onChange={(e) => set('body', e.target.value)} error={fieldErrors.body}
              hint="Plain text. **bold**, [label](https://…) links and lines starting with “- ” for a list are supported." />
            <div className="grid gap-3 sm:grid-cols-2">
              <Select label="Tone" value={draft.severity} onChange={(e) => set('severity', e.target.value as Severity)}>
                <option value="info">Info</option><option value="warning">Warning</option><option value="success">Good news</option>
              </Select>
              <Input label="Priority" inputMode="numeric" value={draft.priority} onChange={(e) => set('priority', e.target.value)} error={fieldErrors.priority} hint="Higher shows first. Up to 3 show at once." />
              <Select label="Audience" value={draft.audience} onChange={(e) => set('audience', e.target.value)} error={fieldErrors.audience}>
                {AUDIENCES.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
              </Select>
              {draft.audience === 'segment' ? (
                <Select label="Customer group" value={draft.segment} onChange={(e) => set('segment', e.target.value)} error={fieldErrors.segment}>
                  <option value="">Choose a group</option>
                  {SEGMENTS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                </Select>
              ) : <div aria-hidden />}
              <Input label="Starts" type="datetime-local" value={draft.starts_at} onChange={(e) => set('starts_at', e.target.value)} error={fieldErrors.starts_at} />
              <Input label="Ends (optional)" type="datetime-local" value={draft.ends_at} onChange={(e) => set('ends_at', e.target.value)} error={fieldErrors.ends_at} hint="Blank = until archived." />
              <Input label="Button link (optional)" value={draft.link_url} placeholder="/wallet or https://…" onChange={(e) => set('link_url', e.target.value)} error={fieldErrors.link_url} />
              <Input label="Button label" value={draft.link_label} maxLength={40} placeholder="Learn more" onChange={(e) => set('link_label', e.target.value)} error={fieldErrors.link_label} />
            </div>
            <label className="flex items-center gap-2 text-sm text-ink-primary">
              <input type="checkbox" checked={draft.dismissible} onChange={(e) => set('dismissible', e.target.checked)} className="h-4 w-4 accent-[var(--brand)]" />
              Customers can dismiss it
            </label>
          </fieldset>
          <section aria-label="Preview" className="rounded-lg border border-surface-border bg-surface-base p-3">
            <p className="mb-2 text-2xs font-semibold uppercase tracking-wide text-ink-muted">Preview on Home (approximate)</p>
            <BannerPreview d={draft} />
          </section>
          {current && (
            <dl className="grid grid-cols-2 gap-2 text-xs">
              <div><dt className="text-ink-muted">Can reach</dt><dd className="num text-ink-primary">{current.reach === null ? 'Customers on that device' : `${formatNumber(current.reach)} customers`}</dd></div>
              <div><dt className="text-ink-muted">Dismissed by</dt><dd className="num text-ink-primary">{formatNumber(current.dismissals)}</dd></div>
              <div><dt className="text-ink-muted">Published</dt><dd className="text-ink-primary">{current.published_at ? formatDateTime(current.published_at) : '—'}</dd></div>
              <div><dt className="text-ink-muted">Created by</dt><dd className="text-ink-primary">{current.created_by ?? '—'}</dd></div>
            </dl>
          )}
        </div>
      </SlideOver>

      <ConfirmModal open={confirm === 'publish'} onClose={() => setConfirm(null)} onConfirm={() => act.mutate('publish')} loading={act.isPending}
        variant="warning" title="Publish announcement" confirmLabel="Publish"
        message="Customers in the audience see it on Home from the start time until it ends or is archived."
        details={[{ label: 'Title', value: draft.title }, { label: 'Audience', value: audienceLabel({ audience: draft.audience as Announcement['audience'], segment: (draft.segment || null) as Announcement['segment'] }) },
          { label: 'Starts', value: draft.starts_at ? formatDateTime(fromLocalInput(draft.starts_at)) : 'Now' }]} />
      <ConfirmModal open={confirm === 'archive'} onClose={() => setConfirm(null)} onConfirm={() => act.mutate('archive')} loading={act.isPending}
        variant="warning" title="Archive announcement" confirmLabel="Archive"
        message="Customers stop seeing it at once. It stays here for the record and can be copied later." />
      <ConfirmModal open={confirm === 'delete'} onClose={() => setConfirm(null)} onConfirm={() => act.mutate('delete')} loading={act.isPending}
        variant="danger" title="Delete draft" confirmLabel="Delete"
        message="This draft was never published, so no customer has seen it." consequence="This cannot be undone." />
    </div>
  )
}
