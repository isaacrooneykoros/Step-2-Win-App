import { Flame, MapPin, Timer, type LucideIcon } from 'lucide-react';

interface Props {
  distance?: number | null;
  calories?: number | null;
  activeMins?: number | null;
  /** Also hide metrics that are exactly 0 (e.g. days synced without distance data). */
  hideZero?: boolean;
  className?: string;
}

interface Metric {
  key: string;
  icon: LucideIcon;
  value: string;
  unit: string;
  label: string;
}

const isShown = (value: number | null | undefined, hideZero: boolean): value is number =>
  typeof value === 'number' && Number.isFinite(value) && (!hideZero || value > 0);

/**
 * Secondary activity metrics under a step count. Only metrics the API actually
 * returned are rendered — a missing value is never shown as a dash or a zero.
 */
export function StepStatChips({ distance, calories, activeMins, hideZero = false, className = '' }: Props) {
  const metrics: Metric[] = [];
  if (isShown(distance, hideZero)) {
    metrics.push({ key: 'distance', icon: MapPin, value: distance.toFixed(1), unit: 'km', label: 'Distance' });
  }
  if (isShown(activeMins, hideZero)) {
    metrics.push({ key: 'active', icon: Timer, value: Math.round(activeMins).toLocaleString('en-KE'), unit: 'min', label: 'Active' });
  }
  if (isShown(calories, hideZero)) {
    metrics.push({ key: 'calories', icon: Flame, value: Math.round(calories).toLocaleString('en-KE'), unit: 'kcal', label: 'Calories' });
  }

  if (metrics.length === 0) return null;

  return (
    <dl
      className={`grid divide-x divide-border-light ${className}`}
      style={{ gridTemplateColumns: `repeat(${metrics.length}, minmax(0, 1fr))` }}
    >
      {metrics.map(({ key, icon: Icon, value, unit, label }) => (
        <div key={key} className="flex min-w-0 flex-col items-center px-2 text-center">
          <dt className="flex items-center gap-1 text-caption text-text-muted">
            <Icon size={13} aria-hidden />
            {label}
          </dt>
          <dd className="num mt-0.5 truncate text-headline text-text-primary">
            {value}
            <span className="ml-0.5 text-caption font-medium text-text-muted">{unit}</span>
          </dd>
        </div>
      ))}
    </dl>
  );
}

export default StepStatChips;
