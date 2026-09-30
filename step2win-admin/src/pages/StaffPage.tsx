import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, KeyRound, MailPlus, RefreshCw, ShieldCheck, UserCog, UserMinus } from 'lucide-react'
import { PageHeader } from '../components/PageHeader'
import { AdminTable, type Column } from '../components/AdminTable'
import { StatusBadge } from '../components/StatusBadge'
import { ConfirmModal } from '../components/ConfirmModal'
import { Panel } from '../components/ui/Card'
import { Button } from '../components/ui/Button'
import { Input, Textarea } from '../components/ui/Input'
import { Modal } from '../components/ui/Modal'
import { EmptyState } from '../components/ui/EmptyState'
import { ErrorState } from '../components/ui/ErrorState'
import { consoleApi } from '../components/users/api'
import type { RoleInfo, StaffInviteRow, StaffRow } from '../components/users/partATypes'
import { ActionNotice, Timestamp, UserCell } from '../components/users/shared'
import { usePermissions } from '../lib/permissions'

const ROLE_ORDER = ['owner', 'finance', 'support', 'trust', 'content', 'settings']

function RoleChips({ roles, labels }: { roles: string[]; labels: Record<string, string> }) {
  const shown = roles.includes('owner') ? ['owner'] : roles
  return (
    <span className="flex flex-wrap gap-1">
      {shown.length === 0 ? <span className="text-xs text-ink-muted">No roles</span> : shown.map((r) => (
        <StatusBadge key={r} size="sm" tone={r === 'owner' ? 'violet' : 'neutral'} label={labels[r] ?? r} />
      ))}
    </span>
  )
}

function RolePicker({ catalog, value, onChange }: { catalog: RoleInfo[]; value: string[]; onChange: (v: string[]) => void }) {
  const toggle = (r: string) => onChange(value.includes(r) ? value.filter((x) => x !== r) : [...value, r])
  return (
    <fieldset className="space-y-1.5">
      <legend className="mb-1 text-xs font-medium text-ink-secondary">Roles</legend>
      {catalog.map((r) => (
        <label key={r.value} className="flex cursor-pointer items-start gap-2.5 rounded-md border border-surface-border px-3 py-2 hover:bg-surface-elevated">
          <input type="checkbox" className="mt-0.5 accent-[var(--brand)]" checked={value.includes(r.value)} onChange={() => toggle(r.value)} />
          <span className="min-w-0">
            <span className="block text-sm font-medium text-ink-primary">{r.label}{r.value === 'owner' && <span className="ml-1.5 text-xs font-normal text-warning">full control</span>}</span>
            <span className="block text-xs text-ink-muted">{r.description}</span>
          </span>
        </label>
      ))}
    </fieldset>
  )
}

export function StaffPage() {
  const qc = useQueryClient()
  const perms = usePermissions()
  const q = useQuery({ queryKey: ['admin', 'staff'], queryFn: consoleApi.staff, enabled: perms.isOwner })
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null)
  const [inviteOpen, setInviteOpen] = useState(false)
  const [identifier, setIdentifier] = useState('')
  const [inviteRoles, setInviteRoles] = useState<string[]>(['support'])
  const [reason, setReason] = useState('')
  const [code, setCode] = useState<string | null>(null)
  const [editing, setEditing] = useState<StaffRow | null>(null)
  const [editRoles, setEditRoles] = useState<string[]>([])
  const [removing, setRemoving] = useState<StaffRow | null>(null)
  const [error, setError] = useState<string | null>(null)

  const catalog = q.data?.catalog.roles.slice().sort((a, b) => ROLE_ORDER.indexOf(a.value) - ROLE_ORDER.indexOf(b.value)) ?? []
  const labels = Object.fromEntries(catalog.map((r) => [r.value, r.label]))
  const refresh = () => void qc.invalidateQueries({ queryKey: ['admin', 'staff'] })
  const fail = (e: unknown) => setError(e instanceof Error ? e.message : 'The request failed.')

  const invite = useMutation({
    mutationFn: () => consoleApi.inviteStaff(identifier.trim(), inviteRoles, reason.trim()),
    onSuccess: (res) => {
      setInviteOpen(false)
      setError(null)
      if (res.code) setCode(res.code)
      else setNotice({ tone: 'success', text: `${identifier.trim()} now has staff access.` })
      setIdentifier(''); setReason('')
      refresh()
    },
    onError: fail,
  })
  const saveRoles = useMutation({
    mutationFn: () => consoleApi.setStaffRoles(editing!.id, editRoles, reason.trim()),
    onSuccess: () => { setNotice({ tone: 'success', text: `Roles updated for ${editing?.username}.` }); setEditing(null); setReason(''); setError(null); refresh() },
    onError: fail,
  })
  const remove = useMutation({
    mutationFn: () => consoleApi.removeStaffAccess(removing!.id, reason.trim()),
    onSuccess: () => { setNotice({ tone: 'success', text: `${removing?.username} no longer has staff access and was signed out.` }); setRemoving(null); setReason(''); setError(null); refresh() },
    onError: fail,
  })
  const revoke = useMutation({
    mutationFn: (id: number) => consoleApi.revokeInvite(id),
    onSuccess: () => { setNotice({ tone: 'success', text: 'Invite revoked.' }); refresh() },
    onError: (e) => setNotice({ tone: 'danger', text: e instanceof Error ? e.message : 'Could not revoke.' }),
  })

  if (!perms.loading && !perms.isOwner) {
    return (
      <div className="space-y-5">
        <PageHeader title="Staff & roles" description="Who can use this console and what each person can do." />
        <EmptyState icon={ShieldCheck} title="Only the owner can manage staff" description="Ask the owner if you need a different role." />
      </div>
    )
  }

  const columns: Column<StaffRow>[] = [
    { key: 'user', label: 'Staff member', render: (s) => <UserCell username={s.username} secondary={s.email} /> },
    { key: 'roles', label: 'Roles', render: (s) => (
      <span className="flex flex-wrap items-center gap-1.5">
        <RoleChips roles={s.roles} labels={labels} />
        {s.legacy_roles && <span className="text-2xs text-ink-muted">(default, from before roles)</span>}
      </span>
    ) },
    { key: 'status', label: 'Status', hideBelow: 'md', render: (s) => <StatusBadge size="sm" status={s.is_active ? 'active' : 'banned'} /> },
    { key: 'last', label: 'Last sign-in', hideBelow: 'lg', render: (s) => <Timestamp value={s.last_login} className="text-ink-secondary" /> },
  ]
  const inviteColumns: Column<StaffInviteRow>[] = [
    { key: 'email', label: 'Email', render: (i) => <span className="font-medium text-ink-primary">{i.email}</span> },
    { key: 'roles', label: 'Roles', render: (i) => <RoleChips roles={i.roles} labels={labels} /> },
    { key: 'status', label: 'Status', render: (i) => <StatusBadge size="sm" tone={i.status === 'pending' ? 'warning' : i.status === 'accepted' ? 'success' : 'neutral'} label={i.status === 'accepted' && i.accepted_username ? `Joined as ${i.accepted_username}` : i.status[0].toUpperCase() + i.status.slice(1)} /> },
    { key: 'code', label: 'Code ends', hideBelow: 'md', render: (i) => <span className="mono text-xs">…{i.code_hint}</span> },
    { key: 'expires', label: 'Expires', hideBelow: 'lg', render: (i) => <Timestamp value={i.expires_at} className="text-ink-secondary" /> },
  ]
  const me = perms.data?.user_id

  return (
    <div className="space-y-5">
      <PageHeader
        title="Staff & roles"
        description="Invite team members, choose what each person can do, and remove access. Every change is recorded in the audit log."
        actions={
          <>
            <Button size="sm" variant="secondary" leftIcon={<RefreshCw size={13} />} loading={q.isFetching} onClick={() => void q.refetch()}>Refresh</Button>
            <Button size="sm" variant="primary" leftIcon={<MailPlus size={13} />} onClick={() => { setError(null); setInviteOpen(true) }}>Invite staff</Button>
          </>
        }
      />
      {notice && <ActionNotice tone={notice.tone} onDismiss={() => setNotice(null)}>{notice.text}</ActionNotice>}
      {q.error && <ErrorState variant="inline" error={q.error} onRetry={() => void q.refetch()} />}

      <AdminTable
        title="Staff"
        subtitle="The owner can do everything. Other roles only see and change their own area; the server refuses anything else."
        columns={columns}
        data={q.data?.staff ?? []}
        rowKey={(s) => s.id}
        isLoading={q.isLoading}
        density="compact"
        rowActions={(s) => (
          <span className="flex gap-1.5">
            <Button size="sm" variant="secondary" leftIcon={<UserCog size={13} />} onClick={() => { setError(null); setReason(''); setEditRoles(s.roles.includes('owner') ? ['owner'] : s.roles); setEditing(s) }}>Roles</Button>
            <Button size="sm" variant="danger-soft" leftIcon={<UserMinus size={13} />} disabled={s.id === me} title={s.id === me ? 'You cannot remove your own access' : undefined}
              onClick={() => { setError(null); setReason(''); setRemoving(s) }}>Remove</Button>
          </span>
        )}
        emptyMessage="No staff yet"
      />

      <Panel padding="none" title="Invites" description="One-time codes for people who don't have an account yet. Valid for 7 days; the code is shown once.">
        {(q.data?.invites.length ?? 0) === 0 ? (
          <EmptyState size="compact" icon={KeyRound} title="No invites" description="Invite someone by email to create one." />
        ) : (
          <AdminTable
            columns={inviteColumns}
            data={q.data?.invites ?? []}
            rowKey={(i) => i.id}
            density="compact"
            rowActions={(i) => i.status === 'pending' ? <Button size="sm" variant="ghost" loading={revoke.isPending && revoke.variables === i.id} onClick={() => revoke.mutate(i.id)}>Revoke</Button> : null}
          />
        )}
      </Panel>

      <Modal open={inviteOpen} onClose={() => !invite.isPending && setInviteOpen(false)} title="Invite staff" size="md"
        description="Enter an existing account's email or username to give it access now, or a new person's email to create a one-time invite code."
        footer={<>
          <Button variant="secondary" onClick={() => setInviteOpen(false)} disabled={invite.isPending}>Cancel</Button>
          <Button variant="primary" loading={invite.isPending} disabled={!identifier.trim() || inviteRoles.length === 0} onClick={() => invite.mutate()}>Invite</Button>
        </>}>
        <div className="space-y-3">
          <Input label="Email or username" value={identifier} onChange={(e) => setIdentifier(e.target.value)} placeholder="name@company.com" autoFocus />
          {catalog.length > 0 && <RolePicker catalog={catalog} value={inviteRoles} onChange={setInviteRoles} />}
          <Textarea label="Note (kept in the audit log)" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
          {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        </div>
      </Modal>

      <Modal open={!!code} onClose={() => setCode(null)} title="Invite code" size="sm"
        description="Share this code with the person through a trusted channel. They sign up on the console's registration page with their email and this code. It is shown only once."
        footer={<Button variant="primary" onClick={() => setCode(null)}>Done</Button>}>
        <div className="flex items-center justify-between gap-3 rounded-md border border-surface-border bg-surface-sunken px-3 py-3">
          <span className="mono text-lg font-semibold tracking-wider text-ink-primary">{code}</span>
          <Button size="sm" variant="secondary" leftIcon={<Copy size={13} />} onClick={() => void navigator.clipboard?.writeText(code ?? '')}>Copy</Button>
        </div>
      </Modal>

      <Modal open={!!editing} onClose={() => !saveRoles.isPending && setEditing(null)} title={`Roles for ${editing?.username ?? ''}`} size="md"
        description="Takes effect on their next request."
        footer={<>
          <Button variant="secondary" onClick={() => setEditing(null)} disabled={saveRoles.isPending}>Cancel</Button>
          <Button variant="primary" loading={saveRoles.isPending} disabled={editRoles.length === 0} onClick={() => saveRoles.mutate()}>Save roles</Button>
        </>}>
        <div className="space-y-3">
          <RolePicker catalog={catalog} value={editRoles} onChange={setEditRoles} />
          <Textarea label="Reason (kept in the audit log)" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
          {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        </div>
      </Modal>

      <ConfirmModal open={!!removing} onClose={() => setRemoving(null)} onConfirm={() => remove.mutate()} loading={remove.isPending}
        variant="danger" title={`Remove staff access from ${removing?.username ?? ''}`} confirmLabel="Remove access" confirmDisabled={reason.trim().length < 3}
        message="They lose console access immediately and are signed out on every device. Their player account is kept."
        details={[{ label: 'Staff member', value: removing?.username }, { label: 'Roles', value: removing?.roles.join(', ') || '—' }]}>
        <Textarea label="Reason (kept in the audit log)" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} required />
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      </ConfirmModal>
    </div>
  )
}
