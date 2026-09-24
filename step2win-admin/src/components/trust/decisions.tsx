import type { ReactNode } from 'react'
import type { FlagAction, ModerationAction, SessionDecision, TrustCase, TrustStatus } from './api'
import type { DecisionSpec } from './ui'
import { TRUST_STATUS_INFO } from './rules'

export function statusFor(score: number): TrustStatus {
  if (score > 80) return 'GOOD'
  if (score > 60) return 'WARN'
  if (score > 40) return 'REVIEW'
  if (score > 20) return 'RESTRICT'
  if (score > 0) return 'SUSPEND'
  return 'BAN'
}

/** Projected trust score after an action — mirrors backend _apply_trust_action. */
export function projectScore(score: number, action: FlagAction | ModerationAction): number {
  switch (action) {
    case 'dismiss': return Math.min(100, score + 10)
    case 'warn': return Math.max(0, score - 5)
    case 'restrict': return 35
    case 'suspend': return 10
    case 'ban': return 0
    case 'unrestrict': return Math.max(score, 65)
    case 'unsuspend': return Math.max(score, 45)
    case 'unban': return Math.max(score, 35)
  }
}

const scoreLine = (from: number, to: number) => {
  const s = statusFor(to)
  return `${from} → ${to} (${TRUST_STATUS_INFO[s].label})`
}

export const ACTION_LABEL: Record<FlagAction | ModerationAction, string> = {
  dismiss: 'Dismiss', warn: 'Warn', restrict: 'Restrict', suspend: 'Suspend', ban: 'Ban from step sync',
  unrestrict: 'Lift restriction', unsuspend: 'Lift suspension', unban: 'Lift ban',
}

const EFFECT: Record<FlagAction | ModerationAction, ReactNode> = {
  dismiss: 'The flag is closed as a false positive. The user’s trust score recovers by 10 points.',
  warn: 'The flag is confirmed and the user’s trust score drops by 5 points. No limits are applied unless the score falls into a restricted band.',
  restrict: 'Trust score is set to 35 (Restricted). Step verification becomes stricter and verified steps carry less weight.',
  suspend: 'Trust score is set to 10 (Suspended). Step syncs are refused (“Challenge participation paused”) and payouts are frozen.',
  ban: 'Trust score is set to 0 (Banned). Step syncs are refused (“Account suspended”) and payouts are frozen. Sign-in is not affected — disable sign-in separately if needed.',
  unrestrict: 'Trust score is raised to at least 65 (Warned band). Normal verification resumes.',
  unsuspend: 'Trust score is raised to at least 45 (Under review band). Step syncs are accepted again.',
  unban: 'Trust score is raised to at least 35 (Restricted band). Step syncs are accepted again under stricter verification.',
}

const PRESETS: Partial<Record<FlagAction | ModerationAction, string[]>> = {
  dismiss: ['Evidence consistent with real walking.', 'Known device issue, not user behaviour.'],
  warn: ['First confirmed incident; warning only.'],
  restrict: ['Confirmed shaking pattern on multiple days.', 'Repeated high-risk sessions.'],
  suspend: ['Impossible pace confirmed in session evidence.', 'Repeat offence after restriction.'],
  ban: ['Scripted or replayed step submissions confirmed.'],
  unrestrict: ['Appeal accepted after review.'],
  unsuspend: ['Appeal accepted after review.'],
  unban: ['Appeal accepted after review.'],
}

export function flagActionSpec(c: TrustCase, action: FlagAction): DecisionSpec {
  const from = c.user.trust_score
  const to = action === 'dismiss' && from >= 100 ? from : projectScore(from, action)
  const variant = action === 'dismiss' ? 'info' : action === 'warn' ? 'warning' : 'danger'
  return {
    title: action === 'dismiss' ? 'Dismiss flag' : action === 'warn' ? 'Confirm flag and warn' : `Confirm flag and ${ACTION_LABEL[action].toLowerCase()}`,
    confirmLabel: action === 'dismiss' ? 'Dismiss flag' : action === 'warn' ? 'Confirm and warn' : ACTION_LABEL[action],
    variant,
    message: EFFECT[action],
    details: [
      { label: 'User', value: c.user.username },
      { label: 'Case', value: `#${c.id} · ${c.type}` },
      { label: 'Trust score', value: <span className="num">{scoreLine(from, to)}</span> },
    ],
    consequence: action === 'ban' || action === 'suspend' ? 'The user can no longer sync steps until an admin lifts this.' : undefined,
    allowMessage: action !== 'dismiss',
    confirmText: action === 'ban' ? 'BAN' : undefined,
    presets: PRESETS[action],
  }
}

export function sessionDecisionSpec(c: TrustCase, decision: SessionDecision): DecisionSpec {
  const common = [
    { label: 'User', value: c.user.username },
    { label: 'Session risk', value: <span className="num">{c.risk_score ?? '—'} / 100</span> },
  ]
  if (decision === 'approved') {
    return {
      title: 'Approve session', confirmLabel: 'Approve session', variant: 'info',
      message: 'Records that this session looks like real walking and closes the review. Steps, rewards and the trust score are not changed by this decision.',
      details: common, allowMessage: false, presets: ['Walk probability and pace are consistent with walking.'],
    }
  }
  if (decision === 'rejected') {
    return {
      title: 'Reject session', confirmLabel: 'Reject session', variant: 'warning',
      message: 'Records this session as confirmed suspicious and closes the review. It does not change steps or the trust score — use Moderate to restrict or suspend the account.',
      details: common, allowMessage: true, presets: ['Shake probability and pace confirm non-walking motion.', 'Replayed events confirmed.'],
    }
  }
  return {
    title: 'Escalate session', confirmLabel: 'Escalate', variant: 'info',
    message: 'Keeps the review open, marked Escalated, for a second reviewer. Nothing else changes.',
    details: common, allowMessage: false, presets: ['Needs a second opinion on the motion evidence.'],
  }
}

export function moderationSpec(user: { username: string; trust_score: number }, action: ModerationAction): DecisionSpec {
  const from = user.trust_score
  const to = projectScore(from, action)
  const lifting = action.startsWith('un')
  return {
    title: `${ACTION_LABEL[action]} · ${user.username}`,
    confirmLabel: ACTION_LABEL[action],
    variant: lifting ? 'warning' : action === 'warn' ? 'warning' : 'danger',
    message: EFFECT[action],
    details: [
      { label: 'User', value: user.username },
      { label: 'Trust score', value: <span className="num">{scoreLine(from, to)}</span> },
    ],
    consequence: action === 'ban' || action === 'suspend' ? 'The user can no longer sync steps until an admin lifts this.' : undefined,
    allowMessage: true,
    confirmText: action === 'ban' ? 'BAN' : undefined,
    presets: PRESETS[action],
  }
}
