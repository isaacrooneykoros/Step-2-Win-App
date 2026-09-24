import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, ChevronRight, Footprints } from 'lucide-react';
import { stepsService } from '../services/api';
import { ScreenHeader } from '../components/ui/ScreenHeader';
import { Segmented } from '../components/ui/Segmented';
import Card, { SectionHeader } from '../components/ui/Card';
import { StatTile } from '../components/ui/StatTile';
import { ListGroup, ListRow } from '../components/ui/ListRow';
import { Skeleton } from '../components/ui/Skeleton';
import { EmptyState } from '../components/ui/EmptyState';
import { LoadError } from '../components/ui/ErrorState';
import { StepBarChart, type StepBar } from '../components/steps/StepBarChart';
import { addDays, dateKey, dayLabel, parseDateKey, relativeDayLabel, useDailyGoal, weekdayShort } from '../components/steps/stepUtils';
import { formatSteps } from '../lib/format';
import type { HealthRecord } from '../types';

type Period = '1w' | '1m' | '3m';

const PERIODS: { value: Period; label: string; days: number; noun: string }[] = [
  { value: '1w', label: 'Week', days: 7, noun: '7 days' },
  { value: '1m', label: 'Month', days: 30, noun: '30 days' },
  { value: '3m', label: '3 months', days: 90, noun: '90 days' },
];

function axisLabelFor(period: Period, key: string, indexFromEnd: number): string | undefined {
  if (period === '1w') return indexFromEnd === 0 ? 'Today' : weekdayShort(key);
  const every = period === '1m' ? 7 : 21;
  if (indexFromEnd % every !== 0) return undefined;
  if (indexFromEnd === 0) return 'Today';
  return parseDateKey(key).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

export default function StepsHistoryScreen() {
  const [period, setPeriod] = useState<Period>('1w');
  const [selected, setSelected] = useState<string | null>(null);
  const { goal } = useDailyGoal();
  const config = PERIODS.find((p) => p.value === period)!;

  const history = useQuery({
    queryKey: ['health', 'history', period],
    queryFn: () => stepsService.getHistory(period),
    // Keep the previous period on screen while the next one loads (no layout jump).
    placeholderData: (prev) => prev,
  });

  // Build the calendar range ending today; days without a record stay null (not zero).
  const byDate = new Map<string, HealthRecord>();
  for (const r of history.data ?? []) {
    const prev = byDate.get(r.date);
    if (!prev || r.steps > prev.steps) byDate.set(r.date, r);
  }
  const todayDate = parseDateKey(dateKey());
  const range = Array.from({ length: config.days }, (_, i) => dateKey(addDays(todayDate, i - (config.days - 1))));
  const records = range.map((key) => byDate.get(key)).filter((r): r is HealthRecord => Boolean(r));

  const total = records.reduce((sum, r) => sum + r.steps, 0);
  const avg = records.length ? Math.round(total / records.length) : 0;
  const metCount = records.filter((r) => r.steps >= goal).length;
  const best = records.reduce<HealthRecord | null>((b, r) => (!b || r.steps > b.steps ? r : b), null);

  const bars: StepBar[] = range.map((key, i) => {
    const rec = byDate.get(key);
    const indexFromEnd = range.length - 1 - i;
    return {
      key,
      value: rec ? rec.steps : null,
      axisLabel: axisLabelFor(period, key, indexFromEnd),
      emphasis: indexFromEnd === 0,
      description: rec
        ? `${dayLabel(key)}: ${formatSteps(rec.steps)} steps, ${rec.steps >= goal ? 'goal met' : 'below goal'}`
        : `${dayLabel(key)}: no data`,
    };
  });

  const activeKey = selected && range.includes(selected) ? selected : range[range.length - 1];
  const activeRecord = byDate.get(activeKey);
  const summaryLabel = `Daily steps for the last ${config.noun}. ${records.length} days recorded, total ${formatSteps(total)}, ${metCount} days met the ${formatSteps(goal)} step goal.`;
  const listed = [...records].reverse();

  return (
    <div className="pb-nav">
      <ScreenHeader title="Step history" back />

      <div className="space-y-6 px-5 pt-1">
        <Segmented<Period>
          label="History period"
          value={period}
          onChange={(p) => {
            setPeriod(p);
            setSelected(null);
          }}
          options={PERIODS.map((p) => ({ value: p.value, label: p.label }))}
        />

        {history.isError ? (
          <LoadError resource="your step history" onRetry={() => history.refetch()} isRetrying={history.isFetching} />
        ) : history.isLoading ? (
          <HistorySkeleton />
        ) : records.length === 0 ? (
          <EmptyState
            icon={Footprints}
            title="No steps recorded yet"
            description={`Nothing synced in the last ${config.noun}. Steps sync automatically once health permissions are on.`}
          />
        ) : (
          <>
            {/* Chart */}
            <Card padding="lg" className={`transition-opacity duration-fast ${history.isPlaceholderData ? 'opacity-60' : ''}`} aria-busy={history.isPlaceholderData || undefined}>
              <div className="flex h-5 items-center justify-between gap-2 text-callout" aria-live="polite">
                <span className="truncate text-text-secondary">{relativeDayLabel(activeKey)}</span>
                {activeRecord ? (
                  <Link
                    to={`/steps/history/${activeKey}`}
                    className="-my-3 inline-flex min-h-touch shrink-0 items-center gap-1.5"
                  >
                    {activeRecord.steps >= goal && <CheckCircle2 size={15} className="text-brand" aria-label="Goal met" />}
                    <span className="num font-semibold text-text-primary">{formatSteps(activeRecord.steps)}</span>
                    <span className="text-text-muted">steps</span>
                    <ChevronRight size={15} className="text-text-muted" aria-hidden />
                  </Link>
                ) : (
                  <span className="text-text-muted">No data</span>
                )}
              </div>
              <StepBarChart
                className="mt-3"
                bars={bars}
                goal={goal}
                height={156}
                label={summaryLabel}
                selectedKey={activeKey}
                onSelect={setSelected}
              />
            </Card>

            {/* Summary */}
            <section>
              <SectionHeader title="Summary" subtitle={`Last ${config.noun}`} />
              <Card padding="lg">
                <div className="grid grid-cols-2 gap-x-4 gap-y-5">
                  <StatTile label="Total steps" value={formatSteps(total)} />
                  <StatTile label="Daily average" value={formatSteps(avg)} hint={`over ${records.length} recorded days`} />
                  <StatTile label="Goal met" value={`${metCount} of ${records.length} days`} hint={`Goal ${formatSteps(goal)} a day`} />
                  <StatTile label="Best day" value={best ? formatSteps(best.steps) : '—'} hint={best ? dayLabel(best.date) : undefined} />
                </div>
              </Card>
            </section>

            {/* Days */}
            <section>
              <SectionHeader title="Days" />
              <ListGroup>
                {listed.map((r) => {
                  const met = r.steps >= goal;
                  const details = [
                    r.distance_km != null && r.distance_km > 0 ? `${r.distance_km.toFixed(1)} km` : null,
                    r.active_minutes != null && r.active_minutes > 0 ? `${r.active_minutes} min active` : null,
                  ].filter(Boolean);
                  return (
                    <ListRow
                      key={r.date}
                      to={`/steps/history/${r.date}`}
                      title={relativeDayLabel(r.date)}
                      subtitle={
                        r.is_suspicious ? (
                          <span className="inline-flex items-center gap-1 text-warning">
                            <AlertTriangle size={12} aria-hidden /> Under review
                          </span>
                        ) : (
                          details.join(' · ') || undefined
                        )
                      }
                      trailing={
                        <span className="flex items-center gap-1.5">
                          {met ? (
                            <CheckCircle2 size={16} className="text-brand" aria-label="Goal met" />
                          ) : (
                            <span className="sr-only">Below goal</span>
                          )}
                          <span className="num text-callout font-semibold text-text-primary">{formatSteps(r.steps)}</span>
                        </span>
                      }
                    />
                  );
                })}
              </ListGroup>
            </section>
          </>
        )}
      </div>
    </div>
  );
}

function HistorySkeleton() {
  return (
    <div className="space-y-6" aria-hidden>
      <div className="rounded-card border border-border-light bg-bg-card p-5 shadow-card">
        <Skeleton className="h-5 w-full rounded" />
        <div className="mt-3 flex h-[156px] items-end gap-1.5 pr-9">
          {[50, 64, 40, 72, 55, 88, 46].map((h, i) => (
            <Skeleton key={i} className="flex-1 rounded-t" style={{ height: `${h}%` }} />
          ))}
        </div>
        <div className="mt-2 h-4" />
      </div>
      <div className="rounded-card border border-border-light bg-bg-card p-5 shadow-card">
        <div className="grid grid-cols-2 gap-x-4 gap-y-5">
          {[0, 1, 2, 3].map((i) => (
            <div key={i}>
              <Skeleton className="h-3 w-16 rounded" />
              <Skeleton className="mt-1.5 h-5 w-24 rounded" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
