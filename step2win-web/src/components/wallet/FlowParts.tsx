import { useId, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { toneClasses, type Tone } from '../ui/Pill';

/** "Step 2 of 3 · Phone number" with a segmented progress track. */
export function StepIndicator({ step, total, label }: { step: number; total: number; label: string }) {
  return (
    <div className="mb-5">
      <div className="flex gap-1.5" aria-hidden>
        {Array.from({ length: total }).map((_, i) => (
          <span
            key={i}
            className={`h-1 flex-1 rounded-full transition-colors duration-normal ease-standard ${i < step ? 'bg-brand' : 'bg-bg-input'}`}
          />
        ))}
      </div>
      <p className="mt-2 text-caption text-text-muted" aria-live="polite">
        Step {step} of {total} · <span className="font-semibold text-text-secondary">{label}</span>
      </p>
    </div>
  );
}

interface AmountFieldProps {
  value: string;
  onChange: (value: string) => void;
  quickAmounts: number[];
  error?: string;
  helper?: ReactNode;
  label?: string;
  /** Disable quick amounts above this. */
  quickMax?: number;
}

/** Large KSh amount input with quick-pick chips. */
export function AmountField({ value, onChange, quickAmounts, error, helper, label = 'Amount', quickMax }: AmountFieldProps) {
  const id = useId();
  const msgId = `${id}-msg`;
  return (
    <div>
      <label htmlFor={id} className="label">
        {label}
      </label>
      <div
        className={[
          'flex items-center gap-2 rounded-control border bg-bg-card px-4 transition-[border-color,box-shadow] duration-fast',
          'focus-within:border-brand focus-within:shadow-[0_0_0_3px_hsl(var(--brand)/0.15)]',
          error ? 'border-danger' : 'border-border',
        ].join(' ')}
      >
        <span className="text-headline text-text-muted" aria-hidden>
          KSh
        </span>
        <input
          id={id}
          data-autofocus
          type="text"
          inputMode="decimal"
          autoComplete="off"
          enterKeyHint="next"
          placeholder="0"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={msgId}
          className="num h-16 min-w-0 flex-1 bg-transparent text-title-lg text-text-primary outline-none placeholder:text-text-muted"
        />
      </div>
      <div id={msgId} className="mt-1.5 min-h-[18px]">
        {error ? (
          <p className="text-caption font-medium text-danger" role="alert">
            {error}
          </p>
        ) : (
          helper && <p className="text-caption text-text-muted">{helper}</p>
        )}
      </div>
      <div className="mt-3 grid grid-cols-4 gap-2" role="group" aria-label="Quick amounts">
        {quickAmounts.map((amt) => {
          const selected = value === String(amt);
          const disabled = quickMax !== undefined && amt > quickMax;
          return (
            <button
              key={amt}
              type="button"
              disabled={disabled}
              aria-pressed={selected}
              onClick={() => onChange(String(amt))}
              className={[
                'num h-11 rounded-xl text-callout font-semibold transition-colors duration-fast',
                selected
                  ? 'bg-brand-soft text-brand ring-1 ring-inset ring-brand'
                  : 'bg-bg-input text-text-secondary hover:text-text-primary',
                'disabled:opacity-40',
              ].join(' ')}
            >
              {amt.toLocaleString('en-KE')}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Label/value rows for a confirmation summary. */
export function SummaryList({ rows }: { rows: Array<{ label: string; value: ReactNode; strong?: boolean }> }) {
  return (
    <dl className="divide-y divide-border-light rounded-card border border-border-light bg-bg-card">
      {rows.map((row) => (
        <div key={row.label} className="flex items-center justify-between gap-4 px-4 py-3">
          <dt className="text-callout text-text-secondary">{row.label}</dt>
          <dd className={`num select-text text-right ${row.strong ? 'text-headline text-text-primary' : 'text-body font-medium text-text-primary'}`}>
            {row.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}


/** Centred outcome panel (waiting / success / failure / pending). */
export function StatusPanel({
  icon: Icon,
  tone,
  title,
  children,
  live,
}: {
  icon: LucideIcon;
  tone: Tone;
  title: string;
  children?: ReactNode;
  /** Announce politely (status changes) vs assertively (failures). */
  live?: 'polite' | 'assertive';
}) {
  const t = toneClasses[tone];
  return (
    <div className="scale-in flex flex-col items-center py-4 text-center" role={live === 'assertive' ? 'alert' : 'status'} aria-live={live ?? 'polite'}>
      <span className={`mb-4 inline-flex h-16 w-16 items-center justify-center rounded-full ${t.soft} ${tone === 'neutral' ? 'text-text-secondary' : t.text}`} aria-hidden>
        <Icon size={30} strokeWidth={2} />
      </span>
      <h3 className="text-title text-text-primary">{title}</h3>
      {children && <div className="mt-2 max-w-[320px] text-callout text-text-secondary">{children}</div>}
    </div>
  );
}

/** Quiet explanatory note with a leading icon. */
export function Note({ icon: Icon, children, tone = 'neutral' }: { icon: LucideIcon; children: ReactNode; tone?: Tone }) {
  const t = toneClasses[tone];
  return (
    <div className={`flex gap-3 rounded-control px-4 py-3 ${tone === 'neutral' ? 'bg-bg-sunken' : t.soft}`}>
      <Icon size={18} className={`mt-0.5 shrink-0 ${tone === 'neutral' ? 'text-text-muted' : t.text}`} aria-hidden />
      <div className="text-callout text-text-secondary">{children}</div>
    </div>
  );
}
