import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Award, Lock } from 'lucide-react';
import { gamificationService } from '../../services/api';
import type { Badge, UserBadge } from '../../services/api/gamification';
import { BadgeGlyph } from '../ui/BadgeGlyph';
import { Pill } from '../ui/Pill';
import { Sheet } from '../ui/Sheet';
import { Skeleton } from '../ui/Skeleton';
import { EmptyState } from '../ui/EmptyState';
import { ErrorInline } from '../ui/ErrorState';
import { formatShortDate } from '../../lib/format';

export interface AchievementsData {
  earned: UserBadge[];
  locked: Badge[];
  total: number;
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
}

/**
 * Earned badges from `my_badges`; locked ones are derived as
 * all badge definitions minus earned (so the two lists can never disagree).
 */
export function useAchievements(): AchievementsData {
  const mine = useQuery({ queryKey: ['gamification', 'badges', 'my'], queryFn: gamificationService.getMyBadges });
  const all = useQuery({ queryKey: ['gamification', 'badges', 'all'], queryFn: gamificationService.getAllBadges, staleTime: 10 * 60_000 });
  const earned = mine.data ?? [];
  const earnedIds = new Set(earned.map((ub) => ub.badge.id));
  const locked = (all.data ?? []).filter((b) => !earnedIds.has(b.id));
  return {
    earned,
    locked,
    total: Math.max(all.data?.length ?? 0, earned.length),
    isLoading: mine.isLoading || all.isLoading,
    isError: mine.isError,
    refetch: () => {
      mine.refetch();
      all.refetch();
    },
  };
}

type Selected = { badge: Badge; earnedAt?: string } | null;

/** Grid of badge glyphs: earned first (reward tone), then locked (muted). Tap for details. */
export function AchievementsGrid({ data, limit }: { data: AchievementsData; limit?: number }) {
  const [selected, setSelected] = useState<Selected>(null);
  const [shown, setShown] = useState<Selected>(null);
  if (selected && selected !== shown) setShown(selected);

  if (data.isLoading) {
    return (
      <div className="grid grid-cols-4 gap-3" aria-busy="true" aria-label="Loading achievements">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex flex-col items-center gap-2">
            <Skeleton className="h-14 w-14 rounded-2xl" />
            <Skeleton className="h-3 w-12 rounded" />
          </div>
        ))}
      </div>
    );
  }
  if (data.isError && data.earned.length === 0) {
    return <ErrorInline message="We couldn't load your achievements." onRetry={data.refetch} />;
  }
  if (data.earned.length === 0 && data.locked.length === 0) {
    return (
      <EmptyState
        icon={Award}
        title="No achievements yet"
        description="Hit your daily goal, keep a streak going or finish a challenge to earn your first badge."
        className="py-6"
      />
    );
  }

  const items: Array<{ badge: Badge; earnedAt?: string }> = [
    ...data.earned.map((ub) => ({ badge: ub.badge, earnedAt: ub.earned_at })),
    ...data.locked.map((badge) => ({ badge })),
  ];
  const visible = limit ? items.slice(0, limit) : items;
  const current = selected ?? shown;

  return (
    <>
      <ul className="grid grid-cols-4 gap-x-2 gap-y-4" aria-label="Achievements">
        {visible.map(({ badge, earnedAt }) => (
          <li key={badge.id}>
            <button
              type="button"
              onClick={() => setSelected({ badge, earnedAt })}
              className="flex w-full flex-col items-center gap-2 rounded-control px-1 py-1 text-center hover:bg-bg-input/60 active:!scale-100"
              aria-label={`${badge.name}, ${earnedAt ? `earned ${formatShortDate(earnedAt)}` : 'not earned yet'}`}
            >
              <span className="relative">
                <BadgeGlyph badge={badge} size="md" locked={!earnedAt} />
                {!earnedAt && (
                  <span className="absolute -bottom-1 -right-1 inline-flex h-5 w-5 items-center justify-center rounded-full border border-border-light bg-bg-card text-text-muted" aria-hidden>
                    <Lock size={11} strokeWidth={2.25} />
                  </span>
                )}
              </span>
              <span className={`line-clamp-2 text-caption leading-tight ${earnedAt ? 'text-text-primary' : 'text-text-muted'}`}>{badge.name}</span>
            </button>
          </li>
        ))}
      </ul>
      <Sheet open={Boolean(selected)} onClose={() => setSelected(null)} size="sm" title={current?.badge.name}>
        {current && (
          <div className="flex flex-col items-center pb-2 text-center">
            <BadgeGlyph badge={current.badge} size="lg" locked={!current.earnedAt} />
            <Pill tone={current.earnedAt ? 'reward' : 'neutral'} size="md" className="mt-4">
              {current.earnedAt ? `Earned ${formatShortDate(current.earnedAt)}` : 'Not earned yet'}
            </Pill>
            {current.badge.description && <p className="mt-3 max-w-[300px] text-body text-text-secondary">{current.badge.description}</p>}
          </div>
        )}
      </Sheet>
    </>
  );
}
