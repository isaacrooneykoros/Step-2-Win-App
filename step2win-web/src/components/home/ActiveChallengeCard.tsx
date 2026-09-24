import { useNavigate } from 'react-router-dom';
import { Trophy } from 'lucide-react';
import Card from '../ui/Card';
import ProgressBar from '../ui/ProgressBar';
import { Pill } from '../ui/Pill';
import { EmptyState } from '../ui/EmptyState';
import { Skeleton } from '../ui/Skeleton';
import { challengeDayProgress, formatKESShort, formatShortDate, formatSteps } from '../../lib/format';
import type { ChallengeDetail } from '../../types';

interface ActiveChallengeCardProps {
  challenge: ChallengeDetail;
}

/** The user's live challenge: day X of Y, challenge steps vs milestone, rank, field and pool. */
export function ActiveChallengeCard({ challenge }: ActiveChallengeCardProps) {
  const me = challenge.my_participation;
  const isActive = challenge.status === 'active';
  const mySteps = me?.steps ?? challenge.user_steps ?? 0;
  const rank = me?.rank ?? challenge.user_rank ?? null;
  const milestone = challenge.milestone > 0 ? challenge.milestone : 0;
  const pct = milestone > 0 ? Math.min(100, (mySteps / milestone) * 100) : 0;
  const reached = milestone > 0 && mySteps >= milestone;
  const { currentDay, totalDays } = challengeDayProgress(challenge.start_date, challenge.end_date);

  // Only surface a payout figure the API actually provided.
  const estimated = me?.estimated_payout != null ? Number(me.estimated_payout) : challenge.user_payout;
  const hasEstimate = typeof estimated === 'number' && Number.isFinite(estimated) && estimated > 0;

  return (
    <Card to={`/challenges/${challenge.id}`} padding="lg">
      <div className="flex items-center justify-between gap-3">
        {isActive ? (
          <Pill tone="brand" dot="live">
            Day {currentDay} of {totalDays}
          </Pill>
        ) : (
          <Pill tone="neutral">Starts {formatShortDate(challenge.start_date)}</Pill>
        )}
        {isActive && challenge.days_remaining > 0 && (
          <span className="text-caption text-text-muted">
            {challenge.days_remaining} {challenge.days_remaining === 1 ? 'day' : 'days'} left
          </span>
        )}
      </div>

      <h3 className="mt-3 line-clamp-2 text-headline text-text-primary">{challenge.name}</h3>

      <div className="mt-4 flex items-baseline justify-between gap-3">
        <p className="text-callout text-text-secondary">
          <span className="num text-headline text-text-primary">{formatSteps(mySteps)}</span>
          <span className="num"> / {formatSteps(milestone)}</span> steps
        </p>
        <span className={`num text-callout font-semibold ${reached ? 'text-success' : 'text-text-secondary'}`}>
          {reached ? 'Milestone reached' : `${Math.floor(pct)}%`}
        </span>
      </div>
      <ProgressBar className="mt-2" progress={pct} height="sm" color={reached ? 'success' : 'brand'} label="Your challenge progress" />
      {!reached && milestone > 0 && (
        <p className="mt-2 text-caption text-text-muted">
          <span className="num">{formatSteps(milestone - mySteps)}</span> steps to the milestone
        </p>
      )}

      <dl className="mt-4 grid grid-cols-3 gap-3 border-t border-border-light pt-4">
        <div className="min-w-0">
          <dt className="text-caption text-text-muted">Your rank</dt>
          <dd className="num mt-0.5 text-headline text-text-primary">
            {rank ? (
              <>
                #{rank}
                <span className="text-caption font-medium text-text-muted"> of {challenge.current_participants}</span>
              </>
            ) : (
              '—'
            )}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-caption text-text-muted">{hasEstimate ? 'Est. payout' : 'Players'}</dt>
          <dd className={`num mt-0.5 truncate text-headline ${hasEstimate ? 'text-reward-ink' : 'text-text-primary'}`}>
            {hasEstimate ? formatKESShort(estimated) : formatSteps(challenge.current_participants)}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-caption text-text-muted">Pool</dt>
          <dd className="num mt-0.5 truncate text-headline text-text-primary">{formatKESShort(challenge.total_pool)}</dd>
        </div>
      </dl>
    </Card>
  );
}

export function NoChallengeCard() {
  const navigate = useNavigate();
  return (
    <Card padding="none">
      <EmptyState
        icon={Trophy}
        className="!py-8"
        title="No active challenge"
        description="Join a step challenge to compete with others and earn from your walking."
        action={{ label: 'Browse challenges', onClick: () => navigate('/challenges/lobby') }}
      />
    </Card>
  );
}

export function ActiveChallengeSkeleton() {
  return (
    <div className="rounded-card border border-border-light bg-bg-card p-5 shadow-card" aria-hidden>
      <Skeleton className="h-6 w-24 rounded-full" />
      <Skeleton className="mt-3 h-5 w-3/5 rounded" />
      <div className="mt-4 flex justify-between">
        <Skeleton className="h-5 w-40 rounded" />
        <Skeleton className="h-5 w-10 rounded" />
      </div>
      <Skeleton className="mt-2 h-1.5 w-full rounded-full" />
      <div className="mt-4 grid grid-cols-3 gap-3 border-t border-border-light pt-4">
        {[0, 1, 2].map((i) => (
          <div key={i}>
            <Skeleton className="h-3 w-14 rounded" />
            <Skeleton className="mt-1.5 h-5 w-12 rounded" />
          </div>
        ))}
      </div>
    </div>
  );
}
