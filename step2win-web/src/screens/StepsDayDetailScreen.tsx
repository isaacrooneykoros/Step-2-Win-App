import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Footprints, MapPin, Share2 } from 'lucide-react';
import { stepsService } from '../services/api/steps';
import type { DayDetail, HealthRecord, LocationWaypoint } from '../types';
import { StepsDayMap } from '../components/StepsDayMap';
import { buildStepShareCard } from '../utils/shareCard';
import { ScreenHeader, IconButton } from '../components/ui/ScreenHeader';
import Card, { SectionHeader } from '../components/ui/Card';
import ProgressBar from '../components/ui/ProgressBar';
import { Pill, type Tone } from '../components/ui/Pill';
import { StatTile } from '../components/ui/StatTile';
import { StepStatChips } from '../components/ui/StepStatChips';
import { Skeleton } from '../components/ui/Skeleton';
import { LoadError } from '../components/ui/ErrorState';
import { EmptyState } from '../components/ui/EmptyState';
import { HourlyChart } from '../components/steps/HourlyChart';
import { dateKey, dayLabel, dayLabelLong, formatHour, periodCovering, useDailyGoal } from '../components/steps/stepUtils';
import { formatSteps } from '../lib/format';
import { shareContent } from '../lib/share';
import { toast } from '../components/ui/Toast';

export default function StepsDayDetailScreen() {
  const { date = '' } = useParams<{ date: string }>();
  const { goal } = useDailyGoal();
  const isToday = date === dateKey();
  const period = periodCovering(date);

  const detail = useQuery({
    queryKey: ['steps', 'day', date],
    queryFn: () => stepsService.getDayDetail(date),
    enabled: Boolean(date),
  });
  // The day's synced record is the source of truth for totals (it matches the history list).
  const history = useQuery({
    queryKey: ['health', 'history', period],
    queryFn: () => stepsService.getHistory(period),
    enabled: Boolean(date),
  });

  const record: HealthRecord | undefined = (history.data ?? [])
    .filter((r) => r.date === date)
    .sort((a, b) => b.steps - a.steps)[0];
  const data = detail.data;

  const steps = record?.steps ?? data?.total_steps ?? 0;
  const distance = record ? record.distance_km : data?.total_km ?? null;
  const calories = record ? record.calories_active : data?.total_calories ?? null;
  const activeMins = record ? record.active_minutes : null;
  const met = steps >= goal;
  const pct = goal > 0 ? (steps / goal) * 100 : 0;
  const hourly = data?.hourly ?? [];
  const activeHours = hourly.filter((h) => h.steps > 0).length;
  const title = date ? (isToday ? 'Today' : dayLabel(date)) : 'Day';

  const handleShare = async () => {
    const longDate = dayLabelLong(date);
    const km = Number(distance ?? 0);
    const kcal = Number(calories ?? 0);
    const message = `I walked ${formatSteps(steps)} steps${km > 0 ? `, ${km.toFixed(2)} km` : ''} on ${longDate}.\nJoin me on Step2Win and turn every step into rewards.`;
    try {
      const cardBlob = await buildStepShareCard({
        dateLabel: longDate,
        steps,
        km,
        kcal,
        minutes: Number(activeMins ?? 0),
      });
      const result = await shareContent({
        title: `My Step2Win stats - ${longDate}`,
        text: message,
        file: { blob: cardBlob, name: `step2win-${date || 'day'}.png` },
        dialogTitle: 'Share your day',
      });
      if (result === 'copied') toast({ message: 'Copied — paste it anywhere to share.', type: 'success' });
      if (result === 'failed') toast({ message: 'Couldn’t open sharing on this device.', type: 'error' });
    } catch (error) {
      console.warn('Share card failed', error);
      toast({ message: 'Couldn’t create the share image.', type: 'error' });
    }
  };

  const loading = detail.isLoading || history.isLoading;
  const hasRoute = Boolean(data && (data.encoded_polyline || data.waypoints.length > 0));

  return (
    <div className="pb-nav">
      <ScreenHeader
        title={title}
        back
        actions={
          data && steps > 0 ? (
            <IconButton label="Share this day" onClick={handleShare}>
              <Share2 size={19} />
            </IconButton>
          ) : undefined
        }
      />

      <div className="space-y-8 px-5 pt-1">
        {detail.isError ? (
          <LoadError resource="this day" onRetry={() => detail.refetch()} isRetrying={detail.isFetching} />
        ) : loading ? (
          <DaySkeleton />
        ) : !record && steps === 0 ? (
          <EmptyState
            icon={Footprints}
            title="No steps recorded"
            description={isToday ? 'Steps you take today will appear here after your phone syncs.' : 'Nothing was synced for ' + dayLabelLong(date) + '.'}
          />
        ) : (
          <>
            {/* Totals + goal state */}
            <section aria-label="Day summary">
              {!isToday && <p className="text-caption text-text-muted">{dayLabelLong(date)}</p>}
              <div className="mt-1 flex items-end justify-between gap-3">
                <p className="min-w-0">
                  <span className="num text-display text-text-primary">{formatSteps(steps)}</span>
                  <span className="ml-1.5 text-body text-text-muted">steps</span>
                </p>
                {met ? (
                  <Pill tone="brand" icon={CheckCircle2} size="md" className="mb-2">
                    Goal met
                  </Pill>
                ) : (
                  <Pill tone="neutral" size="md" className="mb-2">
                    {Math.floor(pct)}% of goal
                  </Pill>
                )}
              </div>
              <ProgressBar className="mt-3" progress={pct} height="sm" label="Progress toward daily goal" />
              <p className="mt-2 text-caption text-text-muted">
                {met ? (
                  <>
                    <span className="num">{formatSteps(steps - goal)}</span> over your <span className="num">{formatSteps(goal)}</span> step goal
                  </>
                ) : (
                  <>
                    <span className="num">{formatSteps(goal - steps)}</span> {isToday ? 'to go to' : 'short of'} your{' '}
                    <span className="num">{formatSteps(goal)}</span> step goal
                  </>
                )}
              </p>
              <StepStatChips className="mt-6" distance={distance} calories={calories} activeMins={activeMins} hideZero />
            </section>

            {/* Hourly */}
            <section>
              <SectionHeader title="Hour by hour" />
              <Card padding="lg">
                {hourly.length > 0 ? (
                  <>
                    <HourlyChart
                      hourly={hourly}
                      peakHour={data?.peak_hour ?? null}
                      upToHour={isToday ? new Date().getHours() : undefined}
                      height={132}
                    />
                    <div className="mt-5 grid grid-cols-2 gap-4 border-t border-border-light pt-4">
                      <StatTile
                        label="Peak hour"
                        value={data?.peak_hour != null ? formatHour(data.peak_hour) : '—'}
                        hint={data?.peak_hour != null ? `${formatSteps(data.peak_steps)} steps` : undefined}
                      />
                      <StatTile label="Active hours" value={String(activeHours)} hint="hours with steps" />
                    </div>
                  </>
                ) : (
                  <p className="py-6 text-center text-callout text-text-muted">
                    No hourly breakdown was synced for this day.
                  </p>
                )}
              </Card>
            </section>

            {/* Route */}
            <section>
              <SectionHeader
                title="Route"
                subtitle={hasRoute && data ? routeSubtitle(data) : undefined}
              />
              {hasRoute && data ? (
                <Card padding="none" className="overflow-hidden">
                  <RouteConfidenceRow confidence={getRouteConfidence(data)} />
                  <StepsDayMap waypoints={data.waypoints} encodedPolyline={data.encoded_polyline} />
                </Card>
              ) : (
                <Card padding="lg">
                  <div className="flex items-start gap-3">
                    <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-bg-input text-text-secondary" aria-hidden>
                      <MapPin size={18} />
                    </span>
                    <div className="min-w-0">
                      <p className="text-callout font-semibold text-text-primary">No route recorded</p>
                      <p className="mt-0.5 text-caption text-text-muted">
                        Allow location access in Settings to see where you walked.
                      </p>
                    </div>
                  </div>
                </Card>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}

function DaySkeleton() {
  return (
    <div className="space-y-8" aria-hidden>
      <div>
        <Skeleton className="h-11 w-44 rounded-lg" />
        <Skeleton className="mt-4 h-1.5 w-full rounded-full" />
        <Skeleton className="mt-3 h-3 w-48 rounded" />
        <div className="mt-6 grid grid-cols-3 gap-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="mx-auto h-10 w-16 rounded" />
          ))}
        </div>
      </div>
      <div className="rounded-card border border-border-light bg-bg-card p-5 shadow-card">
        <Skeleton className="h-5 w-full rounded" />
        <div className="mt-3 flex h-[132px] items-end gap-[2px]">
          {Array.from({ length: 24 }, (_, i) => (
            <Skeleton key={i} className="flex-1 rounded-t-sm" style={{ height: `${10 + ((i * 37) % 70)}%` }} />
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Route confidence ────────────────────────────────────────────────────────

type RouteConfidence = {
  source: 'encoded' | 'waypoints';
  waypointCount: number;
  routeDistanceKm: number;
  grade: 'High' | 'Medium' | 'Low';
  tone: Tone;
};

function routeSubtitle(data: DayDetail): string {
  const km = Number(data.route_distance_km || 0);
  return km > 0 ? `${km.toFixed(2)} km tracked` : 'Tracked route';
}

function RouteConfidenceRow({ confidence }: { confidence: RouteConfidence }) {
  return (
    <div className="flex flex-wrap items-center gap-2 px-4 py-3">
      <Pill tone={confidence.tone}>{confidence.grade} accuracy</Pill>
      <Pill tone="neutral">{confidence.source === 'encoded' ? 'GPS trace' : 'Location points'}</Pill>
      <Pill tone="neutral">{confidence.waypointCount.toLocaleString('en-KE')} points</Pill>
    </div>
  );
}

function getRouteConfidence(data: DayDetail): RouteConfidence {
  const source: 'encoded' | 'waypoints' = data.encoded_polyline ? 'encoded' : 'waypoints';
  const waypointCount = data.waypoints.length;
  const routeDistanceKm = Number(data.route_distance_km || data.total_km || 0);

  let score = source === 'encoded' ? 2 : 0;
  if (waypointCount >= 25) score += 2;
  else if (waypointCount >= 8) score += 1;

  const avgAccuracy = averageAccuracy(data.waypoints);
  if (avgAccuracy > 0) {
    if (avgAccuracy <= 20) score += 2;
    else if (avgAccuracy <= 40) score += 1;
    else if (avgAccuracy >= 80) score -= 1;
  }

  const reportedKm = Number(data.total_km || 0);
  if (reportedKm > 0 && routeDistanceKm > 0) {
    const ratio = Math.abs(routeDistanceKm - reportedKm) / Math.max(reportedKm, 0.01);
    if (ratio <= 0.25) score += 1;
    else if (ratio > 0.7) score -= 1;
  }

  if (score >= 5) return { source, waypointCount, routeDistanceKm, grade: 'High', tone: 'success' };
  if (score >= 2) return { source, waypointCount, routeDistanceKm, grade: 'Medium', tone: 'warning' };
  return { source, waypointCount, routeDistanceKm, grade: 'Low', tone: 'danger' };
}

function averageAccuracy(points: LocationWaypoint[]): number {
  const valid = points
    .map((point) => Number(point.accuracy_m || 0))
    .filter((accuracy) => Number.isFinite(accuracy) && accuracy > 0);
  if (valid.length === 0) return 0;
  return valid.reduce((sum, accuracy) => sum + accuracy, 0) / valid.length;
}
