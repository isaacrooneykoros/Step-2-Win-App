import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { CheckCircle2 } from 'lucide-react';
import Avatar from '../ui/Avatar';
import Pill from '../ui/Pill';
import ProgressBar from '../ui/ProgressBar';
import { Skeleton } from '../ui/Skeleton';
import { formatSteps } from '../../lib/format';
import { duration, easing, usePrefersReducedMotion } from '../../lib/motion';

/**
 * Rank numeral. First place is solid, second and third sit on a quiet chip,
 * everyone else is a plain numeral — hierarchy without trophies or medals.
 */
export function RankMark({ rank }: { rank: number | null | undefined }) {
  if (rank == null) {
    return (
      <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center text-callout text-text-muted">
        <span aria-hidden>–</span>
        <span className="sr-only">Unranked</span>
      </span>
    );
  }
  const tone =
    rank === 1
      ? 'bg-text-primary text-text-inverse'
      : rank <= 3
        ? 'border border-border bg-bg-card text-text-primary'
        : 'text-text-muted';
  return (
    <span
      className={`num inline-flex h-7 min-w-7 shrink-0 items-center justify-center rounded-full px-1 text-callout font-semibold ${tone}`}
    >
      <span className="sr-only">Rank </span>
      {rank}
    </span>
  );
}

interface LeaderboardRowProps {
  /** Stable identity used to animate reordering. */
  id: string | number;
  rank: number | null | undefined;
  name: string;
  steps: number;
  /** 0–100 progress towards the milestone. */
  progress: number;
  qualified: boolean;
  isYou?: boolean;
  /** Replaces the default secondary line under the step count (e.g. payout). */
  trailing?: ReactNode;
  /** Extra line under the progress bar (e.g. tie explanation). */
  note?: ReactNode;
}

export function LeaderboardRow({ id, rank, name, steps, progress, qualified, isYou = false, trailing, note }: LeaderboardRowProps) {
  const pct = Math.max(0, Math.min(100, Math.round(progress)));
  return (
    <li
      data-flip-key={String(id)}
      aria-current={isYou ? 'true' : undefined}
      className={`relative flex items-center gap-3 px-4 py-3 ${isYou ? 'bg-brand-soft' : 'bg-bg-card'}`}
    >
      <RankMark rank={rank} />
      <Avatar name={name} size="sm" highlight={isYou} className={isYou ? 'ring-offset-brand-soft' : ''} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-callout font-semibold text-text-primary">{name}</span>
          {isYou && (
            <Pill tone="brand" solid className="shrink-0">
              You
            </Pill>
          )}
        </div>
        <ProgressBar progress={pct} height="xs" className="mt-2" label={`${name}: ${pct}% of the step goal`} />
        {note && <div className="mt-1.5 text-caption text-text-muted">{note}</div>}
      </div>
      <div className="min-w-[76px] shrink-0 text-right">
        <div className="num text-callout font-semibold text-text-primary">
          {formatSteps(steps)}
          <span className="sr-only"> steps</span>
        </div>
        <div className="mt-0.5 text-caption">
          {trailing ??
            (qualified ? (
              <span className="inline-flex items-center gap-1 font-medium text-success">
                <CheckCircle2 size={12} strokeWidth={2.5} aria-hidden />
                Qualified
              </span>
            ) : (
              <span className="num text-text-muted">{pct}%</span>
            ))}
        </div>
      </div>
    </li>
  );
}

/**
 * Ordered leaderboard surface. When fresh data reorders rows, each row glides from its
 * previous position (FLIP). Nothing animates on first paint or under reduced motion.
 */
export function LeaderboardList({ children, label, className = '' }: { children: ReactNode; label: string; className?: string }) {
  const listRef = useRef<HTMLOListElement>(null);
  const positions = useRef<Map<string, number>>(new Map());
  const reduced = usePrefersReducedMotion();

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const items = Array.from(list.querySelectorAll<HTMLElement>('[data-flip-key]'));
    const next = new Map<string, number>();
    items.forEach((item) => next.set(item.dataset.flipKey as string, item.offsetTop));

    const previous = positions.current;
    if (previous.size > 0 && !reduced) {
      items.forEach((item) => {
        const key = item.dataset.flipKey as string;
        const before = previous.get(key);
        const after = next.get(key);
        if (before === undefined || after === undefined || before === after) return;
        item.animate?.([{ transform: `translateY(${before - after}px)` }, { transform: 'translateY(0)' }], {
          duration: duration.deliberate,
          easing: easing.standard,
        });
      });
    }
    positions.current = next;
  });

  return (
    <ol
      ref={listRef}
      aria-label={label}
      className={`relative divide-y divide-border-light overflow-hidden rounded-card border border-border-light bg-bg-card shadow-card ${className}`}
    >
      {children}
    </ol>
  );
}

export function LeaderboardSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="divide-y divide-border-light overflow-hidden rounded-card border border-border-light bg-bg-card" aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3 px-4 py-3">
          <Skeleton className="h-7 w-7 rounded-full" />
          <Skeleton className="h-8 w-8 rounded-full" />
          <div className="min-w-0 flex-1">
            <Skeleton className="h-3.5 w-24" />
            <Skeleton className="mt-2.5 h-1 w-full rounded-full" />
          </div>
          <div className="flex w-[76px] flex-col items-end">
            <Skeleton className="h-3.5 w-14" />
            <Skeleton className="mt-1.5 h-3 w-10" />
          </div>
        </div>
      ))}
    </div>
  );
}
