import { useCountUp } from '../../lib/motion';

interface AnimatedNumberProps {
  value: number;
  /** Formatter for the displayed value. Defaults to a grouped integer. */
  format?: (value: number) => string;
  className?: string;
  /** Skip the initial count-up (e.g. when the value is already known from cache). */
  startFromValue?: boolean;
}

/**
 * Counts between real values when data changes. The final, exact value is exposed to
 * assistive tech so screen readers never announce intermediate frames.
 */
export function AnimatedNumber({
  value,
  format = (v) => Math.round(v).toLocaleString('en-KE'),
  className = '',
  startFromValue = false,
}: AnimatedNumberProps) {
  const shown = useCountUp(value, { startFromTarget: startFromValue });
  return (
    <span className={`num ${className}`}>
      <span aria-hidden>{format(shown)}</span>
      <span className="sr-only">{format(value)}</span>
    </span>
  );
}

export default AnimatedNumber;
