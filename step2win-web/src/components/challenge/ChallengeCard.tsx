import type { ReactNode } from 'react';
import { BadgeCheck, CalendarDays, CheckCircle2, Clock, Globe, Lock, Star, Ticket, Trophy, Users } from 'lucide-react';
import Card from '../ui/Card';
import ProgressBar from '../ui/ProgressBar';
import { Pill } from '../ui/Pill';
import { Skeleton } from '../ui/Skeleton';
import { formatKESShort, formatSteps } from '../../lib/format';
import {
  dayOfChallenge,
  daysLeftLabel,
  durationDays,
  formatDay,
  startsInLabel,
  toNumber,
  type ChallengeCardModel,
  type ChallengeCardVariant,
} from './challengeUtils';

export interface ChallengeCardProps {
  variant: ChallengeCardVariant;
  challenge: ChallengeCardModel;
  /** Router target; the whole card becomes a link. */
  to?: string;
  onClick?: () => void;
  className?: string;
}

/** Quiet icon + text fact used in the card's secondary row. */
export function ChallengeFact({ icon: Icon, children }: { icon: typeof Users; children: ReactNode }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <Icon size={14} strokeWidth={2} className="shrink-0 text-text-muted" aria-hidden />
      <span className="truncate">{children}</span>
    </span>
  );
}

function EntryFact({ amount }: { amount: string | number }) {
  return (
    <ChallengeFact icon={Ticket}>
      <span className="text-text-muted">Entry </span>
      <span className="num font-semibold text-text-primary">{formatKESShort(amount)}</span>
    </ChallengeFact>
  );
}

function PoolFact({ amount, bonus }: { amount: string | number; bonus?: string | number | null }) {
  const hasBonus = toNumber(bonus) > 0;
  return (
    <ChallengeFact icon={Trophy}>
      <span className="text-text-muted">Pool </span>
      <span className="num font-semibold text-reward-ink">{formatKESShort(amount)}</span>
      {hasBonus && <span className="text-text-muted"> incl. {formatKESShort(bonus)} bonus</span>}
    </ChallengeFact>
  );
}

function StatusPill({ variant, c }: { variant: ChallengeCardVariant; c: ChallengeCardModel }) {
  if (variant === 'active' && c.startDate && c.endDate) {
    const { current, total } = dayOfChallenge(c.startDate, c.endDate);
    return (
      <Pill tone="brand" dot>
        Day {current} of {total}
      </Pill>
    );
  }
  if (variant === 'active') return <Pill tone="brand" dot>Active</Pill>;
  if (variant === 'upcoming') {
    return c.waitingForPlayers ? <Pill tone="warning">Needs players</Pill> : <Pill tone="neutral">Upcoming</Pill>;
  }
  if (variant === 'completed') {
    return c.status === 'cancelled' ? <Pill tone="danger">Cancelled</Pill> : <Pill tone="neutral">Completed</Pill>;
  }
  return c.status === 'active' ? (
    <Pill tone="success" dot="live">
      Live
    </Pill>
  ) : (
    <Pill tone="brand">Open</Pill>
  );
}

function ActivePrimary({ c }: { c: ChallengeCardModel }) {
  const hasSteps = typeof c.steps === 'number';
  if (!hasSteps) {
    // No participation data yet — show time progress rather than inventing step numbers.
    const { current, total } = c.startDate && c.endDate ? dayOfChallenge(c.startDate, c.endDate) : { current: 0, total: 1 };
    return (
      <div>
        <p className="text-callout text-text-secondary">Your steps will appear after your next sync.</p>
        <ProgressBar className="mt-2" progress={(current / total) * 100} height="sm" color="brand" label="Days elapsed" />
      </div>
    );
  }
  const steps = c.steps as number;
  const pct = c.milestone > 0 ? (steps / c.milestone) * 100 : 0;
  const reached = Boolean(c.qualified) || steps >= c.milestone;
  const remaining = Math.max(0, c.milestone - steps);

  return (
    <div>
      <div className="flex items-end justify-between gap-3">
        <p className="min-w-0 truncate">
          <span className="num text-title text-text-primary">{formatSteps(steps)}</span>
          <span className="num text-callout text-text-muted"> / {formatSteps(c.milestone)}</span>
        </p>
        {typeof c.rank === 'number' && c.rank > 0 && (
          <p className="shrink-0 pb-0.5 text-callout text-text-secondary">
            Rank <span className="num font-semibold text-text-primary">{c.rank}</span>
            {c.participants ? <span className="num text-text-muted"> of {c.participants}</span> : null}
          </p>
        )}
      </div>
      <ProgressBar
        className="mt-2"
        progress={pct}
        height="sm"
        color={reached ? 'success' : 'brand'}
        label={`${Math.round(Math.min(100, pct))}% of the step goal`}
      />
      <p className={`mt-2 flex items-center gap-1.5 text-caption ${reached ? 'font-semibold text-success' : 'text-text-muted'}`}>
        {reached ? (
          <>
            <CheckCircle2 size={14} aria-hidden />
            Goal reached, you qualify for a share of the pool
          </>
        ) : (
          <span className="num">{formatSteps(remaining)} steps to go</span>
        )}
      </p>
    </div>
  );
}

function FillBlock({ c, emphasis = false }: { c: ChallengeCardModel; emphasis?: boolean }) {
  const joined = c.participants ?? 0;
  const max = c.maxParticipants ?? 0;
  const spots = c.spotsRemaining ?? Math.max(0, max - joined);
  const pct = c.fillPercent ?? (max > 0 ? (joined / max) * 100 : 0);
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 text-caption">
        <span className="text-text-secondary">
          <span className={`num font-semibold text-text-primary ${emphasis ? 'text-callout' : ''}`}>{joined}</span>
          {max > 0 && <span className="num"> of {max}</span>} joined
        </span>
        {max > 0 && (
          <span className={`num font-semibold ${c.almostFull ? 'text-warning' : 'text-text-secondary'}`}>
            {spots === 0 ? 'Full' : `${spots} ${spots === 1 ? 'spot' : 'spots'} left`}
          </span>
        )}
      </div>
      {max > 0 && (
        <ProgressBar className="mt-1.5" progress={pct} height="xs" color={c.almostFull ? 'warning' : 'brand'} label="Spots filled" />
      )}
    </div>
  );
}

function UpcomingPrimary({ c }: { c: ChallengeCardModel }) {
  if (c.waitingForPlayers) {
    return (
      <div>
        <p className="text-body font-semibold text-text-primary">Waiting for a second player</p>
        <p className="mt-0.5 text-caption text-text-secondary">
          Share invite code{' '}
          {c.inviteCode ? <span className="font-mono font-semibold tracking-wider text-text-primary">{c.inviteCode}</span> : null} so friends can
          join.
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <div>
        <p className="text-body font-semibold text-text-primary">{startsInLabel(c.startDate)}</p>
        {c.startDate && <p className="mt-0.5 text-caption text-text-muted">{formatDay(c.startDate, true)}</p>}
      </div>
      <FillBlock c={c} />
    </div>
  );
}

function CompletedPrimary({ c }: { c: ChallengeCardModel }) {
  if (c.status === 'cancelled') {
    return <p className="text-callout text-text-secondary">This challenge was cancelled before it finished.</p>;
  }
  const payout = toNumber(c.payout);
  const hasResult = typeof c.steps === 'number' || typeof c.qualified === 'boolean';
  if (!hasResult) {
    return <p className="text-callout text-text-secondary">Finished {formatDay(c.endDate)}. Open to see the final results.</p>;
  }
  const detail = [
    typeof c.rank === 'number' && c.rank > 0 ? `Rank ${c.rank}${c.participants ? ` of ${c.participants}` : ''}` : null,
    typeof c.steps === 'number' ? `${formatSteps(c.steps)} steps` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  if (c.qualified && payout > 0) {
    return (
      <div>
        <p className="eyebrow">Your payout</p>
        <p className="num mt-1 text-title text-reward-ink">{formatKESShort(payout)}</p>
        <p className="mt-0.5 flex items-center gap-1.5 text-caption text-text-secondary">
          <CheckCircle2 size={14} className="text-success" aria-hidden />
          Qualified{detail ? ` · ${detail}` : ''}
        </p>
      </div>
    );
  }
  if (!c.qualified && payout > 0) {
    return (
      <div>
        <p className="text-body font-semibold text-text-primary">Entry refunded</p>
        <p className="mt-0.5 text-caption text-text-secondary">
          <span className="num font-semibold text-text-primary">{formatKESShort(payout)}</span> returned to your wallet
          {detail ? ` · ${detail}` : ''}
        </p>
      </div>
    );
  }
  return (
    <div>
      <p className="text-body font-semibold text-text-primary">{c.qualified ? 'Qualified' : 'Goal not reached'}</p>
      {detail && <p className="mt-0.5 text-caption text-text-secondary">{detail}</p>}
    </div>
  );
}

function LobbyPrimary({ c }: { c: ChallengeCardModel }) {
  return <FillBlock c={c} emphasis />;
}

/**
 * Challenge summary card. One visual anchor per variant:
 * - `active`: your progress toward the goal (+ rank when known)
 * - `upcoming`: when it starts and how full it is
 * - `completed`: your result / payout
 * - `lobby`: how full it is, with entry and pool as facts
 */
export function ChallengeCard({ variant, challenge: c, to, onClick, className = '' }: ChallengeCardProps) {
  const duration = durationDays(c.startDate, c.endDate);
  const meta = [c.milestoneTier, `${formatSteps(c.milestone)}-step goal`, duration ? `${duration} days` : null].filter(Boolean).join(' · ');
  const showTopPills = variant === 'lobby' && (c.featured || c.official || c.almostFull);

  return (
    <Card to={to} onClick={to ? undefined : onClick} padding="none" className={`p-4 ${className}`}>
      {showTopPills && (
        <div className="mb-2.5 flex flex-wrap gap-1.5">
          {c.featured && (
            <Pill tone="brand" icon={Star}>
              Featured
            </Pill>
          )}
          {c.official && (
            <Pill tone="info" icon={BadgeCheck}>
              Official
            </Pill>
          )}
          {c.almostFull && (
            <Pill tone="warning" icon={Users}>
              Almost full
            </Pill>
          )}
        </div>
      )}

      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="line-clamp-2 text-headline text-text-primary">{c.name}</h3>
          <p className="mt-0.5 flex min-w-0 items-center gap-1 text-caption text-text-muted">
            {c.isPrivate ? <Lock size={12} className="shrink-0" aria-hidden /> : <Globe size={12} className="shrink-0" aria-hidden />}
            <span className="sr-only">{c.isPrivate ? 'Private challenge. ' : 'Public challenge. '}</span>
            <span className="truncate">{meta}</span>
          </p>
        </div>
        <div className="shrink-0 pt-0.5">
          <StatusPill variant={variant} c={c} />
        </div>
      </div>

      <div className="mt-4">
        {variant === 'active' && <ActivePrimary c={c} />}
        {variant === 'upcoming' && <UpcomingPrimary c={c} />}
        {variant === 'completed' && <CompletedPrimary c={c} />}
        {variant === 'lobby' && <LobbyPrimary c={c} />}
      </div>

      <div className="mt-4 space-y-1.5 border-t border-border-light pt-3 text-caption text-text-secondary">
        {variant !== 'upcoming' && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
            {variant === 'active' && <ChallengeFact icon={Clock}>{daysLeftLabel(c.daysRemaining)}</ChallengeFact>}
            {variant === 'active' && typeof c.participants === 'number' && (
              <ChallengeFact icon={Users}>
                <span className="num">{c.participants}</span> {c.participants === 1 ? 'player' : 'players'}
              </ChallengeFact>
            )}
            {variant === 'completed' && c.endDate && <ChallengeFact icon={CalendarDays}>Ended {formatDay(c.endDate)}</ChallengeFact>}
            {variant === 'lobby' && (
              <ChallengeFact icon={CalendarDays}>
                {c.status === 'active' ? daysLeftLabel(c.daysRemaining) : startsInLabel(c.startDate)}
              </ChallengeFact>
            )}
          </div>
        )}
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5">
          <EntryFact amount={c.entryFee} />
          {c.pool !== undefined && c.pool !== null && <PoolFact amount={c.pool} bonus={c.poolBonus} />}
        </div>
      </div>
    </Card>
  );
}

/** Loading placeholder shaped like `ChallengeCard` for the given variant. */
export function ChallengeCardSkeleton({ variant = 'active', className = '' }: { variant?: ChallengeCardVariant; className?: string }) {
  return (
    <div className={`rounded-card border border-border-light bg-bg-card p-4 shadow-card ${className}`} aria-hidden>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <Skeleton className="h-5 w-3/5 rounded-md" />
          <Skeleton className="mt-2 h-3 w-2/5 rounded" />
        </div>
        <Skeleton className="h-6 w-20 rounded-full" />
      </div>
      <div className="mt-4">
        {variant === 'active' && (
          <>
            <div className="flex items-end justify-between">
              <Skeleton className="h-7 w-32 rounded-md" />
              <Skeleton className="h-4 w-16 rounded" />
            </div>
            <Skeleton className="mt-2 h-1.5 w-full rounded-full" />
            <Skeleton className="mt-2 h-3 w-28 rounded" />
          </>
        )}
        {variant === 'completed' && (
          <>
            <Skeleton className="h-3 w-20 rounded" />
            <Skeleton className="mt-2 h-7 w-28 rounded-md" />
            <Skeleton className="mt-2 h-3 w-40 rounded" />
          </>
        )}
        {(variant === 'upcoming' || variant === 'lobby') && (
          <>
            {variant === 'upcoming' && <Skeleton className="mb-3 h-4 w-32 rounded" />}
            <div className="flex justify-between">
              <Skeleton className="h-3 w-24 rounded" />
              <Skeleton className="h-3 w-16 rounded" />
            </div>
            <Skeleton className="mt-2 h-1 w-full rounded-full" />
          </>
        )}
      </div>
      <div className="mt-4 space-y-2.5 border-t border-border-light pt-3">
        {variant !== 'upcoming' && <Skeleton className="h-3 w-32 rounded" />}
        <div className="flex justify-between">
          <Skeleton className="h-3 w-24 rounded" />
          <Skeleton className="h-3 w-28 rounded" />
        </div>
      </div>
    </div>
  );
}

export default ChallengeCard;
