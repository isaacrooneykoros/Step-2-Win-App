import type { ReactNode } from 'react';
import { ArrowDown, ArrowUp, Minus } from 'lucide-react';
import { Avatar } from '../ui/Avatar';
import { formatSteps } from '../../lib/format';

/** Movement vs last week. Always text + icon, never colour alone. */
export function Movement({ value }: { value: number | null }) {
  if (value === null) {
    return <span className="text-micro font-semibold text-text-muted">New</span>;
  }
  if (value === 0) {
    return (
      <span className="inline-flex items-center gap-0.5 text-micro font-semibold text-text-muted" aria-label="Same place as last week">
        <Minus size={12} aria-hidden />
        <span aria-hidden>0</span>
      </span>
    );
  }
  const up = value > 0;
  const Icon = up ? ArrowUp : ArrowDown;
  return (
    <span
      className={`inline-flex items-center gap-0.5 text-micro font-semibold ${up ? 'text-success' : 'text-danger'}`}
      aria-label={`${up ? 'Up' : 'Down'} ${Math.abs(value)} ${Math.abs(value) === 1 ? 'place' : 'places'} since last week`}
    >
      <Icon size={12} strokeWidth={2.5} aria-hidden />
      <span aria-hidden className="num">{Math.abs(value)}</span>
    </span>
  );
}

interface RankRowProps {
  rank: number | null;
  name: string;
  photo?: string | null;
  steps: number | null;
  subtitle?: ReactNode;
  movement?: number | null;
  highlight?: boolean;
  trailing?: ReactNode;
  onClick?: () => void;
  /** Hide the avatar (team rows use an icon instead). */
  leading?: ReactNode;
}

export function RankRow({ rank, name, photo, steps, subtitle, movement, highlight = false, trailing, onClick, leading }: RankRowProps) {
  const body = (
    <>
      <span
        className={`num w-7 shrink-0 text-center text-callout font-semibold ${rank === 1 ? 'text-brand' : 'text-text-secondary'}`}
        aria-label={rank ? `Rank ${rank}` : 'Not ranked'}
      >
        {rank ?? '–'}
      </span>
      {leading ?? <Avatar name={name} src={photo} size="md" highlight={highlight} />}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-body font-medium text-text-primary">{name}</span>
          {highlight && (
            <span className="shrink-0 rounded-full bg-brand-soft px-1.5 text-micro font-semibold text-brand">You</span>
          )}
        </div>
        {subtitle && <div className="mt-0.5 truncate text-caption text-text-muted">{subtitle}</div>}
      </div>
      <div className="shrink-0 text-right">
        <div className="num text-callout font-semibold text-text-primary">{steps === null ? '—' : formatSteps(steps)}</div>
        {movement !== undefined && <Movement value={movement} />}
      </div>
      {trailing}
    </>
  );
  const cls = `flex w-full min-h-[60px] items-center gap-3 px-4 py-2.5 text-left ${highlight ? 'bg-brand-soft/40' : ''}`;
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={`${cls} hover:bg-bg-input/60 active:!scale-100 active:bg-bg-input`}>
        {body}
      </button>
    );
  }
  return <div className={cls}>{body}</div>;
}

export function RankListSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="divide-y divide-border-light overflow-hidden rounded-card border border-border-light bg-bg-card" aria-busy="true" aria-label="Loading ranking">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 px-4 py-3">
          <div className="skeleton h-4 w-5 rounded" />
          <div className="skeleton h-10 w-10 rounded-full" />
          <div className="flex-1 space-y-2">
            <div className="skeleton h-4 w-28 rounded" />
            <div className="skeleton h-3 w-16 rounded" />
          </div>
          <div className="skeleton h-4 w-14 rounded" />
        </div>
      ))}
    </div>
  );
}
