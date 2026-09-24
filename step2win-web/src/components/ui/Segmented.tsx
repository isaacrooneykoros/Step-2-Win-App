import { useRef, type KeyboardEvent, type ReactNode } from 'react';

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  /** Optional count badge */
  count?: number;
}

interface SegmentedProps<T extends string> {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Accessible name for the group */
  label: string;
  size?: 'sm' | 'md';
  className?: string;
}

/**
 * Segmented control (tabs within a screen). Arrow keys move between options.
 */
export function Segmented<T extends string>({ options, value, onChange, label, size = 'md', className = '' }: SegmentedProps<T>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const activeIndex = Math.max(0, options.findIndex((o) => o.value === value));

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    event.preventDefault();
    const delta = event.key === 'ArrowRight' ? 1 : -1;
    const next = (activeIndex + delta + options.length) % options.length;
    onChange(options[next].value);
    refs.current[next]?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label={label}
      onKeyDown={onKeyDown}
      className={`relative grid rounded-control bg-bg-input p-1 ${className}`}
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
    >
      <span
        aria-hidden
        className="absolute bottom-1 top-1 rounded-[11px] bg-bg-card shadow-card transition-transform duration-normal ease-standard"
        style={{
          left: 4,
          width: `calc((100% - 8px) / ${options.length})`,
          transform: `translateX(${activeIndex * 100}%)`,
        }}
      />
      {options.map((option, index) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            ref={(el) => (refs.current[index] = el)}
            type="button"
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(option.value)}
            className={[
              'relative z-10 inline-flex items-center justify-center gap-1.5 rounded-[11px] font-semibold active:!scale-100',
              size === 'sm' ? 'h-8 text-caption' : 'h-9 text-callout',
              active ? 'text-text-primary' : 'text-text-muted hover:text-text-secondary',
            ].join(' ')}
          >
            <span className="truncate">{option.label}</span>
            {typeof option.count === 'number' && option.count > 0 && (
              <span className={`num rounded-full px-1.5 text-micro ${active ? 'bg-brand-soft text-brand' : 'bg-bg-card/70 text-text-muted'}`}>{option.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export default Segmented;
