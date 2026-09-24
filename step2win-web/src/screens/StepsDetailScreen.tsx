import { useQuery } from '@tanstack/react-query';
import { CalendarDays, History, Route } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { stepsService } from '../services/api';
import { ScreenHeader, IconButton } from '../components/ui/ScreenHeader';
import { ProgressRing } from '../components/ui/ProgressRing';
import { AnimatedNumber } from '../components/ui/AnimatedNumber';
import { StepStatChips } from '../components/ui/StepStatChips';
import Card, { SectionHeader } from '../components/ui/Card';
import { StatTile } from '../components/ui/StatTile';
import { IconTile } from '../components/ui/Pill';
import { ListGroup, ListRow } from '../components/ui/ListRow';
import { Skeleton } from '../components/ui/Skeleton';
import { ErrorInline, LoadError } from '../components/ui/ErrorState';
import { HourlyChart } from '../components/steps/HourlyChart';
import { dateKey, formatHour, useDailyGoal } from '../components/steps/stepUtils';
import { formatSteps } from '../lib/format';

export default function StepsDetailScreen() {
  const navigate = useNavigate();
  const { goal } = useDailyGoal();
  const todayKey = dateKey();

  const today = useQuery({ queryKey: ['health', 'today'], queryFn: stepsService.getTodayHealth });
  const summary = useQuery({ queryKey: ['health', 'summary'], queryFn: stepsService.getSummary });
  const day = useQuery({
    queryKey: ['steps', 'day', todayKey],
    queryFn: () => stepsService.getDayDetail(todayKey),
  });

  const steps = today.data?.steps ?? 0;
  const remaining = Math.max(0, goal - steps);
  const pct = goal > 0 ? Math.round((steps / goal) * 100) : 0;
  const hourly = day.data?.hourly ?? [];

  return (
    <div className="pb-nav">
      <ScreenHeader
        title="Today"
        back
        actions={
          <IconButton label="Step history" onClick={() => navigate('/steps/history')}>
            <History size={20} />
          </IconButton>
        }
      />

      <div className="space-y-8 px-5">
        {/* Hero */}
        <section className="flex flex-col items-center pt-2" aria-label="Today's steps">
          {today.isError ? (
            <LoadError resource="today's steps" onRetry={() => today.refetch()} isRetrying={today.isFetching} />
          ) : (
            <>
              <ProgressRing
                value={steps}
                goal={goal}
                size={212}
                strokeWidth={14}
                loading={today.isLoading}
                label={`${formatSteps(steps)} of ${formatSteps(goal)} steps, ${pct}% of your daily goal`}
              >
                {today.isLoading ? (
                  <Skeleton className="h-10 w-28 rounded-lg" />
                ) : (
                  <>
                    <AnimatedNumber value={steps} startFromValue className="text-display text-text-primary" />
                    <span className="num mt-1 text-callout text-text-muted">of {formatSteps(goal)} steps</span>
                    <span className="num mt-2 text-callout font-semibold text-brand">{pct}%</span>
                  </>
                )}
              </ProgressRing>
              <div className="relative z-10 -mt-2 text-callout text-text-secondary">
                {today.isLoading ? (
                  <Skeleton className="h-5 w-40 rounded" />
                ) : remaining > 0 ? (
                  <>
                    <span className="num font-semibold text-text-primary">{formatSteps(remaining)}</span> steps to your daily goal
                  </>
                ) : (
                  <span className="font-semibold text-brand">Daily goal reached</span>
                )}
              </div>
              {today.data && (
                <StepStatChips
                  className="mt-6 w-full"
                  distance={today.data.distance_km}
                  activeMins={today.data.active_minutes}
                  calories={today.data.calories_active}
                />
              )}
            </>
          )}
        </section>

        {/* Hourly */}
        <section>
          <SectionHeader
            title="Through the day"
            subtitle={
              day.data?.peak_hour != null
                ? `Most active around ${formatHour(day.data.peak_hour)}`
                : undefined
            }
          />
          {day.isError ? (
            <ErrorInline message="Couldn't load today's hourly steps." onRetry={() => day.refetch()} />
          ) : (
            <Card padding="lg">
              {day.isLoading ? (
                <div aria-hidden>
                  <Skeleton className="mb-3 h-5 w-full rounded" />
                  <div className="flex h-[120px] items-end gap-[2px]">
                    {Array.from({ length: 24 }, (_, i) => (
                      <Skeleton key={i} className="flex-1 rounded-t-sm" style={{ height: `${10 + ((i * 37) % 70)}%` }} />
                    ))}
                  </div>
                  <div className="mt-2 h-4" />
                </div>
              ) : hourly.length > 0 ? (
                <HourlyChart hourly={hourly} peakHour={day.data?.peak_hour ?? null} upToHour={new Date().getHours()} />
              ) : (
                <p className="py-6 text-center text-callout text-text-muted">
                  Hourly detail appears here after your phone syncs today's activity.
                </p>
              )}
            </Card>
          )}
        </section>

        {/* Last 7 days */}
        <section>
          <SectionHeader title="Last 7 days" action={{ label: 'History', to: '/steps/history' }} />
          {summary.isError ? (
            <ErrorInline message="Couldn't load your weekly summary." onRetry={() => summary.refetch()} />
          ) : (
            <Card padding="lg">
              {summary.isLoading || !summary.data ? (
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
                  <StatTile label="Total steps" value={formatSteps(summary.data.week_total_steps)} />
                  <StatTile label="Daily average" value={formatSteps(summary.data.week_avg_steps)} />
                  <StatTile
                    label="Distance"
                    value={`${Number(summary.data.week_distance || 0).toLocaleString('en-KE', { maximumFractionDigits: 1 })} km`}
                  />
                  <StatTile label="Best day" value={formatSteps(summary.data.best_day_steps)} />
                </div>
              )}
            </Card>
          )}
        </section>

        <ListGroup>
          <ListRow
            to={`/steps/history/${todayKey}`}
            leading={<IconTile icon={Route} tone="brand" size="sm" />}
            title="Today's breakdown"
            subtitle="Hour by hour and your route"
          />
          <ListRow
            to="/steps/history"
            leading={<IconTile icon={CalendarDays} tone="neutral" size="sm" />}
            title="Step history"
            subtitle="Week, month and 3-month trends"
          />
        </ListGroup>
      </div>
    </div>
  );
}
