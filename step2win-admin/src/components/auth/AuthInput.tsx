import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from 'react';

interface AuthInputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Visible label. Recommended; falls back to the placeholder as the accessible name. */
  label?: string;
  icon?: ReactNode;
  error?: string;
  hint?: string;
  /** Element inside the right edge of the field (e.g. a show/hide password button). */
  rightSlot?: ReactNode;
}

export const AuthInput = forwardRef<HTMLInputElement, AuthInputProps>(
  ({ label, icon, error, hint, rightSlot, id, className, ...props }, ref) => {
    const autoId = useId();
    const inputId = id ?? autoId;
    const describedBy = error ? `${inputId}-error` : hint ? `${inputId}-hint` : undefined;
    return (
      <div className="mb-4">
        {label && (
          <label htmlFor={inputId} className="mb-1.5 block text-xs font-medium text-ink-secondary">
            {label}
          </label>
        )}
        <div className="relative">
          {icon && (
            <span className="pointer-events-none absolute left-3 top-1/2 flex -translate-y-1/2 text-ink-muted" aria-hidden>
              {icon}
            </span>
          )}
          <input
            ref={ref}
            id={inputId}
            {...props}
            aria-label={label ? undefined : props['aria-label'] ?? props.placeholder}
            aria-invalid={error ? true : undefined}
            aria-describedby={describedBy}
            className={`h-10 w-full rounded-md border bg-surface-input text-sm text-ink-primary outline-none focus-visible:outline-none transition-colors placeholder:text-ink-muted focus:border-brand focus:ring-2 focus:ring-brand/20 ${
              error ? 'border-danger' : 'border-surface-strong'
            } ${icon ? 'pl-9' : 'pl-3'} ${rightSlot ? 'pr-16' : 'pr-3'} ${className ?? ''}`}
          />
          {rightSlot && <span className="absolute right-1 top-1/2 -translate-y-1/2">{rightSlot}</span>}
        </div>
        {error && (
          <p id={`${inputId}-error`} className="mt-1.5 text-xs text-danger">
            {error}
          </p>
        )}
        {hint && !error && (
          <p id={`${inputId}-hint`} className="mt-1.5 text-xs leading-relaxed text-ink-muted">
            {hint}
          </p>
        )}
      </div>
    );
  },
);

AuthInput.displayName = 'AuthInput';
