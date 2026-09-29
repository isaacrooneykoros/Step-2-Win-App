import { useId, type ReactNode } from 'react';
import { Check } from 'lucide-react';

/**
 * An explicit consent box: never pre-ticked by the caller, the whole row is the target
 * (≥ 44px), the label can hold links (buttons that open the document), and an error
 * line appears under it when the form was submitted without it.
 */
export function ConsentCheckbox({
  checked,
  onChange,
  children,
  description,
  error,
  disabled = false,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  children: ReactNode;
  description?: ReactNode;
  error?: string;
  disabled?: boolean;
}) {
  const id = useId();
  const descId = useId();
  const errId = useId();
  return (
    <div className="py-1">
      <div className="flex min-h-touch items-start gap-3">
        <span className="relative mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center">
          <input
            id={id}
            type="checkbox"
            checked={checked}
            disabled={disabled}
            onChange={(e) => onChange(e.target.checked)}
            aria-describedby={[description ? descId : '', error ? errId : ''].filter(Boolean).join(' ') || undefined}
            aria-invalid={error ? true : undefined}
            className={[
              'peer h-6 w-6 cursor-pointer appearance-none rounded-[7px] border-2 transition-colors duration-fast ease-standard',
              'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand',
              checked ? 'border-brand bg-brand' : error ? 'border-danger bg-bg-card' : 'border-border bg-bg-card',
              disabled ? 'opacity-50' : '',
            ].join(' ')}
          />
          <Check
            size={16}
            strokeWidth={3}
            aria-hidden
            className={`pointer-events-none absolute text-brand-fg transition-opacity duration-fast ${checked ? 'opacity-100' : 'opacity-0'}`}
          />
        </span>
        <div className="min-w-0 flex-1">
          <label htmlFor={id} className="block cursor-pointer text-callout text-text-primary">
            {children}
          </label>
          {description && (
            <p id={descId} className="mt-0.5 text-caption text-text-muted">
              {description}
            </p>
          )}
          {error && (
            <p id={errId} className="mt-1 text-caption font-medium text-danger" role="alert">
              {error}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/** Inline link inside a consent label that opens a document without toggling the box. */
export function ConsentLink({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick();
      }}
      className="font-semibold text-brand underline underline-offset-2 hover:text-brand-hover"
    >
      {children}
    </button>
  );
}
