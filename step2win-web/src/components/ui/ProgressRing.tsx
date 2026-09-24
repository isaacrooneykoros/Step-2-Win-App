import { useEffect, useId, useState, type ReactNode } from 'react';
import { duration, easing, usePrefersReducedMotion } from '../../lib/motion';

interface ProgressRingProps {
  /** Current value, e.g. steps today. */
  value: number;
  /** Target, e.g. daily goal. */
  goal: number;
  size?: number;
  strokeWidth?: number;
  /** Shown while data is loading: a quiet track with no fill. */
  loading?: boolean;
  /** Centre content. */
  children?: ReactNode;
  /** Accessible description, e.g. "7,412 of 10,000 steps". */
  label: string;
  className?: string;
  /** Portion of the circle drawn (1 = full ring, 0.75 = open-bottom gauge). */
  sweep?: number;
}

/**
 * Real-data progress ring. The arc animates from its previous value to the new one;
 * once the goal is met, the ring completes in brand color and any surplus is drawn
 * as a second, thinner amber lap so "exceeded" is visible without an extra copy.
 */
export function ProgressRing({
  value,
  goal,
  size = 200,
  strokeWidth = 14,
  loading = false,
  children,
  label,
  className = '',
  sweep = 0.78,
}: ProgressRingProps) {
  const reduced = usePrefersReducedMotion();
  const gradientId = useId();
  const safeGoal = goal > 0 ? goal : 1;
  const ratio = Math.max(0, value / safeGoal);
  const main = Math.min(1, ratio);
  const surplus = Math.min(1, Math.max(0, ratio - 1));

  // Start empty on first paint so the arc draws in once, then follows data changes.
  const [shown, setShown] = useState({ main: 0, surplus: 0 });
  useEffect(() => {
    if (loading) return;
    const id = requestAnimationFrame(() => setShown({ main, surplus }));
    return () => cancelAnimationFrame(id);
  }, [main, surplus, loading]);

  const r = (size - strokeWidth) / 2;
  const c = 2 * Math.PI * r;
  const arc = c * sweep;
  const rotation = 90 + (360 * (1 - sweep)) / 2;
  const transition = reduced ? 'none' : `stroke-dashoffset ${duration.data}ms ${easing.standard}`;
  const surplusWidth = Math.max(4, strokeWidth * 0.42);

  return (
    <div
      className={`relative inline-flex items-center justify-center ${className}`}
      style={{ width: size, height: size }}
      role="img"
      aria-label={loading ? 'Loading progress' : label}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ transform: `rotate(${rotation}deg)` }} aria-hidden>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="hsl(var(--brand))" stopOpacity="0.8" />
            <stop offset="100%" stopColor="hsl(var(--brand))" />
          </linearGradient>
        </defs>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="hsl(var(--bg-input))"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={`${arc} ${c}`}
          style={loading && !reduced ? { animation: 'pulseDot 1.6s ease-in-out infinite' } : undefined}
        />
        {!loading && (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={`url(#${gradientId})`}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeDasharray={`${arc} ${c}`}
            strokeDashoffset={arc * (1 - shown.main)}
            style={{ transition, opacity: shown.main > 0 ? 1 : 0 }}
          />
        )}
        {!loading && surplus > 0 && (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke="hsl(var(--reward))"
            strokeWidth={surplusWidth}
            strokeLinecap="round"
            strokeDasharray={`${arc} ${c}`}
            strokeDashoffset={arc * (1 - shown.surplus)}
            style={{ transition, transitionDelay: reduced ? '0ms' : `${duration.data * 0.6}ms` }}
          />
        )}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center">{children}</div>
    </div>
  );
}

export default ProgressRing;
