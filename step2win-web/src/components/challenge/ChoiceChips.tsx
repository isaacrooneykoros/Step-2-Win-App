import { useRef, type KeyboardEvent, type ReactNode } from 'react';

export interface ChoiceChipOption<T extends string> {
  value: T;
  label: ReactNode;
  count?: number;
}

interface ChoiceChipsProps<T extends string> {
  options: ChoiceChipOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Accessible name for the group. */
  label: string;
  /** `scroll` keeps chips on one line (filter bars); `wrap` lets them wrap (form fields). */
  layout?: 'scroll' | 'wrap' | 'grid';
  className?: string;
}

/**
 * Single-select chip group (radiogroup semantics, arrow-key navigation).
 * Each chip has a 44px hit area while the visible pill stays compact.
 */
export function ChoiceChips<T extends string>({ options, value, onChange, label, layout = 'scroll', className = '' }: ChoiceChipsProps<T>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const activeIndex = Math.max(0, options.findIndex((o) => o.value === value));

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const forward = event.key === 'ArrowRight' || event.key === 'ArrowDown';
    const back = event.key === 'ArrowLeft' || event.key === 'ArrowUp';
    if (!forward && !back) return;
    event.preventDefault();
    const next = (activeIndex + (forward ? 1 : -1) + options.length) % options.length;
    onChange(options[next].value);
    refs.current[next]?.focus();
  };

  const layoutClass =
    layout === 'scroll'
      ? '-mx-5 flex gap-2 overflow-x-auto px-5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden'
      : layout === 'grid'
        ? 'grid gap-2'
        : 'flex flex-wrap gap-2';

  return (
    <div
      role="radiogroup"
      aria-label={label}
      onKeyDown={onKeyDown}
      className={`${layoutClass} ${className}`}
      style={layout === 'grid' ? { gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` } : undefined}
    >
      {options.map((option, index) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            ref={(el) => (refs.current[index] = el)}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(option.value)}
            className="group inline-flex min-h-[44px] shrink-0 items-center active:!scale-100"
          >
            <span
              className={[
                'inline-flex h-9 w-full items-center justify-center gap-1.5 whitespace-nowrap rounded-full border px-3.5 text-callout font-semibold transition-colors duration-fast',
                active
                  ? 'border-transparent bg-text-primary text-text-inverse'
                  : 'border-border bg-bg-card text-text-secondary group-hover:bg-bg-input',
              ].join(' ')}
            >
              {option.label}
              {typeof option.count === 'number' && option.count > 0 && (
                <span
                  className={`num rounded-full px-1.5 text-micro ${active ? 'bg-bg-card/20 text-text-inverse' : 'bg-bg-input text-text-muted'}`}
                >
                  {option.count}
                </span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export default ChoiceChips;
