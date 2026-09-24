import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { toneClasses, type Tone } from './Pill';

interface StatTileProps {
  label: string;
  value: ReactNode;
  /** Secondary line below the value, e.g. "of 10,000" or "+12% vs last week". */
  hint?: ReactNode;
  icon?: LucideIcon;
  tone?: Tone;
  /** `plain` sits inside another surface; `card` is its own surface. */
  variant?: 'plain' | 'card';
  className?: string;
}

/** Compact metric: label, value, optional hint. Values use tabular figures. */
export function StatTile({ label, value, hint, icon: Icon, tone = 'neutral', variant = 'plain', className = '' }: StatTileProps) {
  const t = toneClasses[tone];
  return (
    <div
      className={[
        'min-w-0',
        variant === 'card' ? 'rounded-card border border-border-light bg-bg-card p-4 shadow-card' : '',
        className,
      ].join(' ')}
    >
      <div className="flex items-center gap-1.5 text-caption text-text-muted">
        {Icon && <Icon size={14} className={tone === 'neutral' ? 'text-text-muted' : t.text} aria-hidden />}
        <span className="truncate">{label}</span>
      </div>
      <div className="num mt-1 truncate text-headline text-text-primary">{value}</div>
      {hint && <div className="mt-0.5 truncate text-caption text-text-muted">{hint}</div>}
    </div>
  );
}

export default StatTile;
