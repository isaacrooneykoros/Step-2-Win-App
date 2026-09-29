import { CheckCircle2, Hourglass, Info, type LucideIcon } from 'lucide-react';
import type { ReasonSeverity } from '../../types';
import { formatSteps } from '../../lib/format';

const severityMeta: Record<ReasonSeverity, { icon: LucideIcon; className: string; label: string }> = {
  positive: { icon: CheckCircle2, className: 'text-success', label: 'Verified' },
  info: { icon: Info, className: 'text-info', label: 'Note' },
  review: { icon: Hourglass, className: 'text-warning', label: 'Being checked' },
};

export interface ReasonItem {
  code: string;
  severity: ReasonSeverity;
  user_message: string;
  steps_affected?: number | null;
}

/**
 * Server-written reasons, shown as-is (they are kind and never include thresholds), with an
 * icon per severity: positive = the verified parts, info = a neutral note, review = being checked.
 */
export function ReasonList({ reasons, className = '' }: { reasons: ReasonItem[]; className?: string }) {
  if (reasons.length === 0) return null;
  // Verified parts first, then notes, then anything being checked.
  const order: Record<ReasonSeverity, number> = { positive: 0, info: 1, review: 2 };
  const sorted = [...reasons].sort((a, b) => (order[a.severity] ?? 1) - (order[b.severity] ?? 1));
  return (
    <ul className={`space-y-3 ${className}`}>
      {sorted.map((reason, index) => {
        const meta = severityMeta[reason.severity] ?? severityMeta.info;
        const Icon = meta.icon;
        return (
          <li key={`${reason.code}-${index}`} className="flex gap-3">
            <Icon size={18} className={`mt-0.5 shrink-0 ${meta.className}`} aria-label={meta.label} />
            <div className="min-w-0 flex-1">
              <p className="text-callout text-text-secondary">{reason.user_message}</p>
              {reason.steps_affected != null && reason.steps_affected > 0 && (
                <p className="num mt-0.5 text-caption text-text-muted">{formatSteps(reason.steps_affected)} steps</p>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export default ReasonList;
