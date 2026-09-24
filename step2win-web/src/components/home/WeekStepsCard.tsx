import { useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import Card from '../ui/Card';
import { Skeleton } from '../ui/Skeleton';
import { ErrorInline } from '../ui/ErrorState';
import { StepBarChart, type StepBar } from '../steps/StepBarChart';
import { dateKey, dayLabel, relativeDayLabel, weekdayShort } from '../steps/stepUtils';
import { formatSteps } from '../../lib/format';

interface WeekStepsCardProps {
  days: Array<{ date: string; steps: number }> | undefined;
  goal: number;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
}

/** Last seven days vs the daily goal, with totals and goal-met count. */
export function WeekStepsCard({ days, goal, isLoading, isError, onRetry }: WeekStepsCardProps) {
  const today = dateKey();
  const [selected, setSelected] = useState<string | null>(null);

  if (isLoading) return <WeekStepsSkeleton />;
  if (isError) return <ErrorInline message="Couldn't load this week's steps." onRetry={onRetry} />;

  const sorted = [...(days ?? [])].sort((a, b) => a.date.localeCompare(b.date));
  const total = sorted.reduce((sum, d) => sum + d.steps, 0);
  const metCount = sorted.filter((d) => d.steps >= goal).length;
  const avg = sorted.length ? Math.round(total / sorted.length) : 0;
  const activeKey = selected ?? (sorted.some((d) => d.date === today) ? today : sorted[sorted.length - 1]?.date);
  const active = sorted.find((d) => d.date === activeKey);

  const bars: StepBar[] = sorted.map((d) => {
    const met = d.steps >= goal;
    return {
      key: d.date,
      value: d.steps,
      axisLabel: d.date === today ? 'Today' : weekdayShort(d.date),
      emphasis: d.date === today,
      description: `${dayLabel(d.date)}: ${formatSteps(d.steps)} steps, ${met ? 'goal met' : `${formatSteps(goal - d.steps)} below goal`}`,
    };
  });

  const summary = `Steps over the last ${sorted.length} days. Total ${formatSteps(total)}, ${metCount} of ${sorted.length} days met the ${formatSteps(goal)} step goal.`;

  return (
    <Card padding="lg">
      <dl className="grid grid-cols-3 gap-3">
        <div className="min-w-0">
          <dt className="text-caption text-text-muted">Total</dt>
          <dd className="num mt-0.5 truncate text-headline text-text-primary">{formatSteps(total)}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-caption text-text-muted">Daily avg</dt>
          <dd className="num mt-0.5 truncate text-headline text-text-primary">{formatSteps(avg)}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-caption text-text-muted">Goal met</dt>
          <dd className="num mt-0.5 truncate text-headline text-text-primary">
            {metCount}
            <span className="text-caption font-medium text-text-muted"> of {sorted.length} days</span>
          </dd>
        </div>
      </dl>

      <div className="mt-5 flex h-5 items-center justify-between gap-2 text-callout" aria-live="polite">
        {active && (
          <>
            <span className="truncate text-text-secondary">{relativeDayLabel(active.date)}</span>
            <span className="flex shrink-0 items-center gap-1.5">
              {active.steps >= goal && <CheckCircle2 size={15} className="text-brand" aria-label="Goal met" />}
              <span className="num font-semibold text-text-primary">{formatSteps(active.steps)}</span>
              <span className="text-text-muted">steps</span>
            </span>
          </>
        )}
      </div>

      <StepBarChart
        className="mt-3"
        bars={bars}
        goal={goal}
        height={132}
        label={summary}
        selectedKey={activeKey}
        onSelect={setSelected}
      />
    </Card>
  );
}

function WeekStepsSkeleton() {
  return (
    <div className="rounded-card border border-border-light bg-bg-card p-5 shadow-card" aria-hidden>
      <div className="grid grid-cols-3 gap-3">
        {[0, 1, 2].map((i) => (
          <div key={i}>
            <Skeleton className="h-3 w-12 rounded" />
            <Skeleton className="mt-1.5 h-5 w-16 rounded" />
          </div>
        ))}
      </div>
      <Skeleton className="mt-5 h-4 w-full rounded" />
      <div className="mt-3 flex h-[132px] items-end gap-1.5 pr-9">
        {[45, 60, 38, 70, 52, 90, 40].map((h, i) => (
          <Skeleton key={i} className="flex-1 rounded-t" style={{ height: `${h}%` }} />
        ))}
      </div>
      <div className="mt-2 h-4" />
    </div>
  );
}

export default WeekStepsCard;
