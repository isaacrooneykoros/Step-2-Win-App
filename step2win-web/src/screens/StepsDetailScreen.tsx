import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, History, Footprints, MapPin, Flame, PartyPopper } from 'lucide-react';
import { stepsService } from '../services/api';
import type { StepsPeriod } from '../types';
import { StepStatChips } from '../components/ui/StepStatChips';
import { useStepsSyncStore } from '../store/stepsSyncStore';

// Time filter options
const PERIODS: { key: StepsPeriod; label: string }[] = [
  { key: '1d', label: '1D' },
  { key: '1w', label: '1W' },
  { key: '1m', label: '1M' },
  { key: '3m', label: '3M' },
  { key: '1y', label: '1Y' },
  { key: 'all', label: 'All' },
];

export default function StepsDetailScreen() {
  const navigate = useNavigate();
  const [period, setPeriod] = useState<StepsPeriod>('1w');
  const isStepsSocketConnected = useStepsSyncStore((state) => state.isStepsSocketConnected);
  const lastStepsUpdateAt = useStepsSyncStore((state) => state.lastStepsUpdateAt);

  // Fetch summary stats
  const { data: summary, isLoading: isLoadingSummary } = useQuery({
    queryKey: ['health', 'summary'],
    queryFn: stepsService.getSummary,
  });

  // Fetch history for chart
  const { data: history, isLoading: isLoadingHistory } = useQuery({
    queryKey: ['health', 'history', period],
    queryFn: () => stepsService.getHistory(period),
  });

  // Prepare chart data
  const todayStr = new Date().toISOString().split('T')[0];
  const chartData = [...(history || [])].sort((a, b) => a.date.localeCompare(b.date));

  if (isLoadingSummary) {
    return (
      <div className="min-h-screen bg-bg-page flex items-center justify-center">
        <div className="skeleton w-8 h-8 rounded-full" />
      </div>
    );
  }

  if (!summary) return null;

  return (
    <div className="min-h-screen bg-bg-page pb-8">
      {/*  HEADER  */}
      <div className="flex items-center justify-between px-5 pt-6 pb-2">
        {/* Back button */}
        <button
          onClick={() => navigate(-1)}
          className="w-9 h-9 rounded-xl bg-bg-input flex items-center justify-center"
        >
          <ChevronLeft size={20} className="text-text-primary" />
        </button>

        <h1 className="text-text-primary font-bold text-base">Steps</h1>

        {/* History button  navigates to /steps/history */}
        <button
          onClick={() => navigate('/steps/history')}
          className="w-9 h-9 rounded-xl bg-bg-input flex items-center justify-center"
        >
          <History size={18} className="text-text-primary" />
        </button>
      </div>

      {/*  HERO STEP COUNT  */}
      <div className="flex flex-col items-center py-6 px-5">
        {/* Shoe/footprint icon  use the accent blue tint */}
        <div className="w-14 h-14 rounded-2xl bg-tint-blue flex items-center justify-center mb-4">
          <Footprints size={28} className="text-accent-blue" />
        </div>

        {/* Big step count  DM Serif Display font */}
        <div className="flex items-baseline gap-2 mb-1">
          <span className="font-display text-6xl text-text-primary leading-none">
            {summary.today_steps.toLocaleString()}
          </span>
          <span className="text-text-secondary text-lg font-medium">steps</span>
        </div>

        {/* Motivational message  changes based on progress */}
        <p className="text-text-muted text-sm text-center mt-2 flex items-center justify-center gap-1.5">
          {summary.percent_complete >= 100 ? (
            <>
              <PartyPopper className="w-4 h-4 text-green-500" />
              <span>Goal reached! Amazing work today!</span>
            </>
          ) : summary.percent_complete >= 75
              ? `Almost there! ${summary.remaining_today.toLocaleString()} more steps to go!`
              : summary.percent_complete >= 50
                ? `Halfway there! Keep pushing  ${summary.remaining_today.toLocaleString()} left!`
                : `Take ${summary.remaining_today.toLocaleString()} more steps to hit your goal!`}
        </p>

        {/* Progress bar */}
        <div className="w-full mt-4 progress-track">
          <div
            className="progress-fill bg-accent-blue transition-all duration-1000"
            style={{ width: `${summary.percent_complete}%` }}
          />
        </div>
        <div className="flex justify-between w-full mt-1">
          <span className="text-text-muted text-xs">0</span>
          <span className="text-text-muted text-xs">
            {summary.percent_complete}% of {summary.today_goal.toLocaleString()}
          </span>
        </div>

        <StepStatChips
          distance={summary.today_distance}
          calories={summary.today_calories}
          activeMins={summary.today_active_mins}
        />

        <div
          className="mt-4 inline-flex items-center gap-2 rounded-full px-3 py-2 text-xs font-semibold"
          style={{
            background: isStepsSocketConnected ? 'rgba(52,211,153,0.12)' : 'rgba(148,163,184,0.12)',
            color: isStepsSocketConnected ? '#10B981' : '#64748B',
          }}
        >
          <span
            className="h-2 w-2 rounded-full"
            style={{ background: isStepsSocketConnected ? '#10B981' : '#94A3B8' }}
          />
          {isStepsSocketConnected && lastStepsUpdateAt
            ? `Live synced ${new Date(lastStepsUpdateAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`
            : isStepsSocketConnected
              ? 'Live step sync connected'
              : 'Live step sync reconnecting'}
        </div>
      </div>

      {/*  PERIOD FILTER + BAR CHART  */}
      {/* Period selector tabs */}
      <div className="px-4 mb-4">
        <div className="bg-bg-input rounded-2xl p-1 flex gap-1">
          {PERIODS.map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setPeriod(key)}
              className={`flex-1 py-2 rounded-xl text-xs font-bold transition-all duration-200
                ${
                  period === key
                    ? 'bg-bg-elevated text-text-primary shadow-card'
                    : 'text-text-muted'
                }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Bar Chart */}
      <div className="mx-4 mb-4 card p-4">
        {isLoadingHistory ? (
          // Skeleton bars
          <div className="flex items-end gap-1.5" style={{ height: 160 }}>
            {Array.from({ length: 12 }).map((_, i) => (
              <div
                key={i}
                className="flex-1 skeleton rounded-lg"
                style={{ height: `${Math.random() * 80 + 40}px` }}
              />
            ))}
          </div>
        ) : (
          <div className="flex items-end justify-between gap-1" style={{ height: 160 }}>
            {chartData.map((day, i) => {
              const maxSteps = Math.max(...chartData.map((d) => d.steps), 1);
              const barHeight = Math.max((day.steps / maxSteps) * 140, 4);
              const isToday = day.date === todayStr;
              const isHighest = day.steps === maxSteps && day.steps > 0;

              return (
                <div key={i} className="flex-1 flex flex-col items-center gap-1">
                  {/* Step count label on top of bar  only for highest bar */}
                  {isHighest && (
                    <span className="text-accent-blue text-xs font-bold">
                      {day.steps >= 1000
                        ? `${(day.steps / 1000).toFixed(1)}k`
                        : day.steps}
                    </span>
                  )}
                  {/* Bar */}
                  <div
                    className="w-full rounded-lg transition-all duration-700"
                    style={{
                      height: `${barHeight}px`,
                      background: isToday
                        ? '#4F9CF9'
                        : day.steps > 0
                          ? '#BFDBFE'
                          : 'hsl(var(--bg-input))',
                      minHeight: '4px',
                    }}
                  />
                  {/* Date label  show every Nth label to avoid crowding */}
                  {(i % Math.ceil(chartData.length / 7) === 0 || isToday) && (
                    <span
                      className={`text-xs font-medium ${
                        isToday ? 'text-accent-blue' : 'text-text-muted'
                      }`}
                    >
                      {formatChartLabel(day.date, period)}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/*  SUMMARY STATS ROW  */}
      <div className="px-4 mb-4 grid grid-cols-2 sm:grid-cols-3 gap-3">
        {[
          {
            label: 'Week Steps',
            value: summary.week_total_steps.toLocaleString(),
            sub: `avg ${summary.week_avg_steps.toLocaleString()}/day`,
            color: '#4F9CF9',
            tint: '#EFF6FF',
            Icon: Footprints,
          },
          {
            label: 'Distance',
            value: `${summary.week_distance} km`,
            sub: 'this week',
            color: '#34D399',
            tint: '#ECFDF5',
            Icon: MapPin,
          },
          {
            label: 'Calories',
            value: `${summary.week_calories.toLocaleString()}`,
            sub: 'kcal burned',
            color: '#FBBF24',
            tint: '#FFFBEB',
            Icon: Flame,
          },
        ].map(({ label, value, sub, tint, Icon }) => (
          <div key={label} className="card p-3">
            <div
              className="w-8 h-8 rounded-xl flex items-center justify-center mb-2"
              style={{ background: tint }}
            >
              <Icon className="w-4 h-4 text-text-muted" />
            </div>
            <p className="text-text-primary text-sm font-bold leading-tight">
              {value}
            </p>
            <p className="text-text-muted text-xs mt-0.5">{label}</p>
            <p className="text-text-muted text-xs">{sub}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

// Helper function for chart labels
function formatChartLabel(dateStr: string, period: StepsPeriod): string {
  const date = new Date(dateStr);
  if (period === '1d') return 'Today';
  if (period === '1w') return date.toLocaleDateString('en-US', { weekday: 'short' });
  if (period === '1m') return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  if (period === '3m')
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return date.toLocaleDateString('en-US', { month: 'short' });
}


