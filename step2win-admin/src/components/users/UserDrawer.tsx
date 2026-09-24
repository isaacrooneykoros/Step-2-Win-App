import { useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Bar, BarChart, CartesianGrid, Cell, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import {
  Ban, Footprints, KeyRound, LifeBuoy, MonitorSmartphone, Pencil, ShieldAlert, ShieldCheck, Trophy, UserCheck,
  Wallet, History,
} from 'lucide-react'
import { SlideOver } from '../SlideOver'
import { StatusBadge } from '../StatusBadge'
import { DetailRow } from '../DetailRow'
import { Button } from '../ui/Button'
import { Tabs } from '../ui/Tabs'
import { EmptyState } from '../ui/EmptyState'
import { ErrorState } from '../ui/ErrorState'
import { Skeleton } from '../ui/Skeleton'
import { ChartLegend, ChartTooltip } from '../charts/ChartTooltip'
import { SERIES, barCursor, barProps, gridProps, niceTicks, tickFormat, valueFormat, xAxisProps, yAxisProps } from '../../lib/chartTheme'
import { formatKES, formatNumber, formatPercent } from '../../lib/format'
import { cn } from '../../lib/cn'
import { consoleApi } from './api'
import type { UserOverview } from './types'
import { ActionNotice, AuditActionBadge, ChangeList, Figure, InlineLink, SectionTitle, SignedKES, Timestamp, TrustMeter } from './shared'
import { UserActions, type UserAction } from './UserActions'
import { formatDay, humanize, TRUST_LABEL, useAdminRole } from './utils'

type Tab = 'account' | 'activity' | 'challenges' | 'financial' | 'security' | 'support' | 'audit'

interface Props {
  userId: number | null
  onClose: () => void
}

/** Full record for one user: identity, activity, money, trust, support and audit, plus every supported action. */
export function UserDrawer({ userId, onClose }: Props) {
  const [tab, setTab] = useState<Tab>('account')
  const [action, setAction] = useState<UserAction | null>(null)
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null)
  const role = useAdminRole()
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ['admin', 'user-overview', userId],
    queryFn: () => consoleApi.userOverview(userId as number),
    enabled: userId !== null,
  })
  const d = q.data
  const u = d?.user
  const isSelf = role.id !== undefined && u?.id === role.id

  const done = (message: string, opts?: { deleted?: boolean }) => {
    setAction(null)
    void qc.invalidateQueries({ queryKey: ['admin', 'users'] })
    void qc.invalidateQueries({ queryKey: ['admin', 'user-stats'] })
    if (opts?.deleted) {
      onClose()
      return
    }
    setNotice({ tone: 'success', text: message })
    void q.refetch()
  }

  const openFlags = d?.flags.filter((f) => !f.reviewed).length ?? 0
  const tabs = [
    { value: 'account' as const, label: 'Account' },
    { value: 'activity' as const, label: 'Activity' },
    { value: 'challenges' as const, label: 'Challenges', count: d?.challenges.length },
    { value: 'financial' as const, label: 'Financial' },
    { value: 'security' as const, label: 'Security', count: d ? openFlags : undefined },
    { value: 'support' as const, label: 'Support', count: d?.tickets.length },
    { value: 'audit' as const, label: 'Audit', count: d?.audit.length },
  ]

  return (
    <SlideOver
      open={userId !== null}
      onClose={onClose}
      width={760}
      title={u?.username ?? 'User'}
      subtitle={u ? `User #${u.id} · joined ${formatDay(u.date_joined, true)}` : undefined}
      headerAside={
        u && (
          <span className="flex flex-wrap items-center gap-1.5">
            <StatusBadge size="sm" status={u.is_deleted ? 'deleted' : u.is_active ? 'active' : 'banned'} />
            {u.is_staff && <StatusBadge size="sm" status="staff" />}
          </span>
        )
      }
      footer={
        u && !u.is_deleted && (
          <>
            <Button size="sm" variant="secondary" leftIcon={<Pencil size={13} />} onClick={() => setAction({ kind: 'edit' })}>Edit details</Button>
            <Button size="sm" variant="secondary" leftIcon={<KeyRound size={13} />} onClick={() => setAction({ kind: 'reset-password' })}>Reset password</Button>
            {u.is_active ? (
              <Button size="sm" variant="danger-soft" leftIcon={<Ban size={13} />} disabled={isSelf} title={isSelf ? 'You cannot ban your own account' : undefined} onClick={() => setAction({ kind: 'ban' })}>Ban user</Button>
            ) : (
              <Button size="sm" variant="primary" leftIcon={<UserCheck size={13} />} onClick={() => setAction({ kind: 'unban' })}>Unban user</Button>
            )}
          </>
        )
      }
    >
      {q.isLoading ? (
        <DrawerSkeleton />
      ) : q.error || !d || !u ? (
        <ErrorState title="Could not load this user" error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />
      ) : (
        <div className="space-y-4">
          {notice && <ActionNotice tone={notice.tone} onDismiss={() => setNotice(null)}>{notice.text}</ActionNotice>}

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Figure label="Available balance" value={formatKES(d.wallet.available_balance)} hint="Spendable and withdrawable" />
            <Figure label="Locked in challenges" value={formatKES(d.wallet.locked_balance)} hint="Entries in live challenges" />
            <Figure
              label="Trust score"
              value={`${d.trust.score} / 100`}
              hint={TRUST_LABEL[d.trust.status]}
              tone={d.trust.score <= 40 ? 'danger' : d.trust.score <= 80 ? 'warning' : undefined}
            />
            <Figure label="Open flags" value={formatNumber(openFlags)} hint={`${formatNumber(d.flags.length)} raised in total`} tone={openFlags ? 'warning' : undefined} />
          </div>

          <Tabs label="User record sections" items={tabs} value={tab} onChange={setTab} idPrefix="user-drawer" size="sm" />

          <div role="tabpanel" id={`user-drawer-panel-${tab}`} aria-labelledby={`user-drawer-tab-${tab}`}>
            {tab === 'account' && <AccountTab d={d} isSuperuser={role.isSuperuser} isSelf={isSelf} onAction={setAction} />}
            {tab === 'activity' && <ActivityTab d={d} />}
            {tab === 'challenges' && <ChallengesTab d={d} />}
            {tab === 'financial' && <FinancialTab d={d} />}
            {tab === 'security' && <SecurityTab d={d} onAction={setAction} />}
            {tab === 'support' && <SupportTab d={d} />}
            {tab === 'audit' && <AuditTab d={d} />}
          </div>
        </div>
      )}

      {u && action && (
        <UserActions key={`${action.kind}-${u.id}`} user={u} action={action} onClose={() => setAction(null)} onDone={done} />
      )}
    </SlideOver>
  )
}

function DrawerSkeleton() {
  return (
    <div className="space-y-4" aria-hidden>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[0, 1, 2, 3].map((i) => <Skeleton key={i} height={64} />)}
      </div>
      <Skeleton height={28} width="70%" />
      {[0, 1, 2, 3, 4, 5].map((i) => <Skeleton key={i} height={18} />)}
    </div>
  )
}

/** Small bordered list of rows for drawer sections. */
function RowList({ children }: { children: ReactNode }) {
  return <ul className="divide-y divide-[var(--border)] rounded-md border border-surface-border">{children}</ul>
}

// ── Account ─────────────────────────────────────────────────────────────────

function AccountTab({ d, isSuperuser, isSelf, onAction }: { d: UserOverview; isSuperuser: boolean; isSelf: boolean; onAction: (a: UserAction) => void }) {
  const u = d.user
  const hasMoney = Number(u.wallet_balance) !== 0 || Number(u.locked_balance) !== 0
  return (
    <div>
      <SectionTitle>Profile and contact</SectionTitle>
      <div className="grid gap-x-6 sm:grid-cols-2">
        <div>
          <DetailRow label="Username" value={u.username} />
          <DetailRow label="Email" value={u.email} />
          <DetailRow label="Phone (M-Pesa)" value={u.phone_number} mono />
          <DetailRow label="User ID" value={String(u.id)} mono />
        </div>
        <div>
          <DetailRow label="Joined" value={<Timestamp value={u.date_joined} exact />} />
          <DetailRow label="Last sign-in" value={<Timestamp value={u.last_login} exact />} />
          <DetailRow label="Last app activity" value={<Timestamp value={u.last_seen_at} exact />} />
          <DetailRow label="Platform" value={u.device_platform ? humanize(u.device_platform) : null} />
        </div>
      </div>

      <SectionTitle aside={<span className="text-xs text-ink-muted">{d.sessions.filter((s) => s.is_active).length} active</span>}>Sessions</SectionTitle>
      {d.sessions.length === 0 ? (
        <EmptyState size="compact" icon={MonitorSmartphone} title="No sign-in sessions recorded" description="Sessions appear after the user signs in on the app." />
      ) : (
        <RowList>
          {d.sessions.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 text-sm">
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-ink-primary">{s.device_name || humanize(s.device_type)}</span>
                <span className="block truncate text-xs text-ink-muted">
                  {[s.os_version, s.app_version && `app ${s.app_version}`, s.country].filter(Boolean).join(' · ') || 'No device details'}
                </span>
              </span>
              <span className="mono text-xs text-ink-secondary">{s.ip_address ?? '—'}</span>
              <span className="text-xs text-ink-muted"><Timestamp value={s.last_active_at} /></span>
              <StatusBadge size="sm" tone={s.is_active ? 'success' : 'neutral'} label={s.is_active ? 'Active' : 'Signed out'} />
            </li>
          ))}
        </RowList>
      )}

      <SectionTitle>Registered devices</SectionTitle>
      {d.devices.length === 0 ? (
        <p className="text-sm text-ink-muted">No step-tracking device registered.</p>
      ) : (
        <RowList>
          {d.devices.map((dv) => (
            <li key={dv.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 text-sm">
              <span className="min-w-0 flex-1">
                <span className="font-medium text-ink-primary">{humanize(dv.platform)}</span>
                <span className="text-ink-muted"> · app {dv.app_version || '—'}</span>
              </span>
              <span className="text-xs text-ink-muted">first seen {formatDay(dv.first_seen_at)}</span>
              <span className="text-xs text-ink-muted">last <Timestamp value={dv.last_seen_at} /></span>
              <StatusBadge size="sm" tone={dv.trust_level === 'trusted' ? 'success' : dv.trust_level === 'low' ? 'warning' : 'neutral'} label={`Device ${humanize(dv.trust_level).toLowerCase()}`} />
            </li>
          ))}
        </RowList>
      )}

      <SectionTitle>Access and records</SectionTitle>
      <RowList>
        <DangerRow
          title="Reset lifetime step counters"
          description="Sets total steps and best day on the profile to 0. Daily history is kept."
          action={<Button size="sm" variant="secondary" leftIcon={<Footprints size={13} />} onClick={() => onAction({ kind: 'reset-steps' })}>Reset counters</Button>}
        />
        {isSuperuser ? (
          <DangerRow
            title={u.is_staff ? 'Staff access' : 'Grant staff access'}
            description={u.is_staff ? 'This account can open the admin console.' : 'Allow this account to open the admin console.'}
            action={
              u.is_staff ? (
                <Button size="sm" variant="danger-soft" disabled={isSelf} title={isSelf ? 'You cannot remove your own access' : undefined} onClick={() => onAction({ kind: 'remove-staff' })}>Remove staff access</Button>
              ) : (
                <Button size="sm" variant="secondary" leftIcon={<ShieldCheck size={13} />} onClick={() => onAction({ kind: 'grant-staff' })}>Grant staff access</Button>
              )
            }
          />
        ) : (
          <DangerRow title="Staff access" description="Only superusers can change staff access or delete accounts." action={<StatusBadge size="sm" tone="neutral" label="Superuser only" />} />
        )}
        {isSuperuser && (
          <DangerRow
            title="Delete account"
            description={hasMoney ? `Not available: the account holds ${formatKES(Number(u.wallet_balance) + Number(u.locked_balance))}. Ban it instead.` : 'Permanently removes the account and its records.'}
            action={<Button size="sm" variant="danger-soft" disabled={hasMoney || isSelf} onClick={() => onAction({ kind: 'delete' })}>Delete account</Button>}
          />
        )}
      </RowList>
    </div>
  )
}

function DangerRow({ title, description, action }: { title: string; description: string; action: ReactNode }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5">
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-ink-primary">{title}</span>
        <span className="block text-xs text-ink-muted">{description}</span>
      </span>
      {action}
    </li>
  )
}

// ── Activity ────────────────────────────────────────────────────────────────

function ActivityTab({ d }: { d: UserOverview }) {
  const a = d.activity
  const days = a.days.map((x) => ({ ...x, label: formatDay(x.date) }))
  const total = days.reduce((s, x) => s + x.steps, 0)
  const active = days.filter((x) => x.steps > 0)
  const hit = days.filter((x) => x.steps >= a.daily_goal).length
  const flagged = days.filter((x) => x.is_suspicious).length
  const max = Math.max(a.daily_goal, ...days.map((x) => x.steps))
  const ticks = niceTicks(max)
  return (
    <div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Figure label="Steps · 30 days" value={formatNumber(total)} hint={`${formatNumber(active.length ? Math.round(total / active.length) : 0)} per active day`} />
        <Figure label="Goal met" value={`${hit} of 30 days`} hint={`Goal ${formatNumber(a.daily_goal)} steps`} />
        <Figure label="Streak" value={`${a.current_streak} days`} hint={`Best ${a.best_streak} days`} />
        <Figure label="Best day" value={formatNumber(a.best_day_steps)} hint="Lifetime" />
      </div>

      <SectionTitle aside={
        <ChartLegend items={[
          { label: 'Steps', color: SERIES[0] },
          { label: `Goal line · ${formatNumber(a.daily_goal)}`, color: 'var(--ink-3)' },
          ...(flagged ? [{ label: 'Flagged day', color: SERIES[2], value: String(flagged) }] : []),
        ]} />
      }>Daily steps vs goal · last 30 days</SectionTitle>
      {total === 0 ? (
        <EmptyState size="compact" icon={Footprints} title="No steps synced in the last 30 days" description="If the user is walking, check their devices and recent syncs below." />
      ) : (
        <div className="h-[200px]">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={days} margin={{ top: 12, right: 8, bottom: 0, left: -8 }}>
              <CartesianGrid {...gridProps} />
              <XAxis dataKey="label" {...xAxisProps} interval="preserveStartEnd" />
              <YAxis {...yAxisProps} domain={[0, ticks[ticks.length - 1]]} ticks={ticks} tickFormatter={tickFormat.number} />
              <Tooltip cursor={barCursor} content={<ChartTooltip hideSwatch formatValue={valueFormat.number} />} />
              <ReferenceLine y={a.daily_goal} stroke="var(--ink-3)" strokeWidth={1} ifOverflow="extendDomain" />
              <Bar dataKey="steps" name="Steps" {...barProps}>
                {days.map((x) => <Cell key={x.date} fill={x.is_suspicious ? SERIES[2] : SERIES[0]} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      <SectionTitle>Recent syncs</SectionTitle>
      {a.syncs.length === 0 ? (
        <p className="text-sm text-ink-muted">No signed sync events recorded for this user.</p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-surface-border">
          <table className="w-full text-sm">
            <caption className="sr-only">Recent step sync events</caption>
            <thead>
              <tr className="border-b border-surface-border text-left text-xs text-ink-muted">
                <th scope="col" className="px-3 py-2 font-medium">Received</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Steps</th>
                <th scope="col" className="px-3 py-2 font-medium">Result</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Risk</th>
                <th scope="col" className="px-3 py-2 font-medium">Reason</th>
              </tr>
            </thead>
            <tbody>
              {a.syncs.map((s) => (
                <tr key={s.id} className="border-b border-surface-border last:border-b-0">
                  <td className="px-3 py-2 text-xs text-ink-secondary"><Timestamp value={s.created_at} /></td>
                  <td className="num px-3 py-2 text-right">+{formatNumber(s.steps_delta)}</td>
                  <td className="px-3 py-2">
                    <StatusBadge size="sm" tone={s.replay_detected ? 'danger' : s.accepted ? 'success' : 'danger'}
                      label={s.replay_detected ? 'Replay' : s.accepted ? 'Accepted' : 'Rejected'} />
                  </td>
                  <td className={cn('num px-3 py-2 text-right', s.interval_risk_score >= 0.5 && 'font-medium text-danger')}>
                    {formatPercent(s.interval_risk_score * 100, { digits: 0 })}
                  </td>
                  <td className="max-w-56 truncate px-3 py-2 text-xs text-ink-secondary" title={s.rejection_reason ?? undefined}>
                    {s.rejection_reason ?? (s.signature_valid ? '—' : 'Unsigned payload')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ── Challenges ──────────────────────────────────────────────────────────────

function ChallengesTab({ d }: { d: UserOverview }) {
  const navigate = useNavigate()
  if (d.challenges.length === 0) {
    return <EmptyState size="compact" icon={Trophy} title="Has not joined any challenge" />
  }
  const won = d.challenges.filter((c) => Number(c.payout) > 0)
  return (
    <div>
      <div className="mb-3 grid grid-cols-3 gap-2">
        <Figure label="Joined" value={formatNumber(d.challenges.length)} />
        <Figure label="Paid out" value={formatNumber(won.length)} hint="Challenges with a payout" />
        <Figure label="Total payouts" value={formatKES(won.reduce((s, c) => s + Number(c.payout), 0))} />
      </div>
      <div className="overflow-x-auto rounded-md border border-surface-border">
        <table className="w-full text-sm">
          <caption className="sr-only">Challenge entries</caption>
          <thead>
            <tr className="border-b border-surface-border text-left text-xs text-ink-muted">
              <th scope="col" className="px-3 py-2 font-medium">Challenge</th>
              <th scope="col" className="px-3 py-2 font-medium">Status</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Progress</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Rank</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Entry</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Payout</th>
            </tr>
          </thead>
          <tbody>
            {d.challenges.map((c) => {
              const pct = c.milestone ? Math.min(100, Math.round((c.steps / c.milestone) * 100)) : 0
              return (
                <tr key={c.challenge_id} className="border-b border-surface-border last:border-b-0">
                  <td className="px-3 py-2">
                    <button type="button" onClick={() => navigate(`/challenges?open=${c.challenge_id}`)} className="text-left font-medium text-ink-primary hover:text-brand-text hover:underline">
                      {c.name}
                    </button>
                    <span className="block text-xs text-ink-muted">{formatDay(c.start_date)} – {formatDay(c.end_date)}</span>
                  </td>
                  <td className="px-3 py-2"><StatusBadge size="sm" status={c.status === 'active' ? 'live' : c.status} /></td>
                  <td className="px-3 py-2 text-right">
                    <span className="num block">{formatNumber(c.steps)} / {formatNumber(c.milestone)}</span>
                    <span className={cn('text-xs', c.qualified ? 'text-success' : 'text-ink-muted')}>{c.qualified ? 'Qualified' : `${pct}%`}</span>
                  </td>
                  <td className="num px-3 py-2 text-right">{c.rank ?? '—'}</td>
                  <td className="mono px-3 py-2 text-right text-[13px]">{formatKES(c.entry_fee)}</td>
                  <td className="mono px-3 py-2 text-right text-[13px]">{Number(c.payout) > 0 ? formatKES(c.payout) : '—'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Financial ───────────────────────────────────────────────────────────────

function FinancialTab({ d }: { d: UserOverview }) {
  const navigate = useNavigate()
  const w = d.wallet
  return (
    <div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Figure label="Available balance" value={formatKES(w.available_balance)} hint="Equals the wallet balance" />
        <Figure label="Locked in challenges" value={formatKES(w.locked_balance)} hint="Not included in available" />
        <Figure label="Total earned" value={formatKES(w.total_earned)} hint="Challenge payouts" />
        <Figure label="Deposited" value={formatKES(w.total_deposited)} hint="All M-Pesa deposits" />
        <Figure label="Withdrawn" value={formatKES(w.total_withdrawn)} hint="Wallet debits for withdrawals" />
      </div>

      <SectionTitle aside={<InlineLink onClick={() => navigate('/transactions')}>All transactions</InlineLink>}>Recent wallet transactions</SectionTitle>
      {d.transactions.length === 0 ? (
        <EmptyState size="compact" icon={Wallet} title="No wallet transactions" />
      ) : (
        <div className="overflow-x-auto rounded-md border border-surface-border">
          <table className="w-full text-sm">
            <caption className="sr-only">Wallet transactions</caption>
            <thead>
              <tr className="border-b border-surface-border text-left text-xs text-ink-muted">
                <th scope="col" className="px-3 py-2 font-medium">Type</th>
                <th scope="col" className="px-3 py-2 font-medium">Description</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Amount</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Balance after</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">When</th>
              </tr>
            </thead>
            <tbody>
              {d.transactions.map((t) => (
                <tr key={t.id} className="border-b border-surface-border last:border-b-0">
                  <td className="px-3 py-2"><StatusBadge size="sm" tone="neutral" label={humanize(t.type)} /></td>
                  <td className="max-w-52 px-3 py-2">
                    <span className="block truncate text-ink-secondary" title={t.description}>{t.description}</span>
                    {t.reference_id && <span className="mono block text-2xs text-ink-muted">{t.reference_id}</span>}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right text-[13px]"><SignedKES value={t.amount} /></td>
                  <td className="mono whitespace-nowrap px-3 py-2 text-right text-[13px] text-ink-secondary">{formatKES(t.balance_after)}</td>
                  <td className="px-3 py-2 text-right text-xs text-ink-muted"><Timestamp value={t.created_at} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <SectionTitle aside={<InlineLink onClick={() => navigate('/withdrawals')}>Withdrawal queue</InlineLink>}>Withdrawal requests</SectionTitle>
      {d.withdrawals.length === 0 ? (
        <p className="text-sm text-ink-muted">No withdrawal requests.</p>
      ) : (
        <RowList>
          {d.withdrawals.map((w) => (
            <li key={w.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 text-sm">
              <span className="mono w-28 shrink-0 text-right font-medium">{formatKES(w.amount_kes)}</span>
              <span className="min-w-0 flex-1">
                <span className="block text-ink-secondary">{humanize(w.method)} <span className="mono text-xs">{w.destination || '—'}</span></span>
                {w.rejection_reason && <span className="block truncate text-xs text-danger">{w.rejection_reason}</span>}
              </span>
              <span className="text-xs text-ink-muted"><Timestamp value={w.created_at} /></span>
              <StatusBadge size="sm" status={w.status} />
            </li>
          ))}
        </RowList>
      )}
    </div>
  )
}

// ── Security ────────────────────────────────────────────────────────────────

function SecurityTab({ d, onAction }: { d: UserOverview; onAction: (a: UserAction) => void }) {
  const navigate = useNavigate()
  const t = d.trust
  const p = t.profile
  const q = encodeURIComponent(d.user.username)
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-end gap-x-4 gap-y-1">
        <InlineLink onClick={() => navigate(`/fraud?q=${q}`)}>Open in anti-cheat</InlineLink>
        <InlineLink onClick={() => navigate(`/moderation?q=${q}`)}>Moderation history</InlineLink>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-surface-border px-3 py-3">
        <div>
          <p className="text-xs text-ink-muted">Anti-cheat trust score</p>
          <div className="mt-1"><TrustMeter score={t.score} status={t.status} /></div>
        </div>
        <div className="text-right text-xs text-ink-muted">
          <p><span className="num font-medium text-ink-primary">{formatNumber(t.flags_total)}</span> flags counted against the score</p>
          <p>{t.updated_at ? <>Updated <Timestamp value={t.updated_at} /></> : 'No trust record yet — defaults to 100'}</p>
        </div>
      </div>

      {p && (
        <>
          <SectionTitle>Verification history</SectionTitle>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Figure label="Verified sessions" value={formatNumber(p.verified_sessions_count)} />
            <Figure label="Suspicious sessions" value={formatNumber(p.suspicious_sessions_count)} tone={p.suspicious_sessions_count ? 'warning' : undefined} />
            <Figure label="Replay attempts" value={formatNumber(p.replay_attempts_count)} tone={p.replay_attempts_count ? 'danger' : undefined} />
            <Figure label="Rejected steps" value={formatNumber(p.total_rejected_steps)} hint={`${formatNumber(p.total_accepted_steps)} accepted`} />
          </div>
        </>
      )}

      <SectionTitle aside={<span className="text-xs text-ink-muted">Actions change the trust score and are logged on the flag</span>}>Anti-cheat flags</SectionTitle>
      {d.flags.length === 0 ? (
        <EmptyState size="compact" icon={ShieldCheck} title="No anti-cheat flags" description="Signals raised by step verification will be listed here." />
      ) : (
        <RowList>
          {d.flags.map((f) => (
            <li key={f.id} className="px-3 py-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge size="sm" status={f.severity} />
                <span className="text-sm font-medium text-ink-primary">{humanize(f.flag_type)}</span>
                <span className="text-xs text-ink-muted">for {formatDay(f.date, true)} · raised <Timestamp value={f.created_at} /></span>
                <span className="ml-auto">
                  {f.reviewed ? (
                    <StatusBadge size="sm" tone="neutral" label={`Reviewed · ${humanize(f.admin_action ?? 'dismiss').toLowerCase()}`} />
                  ) : (
                    <StatusBadge size="sm" tone="warning" label="Needs review" />
                  )}
                </span>
              </div>
              {Object.keys(f.details).filter((k) => !['admin_action', 'admin_note', 'reviewed_at'].includes(k)).length > 0 && (
                <p className="mt-1 text-xs text-ink-secondary">
                  {Object.entries(f.details)
                    .filter(([k]) => !['admin_action', 'admin_note', 'reviewed_at'].includes(k))
                    .map(([k, v]) => `${humanize(k)}: ${typeof v === 'number' ? formatNumber(v) : String(v)}`)
                    .join(' · ')}
                </p>
              )}
              {f.admin_note && <p className="mt-1 text-xs text-ink-muted">Note: {f.admin_note}</p>}
              {!f.reviewed && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <Button size="sm" variant="secondary" onClick={() => onAction({ kind: 'flag', flag: f, action: 'dismiss' })}>Dismiss</Button>
                  <Button size="sm" variant="secondary" onClick={() => onAction({ kind: 'flag', flag: f, action: 'warn' })}>Warn</Button>
                  <Button size="sm" variant="danger-soft" onClick={() => onAction({ kind: 'flag', flag: f, action: 'restrict' })}>Restrict</Button>
                  <Button size="sm" variant="danger-soft" leftIcon={<ShieldAlert size={13} />} onClick={() => onAction({ kind: 'flag', flag: f, action: 'suspend' })}>Suspend</Button>
                </div>
              )}
            </li>
          ))}
        </RowList>
      )}
    </div>
  )
}

// ── Support ─────────────────────────────────────────────────────────────────

function SupportTab({ d }: { d: UserOverview }) {
  const navigate = useNavigate()
  if (d.tickets.length === 0) {
    return <EmptyState size="compact" icon={LifeBuoy} title="No support tickets" description="Tickets this user opens from the app appear here." />
  }
  return (
    <div>
      <SectionTitle aside={<InlineLink onClick={() => navigate('/support')}>Open support inbox</InlineLink>}>Tickets</SectionTitle>
      <RowList>
        {d.tickets.map((t) => (
          <li key={t.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
            <span className="mono text-xs text-ink-muted">#{t.id}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium text-ink-primary">{t.subject}</span>
              <span className="block text-xs text-ink-muted">
                {humanize(t.category)} · {t.assigned_to_username ? `assigned to ${t.assigned_to_username}` : 'unassigned'} · updated <Timestamp value={t.updated_at} />
              </span>
            </span>
            <StatusBadge size="sm" status={t.priority} label={`${humanize(t.priority)} priority`} />
            <StatusBadge size="sm" status={t.status} />
          </li>
        ))}
      </RowList>
    </div>
  )
}

// ── Audit ───────────────────────────────────────────────────────────────────

function AuditTab({ d }: { d: UserOverview }) {
  const navigate = useNavigate()
  if (d.audit.length === 0) {
    return <EmptyState size="compact" icon={History} title="No admin actions on this user" description="Bans, edits, password resets and staff changes are recorded here." />
  }
  return (
    <div>
      <SectionTitle aside={<InlineLink onClick={() => navigate(`/activity?resource_type=user&resource_id=${d.user.id}`)}>Open in audit log</InlineLink>}>Admin actions</SectionTitle>
      <ol className="relative space-y-0 border-l border-surface-border pl-4">
        {d.audit.map((a) => (
          <li key={a.id} className="relative pb-4 last:pb-0">
            <span className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full border border-surface-strong bg-surface-card" aria-hidden />
            <div className="flex flex-wrap items-center gap-2">
              <AuditActionBadge action={a.action} />
              <span className="text-sm text-ink-primary">{a.description}</span>
            </div>
            <p className="mt-0.5 text-xs text-ink-muted">
              by <span className="font-medium text-ink-secondary">{a.admin_username}</span> · <Timestamp value={a.created_at} exact />
            </p>
            <div className="mt-1.5 max-w-lg"><ChangeList changes={a.changes} /></div>
          </li>
        ))}
      </ol>
    </div>
  )
}
