import ProgressBar from './ProgressBar';

interface XPBarProps {
  currentXP: number;
  xpToNext: number;
  level: number;
  xpThisWeek?: number;
  className?: string;
}

/** Level progress: level chip, XP bar and "x / y XP to level n". */
export function XPBar({ currentXP, xpToNext, level, xpThisWeek = 0, className = '' }: XPBarProps) {
  const safeNext = Math.max(1, xpToNext);
  const into = ((currentXP % safeNext) + safeNext) % safeNext;
  const pct = (into / safeNext) * 100;

  return (
    <div className={`rounded-card border border-border-light bg-bg-card p-4 shadow-card ${className}`}>
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="num inline-flex h-7 min-w-[28px] items-center justify-center rounded-lg bg-brand-soft px-1.5 text-caption font-semibold text-brand">
            {level}
          </span>
          <span className="text-callout text-text-secondary">Level {level}</span>
        </div>
        {xpThisWeek > 0 && <span className="num text-caption font-semibold text-brand">+{xpThisWeek} XP this week</span>}
      </div>
      <ProgressBar progress={pct} height="sm" color="brand" label={`Progress to level ${level + 1}`} />
      <p className="num mt-1.5 text-right text-caption text-text-muted">
        {into} / {safeNext} XP to level {level + 1}
      </p>
    </div>
  );
}

export default XPBar;
