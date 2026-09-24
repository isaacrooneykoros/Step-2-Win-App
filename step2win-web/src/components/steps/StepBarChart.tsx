import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { formatCompact } from '../../lib/format';
import { usePrefersReducedMotion } from '../../lib/motion';

export interface StepBar {
  key: string;
  /** null = no record for this slot (drawn as a hairline stub, never as zero steps). */
  value: number | null;
  /** Text under the bar. Leave undefined to skip the label (caller controls density). */
  axisLabel?: string;
  /** Spoken / tooltip description, e.g. "Tue 22 Sep: 12,228 steps, goal met". */
  description: string;
  /** Emphasise this bar's axis label (e.g. today). */
  emphasis?: boolean;
}

interface StepBarChartProps {
  bars: StepBar[];
  /** Draws a dashed reference line; bars at/above it render in full brand colour. */
  goal?: number;
  /** Plot height in px (excludes axis labels). */
  height?: number;
  /** Accessible summary of the whole chart. */
  label: string;
  selectedKey?: string | null;
  onSelect?: (key: string) => void;
  /** Max bar width in px; bars shrink below this on dense charts. */
  maxBarWidth?: number;
  className?: string;
}

/**
 * Honest bar chart for step counts: linear scale from 0 to max(largest value, goal),
 * a dashed goal line with its value in a right gutter, and one brand hue
 * (full = goal met, soft = below goal). Supports tap/drag scrubbing and arrow keys.
 */
export function StepBarChart({
  bars,
  goal,
  height = 140,
  label,
  selectedKey,
  onSelect,
  maxBarWidth = 28,
  className = '',
}: StepBarChartProps) {
  const reduced = usePrefersReducedMotion();
  const plotRef = useRef<HTMLDivElement>(null);
  const [drawn, setDrawn] = useState(reduced);

  useEffect(() => {
    if (reduced) {
      setDrawn(true);
      return;
    }
    const id = requestAnimationFrame(() => setDrawn(true));
    return () => cancelAnimationFrame(id);
  }, [reduced]);

  const maxValue = Math.max(0, ...bars.map((b) => b.value ?? 0));
  const hasGoal = typeof goal === 'number' && goal > 0;
  const scaleMax = Math.max(maxValue, hasGoal ? goal : 0, 1);
  const goalPct = hasGoal ? (goal / scaleMax) * 100 : 0;
  const dense = bars.length > 14;
  const gapClass = bars.length > 45 ? 'gap-px' : dense ? 'gap-[2px]' : 'gap-1.5';
  const selectedIndex = bars.findIndex((b) => b.key === selectedKey);

  const selectAtClientX = (clientX: number) => {
    if (!onSelect || !plotRef.current || bars.length === 0) return;
    const rect = plotRef.current.getBoundingClientRect();
    const ratio = (clientX - rect.left) / rect.width;
    const index = Math.min(bars.length - 1, Math.max(0, Math.floor(ratio * bars.length)));
    if (bars[index].key !== selectedKey) onSelect(bars[index].key);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!onSelect) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    selectAtClientX(event.clientX);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!onSelect || event.buttons === 0) return;
    selectAtClientX(event.clientX);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!onSelect || bars.length === 0) return;
    let next = selectedIndex < 0 ? bars.length - 1 : selectedIndex;
    if (event.key === 'ArrowLeft') next -= 1;
    else if (event.key === 'ArrowRight') next += 1;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = bars.length - 1;
    else return;
    event.preventDefault();
    onSelect(bars[Math.min(bars.length - 1, Math.max(0, next))].key);
  };

  return (
    <figure className={`m-0 ${className}`} aria-label={label} role="group">
      <div className="flex">
        {/* Plot */}
        <div
          ref={plotRef}
          className={`relative min-w-0 flex-1 touch-pan-y select-none ${onSelect ? 'cursor-pointer rounded-md outline-none focus-visible:ring-2 focus-visible:ring-brand' : ''}`}
          style={{ height }}
          tabIndex={onSelect ? 0 : undefined}
          aria-label={onSelect ? `${label}. Use left and right arrow keys to inspect each bar.` : undefined}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onKeyDown={onKeyDown}
        >
          {/* Baseline */}
          <div className="absolute inset-x-0 bottom-0 border-b border-border" aria-hidden />
          {/* Goal line */}
          {hasGoal && (
            <div
              className="pointer-events-none absolute inset-x-0 z-10 border-t border-dashed border-text-muted/70"
              style={{ bottom: `${goalPct}%` }}
              aria-hidden
            />
          )}
          <div className={`absolute inset-0 flex items-end ${gapClass}`}>
            {bars.map((bar) => {
              const selected = bar.key === selectedKey;
              const met = hasGoal && bar.value !== null && bar.value >= goal;
              const pct = bar.value !== null ? (bar.value / scaleMax) * 100 : 0;
              const fill = bar.value === null ? 'bg-border' : met || !hasGoal ? 'bg-brand' : 'bg-brand/35';
              return (
                <div
                  key={bar.key}
                  className="relative flex h-full min-w-0 flex-1 items-end justify-center"
                  role="img"
                  aria-label={bar.description}
                  title={bar.description}
                >
                  {selected && (
                    <div
                      className="absolute inset-y-0 left-1/2 w-full -translate-x-1/2 rounded-t-md bg-bg-input"
                      style={{ maxWidth: dense ? undefined : maxBarWidth + 12 }}
                      aria-hidden
                    />
                  )}
                  <div
                    className={`relative w-full ${fill} ${dense ? 'rounded-t-[2px]' : 'rounded-t-[4px]'} transition-[height] duration-deliberate ease-standard`}
                    style={{
                      maxWidth: maxBarWidth,
                      height: bar.value === null ? 2 : drawn ? `max(${bar.value > 0 ? 2 : 0}px, ${pct}%)` : 0,
                    }}
                  />
                </div>
              );
            })}
          </div>
        </div>
        {/* Right gutter: goal value */}
        {hasGoal && (
          <div className="relative w-9 shrink-0" style={{ height }} aria-hidden>
            <span
              className="num absolute right-0 translate-y-1/2 text-micro font-semibold text-text-muted"
              style={{ bottom: `${goalPct}%` }}
            >
              {formatCompact(goal)}
            </span>
          </div>
        )}
      </div>

      {/* Axis labels: positioned at bar centres; edge labels anchor inward so they never clip. */}
      <div className={`relative mt-2 h-4 ${hasGoal ? 'mr-9' : ''}`} aria-hidden>
        {bars.map((bar, index) => {
          if (!bar.axisLabel) return null;
          const center = ((index + 0.5) / bars.length) * 100;
          const anchor = center < 8 ? 'left' : center > 92 ? 'right' : 'center';
          const style =
            anchor === 'left'
              ? { left: `${(index / bars.length) * 100}%` }
              : anchor === 'right'
                ? { right: `${((bars.length - index - 1) / bars.length) * 100}%` }
                : { left: `${center}%`, transform: 'translateX(-50%)' };
          const selected = bar.key === selectedKey;
          return (
            <span
              key={bar.key}
              className={`absolute top-0 whitespace-nowrap text-micro ${
                bar.emphasis || selected ? 'font-semibold text-text-primary' : 'text-text-muted'
              }`}
              style={style}
            >
              {bar.axisLabel}
            </span>
          );
        })}
      </div>
    </figure>
  );
}

export default StepBarChart;
