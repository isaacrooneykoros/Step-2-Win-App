import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowDownRight, ArrowUpRight, CalendarCheck, Footprints, Minus, Trophy } from 'lucide-react';
import { authService, stepsService } from '../services/api';
import { useAuthStore } from '../store/authStore';
import type { User } from '../types';
import { ScreenHeader } from '../components/ui/ScreenHeader';
import { Segmented } from '../components/ui/Segmented';
import { SectionHeader } from '../components/ui/Card';
import Card from '../components/ui/Card';
import { StatTile } from '../components/ui/StatTile';
import { Skeleton } from '../components/ui/Skeleton';
import { ErrorState } from '../components/ui/ErrorState';
import { EmptyState } from '../components/ui/EmptyState';
import { StepBarChart, type StepBar } from '../components/steps/StepBarChart';
import { addDays, dayLabel, parseDateKey, relativeDayLabel, useDailyGoal } from '../components/steps/stepUtils';
import { dailySeries, periodStats, type DayPoint } from '../components/profile/profileModel';
import { formatKES, formatSteps } from '../lib/format';

type Period = 'week' | 'month' | 'quarter';

const PERIODS: Record<Period, { days: number; label: string; noun: string }> = {
  week: { days: 7, label: 'Week', noun: 'week' },
  month: { days: 30, label: 'Month', noun: '30 days' },
  quarter: { days: 91, label: '3 Months', noun: '3 months' },
};

/** Weekly buckets for the 3-month view: average steps per recorded day, null when a week has no data. */
function weeklyBars(points: DayPoint[], goal: number): StepBar[] {
  const bars: StepBar[] = [];
  for (let i = 0; i < points.length; i += 7) {
    const week = points.slice(i, i + 7);
    const recorded = week.filter((p) => p.steps !== null);
    const avg = recorded.length ? Math.round(recorded.reduce((s, p) => s + (p.steps ?? 0), 0) / recorded.length) : null;
    const start = week[0].date;
    const end = week[week.length - 1].date;
    const met = recorded.filter((p) => (p.steps ?? 0) >= goal).length;
    const idx = i / 7;
    bars.push({
      key: start,
      value: avg,
      axisLabel: idx % 3 === 0 ? parseDateKey(start).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : undefined,
      description:
        avg === null
          ? `Week of ${dayLabel(start)}: no data`
          : `${dayLabel(start)} to ${dayLabel(end)}: average ${formatSteps(avg)} steps a day, goal met on ${met} of ${recorded.length} recorded days`,
    });
  }
  return bars;
}

function dailyBars(points: DayPoint[], goal: number): StepBar[] {
  const dense = points.length > 7;
  return points.map((p, i) => {
    const d = parseDateKey(p.date);
    const last = i === points.length - 1;
    let axisLabel: string | undefined;
    if (!dense) axisLabel = last ? 'Today' : d.toLocaleDateString('en-GB', { weekday: 'short' });
    else if ((points.length - 1 - i) % 7 === 0) axisLabel = last ? 'Today' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    return {
      key: p.date,
      value: p.steps,
      axisLabel,
      emphasis: last,
      description:
        p.steps === null
          ? `${dayLabel(p.date)}: no data`
          : `${dayLabel(p.date)}: ${formatSteps(p.steps)} steps, ${p.steps >= goal ? 'goal met' : `${formatSteps(goal - p.steps)} below goal`}`,
    };
  });
}

export default function ProfileAnalyticsScreen() {
  const storeUser = useAuthStore((s) => s.user);
  const { data: profile } = useQuery<User>({ queryKey: ['profile'], queryFn: authService.getProfile });
  const user = (profile ?? storeUser) as User | null;
  const { goal } = useDailyGoal();
  const [period, setPeriod] = useState<Period>('week');
  const [selected, setSelected] = useState<string | null>(null);

  // One year of history covers every period plus its comparison window.
  const history = useQuery({ queryKey: ['health', 'history', '1y'], queryFn: () => stepsService.getHistory('1y') });

  const cfg = PERIODS[period];
  const { points, stats, change, bars } = useMemo(() => {
    const pts = dailySeries(history.data, cfg.days);
    const st = periodStats(pts, goal);
    const prevPts = dailySeries(history.data, cfg.days, addDays(new Date(), -cfg.days));
    const prev = periodStats(prevPts, goal);
    // Only compare when both windows are reasonably covered — otherwise the % would mislead.
    const comparable = prev.recordedDays >= Math.ceil(cfg.days / 2) && st.recordedDays >= Math.ceil(cfg.days / 2) && prev.avgSteps > 0;
    const pct = comparable ? Math.round(((st.avgSteps - prev.avgSteps) / prev.avgSteps) * 100) : null;
    return {
      points: pts,
      stats: st,
      change: pct,
      bars: period === 'quarter' ? weeklyBars(pts, goal) : dailyBars(pts, goal),
    };
  }, [history.data, cfg.days, goal, period]);

  const activeBar = bars.find((b) => b.key === selected) ?? null;
  const changePeriod = period === 'week' ? 'previous week' : period === 'month' ? 'previous 30 days' : 'previous 3 months';

  return (
    <div className="pb-nav">
      <ScreenHeader variant="compact" back="/profile" title="Insights" />

      <div className="space-y-6 px-5 pt-2">
        <Segmented
          label="Time period"
          value={period}
          onChange={(p) => {
            setPeriod(p);
            setSelected(null);
          }}
          options={(Object.keys(PERIODS) as Period[]).map((p) => ({ value: p, label: PERIODS[p].label }))}
        />

        {history.isLoading ? (
          <AnalyticsSkeleton />
        ) : history.isError ? (
          <Card padding="none">
            <ErrorState
              title="We couldn't load your step history"
              description="Check your connection and try again."
              onRetry={() => history.refetch()}
              isRetrying={history.isFetching}
            />
          </Card>
        ) : stats.recordedDays === 0 ? (
          <Card padding="none">
            <EmptyState
              icon={Footprints}
              title={`No steps recorded in the last ${cfg.noun}`}
              description="Once your phone syncs steps, your trends will appear here."
            />
          </Card>
        ) : (
          <>
            {/* Headline + chart */}
            <section aria-label="Steps trend">
              <Card padding="lg">
                <p className="text-caption text-text-muted">Daily average</p>
                <div className="mt-0.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <p className="num text-title-lg text-text-primary">
                    {formatSteps(stats.avgSteps)}
                    <span className="text-callout font-medium text-text-muted"> steps</span>
                  </p>
                  {change !== null && <ChangeBadge pct={change} against={changePeriod} />}
                </div>
                <p className="mt-1 text-caption text-text-muted">
                  {formatSteps(stats.totalSteps)} steps in total · {stats.recordedDays} of {cfg.days} days recorded
                </p>

                <div className="mt-5 flex h-5 items-center justify-between gap-2 text-caption" aria-live="polite">
                  {activeBar ? (
                    <>
                      <span className="truncate text-text-secondary">
                        {period === 'quarter' ? `Week of ${dayLabel(activeBar.key)}` : relativeDayLabel(activeBar.key)}
                      </span>
                      <span className="num shrink-0 font-semibold text-text-primary">
                        {activeBar.value === null
                          ? 'No data'
                          : `${formatSteps(activeBar.value)} ${period === 'quarter' ? 'avg/day' : 'steps'}`}
                      </span>
                    </>
                  ) : (
                    <span className="truncate text-text-muted">
                      {period === 'quarter' ? 'Avg per day, by week' : 'Steps per day'} · dashed line = {formatSteps(goal)} goal
                    </span>
                  )}
                </div>
                <StepBarChart
                  className="mt-2"
                  bars={bars}
                  goal={goal}
                  height={period === 'week' ? 150 : 140}
                  maxBarWidth={period === 'week' ? 32 : 18}
                  label={`${period === 'quarter' ? 'Average daily steps per week' : 'Daily steps'} over the last ${cfg.noun}. Average ${formatSteps(stats.avgSteps)} a day against a goal of ${formatSteps(goal)}.`}
                  selectedKey={selected}
                  onSelect={setSelected}
                />
              </Card>
            </section>

            {/* Consistency */}
            <section>
              <SectionHeader title="Consistency" subtitle={`Days you reached ${formatSteps(goal)} steps`} />
              <Card padding="lg">
                <div className="grid grid-cols-2 gap-3">
                  <StatTile
                    icon={CalendarCheck}
                    tone="brand"
                    label="Goal met"
                    value={
                      <>
                        {stats.goalDays}
                        <span className="text-callout font-medium text-text-muted"> of {cfg.days} days</span>
                      </>
                    }
                  />
                  <StatTile label="Longest run" value={`${stats.longestRun} ${stats.longestRun === 1 ? 'day' : 'days'}`} hint="in this period" />
                </div>
                {period !== 'week' && <GoalCalendar points={points} goal={goal} />}
              </Card>
            </section>

            {/* Highlights */}
            <section>
              <SectionHeader title="Highlights" />
              <div className="grid grid-cols-2 gap-3">
                <StatTile
                  variant="card"
                  label="Best day"
                  value={stats.best?.steps != null ? formatSteps(stats.best.steps) : '—'}
                  hint={stats.best ? relativeDayLabel(stats.best.date) : undefined}
                />
                <StatTile
                  variant="card"
                  label="All-time best"
                  value={user?.best_day_steps ? formatSteps(user.best_day_steps) : '—'}
                  hint="single day"
                />
                <StatTile
                  variant="card"
                  label="Distance"
                  value={`${stats.distanceKm.toLocaleString('en-KE', { maximumFractionDigits: 1 })} km`}
                  hint={`in the last ${cfg.noun}`}
                />
                <StatTile
                  variant="card"
                  label="Active time"
                  value={`${Math.round(stats.activeMinutes / Math.max(1, stats.recordedDays))} min`}
                  hint="average per day"
                />
              </div>
            </section>
          </>
        )}

        {/* Challenges (all-time, independent of period) */}
        {user && (
          <section>
            <SectionHeader title="Challenge performance" subtitle="All time" />
            <Card padding="lg">
              <div className="grid grid-cols-3 gap-3">
                <StatTile label="Joined" value={user.challenges_joined} />
                <StatTile label="Won" value={user.challenges_won} />
                <StatTile label="Win rate" value={`${Math.round(user.win_rate || 0)}%`} />
              </div>
              <div className="mt-4 flex items-center justify-between gap-3 border-t border-border-light pt-4">
                <div className="flex items-center gap-2 text-callout text-text-secondary">
                  <Trophy size={16} className="text-reward-ink" aria-hidden />
                  Total earned
                </div>
                <span className="num text-headline text-reward-ink">{formatKES(user.total_earned)}</span>
              </div>
            </Card>
          </section>
        )}
      </div>
    </div>
  );
}

function ChangeBadge({ pct, against }: { pct: number; against: string }) {
  const Icon = pct > 0 ? ArrowUpRight : pct < 0 ? ArrowDownRight : Minus;
  const text = pct === 0 ? 'Same as' : `${Math.abs(pct)}% ${pct > 0 ? 'more than' : 'less than'}`;
  return (
    <span className={`inline-flex items-center gap-1 text-callout font-medium ${pct > 0 ? 'text-success' : 'text-text-secondary'}`}>
      <Icon size={16} strokeWidth={2.25} aria-hidden />
      <span>
        <span className="num">{text}</span> {against}
      </span>
    </span>
  );
}

/** Calendar heat grid: rows are weekdays (Mon–Sun), columns are weeks. Text legend — never colour alone. */
function GoalCalendar({ points, goal }: { points: DayPoint[]; goal: number }) {
  // Pad the front so the first column starts on a Monday.
  const firstDow = (parseDateKey(points[0].date).getDay() + 6) % 7;
  const cells: Array<DayPoint | null> = [...Array.from({ length: firstDow }, () => null), ...points];
  const weeks = Math.ceil(cells.length / 7);
  const weekdays = ['Mon', '', 'Wed', '', 'Fri', '', 'Sun'];

  return (
    <div className="mt-5">
      {/* One grid (labels in column 1) so weekday labels always share rows with their cells. */}
      <div
        className="grid grid-flow-col gap-1"
        style={{
          gridTemplateRows: 'repeat(7, auto)',
          gridTemplateColumns: `2.25rem repeat(${weeks}, ${weeks <= 6 ? '28px' : 'minmax(0, 1fr)'})`,
        }}
        role="list"
        aria-label="Daily goal calendar"
      >
          {weekdays.map((d, i) => (
            <span key={`label-${i}`} className="flex items-center text-micro text-text-muted" aria-hidden>
              {d}
            </span>
          ))}
          {cells.map((p, i) => {
            if (!p) return <span key={`pad-${i}`} aria-hidden />;
            const met = p.steps !== null && p.steps >= goal;
            const some = p.steps !== null && p.steps > 0 && !met;
            const fill = met ? 'bg-brand' : some ? 'bg-brand/30' : 'bg-bg-input';
            const status = p.steps === null ? 'no data' : met ? `goal met, ${formatSteps(p.steps)} steps` : `${formatSteps(p.steps)} steps`;
            return (
              <span
                key={p.date}
                role="listitem"
                aria-label={`${dayLabel(p.date)}: ${status}`}
                title={`${dayLabel(p.date)}: ${status}`}
                className={`aspect-square w-full rounded-[4px] ${fill}`}
              />
            );
          })}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-caption text-text-muted" aria-hidden>
        <Legend className="bg-brand" label="Goal met" />
        <Legend className="bg-brand/30" label="Below goal" />
        <Legend className="bg-bg-input" label="No data" />
      </div>
    </div>
  );
}

function Legend({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`h-2.5 w-2.5 rounded-[3px] ${className}`} />
      {label}
    </span>
  );
}

function AnalyticsSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading insights">
      <div className="rounded-card border border-border-light bg-bg-card p-5 shadow-card">
        <Skeleton className="h-3 w-24 rounded" />
        <Skeleton className="mt-2 h-8 w-40 rounded" />
        <Skeleton className="mt-2 h-3 w-52 rounded" />
        <div className="mt-6 flex h-[150px] items-end gap-1.5 pr-9">
          {[45, 60, 38, 70, 52, 90, 40].map((h, i) => (
            <Skeleton key={i} className="flex-1 rounded-t" style={{ height: `${h}%` }} />
          ))}
        </div>
      </div>
      <Skeleton className="h-48 rounded-card" />
    </div>
  );
}
