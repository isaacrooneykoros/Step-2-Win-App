import { useState } from 'react';
import { StepBarChart, type StepBar } from './StepBarChart';
import { formatHour } from './stepUtils';
import { formatSteps } from '../../lib/format';
import type { HourlyStep } from '../../types';

interface HourlyChartProps {
  hourly: HourlyStep[];
  peakHour: number | null;
  /** When set, hours after this one are drawn as "no data yet" rather than zero. */
  upToHour?: number;
  height?: number;
}

const AXIS_HOURS: Record<number, string> = { 0: '12a', 6: '6a', 12: '12p', 18: '6p' };

/** 24-hour distribution of steps. Tap or drag to read any hour. */
export function HourlyChart({ hourly, peakHour, upToHour, height = 120 }: HourlyChartProps) {
  const byHour = new Map(hourly.map((h) => [h.hour, h.steps]));
  const [selected, setSelected] = useState<number | null>(peakHour);

  const bars: StepBar[] = Array.from({ length: 24 }, (_, hour) => {
    const steps = byHour.get(hour) ?? 0;
    // Hours that haven't happened yet (and have no data) are "not yet", not zero.
    const future = typeof upToHour === 'number' && hour > upToHour && steps === 0;
    return {
      key: String(hour),
      value: future ? null : steps,
      axisLabel: AXIS_HOURS[hour],
      description: future ? `${formatHour(hour)}: not yet` : `${formatHour(hour)}: ${formatSteps(steps)} steps${hour === peakHour ? ', peak hour' : ''}`,
    };
  });

  const activeHours = hourly.filter((h) => h.steps > 0).length;
  const summary =
    peakHour !== null
      ? `Steps by hour. Most active at ${formatHour(peakHour)}; ${activeHours} active hours.`
      : 'Steps by hour. No hourly activity recorded.';
  const selectedSteps = selected !== null ? byHour.get(selected) ?? 0 : null;

  return (
    <div>
      <div className="mb-3 flex h-5 items-center justify-between gap-2 text-callout" aria-live="polite">
        {selected !== null ? (
          <>
            <span className="text-text-secondary">
              {formatHour(selected)}–{formatHour((selected + 1) % 24)}
              {selected === peakHour && <span className="ml-1.5 font-semibold text-brand">Peak</span>}
            </span>
            <span>
              <span className="num font-semibold text-text-primary">{formatSteps(selectedSteps)}</span>
              <span className="text-text-muted"> steps</span>
            </span>
          </>
        ) : (
          <span className="text-text-muted">Tap a bar to see that hour</span>
        )}
      </div>
      <StepBarChart
        bars={bars}
        height={height}
        label={summary}
        selectedKey={selected !== null ? String(selected) : null}
        onSelect={(key) => setSelected(Number(key))}
      />
    </div>
  );
}

export default HourlyChart;
