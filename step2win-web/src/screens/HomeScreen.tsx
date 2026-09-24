import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ChevronRight, Flame, Pencil, Trophy, Wallet } from 'lucide-react';
import { authService, challengesService, stepsService, walletService } from '../services/api';
import { useAuthStore } from '../store/authStore';
import { useStepsSyncStore } from '../store/stepsSyncStore';
import { ProgressRing } from '../components/ui/ProgressRing';
import { AnimatedNumber } from '../components/ui/AnimatedNumber';
import { StepStatChips } from '../components/ui/StepStatChips';
import Card, { SectionHeader } from '../components/ui/Card';
import { IconTile } from '../components/ui/Pill';
import { ListGroup, ListRow } from '../components/ui/ListRow';
import { BadgeGlyph } from '../components/ui/BadgeGlyph';
import { Skeleton } from '../components/ui/Skeleton';
import { ErrorInline } from '../components/ui/ErrorState';
import { formatKESShort, formatRelativeTime, formatSteps } from '../lib/format';
import { useDailyGoal } from '../components/steps/stepUtils';
import { ActiveChallengeCard, ActiveChallengeSkeleton, NoChallengeCard } from '../components/home/ActiveChallengeCard';
import { WeekStepsCard } from '../components/home/WeekStepsCard';
import { DailyGoalSheet } from '../components/home/DailyGoalSheet';
import { ResultsSheet, resultOutcome } from '../components/home/ResultsSheet';
import { fetchMyBadges } from '../components/home/fetchMyBadges';
import type { ChallengeDetail } from '../types';
import { usePollInterval } from '../hooks/useDataSaver';

function greeting(hour: number) {
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

/** Re-render every minute so relative times ("5 min ago") stay honest. */
function useMinuteTick() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

export default function HomeScreen() {
  const user = useAuthStore((state) => state.user);
  const isLive = useStepsSyncStore((state) => state.isStepsSocketConnected);
  const lastLiveUpdate = useStepsSyncStore((state) => state.lastStepsUpdateAt);
  useMinuteTick();
  const { goal } = useDailyGoal();

  const [goalOpen, setGoalOpen] = useState(false);
  const [resultsOpen, setResultsOpen] = useState(false);

  const today = useQuery({ queryKey: ['health', 'today'], queryFn: stepsService.getTodayHealth });
  const profile = useQuery({ queryKey: ['profile'], queryFn: authService.getProfile });
  const weekly = useQuery({ queryKey: ['steps', 'weekly'], queryFn: stepsService.getWeekly });
  const challenges = useQuery({ queryKey: ['challenges', 'my'], queryFn: challengesService.getMyChallenges });
  const badges = useQuery({ queryKey: ['gamification', 'badges', 'my', 'home'], queryFn: fetchMyBadges });
  const walletPoll = usePollInterval(30_000);
  const wallet = useQuery({
    queryKey: ['wallet', 'summary'],
    queryFn: walletService.getSummary,
    refetchInterval: walletPoll,
  });
  const results = useQuery({
    queryKey: ['challenges', 'my-results'],
    queryFn: () => challengesService.getMyRecentResults(),
    staleTime: 5 * 60 * 1000,
  });

  const steps = today.data?.steps ?? 0;
  const remaining = Math.max(0, goal - steps);
  const pct = goal > 0 ? Math.round((steps / goal) * 100) : 0;

  // Sync status: the newest of the live socket push and the server's record timestamp.
  const syncedAt = [lastLiveUpdate, today.data?.synced_at]
    .filter((t): t is string => Boolean(t))
    .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0];

  const myChallenges: ChallengeDetail[] = Array.isArray(challenges.data) ? challenges.data : [];
  const joined = myChallenges.filter((c) => c.my_participation !== null);
  // Most urgent first: the active challenge that ends soonest.
  const active = joined
    .filter((c) => c.status === 'active')
    .sort((a, b) => a.end_date.localeCompare(b.end_date));
  const upcoming = joined
    .filter((c) => c.status === 'pending')
    .sort((a, b) => a.start_date.localeCompare(b.start_date));
  const featured = active[0] ?? upcoming[0];
  const moreCount = active.length + upcoming.length - (featured ? 1 : 0);

  const streak = profile.data?.current_streak ?? user?.current_streak ?? 0;
  const bestStreak = profile.data?.best_streak ?? user?.best_streak ?? 0;
  const myBadges = badges.data ?? [];
  const latest = results.data?.has_results ? results.data : undefined;
  const latestOutcome = latest?.my_result ? resultOutcome(latest.my_result) : null;
  const firstName = user?.username ?? '';

  return (
    <div className="pb-nav">
      {/* Header */}
      <header className="px-5 pb-2 pt-safe">
        <div className="pt-4">
          <p className="text-caption text-text-muted">
            {new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}
          </p>
          <h1 className="mt-0.5 truncate text-title text-text-primary">
            {greeting(new Date().getHours())}
            {firstName ? `, ${firstName}` : ''}
          </h1>
          <p className="mt-1.5 flex items-center gap-1.5 text-caption text-text-muted" aria-live="polite">
            <span
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${isLive ? 'live-dot bg-brand' : 'bg-text-muted/60'}`}
              aria-hidden
            />
            {isLive ? 'Live' : 'Sync paused'}
            {syncedAt ? ` · updated ${formatRelativeTime(syncedAt)}` : today.isSuccess ? ' · no steps synced yet today' : ''}
          </p>
        </div>
      </header>

      <div className="space-y-8 px-5">
        {/* HERO: today vs daily goal */}
        <section aria-labelledby="today-heading" className="flex flex-col items-center pt-2">
          <h2 id="today-heading" className="sr-only">
            Today's steps
          </h2>
          {today.isError ? (
            <ErrorInline className="w-full" message="Couldn't load today's steps." onRetry={() => today.refetch()} />
          ) : (
            <>
              <Link
                to="/steps"
                className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-4 focus-visible:ring-offset-bg-page active:scale-[0.98]"
                aria-label={`Today: ${formatSteps(steps)} of ${formatSteps(goal)} steps, ${pct}% of your goal. Open step details.`}
              >
                <ProgressRing
                  value={steps}
                  goal={goal}
                  size={236}
                  strokeWidth={16}
                  loading={today.isLoading}
                  label={`${formatSteps(steps)} of ${formatSteps(goal)} steps`}
                >
                  {today.isLoading ? (
                    <Skeleton className="h-10 w-32 rounded-lg" />
                  ) : (
                    <>
                      <span className="eyebrow">Today</span>
                      <AnimatedNumber value={steps} startFromValue className="mt-1 text-display text-text-primary" />
                      <span className="num mt-1 text-callout text-text-muted">of {formatSteps(goal)} steps</span>
                      <span className="num mt-2 inline-flex items-center gap-0.5 text-callout font-semibold text-brand">
                        {pct}%
                        <ChevronRight size={15} aria-hidden />
                      </span>
                    </>
                  )}
                </ProgressRing>
              </Link>

              <div className="relative z-10 -mt-3 flex items-center gap-1 text-callout">
                {today.isLoading ? (
                  <Skeleton className="h-5 w-48 rounded" />
                ) : (
                  <>
                    <span className="text-text-secondary">
                      {remaining > 0 ? (
                        <>
                          <span className="num font-semibold text-text-primary">{formatSteps(remaining)}</span> to go
                        </>
                      ) : (
                        <span className="font-semibold text-brand">Daily goal reached</span>
                      )}
                    </span>
                    <span className="text-text-muted" aria-hidden>
                      ·
                    </span>
                    <button
                      type="button"
                      onClick={() => setGoalOpen(true)}
                      className="-my-2 inline-flex min-h-touch items-center gap-1 rounded-full px-2 font-semibold text-brand hover:bg-brand-soft"
                    >
                      <Pencil size={13} aria-hidden />
                      Edit goal
                    </button>
                  </>
                )}
              </div>

              {today.data && (
                <StepStatChips
                  className="mt-5 w-full"
                  distance={today.data.distance_km}
                  activeMins={today.data.active_minutes}
                  calories={today.data.calories_active}
                />
              )}
            </>
          )}
        </section>

        {/* Active challenge */}
        <section>
          <SectionHeader
            title={featured?.status === 'pending' ? 'Next challenge' : 'Your challenge'}
            action={moreCount > 0 ? { label: `${moreCount} more`, to: '/challenges' } : featured ? { label: 'All', to: '/challenges' } : undefined}
          />
          {challenges.isLoading ? (
            <ActiveChallengeSkeleton />
          ) : challenges.isError ? (
            <ErrorInline message="Couldn't load your challenges." onRetry={() => challenges.refetch()} />
          ) : featured ? (
            <ActiveChallengeCard challenge={featured} />
          ) : (
            <NoChallengeCard />
          )}
        </section>

        {/* Last 7 days */}
        <section>
          <SectionHeader title="Last 7 days" action={{ label: 'History', to: '/steps/history' }} />
          <WeekStepsCard
            days={weekly.data}
            goal={goal}
            isLoading={weekly.isLoading}
            isError={weekly.isError}
            onRetry={() => weekly.refetch()}
          />
        </section>

        {/* Wallet & rewards */}
        <section>
          <SectionHeader title="Wallet" />
          {wallet.isError ? (
            <ErrorInline message="Couldn't load your wallet." onRetry={() => wallet.refetch()} />
          ) : (
            <Card to="/wallet" padding="lg">
              <div className="flex items-start gap-3">
                <IconTile icon={Wallet} tone="neutral" />
                <div className="min-w-0 flex-1">
                  <p className="text-caption text-text-muted">Available balance</p>
                  {wallet.isLoading ? (
                    <Skeleton className="mt-1 h-7 w-32 rounded" />
                  ) : (
                    <p className="num mt-0.5 truncate text-title text-text-primary">
                      {formatKESShort(wallet.data?.available_balance ?? 0)}
                    </p>
                  )}
                </div>
                <ChevronRight size={18} className="mt-2.5 shrink-0 text-text-muted" aria-hidden />
              </div>
              {wallet.data && (
                <dl className="mt-4 grid grid-cols-2 gap-3 border-t border-border-light pt-4">
                  <div className="min-w-0">
                    <dt className="text-caption text-text-muted">Total earned</dt>
                    <dd className="num mt-0.5 truncate text-headline text-reward-ink">{formatKESShort(wallet.data.total_earned)}</dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="text-caption text-text-muted">In challenges</dt>
                    <dd className="num mt-0.5 truncate text-headline text-text-primary">
                      {formatKESShort(wallet.data.locked_balance)}
                    </dd>
                  </div>
                </dl>
              )}
            </Card>
          )}

          {latest?.challenge && latest.my_result && latestOutcome && (
            <ListGroup className="mt-3">
              <ListRow
                onClick={() => setResultsOpen(true)}
                chevron
                leading={<IconTile icon={Trophy} tone={Number(latest.my_result.payout_kes) > 0 ? 'reward' : 'neutral'} />}
                title="Latest result"
                subtitle={`${latest.challenge.name}${latest.my_result.final_rank ? ` · #${latest.my_result.final_rank}` : ''}`}
                trailing={
                  Number(latest.my_result.payout_kes) > 0 ? (
                    <span className="num text-callout font-semibold text-reward-ink">
                      +{formatKESShort(latest.my_result.payout_kes)}
                    </span>
                  ) : (
                    <span className="text-caption text-text-muted">{latestOutcome.label}</span>
                  )
                }
              />
            </ListGroup>
          )}
        </section>

        {/* Consistency */}
        <section>
          <SectionHeader
            title="Consistency"
            action={myBadges.length > 0 ? { label: 'Profile', to: '/profile' } : undefined}
          />
          <Card padding="lg">
            <div className="flex items-center gap-3">
              <IconTile icon={Flame} tone={streak > 0 ? 'brand' : 'neutral'} />
              <div className="min-w-0 flex-1">
                <p className="text-headline text-text-primary">
                  <span className="num">{streak}</span>-day streak
                </p>
                <p className="text-caption text-text-muted">
                  {bestStreak > 0 ? <span className="num">Best streak: {bestStreak} days</span> : 'Stay active daily to build a streak'}
                </p>
              </div>
            </div>

            {myBadges.length > 0 && (
              <ul className="mt-4 grid grid-cols-4 gap-2 border-t border-border-light pt-4" aria-label={`${myBadges.length} badges earned`}>
                {myBadges.slice(0, 4).map((ub) => (
                  <li key={ub.id} className="flex min-w-0 flex-col items-center text-center" title={ub.badge.description}>
                    <BadgeGlyph badge={ub.badge} size="sm" />
                    <span className="mt-1.5 line-clamp-2 text-micro text-text-secondary">{ub.badge.name}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </section>
      </div>

      <DailyGoalSheet open={goalOpen} onClose={() => setGoalOpen(false)} currentGoal={goal} />
      {latest && <ResultsSheet open={resultsOpen} onClose={() => setResultsOpen(false)} results={latest} />}
    </div>
  );
}
