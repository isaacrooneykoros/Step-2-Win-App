import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useParams, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, BadgeCheck, CheckCircle2, Eye, SearchX, Star, Users } from 'lucide-react';
import { challengesService } from '../services/api/challenges';
import { useAuthStore } from '../store/authStore';
import { useToast } from '../components/ui/Toast';
import { ScreenHeader } from '../components/ui/ScreenHeader';
import Button from '../components/ui/Button';
import Card from '../components/ui/Card';
import ProgressBar from '../components/ui/ProgressBar';
import { Pill } from '../components/ui/Pill';
import { Sheet } from '../components/ui/Sheet';
import { Skeleton } from '../components/ui/Skeleton';
import { ErrorState } from '../components/ui/ErrorState';
import { ListGroup, ListRow } from '../components/ui/ListRow';
import { formatKES, formatKESShort, formatSteps } from '../lib/format';
import { NextSteps, SummaryList } from '../components/challenge/SummaryList';
import {
  daysLeftLabel,
  daysUntil,
  durationDays,
  formatDay,
  milestoneTier,
  toNumber,
} from '../components/challenge/challengeUtils';

function describeJoinError(error: any): string {
  const data = error?.response?.data;
  const fieldMsg = data?.invite_code?.[0] ?? data?.details?.invite_code?.[0];
  if (fieldMsg) return String(fieldMsg);
  if (data?.error && typeof data.error === 'string') return data.error;
  if (typeof data?.message === 'string' && !data.message.startsWith('{')) return data.message;
  if (!error?.response) return "We couldn't reach Step2Win. Check your connection and try again.";
  return 'Something went wrong while joining. Please try again.';
}

/** Fixed action bar above the bottom navigation. Portalled so the route transition's transform doesn't trap it. */
function StickyFooter({ children }: { children: React.ReactNode }) {
  return createPortal(
    <div
      className="fixed inset-x-0 z-40 border-t border-border-light bg-bg-page/95 px-5 pb-3 pt-3 backdrop-blur-md md:left-1/2 md:right-auto md:w-[640px] md:-translate-x-1/2"
      style={{ bottom: 'calc(var(--nav-height) + env(safe-area-inset-bottom, 0px))' }}
    >
      {children}
    </div>,
    document.body,
  );
}

function PreviewSkeleton() {
  return (
    <div className="space-y-6 px-5" aria-hidden>
      <div>
        <div className="flex gap-2">
          <Skeleton className="h-6 w-14 rounded-full" />
          <Skeleton className="h-6 w-20 rounded-full" />
        </div>
        <Skeleton className="mt-3 h-8 w-4/5 rounded-md" />
        <Skeleton className="mt-2 h-4 w-3/5 rounded" />
      </div>
      <div className="rounded-card border border-border-light bg-bg-card p-5">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <Skeleton className="h-3 w-16 rounded" />
            <Skeleton className="mt-2 h-7 w-24 rounded-md" />
          </div>
          <div>
            <Skeleton className="h-3 w-16 rounded" />
            <Skeleton className="mt-2 h-7 w-28 rounded-md" />
          </div>
        </div>
        <Skeleton className="mt-5 h-3 w-full rounded" />
        <Skeleton className="mt-2 h-1.5 w-full rounded-full" />
      </div>
      <div className="space-y-2">
        <Skeleton className="h-4 w-24 rounded" />
        <Skeleton className="h-48 w-full rounded-card" />
      </div>
    </div>
  );
}

export default function ChallengePreviewScreen() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const user = useAuthStore((state) => state.user);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);

  const {
    data: challenge,
    isLoading,
    isError,
    error,
    refetch,
    isRefetching,
  } = useQuery({
    queryKey: ['challenges', 'lobby', id],
    queryFn: () => challengesService.getLobbyCard(Number(id)),
    enabled: !!id,
  });

  const { data: config } = useQuery({
    queryKey: ['challenges', 'config'],
    queryFn: challengesService.getConfig,
    staleTime: 10 * 60_000,
  });

  const joinMutation = useMutation({
    mutationFn: (inviteCode: string) => challengesService.join({ invite_code: inviteCode }),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['challenges'] });
      queryClient.invalidateQueries({ queryKey: ['profile'] });
      queryClient.invalidateQueries({ queryKey: ['wallet'] });
      showToast({ message: "You're in. Good luck!", type: 'success' });
      window.setTimeout(() => {
        setConfirmOpen(false);
        navigate(`/challenges/${result.challenge.id}`, { replace: true });
      }, 900);
    },
    onError: (err: any) => setJoinError(describeJoinError(err)),
  });

  const notFound = (error as any)?.response?.status === 404;

  if (isLoading || (!challenge && !isError)) {
    return (
      <div className="pb-nav">
        <ScreenHeader back="/challenges/lobby" title="Challenge" />
        <PreviewSkeleton />
      </div>
    );
  }

  if (!challenge) {
    return (
      <div className="pb-nav">
        <ScreenHeader back="/challenges/lobby" title="Challenge" />
        {notFound ? (
          <ErrorState
            icon={SearchX}
            title="Challenge not found"
            description="It may have ended or been removed."
            onRetry={() => navigate('/challenges/lobby')}
            retryLabel="Back to Discover"
          />
        ) : (
          <ErrorState
            title="Couldn't load this challenge"
            description="Check your connection and try again."
            onRetry={() => void refetch()}
            isRetrying={isRefetching}
            secondaryAction={{ label: 'Back', onClick: () => navigate('/challenges/lobby') }}
          />
        )}
      </div>
    );
  }

  const canJoin = !challenge.user_is_joined && challenge.spots_remaining > 0 && ['pending', 'active'].includes(challenge.status);
  const entry = toNumber(challenge.entry_fee);
  const pool = toNumber(challenge.effective_pool_kes);
  const bonus = toNumber(challenge.platform_bonus_kes);
  const available = user?.available_balance != null ? Number(user.available_balance) : null;
  const insufficient = available !== null && entry > available;
  const tier = milestoneTier(challenge.milestone_label);
  const duration = durationDays(challenge.start_date, challenge.end_date);
  const startsIn = daysUntil(challenge.start_date);
  const feePct = config ? Number(config.platform_fee_percentage) : null;
  const feeText = feePct !== null && Number.isFinite(feePct) ? `A ${feePct}% platform fee` : 'A platform fee';
  const isLive = challenge.status === 'active';

  const startValue =
    startsIn === null
      ? '—'
      : startsIn > 0
        ? `${formatDay(challenge.start_date, true)} (in ${startsIn} ${startsIn === 1 ? 'day' : 'days'})`
        : startsIn === 0
          ? 'Today'
          : formatDay(challenge.start_date, true);

  const handleSpectate = () => navigate(`/challenges/${challenge.id}/spectate`);

  const openConfirm = () => {
    setJoinError(null);
    joinMutation.reset();
    setConfirmOpen(true);
  };

  return (
    <div style={{ paddingBottom: 'calc(var(--nav-height) + env(safe-area-inset-bottom, 0px) + 120px)' }}>
      <ScreenHeader back="/challenges/lobby" title="Challenge" />

      <div className="space-y-6 px-5">
        <header>
          <div className="flex flex-wrap gap-1.5">
            {isLive ? (
              <Pill tone="success" dot="live">
                Live
              </Pill>
            ) : (
              <Pill tone="brand">Open for entries</Pill>
            )}
            {challenge.is_featured && (
              <Pill tone="brand" icon={Star}>
                Featured
              </Pill>
            )}
            {challenge.is_platform_challenge && (
              <Pill tone="info" icon={BadgeCheck}>
                Official
              </Pill>
            )}
            {challenge.is_almost_full && (
              <Pill tone="warning" icon={Users}>
                Almost full
              </Pill>
            )}
          </div>
          <h1 className="mt-3 text-title-lg text-text-primary">{challenge.name}</h1>
          <p className="mt-1 text-callout text-text-secondary">
            Public challenge · {formatSteps(challenge.milestone)} step goal{tier ? ` · ${tier}` : ''}
          </p>
        </header>

        <Card padding="lg">
          <div className="grid grid-cols-2 gap-4">
            <div className="min-w-0">
              <p className="text-caption text-text-muted">Entry contribution</p>
              <p className="num mt-1 truncate text-title text-text-primary">{formatKESShort(entry)}</p>
            </div>
            <div className="min-w-0">
              <p className="text-caption text-text-muted">Pool so far</p>
              <p className="num mt-1 truncate text-title text-reward-ink">{formatKESShort(pool)}</p>
              {bonus > 0 && <p className="mt-0.5 text-caption text-text-muted">Includes {formatKESShort(bonus)} platform bonus</p>}
            </div>
          </div>
          <div className="mt-5 border-t border-border-light pt-4">
            <div className="flex items-baseline justify-between gap-3 text-caption">
              <span className="text-text-secondary">
                <span className="num text-callout font-semibold text-text-primary">{challenge.participant_count}</span>
                <span className="num"> of {challenge.max_participants}</span> joined
              </span>
              <span className={`num font-semibold ${challenge.is_almost_full ? 'text-warning' : 'text-text-secondary'}`}>
                {challenge.spots_remaining === 0
                  ? 'Full'
                  : `${challenge.spots_remaining} ${challenge.spots_remaining === 1 ? 'spot' : 'spots'} left`}
              </span>
            </div>
            <ProgressBar
              className="mt-2"
              progress={challenge.fill_percentage}
              height="sm"
              color={challenge.is_almost_full ? 'warning' : 'brand'}
              label="Spots filled"
            />
          </div>
        </Card>

        <section>
          <h2 className="mb-3 text-headline text-text-primary">Key facts</h2>
          <SummaryList
            items={[
              { label: 'Step goal', value: `${formatSteps(challenge.milestone)} steps` },
              { label: isLive || (startsIn !== null && startsIn < 0) ? 'Started' : 'Starts', value: startValue },
              {
                label: 'Ends',
                value: `${formatDay(challenge.end_date, true)}${isLive ? ` (${daysLeftLabel(challenge.days_remaining).toLowerCase()})` : ''}`,
              },
              ...(duration ? [{ label: 'Duration', value: `${duration} days` }] : []),
              { label: 'Players', value: `${challenge.participant_count} joined · ${challenge.max_participants} max` },
            ]}
          />
        </section>

        <section>
          <h2 className="mb-3 text-headline text-text-primary">How it works</h2>
          <Card padding="lg">
            <NextSteps
              title="Rules"
              steps={[
                `Walk ${formatSteps(challenge.milestone)} steps in total between ${formatDay(challenge.start_date)} and ${formatDay(challenge.end_date)} to qualify.`,
                'Everyone who qualifies shares the pool in proportion to their steps. More steps, bigger share.',
                `${feeText} is taken from the pool before payouts.`,
                'If nobody reaches the goal, every entry is refunded in full.',
                'Payouts go to your Step2Win wallet, and you can withdraw them to M-Pesa.',
              ]}
            />
          </Card>
        </section>

        {isLive && !challenge.user_is_joined && (
          <ListGroup>
            <ListRow
              onClick={handleSpectate}
              chevron
              leading={<Eye size={20} className="text-text-muted" aria-hidden />}
              title="Watch the live leaderboard"
              subtitle="See how others are doing before you join"
            />
          </ListGroup>
        )}
      </div>

      <StickyFooter>
        {challenge.user_is_joined ? (
          <div className="flex items-center gap-3">
            <p className="flex min-w-0 flex-1 items-center gap-1.5 text-callout font-semibold text-success">
              <CheckCircle2 size={18} aria-hidden />
              <span className="truncate">You're in this challenge</span>
            </p>
            <Button size="lg" onClick={() => navigate(`/challenges/${challenge.id}`)}>
              Open
            </Button>
          </div>
        ) : canJoin ? (
          <div className="flex items-center gap-4">
            <div className="shrink-0">
              <p className="text-caption text-text-muted">Entry</p>
              <p className="num whitespace-nowrap text-headline text-text-primary">{formatKESShort(entry)}</p>
            </div>
            <Button size="lg" fullWidth onClick={openConfirm}>
              Join challenge
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-center text-callout font-semibold text-text-secondary">
              {challenge.spots_remaining === 0 ? 'This challenge is full' : 'This challenge has ended'}
            </p>
            {isLive && (
              <Button size="lg" variant="outline" fullWidth onClick={handleSpectate} leftIcon={<Eye size={18} aria-hidden />}>
                Watch live leaderboard
              </Button>
            )}
          </div>
        )}
      </StickyFooter>

      <Sheet
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        dismissible={!joinMutation.isPending && !joinMutation.isSuccess}
        title="Confirm your entry"
        description={challenge.name}
        footer={
          <div className="flex gap-3 pb-3">
            <Button variant="outline" size="lg" onClick={() => setConfirmOpen(false)} disabled={joinMutation.isPending || joinMutation.isSuccess}>
              Cancel
            </Button>
            <Button
              fullWidth
              size="lg"
              onClick={() => {
                setJoinError(null);
                joinMutation.mutate(challenge.invite_code);
              }}
              disabled={insufficient}
              isLoading={joinMutation.isPending}
              loadingText="Joining…"
              isSuccess={joinMutation.isSuccess}
              successText="You're in"
            >
              Pay {formatKES(entry)}
            </Button>
          </div>
        }
      >
        <div className="space-y-5">
          <div className="rounded-card bg-bg-sunken p-4">
            <p className="eyebrow">You pay now</p>
            <p className="num mt-1 text-title-lg text-text-primary">{formatKES(entry)}</p>
            <p className="mt-1 text-callout text-text-secondary">From your Step2Win wallet, into this challenge's pool.</p>
          </div>

          {available !== null && (
            <SummaryList
              items={[
                { label: 'Available balance', value: formatKES(available) },
                { label: 'Entry contribution', value: `− ${formatKES(entry)}` },
                {
                  label: 'Balance after',
                  value: formatKES(Math.max(0, available - entry)),
                  strong: true,
                  tone: insufficient ? 'danger' : 'default',
                },
              ]}
            />
          )}

          {insufficient && (
            <div className="flex items-start gap-3 rounded-card bg-warning-soft p-4" role="status">
              <AlertCircle size={18} className="mt-0.5 shrink-0 text-warning" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="text-callout font-semibold text-text-primary">Not enough balance</p>
                <p className="mt-0.5 text-caption text-text-secondary">
                  You need {formatKES(entry - (available ?? 0))} more. Deposit with M-Pesa, then come back to join.
                </p>
                <Button variant="outline" size="sm" className="mt-3" onClick={() => navigate('/wallet')}>
                  Deposit
                </Button>
              </div>
            </div>
          )}

          {joinError && (
            <div className="flex items-start gap-3 rounded-card bg-danger-soft p-4" role="alert">
              <AlertCircle size={18} className="mt-0.5 shrink-0 text-danger" aria-hidden />
              <div className="min-w-0">
                <p className="text-callout font-semibold text-danger">Couldn't join</p>
                <p className="mt-0.5 text-caption text-text-secondary">{joinError}</p>
              </div>
            </div>
          )}

          <NextSteps
            steps={[
              `${formatKES(entry)} moves into the pool, taking it to ${formatKES(pool + entry)}.`,
              isLive
                ? `Steps you've synced since ${formatDay(challenge.start_date)} count straight away.`
                : `Your steps start counting on ${formatDay(challenge.start_date, true)}.`,
              `Results are final after ${formatDay(challenge.end_date, true)}. If you qualify, your payout lands in your wallet.`,
            ]}
          />
        </div>
      </Sheet>
    </div>
  );
}
