import { useId, type ReactNode } from 'react';

/** Visual track + thumb. Purely presentational — the interactive element owns the role. */
function SwitchTrack({ checked, disabled = false }: { checked: boolean; disabled?: boolean }) {
  return (
    <span
      aria-hidden
      className={[
        'relative inline-flex h-[30px] w-[50px] shrink-0 items-center rounded-full',
        'transition-colors duration-fast ease-standard',
        checked ? 'bg-brand' : 'bg-border',
        disabled ? 'opacity-50' : '',
      ].join(' ')}
    >
      <span
        className={[
          'absolute left-[3px] h-6 w-6 rounded-full bg-bg-card shadow-card',
          'transition-transform duration-normal ease-standard',
          checked ? 'translate-x-5' : 'translate-x-0',
        ].join(' ')}
      />
    </span>
  );
}

interface SwitchProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** Accessible name when no visible label is associated. */
  label?: string;
  labelledBy?: string;
  describedBy?: string;
  disabled?: boolean;
  className?: string;
}

/**
 * Standalone accessible switch (role="switch", 44px hit area).
 * Space / Enter toggle via native button semantics.
 */
export function Switch({ checked, onChange, label, labelledBy, describedBy, disabled = false, className = '' }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={labelledBy ? undefined : label}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`inline-flex h-11 min-w-[44px] items-center justify-center rounded-full active:!scale-100 ${className}`}
    >
      <SwitchTrack checked={checked} disabled={disabled} />
    </button>
  );
}

interface ToggleRowProps {
  leading?: ReactNode;
  title: string;
  subtitle?: ReactNode;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}

/**
 * Settings list row where the entire row is the switch — a large, native-feeling target.
 * Title is the accessible name; subtitle is the description.
 */
export function ToggleRow({ leading, title, subtitle, checked, onChange, disabled = false }: ToggleRowProps) {
  const titleId = useId();
  const descId = useId();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={titleId}
      aria-describedby={subtitle ? descId : undefined}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="flex min-h-[56px] w-full items-center gap-3 px-4 py-3 text-left hover:bg-bg-input/60 active:!scale-100 active:bg-bg-input disabled:opacity-50"
    >
      {leading}
      <span className="min-w-0 flex-1">
        <span id={titleId} className="block text-body font-medium text-text-primary">
          {title}
        </span>
        {subtitle && (
          <span id={descId} className="mt-0.5 block text-caption text-text-muted">
            {subtitle}
          </span>
        )}
      </span>
      <SwitchTrack checked={checked} disabled={disabled} />
    </button>
  );
}

export default Switch;
