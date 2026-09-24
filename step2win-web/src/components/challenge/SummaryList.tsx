import type { ReactNode } from 'react';

export interface SummaryItem {
  label: ReactNode;
  value: ReactNode;
  /** Visually emphasise the row (e.g. the amount being charged). */
  strong?: boolean;
  /** Tone of the value text. */
  tone?: 'default' | 'reward' | 'danger' | 'muted';
}

const toneClass = {
  default: 'text-text-primary',
  reward: 'text-reward-ink',
  danger: 'text-danger',
  muted: 'text-text-secondary',
} as const;

/** Label / value rows for confirmations and key facts. Renders a semantic <dl>. */
export function SummaryList({ items, className = '' }: { items: SummaryItem[]; className?: string }) {
  return (
    <dl className={`divide-y divide-border-light overflow-hidden rounded-card border border-border-light bg-bg-card ${className}`}>
      {items.map((item, index) => (
        <div key={index} className="flex min-h-[48px] items-center justify-between gap-4 px-4 py-2.5">
          <dt className="min-w-0 text-callout text-text-secondary">{item.label}</dt>
          <dd
            className={[
              'num min-w-0 text-right',
              item.strong ? 'text-headline' : 'text-callout font-semibold',
              toneClass[item.tone ?? 'default'],
            ].join(' ')}
          >
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** Numbered "what happens next" steps. */
export function NextSteps({ title = 'What happens next', steps, className = '' }: { title?: string; steps: ReactNode[]; className?: string }) {
  return (
    <section className={className}>
      <h3 className="eyebrow mb-2.5">{title}</h3>
      <ol className="space-y-3">
        {steps.map((step, index) => (
          <li key={index} className="flex gap-3">
            <span
              className="num inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-bg-input text-caption font-semibold text-text-secondary"
              aria-hidden
            >
              {index + 1}
            </span>
            <p className="min-w-0 pt-0.5 text-callout text-text-secondary">{step}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

export default SummaryList;
