import { useQuery } from '@tanstack/react-query';
import { CalendarCheck, Footprints, TrendingUp, type LucideIcon } from 'lucide-react';
import { challengesService } from '../../services/api';
import { IconTile, type Tone } from './Pill';
import { Skeleton } from './Skeleton';
import { formatSteps } from '../../lib/format';

interface ChallengeSocialBadgesProps {
  challengeId: number;
}

interface Highlight {
  key: string;
  icon: LucideIcon;
  tone: Tone;
  title: string;
  username: string;
  detail: string;
}

/** Group highlights for private challenges: consistency, best day, most improved. */
export function ChallengeSocialBadges({ challengeId }: ChallengeSocialBadgesProps) {
  const { data: stats, isLoading } = useQuery({
    queryKey: ['challenges', challengeId, 'social-stats'],
    queryFn: () => challengesService.getSocialStats(challengeId),
    retry: 1,
  });

  if (isLoading) {
    return (
      <section aria-busy="true">
        <Skeleton className="mb-3 h-5 w-32" />
        <div className="divide-y divide-border-light overflow-hidden rounded-card border border-border-light bg-bg-card">
          {[0, 1].map((i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-3">
              <Skeleton className="h-10 w-10 rounded-xl" />
              <div className="flex-1">
                <Skeleton className="h-3.5 w-28" />
                <Skeleton className="mt-2 h-3 w-40" />
              </div>
            </div>
          ))}
        </div>
      </section>
    );
  }

  if (!stats) return null;

  const highlights: Highlight[] = [];
  if (stats.most_consistent) {
    highlights.push({
      key: 'most_consistent',
      icon: CalendarCheck,
      tone: 'brand',
      title: 'Most consistent',
      username: stats.most_consistent.username,
      detail: `${stats.most_consistent.days_active} active ${stats.most_consistent.days_active === 1 ? 'day' : 'days'}`,
    });
  }
  if (stats.biggest_single_day) {
    highlights.push({
      key: 'biggest_single_day',
      icon: Footprints,
      tone: 'info',
      title: 'Biggest single day',
      username: stats.biggest_single_day.username,
      detail: `${formatSteps(stats.biggest_single_day.steps)} steps`,
    });
  }
  if (stats.most_improved) {
    highlights.push({
      key: 'most_improved',
      icon: TrendingUp,
      tone: 'success',
      title: 'Most improved',
      username: stats.most_improved.username,
      detail: `${stats.most_improved.improvement_percent}% improvement`,
    });
  }

  if (highlights.length === 0) return null;

  return (
    <section aria-labelledby={`highlights-${challengeId}`}>
      <h2 id={`highlights-${challengeId}`} className="mb-3 text-headline text-text-primary">
        Group highlights
      </h2>
      <ul className="divide-y divide-border-light overflow-hidden rounded-card border border-border-light bg-bg-card shadow-card">
        {highlights.map((h) => (
          <li key={h.key} className="flex min-h-[56px] items-center gap-3 px-4 py-3">
            <IconTile icon={h.icon} tone={h.tone} />
            <div className="min-w-0 flex-1">
              <p className="text-caption text-text-muted">{h.title}</p>
              <p className="truncate text-callout font-semibold text-text-primary">{h.username}</p>
            </div>
            <span className="num shrink-0 text-right text-caption text-text-secondary">{h.detail}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
