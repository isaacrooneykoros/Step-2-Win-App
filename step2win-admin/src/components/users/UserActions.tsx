import { useState, type ReactNode } from 'react'
import { useMutation } from '@tanstack/react-query'
import { ConfirmModal } from '../ConfirmModal'
import { Modal } from '../ui/Modal'
import { Button } from '../ui/Button'
import { Input, Select, Textarea } from '../ui/Input'
import { formatKES, formatNumber } from '../../lib/format'
import { ApiError, consoleApi } from './api'
import type { ConsoleUser, UserFlag } from './types'
import { newIdempotencyKey } from './partATypes'
import { humanize } from './utils'

export type UserAction =
  | { kind: 'ban' | 'unban' | 'delete' | 'reset-password' | 'edit' | 'sign-out' | 'unlock' | 'adjust-balance' | 'adjust-xp' | 'message' }
  | { kind: 'flag'; flag: UserFlag; action: FlagAction }
  | { kind: 'device-reset'; registrationId?: string; label?: string }
  | { kind: 'revoke-badge'; badgeId: number; badgeName: string }
  | { kind: 'correct-steps'; date?: string; steps?: number }
  | { kind: 'reverse'; txnId: number; amount: string; type: string; description: string }

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

const REASON_MIN = 5

/** Every consequential action on a user, each behind a confirmation that states what happens. */
export function UserActions({ user, action, onClose, onDone }: Props) {
  const [reason, setReason] = useState('')
  const [password, setPassword] = useState('')
  const [password2, setPassword2] = useState('')
  const [form, setForm] = useState({
    username: user.username, email: user.email, phone_number: user.phone_number ?? '',
    first_name: user.first_name ?? '', last_name: user.last_name ?? '', daily_goal: String(user.daily_goal ?? ''),
  })
  const [amount, setAmount] = useState('')
  const [reference, setReference] = useState('')
  const [subject, setSubject] = useState('')
  const [message, setMessage] = useState('')
  const [stepKind, setStepKind] = useState<'set' | 'void' | 'clear'>('set')
  const [stepDate, setStepDate] = useState(action && action.kind === 'correct-steps' ? action.date ?? '' : '')
  const [steps, setSteps] = useState(action && action.kind === 'correct-steps' && action.steps !== undefined ? String(action.steps) : '')
  // One idempotency key per opened form: a double click or a retry can't apply twice.
  const [idemKey] = useState(newIdempotencyKey)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)

  const close = () => {
    setError(null)
    setFieldErrors({})
    onClose()
  }

  const m = useMutation({
    mutationFn: async (a: UserAction): Promise<{ message: string; deleted?: boolean }> => {
      const r = reason.trim()
      switch (a.kind) {
        case 'ban': await consoleApi.banUser(user.id, r); return { message: `${user.username} is banned and can no longer sign in.` }
        case 'unban': await consoleApi.unbanUser(user.id, r); return { message: `${user.username} can sign in again.` }
        case 'delete': await consoleApi.deleteUser(user.id, r); return { message: `${user.username} was deleted and anonymised.`, deleted: true }
        case 'reset-password': await consoleApi.resetPassword(user.id, password, r); return { message: `Password reset for ${user.username}. Share it through a verified channel.` }
        case 'sign-out': await consoleApi.signOutEverywhere(user.id); return { message: `${user.username} was signed out on every device.` }
        case 'unlock': await consoleApi.unlockLogin(user.id); return { message: `Sign-in lockout cleared for ${user.username}.` }
        case 'device-reset':
          await consoleApi.resetDevice(user.id, a.registrationId ? { mode: 'deactivate', registration_id: a.registrationId, reason: r } : { mode: 'reset', reason: r })
          return { message: a.registrationId ? 'Device deactivated.' : `Device binding reset. ${user.username} can bind a new phone now.` }
        case 'adjust-balance': {
          const res = await consoleApi.adjustBalance({ user_id: user.id, amount: amount.trim(), reason: r, reference: reference.trim() || undefined, idempotency_key: idemKey })
          return {
            message: res.correction.status === 'pending'
              ? `Adjustment of ${formatKES(amount)} is waiting for a second finance approver (Transactions page).`
              : `Balance adjusted by ${formatKES(amount)}. New balance ${formatKES(res.wallet_balance)}.`,
          }
        }
        case 'adjust-xp': {
          const res = await consoleApi.adjustXp(user.id, Number(amount), r)
          return { message: `XP adjusted. ${user.username} now has ${formatNumber(res.total_xp)} XP (level ${res.level}).` }
        }
        case 'revoke-badge': await consoleApi.revokeBadge(user.id, a.badgeId, r); return { message: `Badge ${a.badgeName} revoked.` }
        case 'message': {
          const res = await consoleApi.messageUser(user.id, { subject: subject.trim(), message: message.trim() })
          return { message: `Message sent as support ticket #${res.ticket_id}. Replies appear in Support.` }
        }
        case 'correct-steps': {
          const res = await consoleApi.correctSteps(user.id, { date: stepDate, kind: stepKind, steps: stepKind === 'set' ? Number(steps) : undefined, reason: r })
          return { message: `Steps for ${res.date}: ${formatNumber(res.steps.old)} → ${formatNumber(res.steps.new)}. Live challenges, totals and rankings were recomputed.` }
        }
        case 'edit': {
          const diff: Record<string, string | number> = {}
          if (form.username.trim() !== user.username) diff.username = form.username.trim()
          if (form.email.trim() !== user.email) diff.email = form.email.trim()
          if (form.phone_number.trim() !== (user.phone_number ?? '')) diff.phone_number = form.phone_number.trim()
          if (form.first_name.trim() !== (user.first_name ?? '')) diff.first_name = form.first_name.trim()
          if (form.last_name.trim() !== (user.last_name ?? '')) diff.last_name = form.last_name.trim()
          if (form.daily_goal.trim() && Number(form.daily_goal) !== (user.daily_goal ?? 0)) diff.daily_goal = Number(form.daily_goal)
          if (!Object.keys(diff).length) return { message: 'No changes to save.' }
          await consoleApi.updateUser(user.id, diff)
          return { message: `Saved ${Object.keys(diff).map(humanize).join(', ').toLowerCase()} for ${form.username.trim()}.` }
        }
        case 'reverse': {
          const res = await consoleApi.reverseTransaction(a.txnId, r, idemKey)
          return {
            message: res.correction.status === 'pending'
              ? 'Reversal is waiting for a second finance approver (Transactions page).'
              : `Transaction #${a.txnId} reversed. A reversal row was added to the ledger.`,
          }
        }
        case 'flag': await consoleApi.actionFlag(a.flag.id, a.action, r); return { message: `Flag ${humanize(a.flag.flag_type).toLowerCase()} ${a.action === 'dismiss' ? 'dismissed' : `actioned: ${a.action}`}.` }
      }
    },
    onSuccess: (res) => onDone(res.message, { deleted: res.deleted }),
    onError: (e) => {
      setError(e instanceof Error ? e.message : 'The request failed.')
      if (e instanceof ApiError) setFieldErrors(e.fields)
    },
  })

  if (!action) return null
  const loading = m.isPending
  const run = () => m.mutate(action)
  const reasonOk = reason.trim().length >= REASON_MIN
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
      placeholder={required ? `Required, at least ${REASON_MIN} characters` : 'Optional'}
    />
  )
  const formModal = (title: string, description: string, confirm: string, disabled: boolean, body: ReactNode, variant: 'primary' | 'danger' = 'primary') => (
    <Modal
      open onClose={loading ? () => undefined : close} dismissible={!loading} size="sm" title={title} description={description}
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={loading}>Cancel</Button>
          <Button variant={variant} onClick={run} loading={loading} disabled={disabled}>{confirm}</Button>
        </>
      }
    >
      <div className="space-y-3">{body}{errorLine}</div>
    </Modal>
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
    case 'delete':
      return (
        <ConfirmModal
          open onClose={close} onConfirm={run} loading={loading} variant="danger"
          title={`Delete ${user.username}`} confirmLabel="Delete account" confirmText={user.username}
          confirmDisabled={!reason.trim()}
          message="The account is anonymised and personal data removed. Wallet, payment and challenge records are kept, detached from the person. Accounts holding money or with open withdrawals are refused — ban them instead."
          details={[...who, ...money]}
          consequence="This cannot be undone."
        >
          {reasonField(true)}
          {errorLine}
        </ConfirmModal>
      )
    case 'sign-out':
      return (
        <ConfirmModal
          open onClose={close} onConfirm={run} loading={loading} variant="warning"
          title={`Sign ${user.username} out everywhere`} confirmLabel="Sign out everywhere"
          message="Every refresh token is revoked and every app session ends. The user signs in again with their password."
          details={who}
          consequence="Use after a password reset or when an account may be shared or stolen."
        >
          {errorLine}
        </ConfirmModal>
      )
    case 'unlock':
      return (
        <ConfirmModal
          open onClose={close} onConfirm={run} loading={loading} variant="info"
          title="Clear sign-in lockout" confirmLabel="Clear lockout"
          message="Removes the failed sign-in attempts that locked this account, so the user can try again now."
          details={who}
        >
          {errorLine}
        </ConfirmModal>
      )
    case 'device-reset':
      return (
        <ConfirmModal
          open onClose={close} onConfirm={run} loading={loading} variant="danger"
          title={action.registrationId ? 'Deactivate device' : 'Reset device binding'}
          confirmLabel={action.registrationId ? 'Deactivate device' : 'Reset binding'} confirmDisabled={!reasonOk}
          message={action.registrationId
            ? `The ${action.label ?? 'device'} stops counting steps until the user binds it again.`
            : 'Every registered device is deactivated and the 24-hour device switch wait is lifted, so the user can bind a new phone right away.'}
          details={who}
          consequence="Step history is not changed."
        >
          {reasonField(true)}
          {errorLine}
        </ConfirmModal>
      )
    case 'adjust-balance': {
      const n = Number(amount)
      const valid = amount.trim() !== '' && Number.isFinite(n) && n !== 0
      const below = valid && n < 0 && Math.abs(n) > Number(user.wallet_balance)
      return formModal(
        `Adjust ${user.username}'s balance`,
        'Adds a new "adjustment" row to the wallet ledger (existing rows are never edited). Large amounts wait for a second finance approver.',
        'Adjust balance',
        !valid || below || !reasonOk,
        <>
          <p className="text-sm text-ink-secondary">Current balance <span className="mono font-medium text-ink-primary">{formatKES(user.wallet_balance)}</span></p>
          <Input label="Amount in KES (negative to debit)" inputMode="decimal" className="mono" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 250 or -250"
            error={below ? 'The balance can never go below zero.' : fieldErrors.amount} hint={valid && !below ? `New balance ${formatKES(Number(user.wallet_balance) + n)}` : undefined} />
          <Input label="Reference (optional)" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Ticket, M-Pesa ref…" maxLength={100} />
          {reasonField(true, 'Reason (shown in the ledger and audit log)')}
        </>,
      )
    }
    case 'adjust-xp': {
      const n = Number(amount)
      const valid = Number.isInteger(n) && n !== 0 && Math.abs(n) <= 10000
      return formModal(
        `Adjust XP for ${user.username}`,
        'Recorded as an XP event (admin adjustment). XP never goes below zero.',
        'Adjust XP', !valid || !reasonOk,
        <>
          <p className="text-sm text-ink-secondary">Current XP <span className="num font-medium text-ink-primary">{formatNumber(user.xp_profile?.total_xp ?? 0)}</span></p>
          <Input label="XP to add (negative to remove)" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 100 or -50" />
          {reasonField(true)}
        </>,
      )
    }
    case 'revoke-badge':
      return (
        <ConfirmModal open onClose={close} onConfirm={run} loading={loading} variant="danger" title={`Revoke badge ${action.badgeName}`}
          confirmLabel="Revoke badge" confirmDisabled={!reasonOk} message="The badge is removed from this user's profile. The badge itself stays available." details={who}>
          {reasonField(true)}
          {errorLine}
        </ConfirmModal>
      )
    case 'message':
      return formModal(
        `Message ${user.username}`,
        'Opens a support conversation that the user sees in Support in the app. Their reply comes back to the support inbox.',
        'Send message', !subject.trim() || message.trim().length < 2,
        <>
          <Input label="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={255} />
          <Textarea label="Message" rows={5} value={message} onChange={(e) => setMessage(e.target.value)} maxLength={5000} />
        </>,
      )
    case 'correct-steps': {
      const n = Number(steps)
      const valid = !!stepDate && (stepKind !== 'set' || (steps.trim() !== '' && Number.isInteger(n) && n >= 0 && n <= 150000))
      return formModal(
        `Correct steps for ${user.username}`,
        'Stored as a correction on top of the synced day; raw sync evidence is never changed. Live challenges covering the day, lifetime totals and weekly rankings are recomputed. Days in settled challenges cannot be changed.',
        'Save correction', !valid || !reasonOk,
        <>
          <Input label="Day" type="date" value={stepDate} onChange={(e) => setStepDate(e.target.value)} max={new Date().toISOString().slice(0, 10)} />
          <Select label="Correction" value={stepKind} onChange={(e) => setStepKind(e.target.value as 'set' | 'void' | 'clear')}>
            <option value="set">Set the day's steps</option>
            <option value="void">Void the day (0 steps)</option>
            <option value="clear">Remove the correction (back to synced steps)</option>
          </Select>
          {stepKind === 'set' && <Input label="Steps for the day" inputMode="numeric" value={steps} onChange={(e) => setSteps(e.target.value)} hint="Counts toward goals and challenges" />}
          {reasonField(true)}
        </>,
        stepKind === 'set' ? 'primary' : 'danger',
      )
    }
    case 'reverse':
      return (
        <ConfirmModal open onClose={close} onConfirm={run} loading={loading} variant="danger" title="Reverse transaction"
          confirmLabel="Reverse transaction" confirmDisabled={!reasonOk}
          message="Adds the opposite row to the ledger and links the two. The original row is kept. A row can be reversed once; reversals above the approval threshold wait for a second finance approver."
          details={[
            ...who,
            { label: 'Transaction', value: <span className="mono">#{action.txnId} · {humanize(action.type)}</span> },
            { label: 'Amount', value: <span className="mono">{formatKES(action.amount)}</span> },
            { label: 'Reversal', value: <span className="mono">{formatKES(-Number(action.amount))}</span> },
            { label: 'Description', value: action.description },
          ]}
          consequence="The balance can never go below zero: a reversal that would do that is refused."
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
          title={copy.title} confirmLabel={copy.confirm} confirmDisabled={!reasonOk}
          message={copy.message}
          details={[
            { label: 'User', value: user.username },
            { label: 'Flag', value: humanize(action.flag.flag_type) },
            { label: 'Severity', value: humanize(action.flag.severity) },
            { label: 'Trust score now', value: <span className="num">{user.trust_score}</span> },
          ]}
          consequence={copy.consequence}
        >
          {reasonField(true, 'Reason (saved on the flag and in the audit log)')}
          {errorLine}
        </ConfirmModal>
      )
    }
    case 'reset-password': {
      const mismatch = password2.length > 0 && password !== password2
      return formModal(
        `Set a new password for ${user.username}`,
        "The user's current password stops working immediately.",
        'Set password', password.length < 8 || mismatch || !password2 || !reason.trim(),
        <>
          <Input label="New password" type="password" autoComplete="new-password" value={password}
            onChange={(e) => setPassword(e.target.value)} hint="At least 8 characters; common passwords are rejected by the server."
            error={fieldErrors.new_password} />
          <Input label="Repeat password" type="password" autoComplete="new-password" value={password2}
            onChange={(e) => setPassword2(e.target.value)} error={mismatch ? 'Passwords do not match' : undefined} />
          {reasonField(true)}
        </>,
      )
    }
    case 'edit':
      return formModal(
        `Edit ${user.username}`, 'Changes are recorded in the audit log with the previous values.', 'Save changes',
        !form.username.trim() || !form.email.trim() || !form.phone_number.trim(),
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <Input label="First name" value={form.first_name} onChange={(e) => setForm({ ...form, first_name: e.target.value })} error={fieldErrors.first_name} />
            <Input label="Last name" value={form.last_name} onChange={(e) => setForm({ ...form, last_name: e.target.value })} error={fieldErrors.last_name} />
          </div>
          <Input label="Username" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} error={fieldErrors.username} required />
          <Input label="Email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} error={fieldErrors.email} required />
          <Input label="Phone number" className="mono" inputMode="tel" value={form.phone_number}
            onChange={(e) => setForm({ ...form, phone_number: e.target.value })} error={fieldErrors.phone_number}
            hint="Used for M-Pesa payouts. Format 2547XXXXXXXX." required />
          <Input label="Daily step goal" inputMode="numeric" value={form.daily_goal} onChange={(e) => setForm({ ...form, daily_goal: e.target.value })}
            error={fieldErrors.daily_goal} hint="1,000 – 60,000 steps" />
        </>,
      )
  }
}
