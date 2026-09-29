import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Hourglass, Info, ShieldCheck } from 'lucide-react';
import { stepsService } from '../../services/api/steps';
import type { DayBreakdown } from '../../types';
import { formatSteps } from '../../lib/format';
import Card from '../ui/Card';
import { Pill } from '../ui/Pill';
import { Skeleton } from '../ui/Skeleton';
import { ErrorInline } from '../ui/ErrorState';
import { ReasonList } from './ReasonList';
import { HowVerifiedSheet } from './HowVerifiedSheet';

export function useDayVerification(date: string) {
  return useQuery<DayBreakdown | null>({
    queryKey: ['steps', 'verification', date],
    queryFn: async () => {
      try {
        return await stepsService.getVerificationDay(date);
      } catch (error) {
        // Nothing recorded for that day yet.
        if ((error as { response?: { status?: number } })?.response?.status === 404) return null;
        throw error;
      }
    },
    enabled: Boolean(date),
    staleTime: 60_000,
  });
}

/**
 * The "why" for one day: what counted for goals, what counts toward challenges, and the
 * server's reasons (shown as written).
 */
export function VerificationPanel({ date, isToday = false }: { date: string; isToday?: boolean }) {
  const [howOpen, setHowOpen] = useState(false);
  const query = useDayVerification(date);
  const day = query.data;

  return (
    <>
      {query.isError ? (
        <ErrorInline message="Couldn’t load how your steps counted." onRetry={() => query.refetch()} />
      ) : (
        <Card padding="lg">
          {query.isLoading ? (
            <div aria-hidden>
              <Skeleton className="h-5 w-3/4 rounded" />
              <Skeleton className="mt-3 h-2 w-full rounded-full" />
              <Skeleton className="mt-4 h-4 w-full rounded" />
              <Skeleton className="mt-2 h-4 w-2/3 rounded" />
            </div>
          ) : !day ? (
            <p className="text-callout text-text-muted">
              {isToday
                ? 'How your steps count appears here once your phone syncs today’s steps.'
                : 'There are no verification details for this day.'}
            </p>
          ) : (
            <DayBreakdownView day={day} />
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
      )}
      <HowVerifiedSheet open={howOpen} onClose={() => setHowOpen(false)} />
    </>
  );
}

function DayBreakdownView({ day }: { day: DayBreakdown }) {
  const goalSteps = Math.max(0, day.goal_steps);
  const challengeSteps = Math.max(0, Math.min(day.challenge_steps, goalSteps || day.challenge_steps));
  const share = goalSteps > 0 ? Math.min(100, (challengeSteps / goalSteps) * 100) : 0;
  return (
    <div>
      <p className="text-callout text-text-secondary">
        <span className="num font-semibold text-text-primary">{formatSteps(goalSteps)}</span> counted
        <span className="text-text-muted" aria-hidden>
          {' · '}
        </span>
        <span className="sr-only">, </span>
        <span className="num font-semibold text-text-primary">{formatSteps(challengeSteps)}</span> count toward challenges
      </p>
      <div
        className="mt-3 h-2 w-full overflow-hidden rounded-full bg-bg-input"
        role="img"
        aria-label={`${formatSteps(challengeSteps)} of ${formatSteps(goalSteps)} steps count toward challenges`}
      >
        <div className="h-full rounded-full bg-brand transition-[width] duration-deliberate ease-standard" style={{ width: `${share}%` }} />
      </div>
      <p className="mt-2 flex items-center gap-1.5 text-caption text-text-muted">
        <ShieldCheck size={14} className="shrink-0 text-brand" aria-hidden />
        Counted steps fill your goal, streak and XP.
      </p>
      {day.under_review && (
        <Pill tone="warning" icon={Hourglass} className="mt-2">
          Being checked
        </Pill>
      )}
      <ReasonList className="mt-4" reasons={day.reasons} />
    </div>
  );
}

/** One quiet line for Home: "8,400 counted · 7,900 count toward challenges". Hidden until known. */
export function VerificationLine({ date, className = '' }: { date: string; className?: string }) {
  const [howOpen, setHowOpen] = useState(false);
  const query = useDayVerification(date);
  const day = query.data;
  if (!day || day.goal_steps <= 0) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setHowOpen(true)}
        className={`inline-flex min-h-touch items-center gap-1.5 rounded-full px-3 text-caption text-text-muted hover:bg-bg-input ${className}`}
      >
        <span>
          <span className="num font-semibold text-text-secondary">{formatSteps(day.goal_steps)}</span> counted
          <span aria-hidden>{' · '}</span>
          <span className="sr-only">, </span>
          <span className="num font-semibold text-text-secondary">{formatSteps(day.challenge_steps)}</span> count toward challenges
        </span>
        <Info size={14} aria-hidden />
        <span className="sr-only">How steps are verified</span>
      </button>
      <HowVerifiedSheet open={howOpen} onClose={() => setHowOpen(false)} showBreakdownLink />
    </>
  );
}
