import { useParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Info, MinusCircle, RotateCcw, Wallet, type LucideIcon } from 'lucide-react';
import { challengesService } from '../services/api/challenges';
import { useAuthStore } from '../store/authStore';
import { ScreenHeader } from '../components/ui/ScreenHeader';
import Card from '../components/ui/Card';
import Pill, { type Tone } from '../components/ui/Pill';
import Button from '../components/ui/Button';
import AnimatedNumber from '../components/ui/AnimatedNumber';
import { ListGroup, ListRow } from '../components/ui/ListRow';
import { LoadError, NotFoundError } from '../components/ui/ErrorState';
import { LeaderboardList, LeaderboardRow } from '../components/challenge-detail/Leaderboard';
import { ResultsSkeleton } from '../components/challenge-detail/Skeletons';
import { formatCalendarDay, toNumber } from '../components/challenge-detail/meta';
import type { ChallengeResultEntry, ChallengeResults } from '../components/challenge-detail/types';
import { formatKES } from '../utils/currency';
import { formatSteps } from '../lib/format';

const PAYOUT_RULE: Record<string, string> = {
  proportional: 'Proportional split',
  winner_takes_all: 'Winner takes all',
  top_3: 'Top 3 split (50 / 30 / 20)',
};

type Outcome = { label: string; tone: Tone; icon: LucideIcon };

function outcomeFor(result: ChallengeResultEntry, isRefund: boolean): Outcome {
  if (isRefund || result.payout_method === 'refund') return { label: 'Refunded', tone: 'info', icon: RotateCcw };
  if (toNumber(result.payout_kes) > 0) return { label: 'Won', tone: 'reward', icon: Wallet };
  if (result.qualified) return { label: 'Qualified', tone: 'success', icon: CheckCircle2 };
  return { label: 'Not qualified', tone: 'neutral', icon: MinusCircle };
}

function tieExplanation(result: ChallengeResultEntry): string | null {
  if (!result.tied_with_count) return null;
  const others = `${result.tied_with_count} other ${result.tied_with_count === 1 ? 'participant' : 'participants'}`;
  if (result.payout_method === 'dead_heat') {
    return `You tied with ${others}. The prize for the tied positions was split equally between you.`;
  }
  return `You tied with ${others}.${result.tiebreaker_label ? ` The tie was decided by ${result.tiebreaker_label.charAt(0).toLowerCase()}${result.tiebreaker_label.slice(1)}.` : ''}`;
}

function rowTrailing(result: ChallengeResultEntry) {
  const payout = toNumber(result.payout_kes);
  if (result.payout_method === 'refund') return <span className="font-medium text-info">Refunded</span>;
  if (payout > 0) return <span className="num font-semibold text-reward-ink">{formatKES(payout)}</span>;
  if (result.qualified) {
    return (
      <span className="inline-flex items-center gap-1 font-medium text-success">
        <CheckCircle2 size={12} strokeWidth={2.5} aria-hidden />
        Qualified
      </span>
    );
  }
  return <span className="text-text-muted">No payout</span>;
}

export default function ChallengeResultsScreen() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const user = useAuthStore((state) => state.user);

  const { data, isLoading, isError, error, refetch, isRefetching } = useQuery<ChallengeResults>({
    queryKey: ['challenges', 'results', id],
    queryFn: () => challengesService.getChallengeResults(Number(id)),
    enabled: !!id,
  });

  if (isLoading) {
    return (
      <div className="pb-nav">
        <ScreenHeader title="Results" back={`/challenges/${id}`} />
        <ResultsSkeleton />
      </div>
    );
  }

  if (isError || !data) {
    const status = (error as { response?: { status?: number } } | null)?.response?.status;
    return (
      <div className="pb-nav">
        <ScreenHeader title="Results" back={`/challenges/${id}`} />
        {status === 404 || status === 400 ? (
          <NotFoundError
            message="Results appear here once the challenge has closed and payouts are calculated."
            onGoBack={() => navigate(`/challenges/${id}`)}
            className="pt-16"
          />
        ) : (
          <LoadError resource="results" onRetry={() => refetch()} isRetrying={isRefetching} className="pt-16" />
        )}
      </div>
    );
  }

  const { challenge, summary, my_result: me, leaderboard } = data;
  const isRefund = summary.is_refund;
  const milestone = challenge.milestone;
  const outcome = me ? outcomeFor(me, isRefund) : null;
  const myPayout = toNumber(me?.payout_kes);
  const tie = me ? tieExplanation(me) : null;
  const myName = me?.username ?? user?.username;

  return (
    <div className="pb-nav">
      <ScreenHeader title="Results" back={`/challenges/${challenge.id}`} />

      <div className="space-y-8 px-5 pt-1">
        <header>
          <p className="text-caption text-text-muted">
            Final results
            {challenge.end_date ? ` · closed ${formatCalendarDay(challenge.end_date)}` : ''}
          </p>
          <h1 className="mt-1 text-title-lg text-text-primary [overflow-wrap:anywhere]">{challenge.name}</h1>
        </header>

        {/* ── Your outcome ─────────────────────────────────────── */}
        {me && outcome && (
          <section aria-labelledby="outcome-title">
            <Card padding="lg">
              <Pill tone={outcome.tone} icon={outcome.icon} size="md">
                {outcome.label}
              </Pill>

              {isRefund ? (
                <>
                  <h2 id="outcome-title" className="mt-4 text-callout text-text-secondary">
                    Returned to your wallet
                  </h2>
                  <AnimatedNumber value={myPayout} startFromValue format={(v) => formatKES(v)} className="mt-1 block text-display text-text-primary" />
                  <p className="mt-2 text-callout text-text-secondary">
                    Nobody reached {formatSteps(milestone)} steps, so every entry contribution was refunded in full.
                  </p>
                </>
              ) : myPayout > 0 ? (
                <>
                  <h2 id="outcome-title" className="mt-4 text-callout text-text-secondary">
                    You earned
                  </h2>
                  <AnimatedNumber value={myPayout} startFromValue format={(v) => formatKES(v)} className="mt-1 block text-display text-reward-ink" />
                  <p className="mt-2 text-callout text-text-secondary">Credited to your Step2Win wallet.</p>
                </>
              ) : me.qualified ? (
                <>
                  <h2 id="outcome-title" className="mt-4 text-title text-text-primary">
                    You reached the goal
                  </h2>
                  <p className="mt-2 text-callout text-text-secondary">
                    You qualified, but under the {PAYOUT_RULE[challenge.payout_structure]?.toLowerCase() ?? 'payout'} rule this finish didn’t earn a share of the pool.
                  </p>
                </>
              ) : (
                <>
                  <h2 id="outcome-title" className="mt-4 text-title text-text-primary">
                    <span className="num">{formatSteps(Math.max(0, milestone - me.final_steps))}</span> steps short
                  </h2>
                  <p className="mt-2 text-callout text-text-secondary">
                    You walked {formatSteps(me.final_steps)} of the {formatSteps(milestone)} steps needed to qualify. Your entry contribution was shared by the qualified finishers.
                  </p>
                </>
              )}

              <dl className="mt-5 grid grid-cols-3 divide-x divide-border-light border-t border-border-light pt-4">
                <div className="min-w-0 pr-3">
                  <dt className="text-caption text-text-muted">Final rank</dt>
                  <dd className="num mt-0.5 truncate text-headline text-text-primary">
                    {me.final_rank ? (
                      <>
                        {me.final_rank}
                        <span className="text-callout font-normal text-text-muted"> of {summary.total_participants}</span>
                      </>
                    ) : (
                      '–'
                    )}
                  </dd>
                </div>
                <div className="min-w-0 px-3">
                  <dt className="text-caption text-text-muted">Your steps</dt>
                  <dd className="num mt-0.5 truncate text-headline text-text-primary">{formatSteps(me.final_steps)}</dd>
                </div>
                <div className="min-w-0 pl-3">
                  <dt className="text-caption text-text-muted">Goal</dt>
                  <dd className="num mt-0.5 truncate text-headline text-text-primary">{formatSteps(milestone)}</dd>
                </div>
              </dl>

              {tie && (
                <div className="mt-4 flex gap-2.5 rounded-control bg-bg-input p-3">
                  <Info size={16} className="mt-0.5 shrink-0 text-text-secondary" aria-hidden />
                  <p className="text-callout text-text-secondary">{tie}</p>
                </div>
              )}
            </Card>
          </section>
        )}

        {/* ── Summary ──────────────────────────────────────────── */}
        <ListGroup title="Summary">
          <ListRow
            title="Participants"
            trailing={<span className="num text-callout text-text-secondary">{summary.total_participants}</span>}
          />
          <ListRow
            title="Qualified"
            trailing={
              <span className="num text-callout text-text-secondary">
                {summary.qualified_count} of {summary.total_participants}
              </span>
            }
          />
          <ListRow
            title="Entry contribution"
            trailing={<span className="num text-callout text-text-secondary">{formatKES(challenge.entry_fee)}</span>}
          />
          <ListRow title="Total pool" trailing={<span className="num text-callout text-text-secondary">{formatKES(challenge.total_pool)}</span>} />
          <ListRow
            title="Net pool"
            subtitle={PAYOUT_RULE[challenge.payout_structure] ?? undefined}
            trailing={<span className="num text-callout font-semibold text-text-primary">{formatKES(challenge.net_pool)}</span>}
          />
          <ListRow
            title={isRefund ? 'Refunded' : 'Paid out'}
            trailing={<span className="num text-headline text-reward-ink">{formatKES(summary.total_paid_out)}</span>}
          />
        </ListGroup>

        {/* ── Final leaderboard ────────────────────────────────── */}
        <section aria-labelledby="final-board">
          <div className="mb-3">
            <h2 id="final-board" className="text-headline text-text-primary">
              Final leaderboard
            </h2>
            <p className="mt-0.5 text-caption text-text-muted">Ranked by total steps when the challenge closed</p>
          </div>
          <LeaderboardList label="Final leaderboard">
            {leaderboard.map((r, index) => (
              <LeaderboardRow
                key={r.username}
                id={r.username}
                rank={r.final_rank ?? (isRefund ? null : index + 1)}
                name={r.username}
                steps={r.final_steps}
                progress={milestone > 0 ? (r.final_steps / milestone) * 100 : 0}
                qualified={r.qualified}
                isYou={!!myName && r.username === myName}
                trailing={rowTrailing(r)}
                note={
                  r.tied_with_count > 0 ? (
                    <span>
                      Tied with {r.tied_with_count} {r.tied_with_count === 1 ? 'other' : 'others'}
                      {r.payout_method === 'dead_heat' ? ' · prize split equally' : r.tiebreaker_label ? ` · ${r.tiebreaker_label}` : ''}
                    </span>
                  ) : undefined
                }
              />
            ))}
          </LeaderboardList>
        </section>

        <div className="flex flex-col gap-2 min-[420px]:flex-row">
          <Button variant="secondary" size="lg" className="w-full min-[420px]:flex-1" onClick={() => navigate(`/challenges/${challenge.id}`)}>
            Challenge details
          </Button>
          <Button size="lg" className="w-full min-[420px]:flex-1" onClick={() => navigate('/challenges')}>
            Find a new challenge
          </Button>
        </div>
      </div>
    </div>
  );
}
