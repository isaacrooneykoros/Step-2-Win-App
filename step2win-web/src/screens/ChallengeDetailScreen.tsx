import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import {
  CalendarRange,
  CheckCircle2,
  Clock,
  Globe,
  Lock,
  LogOut,
  Radio,
  RefreshCw,
  RotateCcw,
  Scale,
  Target,
  UserPlus,
  type LucideIcon,
} from 'lucide-react';
import { challengesService } from '../services/api';
import { useAuthStore } from '../store/authStore';
import { useToast } from '../components/ui/Toast';
import { CelebrationModal, type CelebrationData } from '../components/ui/CelebrationModal';
import GroupChat from '../components/GroupChat';
import { ChallengeSocialBadges } from '../components/ui/ChallengeSocialBadges';
import { ScreenHeader, IconButton } from '../components/ui/ScreenHeader';
import Pill from '../components/ui/Pill';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import { ListGroup, ListRow } from '../components/ui/ListRow';
import ProgressBar from '../components/ui/ProgressBar';
import { ProgressRing } from '../components/ui/ProgressRing';
import AnimatedNumber from '../components/ui/AnimatedNumber';
import { Sheet } from '../components/ui/Sheet';
import { ErrorInline, LoadError, NotFoundError } from '../components/ui/ErrorState';
import { EmptyState } from '../components/ui/EmptyState';
import { LeaderboardList, LeaderboardRow, LeaderboardSkeleton } from '../components/challenge-detail/Leaderboard';
import { InviteSheet } from '../components/challenge-detail/InviteSheet';
import { StickyFooter } from '../components/challenge-detail/StickyFooter';
import { ChallengeDetailSkeleton } from '../components/challenge-detail/Skeletons';
import {
  apiErrorMessage,
  challengeStatusMeta,
  formatCalendarDay,
  timeLeftLabel,
  toNumber,
  winConditionRule,
} from '../components/challenge-detail/meta';
import type { ChallengeDetail, Participant } from '../types';
import { formatKES } from '../utils/currency';
import { challengeDayProgress, formatSteps } from '../lib/format';
import { usePollInterval } from '../hooks/useDataSaver';

function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function Metric({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: string; tone?: 'reward' }) {
  return (
    <div className="min-w-0 px-3 first:pl-0 last:pr-0">
      <dt className="truncate text-caption text-text-muted">{label}</dt>
      <dd className={`num mt-0.5 truncate text-headline ${tone === 'reward' ? 'text-reward-ink' : 'text-text-primary'}`}>{value}</dd>
      {hint && <dd className="mt-0.5 truncate text-caption text-text-muted">{hint}</dd>}
    </div>
  );
}

function RuleItem({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-3 px-4 py-3.5">
      <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-bg-input text-text-secondary" aria-hidden>
        <Icon size={16} />
      </span>
      <div className="min-w-0">
        <p className="text-callout font-semibold text-text-primary">{title}</p>
        <p className="mt-0.5 text-callout text-text-secondary">{children}</p>
      </div>
    </li>
  );
}

export default function ChallengeDetailScreen() {
  const { id } = useParams<{ id: string }>();
  const challengeId = Number(id);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const user = useAuthStore((state) => state.user);
  const { showToast } = useToast();

  const [showCelebration, setShowCelebration] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [rematchOpen, setRematchOpen] = useState(false);

  const {
    data: challenge,
    isLoading,
    isError,
    error,
    refetch,
    isRefetching,
  } = useQuery<ChallengeDetail>({
    queryKey: ['challenges', id],
    queryFn: () => challengesService.getDetail(challengeId),
    enabled: !!id,
  });

  const isActive = challenge?.status === 'active';

  // Live challenges refresh quietly (paused while data saver is on).
  const livePoll = usePollInterval(isActive ? 60_000 : false);

  const leaderboardQuery = useQuery<Participant[]>({
    queryKey: ['challenges', id, 'leaderboard'],
    queryFn: () => challengesService.getLeaderboard(challengeId),
    enabled: !!id,
    // Live challenges refresh quietly so rank changes appear without a pull.
    refetchInterval: livePoll,
  });

  const { data: stats } = useQuery({
    queryKey: ['challenges', id, 'stats'],
    queryFn: () => challengesService.getStats(challengeId),
    enabled: !!id,
  });

  const leaderboard = leaderboardQuery.data ?? challenge?.participants ?? [];
  const userParticipant = challenge?.my_participation || leaderboard.find((p) => p.user === user?.id);

  // Estimated payouts are only published on the public live board.
  const spectateQuery = useQuery({
    queryKey: ['challenges', 'spectate', id],
    queryFn: () => challengesService.getSpectatorLeaderboard(challengeId),
    enabled: !!challenge && isActive && !challenge.is_private && !!userParticipant,
    retry: false,
    refetchInterval: livePoll,
  });

  const rematchMutation = useMutation({
    mutationFn: () => challengesService.rematch(challengeId),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['challenges'] });
      queryClient.invalidateQueries({ queryKey: ['wallet'] });
      setRematchOpen(false);
      showToast({ message: 'Rematch started. Invite the group to join.', type: 'success' });
      navigate(`/challenges/${data.challenge.id}`);
    },
    onError: (err: unknown) => {
      showToast({ message: apiErrorMessage(err, 'Couldn’t start the rematch. Try again.'), type: 'error' });
    },
  });

  const leaveMutation = useMutation({
    mutationFn: () => challengesService.leave(challengeId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['challenges'] });
      queryClient.invalidateQueries({ queryKey: ['wallet'] });
      setLeaveOpen(false);
      showToast({
        message: `You left the challenge. ${formatKES(challenge?.entry_fee)} is back in your wallet.`,
        type: 'success',
      });
      navigate('/challenges');
    },
    onError: (err: unknown) => {
      showToast({ message: apiErrorMessage(err, 'Couldn’t leave the challenge. Try again.'), type: 'error' });
    },
  });

  const celebrationData = useMemo<CelebrationData | null>(() => {
    if (!challenge || !userParticipant) return null;
    return {
      challengeName: challenge.name,
      payout: toNumber(userParticipant.payout),
      position: userParticipant.rank,
      totalParticipants: leaderboard.length || challenge.current_participants || undefined,
      steps: userParticipant.steps,
      milestone: challenge.milestone,
    };
  }, [challenge, leaderboard.length, userParticipant]);

  useEffect(() => {
    if (!challenge || !userParticipant || !id || !user?.id) return;
    if (!(challenge.status === 'completed' && userParticipant.qualified)) return;
    const storageKey = `celebration_shown_${user.id}_${id}`;
    if (localStorage.getItem(storageKey) === 'true') return;
    setShowCelebration(true);
    localStorage.setItem(storageKey, 'true');
  }, [challenge, id, user?.id, userParticipant]);

  if (isLoading) {
    return (
      <div className="pb-nav">
        <ScreenHeader title="Challenge" back="/challenges" />
        <ChallengeDetailSkeleton />
      </div>
    );
  }

  if (isError || !challenge) {
    const status = (error as { response?: { status?: number } } | null)?.response?.status;
    return (
      <div className="pb-nav">
        <ScreenHeader title="Challenge" back="/challenges" />
        {status === 404 || (!isError && !challenge) ? (
          <NotFoundError message="This challenge doesn’t exist or is no longer available." onGoBack={() => navigate('/challenges')} className="pt-16" />
        ) : (
          <LoadError resource="this challenge" onRetry={() => refetch()} isRetrying={isRefetching} className="pt-16" />
        )}
      </div>
    );
  }

  const status = challenge.status;
  const statusMeta = challengeStatusMeta(status);
  const isCompleted = status === 'completed';
  const isOpen = status === 'active' || status === 'pending';
  // "pending" = waiting for admin approval: not listed and not joinable yet.
  const awaitingApproval = status === 'pending';
  const milestone = challenge.milestone;
  const day = challengeDayProgress(challenge.start_date, challenge.end_date);
  const totalParticipants = leaderboard.length || challenge.current_participants;
  const qualifiedCount = stats?.qualified_count ?? leaderboard.filter((p) => p.qualified || p.steps >= milestone).length;

  const mySteps = userParticipant?.steps ?? 0;
  const myQualified = userParticipant ? (isCompleted ? userParticipant.qualified : userParticipant.qualified || mySteps >= milestone) : false;
  const myPct = milestone > 0 ? Math.min(100, Math.round((mySteps / milestone) * 100)) : 0;
  const toGo = Math.max(0, milestone - mySteps);
  const daysIncludingToday = Math.max(1, (challenge.days_remaining ?? 0) + 1);
  const myPayout = toNumber(userParticipant?.payout);
  const myIndex = userParticipant ? leaderboard.findIndex((p) => p.user === userParticipant.user) : -1;
  const myRank = userParticipant?.rank ?? (!isCompleted && myIndex >= 0 ? myIndex + 1 : null);

  const spectatorMe = spectateQuery.data?.leaderboard.find((p) => p.username === user?.username);
  const estimatedPayout = userParticipant?.estimated_payout != null
    ? toNumber(userParticipant.estimated_payout)
    : spectatorMe?.estimated_payout ?? null;

  const totalPool = toNumber(stats?.total_pool ?? challenge.total_pool);
  const platformFee = toNumber(stats?.platform_fee ?? challenge.platform_fee);
  const netPool = toNumber(stats?.net_pool ?? challenge.net_pool);
  const feePct = totalPool > 0 ? Math.round((platformFee / totalPool) * 100) : null;
  const rule = winConditionRule(challenge.win_condition, milestone);

  const canLeave = !!userParticipant && (status === 'pending' || (status === 'active' && localToday() <= challenge.start_date));
  const canInvite = !!challenge.invite_code && status === 'active' && !challenge.is_full;
  const canRematch = isCompleted && challenge.is_private && !!userParticipant;
  const showJoin = !userParticipant && status === 'active' && !challenge.is_full;

  return (
    <div className="pb-nav">
      <ScreenHeader
        title="Challenge"
        back="/challenges"
        actions={
          canInvite ? (
            <IconButton label="Invite friends" onClick={() => setInviteOpen(true)}>
              <UserPlus size={20} aria-hidden />
            </IconButton>
          ) : undefined
        }
      />

      <div className="space-y-8 px-5 pt-1">
        {/* ── Overview ─────────────────────────────────────────── */}
        <section aria-labelledby="challenge-title">
          <div className="flex flex-wrap items-center gap-1.5">
            <Pill tone={statusMeta.tone} dot={statusMeta.live ? 'live' : undefined} icon={statusMeta.icon}>
              {statusMeta.label}
            </Pill>
            <Pill icon={challenge.is_private ? Lock : Globe}>{challenge.is_private ? 'Private' : 'Public'}</Pill>
            <Pill icon={Target}>{formatSteps(milestone)} steps</Pill>
          </div>
          <h1 id="challenge-title" className="mt-3 text-title-lg text-text-primary [overflow-wrap:anywhere]">
            {challenge.name}
          </h1>
          {challenge.description && <p className="mt-1.5 text-callout text-text-secondary">{challenge.description}</p>}

          <div className="mt-5">
            <div className="flex items-baseline justify-between gap-3">
              <p className="text-callout font-semibold text-text-primary">
                {status === 'active' ? (
                  <span className="num">
                    Day {day.currentDay} of {day.totalDays}
                  </span>
                ) : status === 'pending' ? (
                  <span className="num">{day.totalDays}-day challenge</span>
                ) : (
                  <span className="num">Finished · {day.totalDays} days</span>
                )}
              </p>
              <p className="text-callout text-text-secondary">
                {timeLeftLabel(status, challenge.days_remaining, challenge.start_date, challenge.end_date)}
              </p>
            </div>
            <ProgressBar
              className="mt-2"
              height="sm"
              color="brand"
              progress={status === 'pending' ? 0 : isCompleted ? 100 : day.fraction * 100}
              label="Challenge timeline"
            />
            <div className="mt-1.5 flex justify-between text-caption text-text-muted">
              <span>{formatCalendarDay(challenge.start_date)}</span>
              <span>{formatCalendarDay(challenge.end_date)}</span>
            </div>
          </div>

          {awaitingApproval && (
            <div className="mt-5 flex items-start gap-3 rounded-card bg-warning-soft p-4" role="status">
              <Clock size={18} className="mt-0.5 shrink-0 text-warning" aria-hidden />
              <div className="min-w-0">
                <p className="text-callout font-semibold text-text-primary">Waiting for approval</p>
                <p className="mt-0.5 text-caption text-text-secondary">
                  Step2Win reviews new public challenges before they appear in the lobby. Once approved it goes live and others can join. If
                  it isn’t approved, your entry is refunded to your wallet.
                </p>
              </div>
            </div>
          )}
        </section>

        {/* ── Your performance ─────────────────────────────────── */}
        {userParticipant && (
          <section aria-labelledby="perf-title">
            <h2 id="perf-title" className="mb-3 text-headline text-text-primary">
              {isCompleted ? 'Your result' : 'Your performance'}
            </h2>
            <Card padding="lg">
              <div className="flex items-center gap-5">
                <ProgressRing
                  value={mySteps}
                  goal={milestone}
                  size={112}
                  strokeWidth={10}
                  sweep={1}
                  label={`${formatSteps(mySteps)} of ${formatSteps(milestone)} steps`}
                >
                  <span className="num text-title text-text-primary">{myPct}%</span>
                  <span className="text-micro text-text-muted">of goal</span>
                </ProgressRing>
                <div className="min-w-0 flex-1">
                  <AnimatedNumber value={mySteps} className="block text-title-lg text-text-primary" startFromValue />
                  <p className="text-callout text-text-secondary">of {formatSteps(milestone)} steps</p>
                  <div className="mt-3">
                    {myQualified ? (
                      <Pill tone="success" icon={CheckCircle2} size="md">
                        Qualified
                      </Pill>
                    ) : isCompleted ? (
                      <Pill tone="neutral" size="md">
                        Not qualified
                      </Pill>
                    ) : (
                      <Pill tone="neutral" size="md">
                        <span className="num">{formatSteps(toGo)}</span> to qualify
                      </Pill>
                    )}
                  </div>
                </div>
              </div>

              <dl className="mt-5 grid grid-cols-2 divide-x divide-border-light border-t border-border-light pt-4 min-[380px]:grid-cols-3">
                <Metric
                  label={isCompleted ? 'Final rank' : 'Rank'}
                  value={
                    myRank ? (
                      <>
                        {myRank}
                        <span className="text-callout font-normal text-text-muted"> of {totalParticipants}</span>
                      </>
                    ) : (
                      '–'
                    )
                  }
                />
                {isCompleted ? (
                  <Metric label="Payout" value={myPayout > 0 ? formatKES(myPayout) : '–'} tone={myPayout > 0 ? 'reward' : undefined} />
                ) : myQualified ? (
                  <Metric label="Over goal" value={`+${formatSteps(mySteps - milestone)}`} />
                ) : status === 'active' ? (
                  <Metric
                    label="Daily target"
                    value={formatSteps(Math.ceil(toGo / daysIncludingToday))}
                    hint={`for ${daysIncludingToday} ${daysIncludingToday === 1 ? 'day' : 'days'}`}
                  />
                ) : (
                  <Metric label="To qualify" value={formatSteps(toGo)} />
                )}
                <div className="hidden min-[380px]:block">
                  {estimatedPayout != null && !isCompleted ? (
                    <Metric label="Est. payout" value={formatKES(estimatedPayout)} tone="reward" hint="if it ended now" />
                  ) : (
                    <Metric label="Qualified" value={`${qualifiedCount} of ${totalParticipants}`} />
                  )}
                </div>
              </dl>
              {estimatedPayout != null && !isCompleted && (
                <p className="mt-3 text-caption text-text-muted min-[380px]:hidden">
                  Estimated payout if it ended now: <span className="num font-semibold text-reward-ink">{formatKES(estimatedPayout)}</span>
                </p>
              )}
            </Card>
          </section>
        )}

        {/* ── Leaderboard ──────────────────────────────────────── */}
        <section aria-labelledby="board-title">
          <div className="mb-3 flex items-end justify-between gap-3">
            <div className="min-w-0">
              <h2 id="board-title" className="text-headline text-text-primary">
                {isCompleted ? 'Final standings' : 'Leaderboard'}
              </h2>
              <p className="mt-0.5 text-caption text-text-muted">
                <span className="num">
                  {qualifiedCount} of {totalParticipants}
                </span>{' '}
                qualified{isActive ? ' · refreshes every minute' : ''}
              </p>
            </div>
            {isActive && !challenge.is_private && (
              <Button variant="ghost" size="sm" className="-mr-2 min-h-touch text-brand" leftIcon={<Radio size={16} aria-hidden />} onClick={() => navigate(`/challenges/${challenge.id}/spectate`)}>
                Live view
              </Button>
            )}
          </div>

          {leaderboardQuery.isLoading && !challenge.participants?.length ? (
            <LeaderboardSkeleton rows={Math.min(6, challenge.current_participants || 4)} />
          ) : leaderboard.length === 0 ? (
            <Card padding="none">
              <EmptyState title="No participants yet" description="Invite friends — the leaderboard fills in as people join." />
            </Card>
          ) : (
            <LeaderboardList label={`${challenge.name} leaderboard`}>
              {leaderboard.map((p, index) => (
                <LeaderboardRow
                  key={p.user}
                  id={p.user}
                  rank={isCompleted ? p.rank : p.rank ?? index + 1}
                  name={p.username}
                  steps={p.steps}
                  progress={milestone > 0 ? (p.steps / milestone) * 100 : 0}
                  qualified={isCompleted ? p.qualified : p.qualified || p.steps >= milestone}
                  isYou={p.user === user?.id}
                  trailing={
                    isCompleted && toNumber(p.payout) > 0 ? (
                      <span className="num font-semibold text-reward-ink">{formatKES(p.payout)}</span>
                    ) : undefined
                  }
                />
              ))}
            </LeaderboardList>
          )}
          {leaderboardQuery.isError && (
            <ErrorInline className="mt-3" message="Couldn’t refresh the leaderboard." onRetry={() => leaderboardQuery.refetch()} />
          )}
        </section>

        {/* ── Pool & rewards ───────────────────────────────────── */}
        <ListGroup
          title="Pool & rewards"
          footer={
            isCompleted
              ? 'Payouts were credited to winners’ wallets when the challenge closed.'
              : 'Payouts are credited to wallets automatically when the challenge closes.'
          }
        >
          <ListRow title="Entry contribution" trailing={<span className="num text-callout font-semibold text-text-primary">{formatKES(challenge.entry_fee)}</span>} />
          <ListRow
            title="Total pool"
            subtitle={`From ${totalParticipants} ${totalParticipants === 1 ? 'participant' : 'participants'}`}
            trailing={<span className="num text-callout font-semibold text-text-primary">{formatKES(totalPool)}</span>}
          />
          <ListRow
            title="Platform fee"
            subtitle={feePct != null ? `${feePct}% of the pool` : undefined}
            trailing={<span className="num text-callout text-text-secondary">− {formatKES(platformFee)}</span>}
          />
          <ListRow
            title="Net pool"
            subtitle="Shared by qualified finishers"
            trailing={<span className="num text-headline text-reward-ink">{formatKES(netPool)}</span>}
          />
          {isCompleted && userParticipant && myPayout > 0 && (
            <ListRow
              title="Your payout"
              trailing={<span className="num text-headline text-reward-ink">{formatKES(myPayout)}</span>}
            />
          )}
          {!isCompleted && estimatedPayout != null && (
            <ListRow
              title="Your estimated payout"
              subtitle="If the challenge ended now"
              trailing={<span className="num text-headline text-reward-ink">{formatKES(estimatedPayout)}</span>}
            />
          )}
        </ListGroup>

        {/* ── How it works ─────────────────────────────────────── */}
        <section aria-labelledby="rules-title">
          <h2 id="rules-title" className="eyebrow mb-2 px-1">
            How it works
          </h2>
          <ul className="divide-y divide-border-light overflow-hidden rounded-card border border-border-light bg-bg-card shadow-card">
            <RuleItem icon={Target} title="Reach the goal">
              Walk at least <span className="num font-semibold text-text-primary">{formatSteps(milestone)}</span> steps between{' '}
              {formatCalendarDay(challenge.start_date)} and {formatCalendarDay(challenge.end_date)}.
            </RuleItem>
            <RuleItem icon={Scale} title={rule.title}>
              {rule.body}
            </RuleItem>
            <RuleItem icon={RotateCcw} title="Nobody qualifies?">
              Every entry contribution is refunded in full.
            </RuleItem>
            {isOpen && (
              <RuleItem icon={CalendarRange} title="Changing your mind">
                You can leave until the end of the first day and your entry contribution returns to your wallet.
              </RuleItem>
              )}
          </ul>
        </section>

        {/* ── Private group features ───────────────────────────── */}
        {userParticipant && challenge.is_private && (
          <>
            <ChallengeSocialBadges challengeId={challenge.id} />
            <GroupChat challengeId={challenge.id} />
          </>
        )}

        {/* ── Details ──────────────────────────────────────────── */}
        <ListGroup title="Details">
          <ListRow title="Created by" trailing={<span className="text-callout text-text-secondary">{challenge.creator_username}</span>} />
          <ListRow
            title="Participants"
            trailing={
              <span className="num text-callout text-text-secondary">
                {challenge.current_participants} of {challenge.max_participants}
              </span>
            }
          />
          <ListRow
            title="Visibility"
            trailing={<span className="text-callout text-text-secondary">{challenge.is_private ? 'Private · invite only' : 'Public'}</span>}
          />
          {canInvite && (
            <ListRow
              title="Invite code"
              onClick={() => setInviteOpen(true)}
              trailing={<span className="num text-callout tracking-widest text-text-secondary">{challenge.invite_code}</span>}
            />
          )}
        </ListGroup>

        {canLeave && (
          <div className="flex justify-center">
            <Button variant="ghost" className="text-danger" leftIcon={<LogOut size={18} aria-hidden />} onClick={() => setLeaveOpen(true)}>
              Leave challenge
            </Button>
          </div>
        )}
      </div>

      {/* ── Sticky actions ─────────────────────────────────────── */}
      {isCompleted && (
        <StickyFooter>
          <div className="flex gap-2">
            {canRematch && (
              <Button variant="secondary" size="lg" className="flex-1" leftIcon={<RefreshCw size={18} aria-hidden />} onClick={() => setRematchOpen(true)}>
                Rematch
              </Button>
            )}
            <Button size="lg" className="flex-1" onClick={() => navigate(`/challenges/${challenge.id}/results`)}>
              View results
            </Button>
          </div>
        </StickyFooter>
      )}
      {showJoin && (
        <StickyFooter>
          <Button fullWidth size="lg" onClick={() => navigate(`/challenges/lobby/${challenge.id}`)}>
            Join for {formatKES(challenge.entry_fee)}
          </Button>
        </StickyFooter>
      )}

      {challenge.invite_code && (
        <InviteSheet open={inviteOpen} onClose={() => setInviteOpen(false)} inviteCode={challenge.invite_code} challengeName={challenge.name} />
      )}

      <Sheet
        open={leaveOpen}
        onClose={() => setLeaveOpen(false)}
        dismissible={!leaveMutation.isPending}
        title="Leave this challenge?"
        description={`Your ${formatKES(challenge.entry_fee)} entry contribution goes back to your wallet and you’ll be removed from the leaderboard.`}
        size="sm"
        footer={
          <div className="flex flex-col gap-2">
            <Button variant="danger" size="lg" fullWidth isLoading={leaveMutation.isPending} loadingText="Leaving…" onClick={() => leaveMutation.mutate()}>
              Leave and refund {formatKES(challenge.entry_fee)}
            </Button>
            <Button variant="ghost" fullWidth disabled={leaveMutation.isPending} onClick={() => setLeaveOpen(false)}>
              Stay in
            </Button>
          </div>
        }
      >
        <p className="text-callout text-text-secondary">You can rejoin later only if the challenge still has open spots and hasn’t started.</p>
      </Sheet>

      <Sheet
        open={rematchOpen}
        onClose={() => setRematchOpen(false)}
        dismissible={!rematchMutation.isPending}
        title="Start a rematch?"
        description="A new private challenge starts today with the same goal, length and entry contribution."
        size="sm"
        footer={
          <div className="flex flex-col gap-2">
            <Button size="lg" fullWidth isLoading={rematchMutation.isPending} loadingText="Starting rematch…" onClick={() => rematchMutation.mutate()}>
              Pay {formatKES(challenge.entry_fee)} and start
            </Button>
            <Button variant="ghost" fullWidth disabled={rematchMutation.isPending} onClick={() => setRematchOpen(false)}>
              Cancel
            </Button>
          </div>
        }
      >
        <dl className="divide-y divide-border-light rounded-card border border-border-light">
          <div className="flex justify-between gap-3 px-4 py-3">
            <dt className="text-callout text-text-secondary">Goal</dt>
            <dd className="num text-callout font-semibold text-text-primary">{formatSteps(milestone)} steps</dd>
          </div>
          <div className="flex justify-between gap-3 px-4 py-3">
            <dt className="text-callout text-text-secondary">Length</dt>
            <dd className="num text-callout font-semibold text-text-primary">{day.totalDays} days</dd>
          </div>
          <div className="flex justify-between gap-3 px-4 py-3">
            <dt className="text-callout text-text-secondary">Entry contribution</dt>
            <dd className="num text-callout font-semibold text-text-primary">{formatKES(challenge.entry_fee)}</dd>
          </div>
        </dl>
        <p className="mt-3 text-caption text-text-muted">Paid from your wallet balance. You’ll get an invite code to share with the group.</p>
      </Sheet>

      <CelebrationModal
        isOpen={showCelebration}
        onClose={() => setShowCelebration(false)}
        data={celebrationData}
        onPrimary={() => {
          setShowCelebration(false);
          navigate(`/challenges/${challenge.id}/results`);
        }}
      />
    </div>
  );
}
