import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Hourglass, Info, PauseCircle, Route } from 'lucide-react';
import { stepsService } from '../services/api/steps';
import { dismissFinishedWalk } from '../services/walkSession';
import type { WalkSummary } from '../types';
import { decodePolyline } from '../lib/polyline';
import { formatSteps } from '../lib/format';
import { ScreenHeader } from '../components/ui/ScreenHeader';
import Card, { SectionHeader } from '../components/ui/Card';
import Button from '../components/ui/Button';
import { Pill, type Tone } from '../components/ui/Pill';
import { StatTile } from '../components/ui/StatTile';
import { Skeleton } from '../components/ui/Skeleton';
import { LoadError, NotFoundError } from '../components/ui/ErrorState';
import { StickyFooter } from '../components/challenge-detail/StickyFooter';
import { RouteSvg } from '../components/walks/RouteSvg';
import { ReasonList } from '../components/walks/ReasonList';
import { HowVerifiedSheet } from '../components/walks/HowVerifiedSheet';
import { formatDistance, formatDuration, formatPace, formatWalkDate } from '../components/walks/walkFormat';

export function walkVerdictMeta(walk: Pick<WalkSummary, 'verdict' | 'status'>): { label: string; tone: Tone } {
  if (walk.status === 'active') return { label: 'In progress', tone: 'brand' };
  if (walk.verdict === 'verified') return { label: 'Counts toward challenges', tone: 'success' };
  if (walk.verdict === 'pending') return { label: 'Being checked', tone: 'neutral' };
  return { label: 'Counts for your goals', tone: 'neutral' };
}

export default function WalkSummaryScreen() {
  const { id = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [howOpen, setHowOpen] = useState(false);

  // The walk's summary has been seen: Home goes back to "Start a walk".
  useEffect(() => {
    dismissFinishedWalk();
  }, []);

  const query = useQuery({
    queryKey: ['walks', 'detail', id],
    queryFn: () => stepsService.getWalk(id),
    enabled: Boolean(id),
    // A walk being judged: look again shortly.
    refetchInterval: (q) => (q.state.data?.verdict === 'pending' && q.state.data?.status !== 'active' ? 15_000 : false),
  });
  const walk = query.data;
  const route = useMemo(() => decodePolyline(walk?.polyline), [walk?.polyline]);

  if (query.isError) {
    const status = (query.error as { response?: { status?: number } } | null)?.response?.status;
    return (
      <div className="pb-nav">
        <ScreenHeader title="Walk" back />
        {status === 404 ? (
          <NotFoundError message="This walk isn’t available." onGoBack={() => navigate('/')} className="pt-16" />
        ) : (
          <LoadError resource="this walk" onRetry={() => query.refetch()} isRetrying={query.isFetching} className="pt-16" />
        )}
      </div>
    );
  }

  const verdict = walk ? walkVerdictMeta(walk) : null;
  const VerdictIcon = walk?.verdict === 'verified' ? CheckCircle2 : walk?.verdict === 'pending' ? Hourglass : undefined;

  return (
    <div className="pb-nav">
      <ScreenHeader title="Walk" back />
      <div className="space-y-6 px-5 pt-1">
        <section aria-label="Walk summary">
          {!walk ? (
            <>
              <Skeleton className="h-4 w-40 rounded" />
              <Skeleton className="mt-2 h-9 w-48 rounded-lg" />
            </>
          ) : (
            <>
              <p className="text-caption text-text-muted">{formatWalkDate(walk.started_at)}</p>
              <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
                <p>
                  <span className="num text-display text-text-primary">{formatDistance(walk.distance_m)}</span>
                </p>
                {verdict && (
                  <Pill tone={verdict.tone} icon={VerdictIcon} size="md">
                    {verdict.label}
                  </Pill>
                )}
              </div>
            </>
          )}
        </section>

        {walk?.auto_ended && (
          <div className="flex items-start gap-3 rounded-card bg-info-soft p-4" role="note">
            <PauseCircle size={18} className="mt-0.5 shrink-0 text-info" aria-hidden />
            <p className="text-caption text-text-secondary">Your walk ended after a long pause. Everything up to then is saved.</p>
          </div>
        )}

        {!walk ? (
          <Skeleton className="h-[220px] w-full rounded-card" />
        ) : (
          <RouteSvg
            points={route}
            height={220}
            emptyText="No route was recorded for this walk."
            label={`Route of your walk on ${formatWalkDate(walk.started_at)}`}
          />
        )}

        <Card padding="lg">
          {!walk ? (
            <div className="grid grid-cols-2 gap-x-4 gap-y-5" aria-hidden>
              {[0, 1, 2, 3].map((i) => (
                <div key={i}>
                  <Skeleton className="h-3 w-16 rounded" />
                  <Skeleton className="mt-1.5 h-5 w-20 rounded" />
                </div>
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-x-4 gap-y-5">
              <StatTile label="Duration" value={formatDuration(walk.duration_s)} />
              <StatTile label="Pace" value={formatPace(walk.duration_s, walk.distance_m)} />
              <StatTile label="Steps" value={formatSteps(walk.steps)} hint="count for your goals" />
              <StatTile
                label="Verified steps"
                value={walk.verdict === 'pending' ? '–' : formatSteps(walk.verified_steps)}
                hint={walk.verdict === 'pending' ? 'being checked' : 'count toward challenges'}
                tone={walk.verified_steps > 0 ? 'success' : 'neutral'}
              />
            </div>
          )}
        </Card>

        {walk && (
          <section>
            <SectionHeader title="How this walk counted" />
            <Card padding="lg">
              {walk.reasons.length > 0 ? (
                <ReasonList reasons={walk.reasons} />
              ) : (
                <p className="text-callout text-text-muted">
                  {walk.verdict === 'pending' ? 'We’re checking your walk. This usually takes a moment.' : 'Nothing more to explain for this walk.'}
                </p>
              )}
              <button
                type="button"
                onClick={() => setHowOpen(true)}
                className="-mx-2 -mb-2 mt-3 inline-flex min-h-touch items-center gap-1.5 rounded-control px-2 text-callout font-semibold text-brand hover:bg-brand-soft"
              >
                <Info size={16} aria-hidden />
                How steps are verified
              </button>
            </Card>
          </section>
        )}
      </div>

      <StickyFooter>
        <div className="flex gap-2">
          <Button variant="secondary" size="lg" className="flex-1" leftIcon={<Route size={18} aria-hidden />} onClick={() => navigate('/walk')}>
            New walk
          </Button>
          <Button size="lg" className="flex-1" onClick={() => navigate('/', { replace: true })}>
            Done
          </Button>
        </div>
      </StickyFooter>

      <HowVerifiedSheet open={howOpen} onClose={() => setHowOpen(false)} />
    </div>
  );
}
