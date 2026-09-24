import { ProgressRing } from './ProgressRing';

type BarTone = 'brand' | 'reward' | 'success' | 'warning' | 'danger' | 'info' | 'primary' | 'error';

interface ProgressBarProps {
  /** 0–100 */
  progress: number;
  showLabel?: boolean;
  height?: 'xs' | 'sm' | 'md' | 'lg';
  color?: BarTone;
  className?: string;
  /** Accessible name, e.g. "Challenge progress" */
  label?: string;
}

const toneFill: Record<BarTone, string> = {
  brand: 'bg-brand',
  primary: 'bg-brand',
  reward: 'bg-reward',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  error: 'bg-danger',
  info: 'bg-info',
};

const heights = { xs: 'h-1', sm: 'h-1.5', md: 'h-2', lg: 'h-3' };

export default function ProgressBar({
  progress,
  showLabel = false,
  height = 'md',
  color = 'brand',
  className = '',
  label = 'Progress',
}: ProgressBarProps) {
  const clamped = Math.max(0, Math.min(100, Number.isFinite(progress) ? progress : 0));

  return (
    <div className={className}>
      <div
        className={`w-full overflow-hidden rounded-full bg-bg-input ${heights[height]}`}
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(clamped)}
      >
        <div
          className={`h-full rounded-full ${toneFill[color]} transition-[width] duration-deliberate ease-standard`}
          style={{ width: `${clamped}%` }}
        />
      </div>
      {showLabel && <p className="num mt-1 text-right text-caption text-text-muted">{Math.round(clamped)}%</p>}
    </div>
  );
}

export { ProgressBar };

interface CircularProgressProps {
  progress: number;
  size?: number;
  strokeWidth?: number;
  showLabel?: boolean;
  label?: string;
}

/** Legacy API kept for compatibility — renders the shared ProgressRing. */
export function CircularProgress({ progress, size = 120, strokeWidth = 8, showLabel = true, label }: CircularProgressProps) {
  const clamped = Math.max(0, Math.min(100, progress));
  return (
    <ProgressRing value={clamped} goal={100} size={size} strokeWidth={strokeWidth} sweep={1} label={`${Math.round(clamped)}%${label ? ` ${label}` : ''}`}>
      {showLabel && (
        <>
          <span className="num text-title text-text-primary">{Math.round(clamped)}%</span>
          {label && <span className="text-caption text-text-muted">{label}</span>}
        </>
      )}
    </ProgressRing>
  );
}
