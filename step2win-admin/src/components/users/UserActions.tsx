import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { ConfirmModal } from '../ConfirmModal'
import { Modal } from '../ui/Modal'
import { Button } from '../ui/Button'
import { Input, Textarea } from '../ui/Input'
import { formatKES, formatNumber } from '../../lib/format'
import { ApiError, consoleApi } from './api'
import type { ConsoleUser, UserFlag } from './types'
import { humanize } from './utils'

export type UserAction =
  | { kind: 'ban' | 'unban' | 'grant-staff' | 'remove-staff' | 'reset-steps' | 'delete' | 'reset-password' | 'edit' }
  | { kind: 'flag'; flag: UserFlag; action: FlagAction }

export type FlagAction = 'dismiss' | 'warn' | 'restrict' | 'suspend'

interface Props {
  user: ConsoleUser
  action: UserAction | null
  onClose: () => void
  /** Called after a successful action with a human summary. */
  onDone: (message: string, opts?: { deleted?: boolean }) => void
}

const FLAG_COPY: Record<FlagAction, { title: string; message: string; consequence: string; confirm: string; variant: 'danger' | 'warning' | 'info' }> = {
  dismiss: {
    title: 'Dismiss flag',
    message: 'Marks this flag as reviewed with no action. The user regains 10 trust points (max 100).',
    consequence: 'Use when the activity is explained and legitimate.',
    confirm: 'Dismiss flag',
    variant: 'info',
  },
  warn: {
    title: 'Warn user',
    message: 'Marks the flag as actioned and deducts 5 trust points.',
    consequence: 'The account keeps full access.',
    confirm: 'Warn user',
    variant: 'warning',
  },
  restrict: {
    title: 'Restrict user',
    message: 'Sets the trust score to 35 (Restricted). Anti-cheat treats restricted users more strictly on future syncs.',
    consequence: 'The account can still sign in; its step rewards are limited by anti-cheat.',
    confirm: 'Restrict user',
    variant: 'danger',
  },
  suspend: {
    title: 'Suspend user',
    message: 'Sets the trust score to 10 (Suspended).',
    consequence: 'Anti-cheat rejects most step submissions from suspended users until the score recovers.',
    confirm: 'Suspend user',
    variant: 'danger',
  },
}

/** Every consequential action on a user, each behind a confirmation that states what happens. */
export function UserActions({ user, action, onClose, onDone }: Props) {
  const [reason, setReason] = useState('')
  const [password, setPassword] = useState('')
  const [password2, setPassword2] = useState('')
  const [form, setForm] = useState({ username: user.username, email: user.email, phone_number: user.phone_number ?? '' })
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)

  const reset = () => {
    setReason('')
    setPassword('')
    setPassword2('')
    setError(null)
    setFieldErrors({})
  }
  const close = () => {
    reset()
    onClose()
  }

  const m = useMutation({
    mutationFn: async (a: UserAction): Promise<{ message: string; deleted?: boolean }> => {
      const r = reason.trim()
      switch (a.kind) {
        case 'ban': await consoleApi.banUser(user.id, r); return { message: `${user.username} is banned and can no longer sign in.` }
        case 'unban': await consoleApi.unbanUser(user.id, r); return { message: `${user.username} can sign in again.` }
        case 'grant-staff': await consoleApi.makeStaff(user.id, r); return { message: `${user.username} now has staff access.` }
        case 'remove-staff': await consoleApi.removeStaff(user.id, r); return { message: `Staff access removed from ${user.username}.` }
        case 'reset-steps': await consoleApi.resetSteps(user.id, r); return { message: `Lifetime step counters reset for ${user.username}.` }
        case 'delete': await consoleApi.deleteUser(user.id, r); return { message: `${user.username} was permanently deleted.`, deleted: true }
        case 'reset-password': await consoleApi.resetPassword(user.id, password, r); return { message: `Password reset for ${user.username}. Share it through a verified channel.` }
        case 'edit': {
          const diff: Record<string, string> = {}
          if (form.username.trim() !== user.username) diff.username = form.username.trim()
          if (form.email.trim() !== user.email) diff.email = form.email.trim()
          if (form.phone_number.trim() !== (user.phone_number ?? '')) diff.phone_number = form.phone_number.trim()
          if (!Object.keys(diff).length) return { message: 'No changes to save.' }
          await consoleApi.updateUser(user.id, diff)
          return { message: `Saved ${Object.keys(diff).map(humanize).join(', ').toLowerCase()} for ${form.username.trim()}.` }
        }
        case 'flag': await consoleApi.actionFlag(a.flag.id, a.action, r); return { message: `Flag ${humanize(a.flag.flag_type).toLowerCase()} ${a.action === 'dismiss' ? 'dismissed' : `actioned: ${a.action}`}.` }
      }
    },
    onSuccess: (res) => {
      reset()
      onDone(res.message, { deleted: res.deleted })
    },
    onError: (e) => {
      setError(e instanceof Error ? e.message : 'The request failed.')
      if (e instanceof ApiError) setFieldErrors(e.fields)
    },
  })

  if (!action) return null
  const loading = m.isPending
  const run = () => m.mutate(action)
  const who = [
    { label: 'User', value: user.username },
    { label: 'Email', value: <span className="mono text-[12px]">{user.email || '—'}</span> },
  ]
  const money = [
    { label: 'Available balance', value: <span className="mono">{formatKES(user.available_balance)}</span> },
    { label: 'Locked in challenges', value: <span className="mono">{formatKES(user.locked_balance)}</span> },
  ]
  const errorLine = error ? <p role="alert" className="text-sm text-danger">{error}</p> : null
  const reasonField = (required: boolean, label = 'Reason (kept in the audit log)') => (
    <Textarea
      label={label}
      value={reason}
      onChange={(e) => setReason(e.target.value)}
      required={required}
      maxLength={500}
      rows={2}
      placeholder={required ? 'Required' : 'Optional'}
    />
  )

  switch (action.kind) {
    case 'ban':
      return (
        <ConfirmModal
          open onClose={close} onConfirm={run} loading={loading} variant="danger"
          title={`Ban ${user.username}`} confirmLabel="Ban user" confirmDisabled={!reason.trim()}
          message="The account is deactivated immediately. Existing sessions stop working on their next request and the user cannot sign in."
          details={[...who, ...money]}
          consequence="Balances are not moved. Locked entries stay in their challenges. Unban to restore access."
        >
          {reasonField(true)}
          {errorLine}
        </ConfirmModal>
      )
    case 'unban':
      return (
        <ConfirmModal
          open onClose={close} onConfirm={run} loading={loading} variant="warning"
          title={`Unban ${user.username}`} confirmLabel="Restore access"
          message="The account is reactivated and the user can sign in again. Their trust score is not changed."
          details={who}
        >
          {reasonField(false)}
          {errorLine}
        </ConfirmModal>
      )
    case 'grant-staff':
      return (
        <ConfirmModal
          open onClose={close} onConfirm={run} loading={loading} variant="danger"
          title={`Give ${user.username} staff access`} confirmLabel="Grant staff access" confirmText={user.username}
          confirmDisabled={!reason.trim()}
          message="Staff can open this console: approve withdrawals, ban users, cancel challenges and read every user's financial records."
          details={who}
          consequence="Only grant this to verified team members."
        >
          {reasonField(true)}
          {errorLine}
        </ConfirmModal>
      )
    case 'remove-staff':
      return (
        <ConfirmModal
          open onClose={close} onConfirm={run} loading={loading} variant="danger"
          title={`Remove staff access from ${user.username}`} confirmLabel="Remove staff access"
          message="They lose access to this console on their next request. Their player account is unaffected."
          details={who}
        >
          {reasonField(false)}
          {errorLine}
        </ConfirmModal>
      )
    case 'reset-steps':
      return (
        <ConfirmModal
          open onClose={close} onConfirm={run} loading={loading} variant="danger"
          title="Reset lifetime step counters" confirmLabel="Reset counters" confirmDisabled={!reason.trim()}
          message="Sets lifetime total steps and best day to 0 on the profile."
          details={[
            ...who,
            { label: 'Lifetime steps', value: <span className="num">{formatNumber(user.total_steps)}</span> },
          ]}
          consequence="Daily step history and challenge progress are not changed. This cannot be undone."
        >
          {reasonField(true)}
          {errorLine}
        </ConfirmModal>
      )
    case 'delete':
      return (
        <ConfirmModal
          open onClose={close} onConfirm={run} loading={loading} variant="danger"
          title={`Delete ${user.username} permanently`} confirmLabel="Delete account" confirmText={user.username}
          confirmDisabled={!reason.trim()}
          message="Deletes the account and its step history, sessions, challenge entries and wallet ledger. Accounts with a balance or withdrawal records cannot be deleted — ban them instead."
          details={[...who, ...money]}
          consequence="This cannot be undone."
        >
          {reasonField(true)}
          {errorLine}
        </ConfirmModal>
      )
    case 'flag': {
      const copy = FLAG_COPY[action.action]
      return (
        <ConfirmModal
          open onClose={close} onConfirm={run} loading={loading} variant={copy.variant}
          title={copy.title} confirmLabel={copy.confirm}
          message={copy.message}
          details={[
            { label: 'User', value: user.username },
            { label: 'Flag', value: humanize(action.flag.flag_type) },
            { label: 'Severity', value: humanize(action.flag.severity) },
            { label: 'Trust score now', value: <span className="num">{user.trust_score}</span> },
          ]}
          consequence={copy.consequence}
        >
          {reasonField(false, 'Note (saved on the flag)')}
          {errorLine}
        </ConfirmModal>
      )
    }
    case 'reset-password': {
      const mismatch = password2.length > 0 && password !== password2
      return (
        <Modal
          open onClose={loading ? () => undefined : close} dismissible={!loading} size="sm"
          title={`Set a new password for ${user.username}`}
          description="The user's current password stops working immediately."
          footer={
            <>
              <Button variant="secondary" onClick={close} disabled={loading}>Cancel</Button>
              <Button variant="primary" onClick={run} loading={loading} disabled={password.length < 8 || mismatch || !password2 || !reason.trim()}>
                Set password
              </Button>
            </>
          }
        >
          <div className="space-y-3">
            <Input label="New password" type="password" autoComplete="new-password" value={password}
              onChange={(e) => setPassword(e.target.value)} hint="At least 8 characters; common passwords are rejected by the server."
              error={fieldErrors.new_password} />
            <Input label="Repeat password" type="password" autoComplete="new-password" value={password2}
              onChange={(e) => setPassword2(e.target.value)} error={mismatch ? 'Passwords do not match' : undefined} />
            {reasonField(true)}
            {errorLine}
          </div>
        </Modal>
      )
    }
    case 'edit':
      return (
        <Modal
          open onClose={loading ? () => undefined : close} dismissible={!loading} size="sm"
          title={`Edit ${user.username}`} description="Changes are recorded in the audit log with the previous values."
          footer={
            <>
              <Button variant="secondary" onClick={close} disabled={loading}>Cancel</Button>
              <Button variant="primary" onClick={run} loading={loading}
                disabled={!form.username.trim() || !form.email.trim() || !form.phone_number.trim()}>
                Save changes
              </Button>
            </>
          }
        >
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); run() }}>
            <Input label="Username" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} error={fieldErrors.username} required />
            <Input label="Email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} error={fieldErrors.email} required />
            <Input label="Phone number" className="mono" inputMode="tel" value={form.phone_number}
              onChange={(e) => setForm({ ...form, phone_number: e.target.value })} error={fieldErrors.phone_number}
              hint="Used for M-Pesa payouts. Format 2547XXXXXXXX." required />
            {error && !Object.keys(fieldErrors).length && errorLine}
            <button type="submit" hidden />
          </form>
        </Modal>
      )
  }
}
