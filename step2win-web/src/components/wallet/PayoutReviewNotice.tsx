import { Clock } from 'lucide-react';
import { IconTile } from '../ui/Pill';
import { formatKES } from '../../lib/format';
import type { PayoutReview } from '../../types';

/**
 * Challenge payouts held for review. The money is not in the balance yet, so the
 * wallet says so plainly instead of leaving the user to wonder where it went.
 */
export function PayoutReviewNotice({ items }: { items: PayoutReview[] }) {
  if (items.length === 0) return null;
  return (
    <section aria-label="Payouts under review" className="space-y-2">
      {items.map((p) => (
        <div
          key={p.id}
          role="status"
          className="flex min-h-[56px] items-start gap-3 rounded-card border border-border-light bg-bg-card px-4 py-3 shadow-card"
        >
          <IconTile icon={Clock} tone="warning" size="sm" />
          <div className="min-w-0 flex-1">
            <p className="text-callout font-semibold text-text-primary">Payout under review</p>
            <p className="mt-0.5 text-caption text-text-secondary">
              Your <span className="num font-semibold text-text-primary">{formatKES(p.amount)}</span> payout is being
              reviewed. This usually takes up to {p.review_hours} hours.
            </p>
            {p.challenge_name && (
              <p className="mt-0.5 truncate text-caption text-text-muted">From {p.challenge_name}</p>
            )}
          </div>
        </div>
      ))}
    </section>
  );
}
