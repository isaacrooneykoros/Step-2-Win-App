import { useMemo, useState, type ElementType } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Award, Crown, Flame, Footprints, Medal, Pencil, Plus, RefreshCw, Trash2, Trophy, UserPlus } from 'lucide-react'
import { PageHeader } from '../components/PageHeader'
import { StatCard } from '../components/StatCard'
import { StatusBadge } from '../components/StatusBadge'
import { AdminTable, type Column } from '../components/AdminTable'
import { SlideOver } from '../components/SlideOver'
import { DetailRow } from '../components/DetailRow'
import { ConfirmModal } from '../components/ConfirmModal'
import { Modal } from '../components/ui/Modal'
import { Button } from '../components/ui/Button'
import { Input, SearchInput, Select, Textarea } from '../components/ui/Input'
import { SegmentedControl } from '../components/ui/Tabs'
import { Toolbar } from '../components/ui/Toolbar'
import { EmptyState } from '../components/ui/EmptyState'
import { ErrorState } from '../components/ui/ErrorState'
import { formatNumber } from '../lib/format'
import { ApiError, consoleApi } from '../components/users/api'
import type { BadgeDef, ConsoleUser } from '../components/users/types'
import { ActionNotice, SectionTitle, Timestamp, UserCell } from '../components/users/shared'
import { humanize, useDebounced } from '../components/users/utils'

/** badge.icon holds an emoji in the database; the console never renders it. Type decides the icon. */
const TYPE_ICON: Record<string, ElementType> = {
  milestone: Footprints, achievement: Medal, challenge: Trophy, streak: Flame, rank: Crown,
}
const TYPES = ['milestone', 'achievement', 'challenge', 'streak', 'rank']
const CRITERIA: Array<{ value: string; label: string; unit?: string }> = [
  { value: 'manual', label: 'Manual award only' },
  { value: 'first_challenge', label: 'First challenge joined' },
  { value: 'first_win', label: 'First challenge won' },
  { value: 'step_milestone', label: 'Lifetime steps reach', unit: 'steps' },
  { value: 'challenge_wins', label: 'Challenge wins reach', unit: 'wins' },
  { value: 'streak_days', label: 'Goal streak reaches', unit: 'days' },
  { value: 'total_xp', label: 'Total XP reaches', unit: 'XP' },
]
const needsValue = (criteria: string) => Boolean(CRITERIA.find((c) => c.value === criteria)?.unit)

function criteriaText(b: Pick<BadgeDef, 'criteria_type' | 'criteria_value'>): string {
  const c = CRITERIA.find((x) => x.value === b.criteria_type)
  if (!c) return humanize(b.criteria_type)
  return c.unit ? `${c.label} ${formatNumber(b.criteria_value)} ${c.unit}` : c.label
}

function BadgeIcon({ type, size = 32 }: { type: string; size?: number }) {
  const Icon = TYPE_ICON[type] ?? Award
  return (
    <span aria-hidden className="flex shrink-0 items-center justify-center rounded-md border border-surface-border bg-surface-elevated text-ink-secondary" style={{ width: size, height: size }}>
      <Icon size={Math.round(size * 0.5)} />
    </span>
  )
}

const slugify = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50)

export function BadgesPage() {
  const qc = useQueryClient()
  const [search, setSearch] = useState('')
  const [type, setType] = useState('all')
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [editing, setEditing] = useState<BadgeDef | 'new' | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const q = useQuery({ queryKey: ['admin', 'badges'], queryFn: consoleApi.listBadges })
  const badges = useMemo(() => q.data?.results ?? [], [q.data])
  const selected = badges.find((b) => b.id === selectedId) ?? null

  const rows = badges.filter((b) =>
    (type === 'all' || b.badge_type === type) &&
    (!search.trim() || `${b.name} ${b.slug} ${b.description}`.toLowerCase().includes(search.trim().toLowerCase())))
  const totalAwarded = badges.reduce((s, b) => s + b.users_earned, 0)
  const top = [...badges].sort((a, b) => b.users_earned - a.users_earned)[0]
  const neverEarned = badges.filter((b) => b.users_earned === 0).length
  const maxEarned = Math.max(1, ...badges.map((b) => b.users_earned))

  const typeItems = [{ value: 'all', label: 'All' }, ...TYPES.map((t) => ({ value: t, label: humanize(t) }))]

  const columns: Column<BadgeDef>[] = [
    {
      key: 'name', label: 'Badge', sortable: true, sortValue: (b) => b.name, width: '32%',
      render: (b) => (
        <span className="flex min-w-0 items-center gap-2.5">
          <BadgeIcon type={b.badge_type} />
          <span className="min-w-0">
            <span className="block truncate font-medium text-ink-primary">{b.name}</span>
            <span className="block truncate text-xs text-ink-muted">{b.description}</span>
          </span>
        </span>
      ),
    },
    { key: 'type', label: 'Type', sortable: true, sortValue: (b) => b.badge_type, render: (b) => <StatusBadge size="sm" tone="neutral" label={humanize(b.badge_type)} /> },
    { key: 'criteria', label: 'Awarded when', hideBelow: 'md', render: (b) => <span className="text-ink-secondary">{criteriaText(b)}</span> },
    {
      key: 'earned', label: 'Earned by', sortable: true, sortValue: (b) => b.users_earned, numeric: true,
      render: (b) => (
        <span className="inline-flex items-center justify-end gap-2">
          <span className="hidden h-1.5 w-16 overflow-hidden rounded-sm bg-surface-elevated sm:block" aria-hidden>
            <span className="block h-full rounded-sm bg-brand" style={{ width: `${(b.users_earned / maxEarned) * 100}%` }} />
          </span>
          <span className="w-8 text-right">{formatNumber(b.users_earned)}</span>
        </span>
      ),
    },
    { key: 'slug', label: 'Slug', hideBelow: 'xl', render: (b) => <span className="mono text-xs text-ink-secondary">{b.slug}</span> },
    { key: 'created', label: 'Created', sortable: true, sortValue: (b) => b.created_at, hideBelow: 'lg', render: (b) => <Timestamp value={b.created_at} className="text-ink-secondary" /> },
  ]

  const afterSave = (msg: string) => {
    setEditing(null)
    setNotice(msg)
    void qc.invalidateQueries({ queryKey: ['admin', 'badges'] })
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Badges"
        description="Achievement definitions shown on user profiles, and how many people have earned each."
        actions={
          <>
            <Button size="sm" variant="secondary" leftIcon={<RefreshCw size={13} />} loading={q.isFetching} onClick={() => void q.refetch()}>Refresh</Button>
            <Button size="sm" variant="primary" leftIcon={<Plus size={13} />} onClick={() => setEditing('new')}>New badge</Button>
          </>
        }
      />
      {notice && <ActionNotice tone="success" onDismiss={() => setNotice(null)}>{notice}</ActionNotice>}

      {q.error && !q.data ? null : (
        <section aria-label="Badge totals" className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatCard label="Badge definitions" icon={Award} loading={q.isLoading} value={formatNumber(badges.length)}
            hint={`${new Set(badges.map((b) => b.badge_type)).size} types`} />
          <StatCard label="Times awarded" icon={Medal} loading={q.isLoading} value={formatNumber(totalAwarded)} hint="Across all users" />
          <StatCard label="Most earned" icon={Trophy} loading={q.isLoading} value={top && top.users_earned ? top.name : '—'}
            hint={top && top.users_earned ? `${formatNumber(top.users_earned)} users` : 'No badges earned yet'} />
          <StatCard label="Never earned" icon={Footprints} loading={q.isLoading} value={formatNumber(neverEarned)}
            hint={neverEarned ? 'Check their criteria' : 'Every badge has been earned'} tone={neverEarned ? 'warning' : 'default'} />
        </section>
      )}

      <AdminTable
        columns={columns}
        data={rows}
        rowKey={(b) => b.id}
        isLoading={q.isLoading}
        error={q.error && !q.data ? q.error : undefined}
        onRetry={() => void q.refetch()}
        onRowClick={(b) => setSelectedId(b.id)}
        isRowActive={(b) => b.id === selectedId}
        toolbar={
          <Toolbar actions={<span className="num text-xs text-ink-muted">{`${rows.length} of ${badges.length}`}</span>}>
            <SearchInput size="sm" value={search} onChange={setSearch} placeholder="Search badges" />
            <SegmentedControl label="Badge type" items={typeItems} value={type} onChange={setType} />
          </Toolbar>
        }
        emptyState={
          <EmptyState size="compact" icon={Award} title={badges.length ? 'No badges match' : 'No badges defined'}
            description={badges.length ? 'Clear the search or pick another type.' : 'Create the first badge to reward milestones and streaks.'}
            action={!badges.length ? <Button size="sm" variant="primary" leftIcon={<Plus size={13} />} onClick={() => setEditing('new')}>New badge</Button> : undefined} />
        }
      />

      <BadgeDrawer badge={selected} onClose={() => setSelectedId(null)} onEdit={(b) => setEditing(b)}
        onDeleted={(name) => { setSelectedId(null); setNotice(`Badge “${name}” deleted.`); void qc.invalidateQueries({ queryKey: ['admin', 'badges'] }) }} />
      {editing && <BadgeForm key={editing === 'new' ? 'new' : editing.id} badge={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={afterSave} />}
    </div>
  )
}

function BadgeDrawer({ badge, onClose, onEdit, onDeleted }: {
  badge: BadgeDef | null; onClose: () => void; onEdit: (b: BadgeDef) => void; onDeleted: (name: string) => void
}) {
  const qc = useQueryClient()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [award, setAward] = useState<ConsoleUser | null>(null)
  const [userSearch, setUserSearch] = useState('')
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null)
  const uq = useDebounced(userSearch.trim(), 300)
  const usersQ = useQuery({
    queryKey: ['admin', 'users', 'badge-picker', uq],
    queryFn: () => consoleApi.listUsers({ page: 1, page_size: 6, search: uq }),
    enabled: !!badge && uq.length >= 2,
  })
  const del = useMutation({
    mutationFn: () => consoleApi.deleteBadge(badge!.id),
    onSuccess: () => { setConfirmDelete(false); onDeleted(badge!.name) },
  })
  const give = useMutation({
    mutationFn: (u: ConsoleUser) => consoleApi.awardBadge(badge!.id, u.id),
    onSuccess: (res) => {
      setAward(null)
      setUserSearch('')
      setNotice({ tone: 'success', text: res.created ? `Awarded to ${res.user}.` : `${res.user} already had this badge; nothing changed.` })
      void qc.invalidateQueries({ queryKey: ['admin', 'badges'] })
    },
    onError: (e) => { setAward(null); setNotice({ tone: 'danger', text: e instanceof Error ? e.message : 'Award failed' }) },
  })

  return (
    <SlideOver open={!!badge} onClose={onClose} width={520} title={badge?.name ?? ''} subtitle={badge ? humanize(badge.badge_type) : undefined}
      footer={badge && (
        <>
          <Button size="sm" variant="danger-soft" leftIcon={<Trash2 size={13} />} onClick={() => setConfirmDelete(true)}>Delete</Button>
          <Button size="sm" variant="secondary" leftIcon={<Pencil size={13} />} onClick={() => onEdit(badge)}>Edit</Button>
        </>
      )}>
      {badge && (
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <BadgeIcon type={badge.badge_type} size={44} />
            <p className="text-sm text-ink-secondary">{badge.description}</p>
          </div>
          <div>
            <DetailRow label="Awarded when" value={criteriaText(badge)} />
            <DetailRow label="Earned by" value={`${formatNumber(badge.users_earned)} users`} />
            <DetailRow label="Slug" value={badge.slug} mono />
            <DetailRow label="Created" value={<Timestamp value={badge.created_at} exact />} />
          </div>

          <div>
            <SectionTitle>Award manually</SectionTitle>
            {notice && <div className="mb-2"><ActionNotice tone={notice.tone} onDismiss={() => setNotice(null)}>{notice.text}</ActionNotice></div>}
            <SearchInput size="sm" value={userSearch} onChange={setUserSearch} placeholder="Find a user by name, email or phone" containerClassName="sm:w-full" />
            {uq.length >= 2 && (
              <div className="mt-2 rounded-md border border-surface-border">
                {usersQ.isLoading ? <p className="px-3 py-2 text-xs text-ink-muted">Searching…</p> : usersQ.error ? (
                  <ErrorState size="compact" error={usersQ.error} onRetry={() => void usersQ.refetch()} />
                ) : !usersQ.data?.results.length ? <p className="px-3 py-2 text-xs text-ink-muted">No users found.</p> : (
                  <ul className="divide-y divide-[var(--border)]">
                    {usersQ.data.results.map((u) => (
                      <li key={u.id} className="flex items-center justify-between gap-3 px-3 py-1.5">
                        <UserCell username={u.username} secondary={u.email} />
                        <Button size="sm" variant="secondary" leftIcon={<UserPlus size={13} />} onClick={() => setAward(u)}>Award</Button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {badge && (
        <ConfirmModal open={confirmDelete} onClose={() => setConfirmDelete(false)} onConfirm={() => del.mutate()} loading={del.isPending}
          variant="danger" title="Delete badge" confirmLabel="Delete badge" confirmText={badge.users_earned ? badge.slug : undefined}
          message={badge.users_earned ? `The badge disappears from the profiles of ${formatNumber(badge.users_earned)} users who earned it.` : 'Nobody has earned this badge yet.'}
          details={[{ label: 'Badge', value: badge.name }, { label: 'Earned by', value: formatNumber(badge.users_earned) }]}
          consequence="This cannot be undone.">
          {del.error && <p role="alert" className="text-sm text-danger">{del.error.message}</p>}
        </ConfirmModal>
      )}
      {badge && award && (
        <ConfirmModal open onClose={() => setAward(null)} onConfirm={() => give.mutate(award)} loading={give.isPending} variant="info"
          title="Award badge" confirmLabel="Award badge" message="The badge is added to the user's profile and shows as new in the app."
          details={[{ label: 'Badge', value: badge.name }, { label: 'User', value: award.username }]} />
      )}
    </SlideOver>
  )
}

function BadgeForm({ badge, onClose, onSaved }: { badge: BadgeDef | null; onClose: () => void; onSaved: (msg: string) => void }) {
  const [form, setForm] = useState({
    name: badge?.name ?? '', slug: badge?.slug ?? '', description: badge?.description ?? '',
    badge_type: badge?.badge_type ?? 'achievement', criteria_type: badge?.criteria_type ?? 'manual',
    criteria_value: badge?.criteria_value != null ? String(badge.criteria_value) : '',
  })
  const [slugTouched, setSlugTouched] = useState(!!badge)
  const [fields, setFields] = useState<Record<string, string>>({})
  const save = useMutation({
    mutationFn: () => {
      const payload = {
        name: form.name.trim(), slug: form.slug.trim(), description: form.description.trim(),
        badge_type: form.badge_type, criteria_type: form.criteria_type,
        criteria_value: needsValue(form.criteria_type) ? Number(form.criteria_value) : null,
      }
      return badge ? consoleApi.updateBadge(badge.id, payload) : consoleApi.createBadge({ ...payload, icon: form.badge_type.slice(0, 10) })
    },
    onSuccess: (b) => onSaved(badge ? `Saved “${b.name}”.` : `Created “${b.name}”.`),
    onError: (e) => { if (e instanceof ApiError) setFields(e.fields) },
  })
  const valueMissing = needsValue(form.criteria_type) && !(Number(form.criteria_value) > 0)
  const invalid = !form.name.trim() || !form.slug.trim() || !form.description.trim() || valueMissing
  const unit = CRITERIA.find((c) => c.value === form.criteria_type)?.unit

  return (
    <Modal open onClose={save.isPending ? () => undefined : onClose} dismissible={!save.isPending} size="md"
      title={badge ? `Edit ${badge.name}` : 'New badge'}
      description="The app shows the name and description. Type sets the icon everywhere."
      footer={<>
        <Button variant="secondary" onClick={onClose} disabled={save.isPending}>Cancel</Button>
        <Button variant="primary" onClick={() => save.mutate()} loading={save.isPending} disabled={invalid}>{badge ? 'Save changes' : 'Create badge'}</Button>
      </>}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (!invalid) save.mutate() }}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Input label="Name" required value={form.name} maxLength={100} error={fields.name}
            onChange={(e) => setForm({ ...form, name: e.target.value, slug: slugTouched ? form.slug : slugify(e.target.value) })} />
          <Input label="Slug" required className="mono" value={form.slug} maxLength={50} error={fields.slug} hint="Unique ID used by the app"
            onChange={(e) => { setSlugTouched(true); setForm({ ...form, slug: slugify(e.target.value) }) }} />
        </div>
        <Textarea label="Description" required rows={2} value={form.description} error={fields.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Select label="Type" value={form.badge_type} onChange={(e) => setForm({ ...form, badge_type: e.target.value })} error={fields.badge_type}>
            {TYPES.map((t) => <option key={t} value={t}>{humanize(t)}</option>)}
          </Select>
          <div className="flex items-end gap-2 pb-0.5">
            <BadgeIcon type={form.badge_type} size={36} />
            <span className="text-xs text-ink-muted">Icon shown for {humanize(form.badge_type).toLowerCase()} badges</span>
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Select label="Awarded when" value={form.criteria_type} onChange={(e) => setForm({ ...form, criteria_type: e.target.value })} error={fields.criteria_type}>
            {CRITERIA.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </Select>
          {unit && (
            <Input label={`Threshold (${unit})`} type="number" min={1} required value={form.criteria_value} error={fields.criteria_value ?? (valueMissing && form.criteria_value ? 'Enter a number above 0' : undefined)}
              onChange={(e) => setForm({ ...form, criteria_value: e.target.value })} />
          )}
        </div>
        {save.error && !Object.keys(fields).length && <p role="alert" className="text-sm text-danger">{save.error.message}</p>}
        <button type="submit" hidden />
      </form>
    </Modal>
  )
}
