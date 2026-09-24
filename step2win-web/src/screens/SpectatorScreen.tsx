import { useParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Eye, Target } from 'lucide-react';
import { challengesService } from '../services/api/challenges';
import { useAuthStore } from '../store/authStore';
import { ScreenHeader } from '../components/ui/ScreenHeader';
import Pill from '../components/ui/Pill';
import Button from '../components/ui/Button';
import Card from '../components/ui/Card';
import { ListGroup, ListRow } from '../components/ui/ListRow';
import { EmptyState } from '../components/ui/EmptyState';
import { LoadError, NotFoundError } from '../components/ui/ErrorState';
import { LeaderboardList, LeaderboardRow } from '../components/challenge-detail/Leaderboard';
import { SpectatorSkeleton } from '../components/challenge-detail/Skeletons';
import { StickyFooter } from '../components/challenge-detail/StickyFooter';
import { challengeStatusMeta, formatCalendarDay, parseCalendarDate } from '../components/challenge-detail/meta';
import type { SpectatorParticipant } from '../types';
import { formatKES } from '../utils/currency';
import { formatSteps } from '../lib/format';
import { usePollInterval } from '../hooks/useDataSaver';

function daysLeft(endDate: string): number {
  const end = parseCalendarDate(endDate);
  const today = new Date();
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.max(0, Math.round((end.getTime() - startOfToday.getTime()) / 86_400_000));
}

export default function SpectatorScreen() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const user = useAuthStore((state) => state.user);

  const livePoll = usePollInterval(60_000);
  const { data, isLoading, isError, error, refetch, isRefetching, dataUpdatedAt } = useQuery({
    queryKey: ['challenges', 'spectate', id],
    queryFn: () => challengesService.getSpectatorLeaderboard(Number(id)),
    enabled: !!id,
    refetchInterval: livePoll,
  });

  if (isLoading) {
    return (
      <div className="pb-nav">
        <ScreenHeader title="Live leaderboard" back />
        <SpectatorSkeleton />
      </div>
    );
  }

  if (isError || !data) {
    const status = (error as { response?: { status?: number } } | null)?.response?.status;
    return (
      <div className="pb-nav">
        <ScreenHeader title="Live leaderboard" back />
        {status === 404 ? (
          <NotFoundError
            message="This leaderboard isn’t public, or the challenge no longer exists."
            onGoBack={() => navigate('/challenges')}
            className="pt-16"
          />
        ) : (
          <LoadError resource="the leaderboard" onRetry={() => refetch()} isRetrying={isRefetching} className="pt-16" />
        )}
      </div>
    );
  }

  const { challenge, leaderboard, qualified_count, total_participants, user_is_participant } = data;
  const statusMeta = challengeStatusMeta(challenge.status);
  const isCompleted = challenge.status === 'completed';
  const remaining = daysLeft(challenge.end_date);
  const updatedAt = dataUpdatedAt ? new Date(dataUpdatedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : null;

  return (
    <div className="pb-nav">
      <ScreenHeader title="Live leaderboard" back />

      <div className="space-y-8 px-5 pt-1">
        <section aria-labelledby="spectate-title">
          <div className="flex flex-wrap items-center gap-1.5">
            <Pill tone={statusMeta.tone} dot={statusMeta.live ? 'live' : undefined} icon={statusMeta.icon}>
              {statusMeta.label}
            </Pill>
            <Pill icon={Eye}>View only</Pill>
            <Pill icon={Target}>{formatSteps(challenge.milestone)} steps</Pill>
          </div>
          <h1 id="spectate-title" className="mt-3 text-title-lg text-text-primary [overflow-wrap:anywhere]">
            {challenge.name}
          </h1>

          <dl className="mt-5 grid grid-cols-3 divide-x divide-border-light">
            <div className="min-w-0 pr-3">
              <dt className="text-caption text-text-muted">Participants</dt>
              <dd className="num mt-0.5 text-headline text-text-primary">{total_participants}</dd>
            </div>
            <div className="min-w-0 px-3">
              <dt className="text-caption text-text-muted">Qualified</dt>
              <dd className="num mt-0.5 text-headline text-text-primary">
                {qualified_count}
                <span className="text-callout font-normal text-text-muted"> of {total_participants}</span>
              </dd>
            </div>
            <div className="min-w-0 pl-3">
              <dt className="text-caption text-text-muted">{isCompleted ? 'Ended' : 'Time left'}</dt>
              <dd className="num mt-0.5 truncate text-headline text-text-primary">
                {isCompleted ? formatCalendarDay(challenge.end_date) : remaining === 0 ? 'Last day' : `${remaining} ${remaining === 1 ? 'day' : 'days'}`}
              </dd>
            </div>
          </dl>
        </section>

        <ListGroup title="Pool">
          <ListRow
            title="Total pool"
            subtitle={`Ends ${formatCalendarDay(challenge.end_date)}`}
            trailing={<span className="num text-headline text-reward-ink">{formatKES(challenge.total_pool)}</span>}
          />
          <ListRow title="Entry contribution" trailing={<span className="num text-callout text-text-secondary">{formatKES(challenge.entry_fee)}</span>} />
        </ListGroup>

        <section aria-labelledby="rankings-title">
          <div className="mb-3">
            <h2 id="rankings-title" className="text-headline text-text-primary">
              Rankings
            </h2>
            <p className="mt-0.5 text-caption text-text-muted">
              Estimated payouts are for qualified walkers if the challenge ended now
              {updatedAt ? ` · updated ${updatedAt}` : ''}
            </p>
          </div>

          {leaderboard.length === 0 ? (
            <Card padding="none">
              <EmptyState title="No participants yet" description="Rankings appear as soon as people join and start walking." />
            </Card>
          ) : (
            <LeaderboardList label={`${challenge.name} rankings`}>
              {leaderboard.map((p: SpectatorParticipant) => (
                <LeaderboardRow
                  key={p.username}
                  id={p.username}
                  rank={p.rank}
                  name={p.username}
                  steps={p.steps}
                  progress={p.progress_pct}
                  qualified={p.qualified}
                  isYou={!!user?.username && p.username === user.username}
                  trailing={
                    p.qualified && p.estimated_payout != null ? (
                      <span className="num font-semibold text-reward-ink">
                        <span className="sr-only">Estimated payout </span>~{formatKES(p.estimated_payout)}
                      </span>
                    ) : undefined
                  }
                />
              ))}
            </LeaderboardList>
          )}
        </section>

        {user_is_participant && (
          <Button variant="secondary" size="lg" fullWidth onClick={() => navigate(`/challenges/${challenge.id}`)}>
            Open your challenge
          </Button>
        )}
      </div>

      {!user_is_participant && !isCompleted && (
        <StickyFooter>
          <Button fullWidth size="lg" onClick={() => navigate(`/challenges/lobby/${challenge.id}`)}>
            Join for {formatKES(challenge.entry_fee)}
          </Button>
        </StickyFooter>
      )}
    </div>
  );
}
