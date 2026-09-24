import { Sheet } from './Sheet';
import Button from './Button';
import { formatKES } from '../../utils/currency';
import { formatSteps } from '../../lib/format';

export interface CelebrationData {
  challengeName: string;
  /** Amount credited to the wallet (KSh). 0 when the finisher qualified without a payout. */
  payout: number;
  position?: number | null;
  totalParticipants?: number;
  steps?: number;
  milestone?: number;
}

interface CelebrationModalProps {
  isOpen: boolean;
  onClose: () => void;
  data?: CelebrationData | null;
  /** Primary action. Falls back to closing the sheet. */
  onPrimary?: () => void;
  primaryLabel?: string;
}

/** Drawn check mark — uses the shared drawCheck keyframe, collapsed by reduced motion. */
function DrawnCheck({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" width="30" height="30" fill="none" className={className} aria-hidden>
      <path
        d="M5 12.5l4.5 4.5L19 7.5"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ strokeDasharray: 24, strokeDashoffset: 24, animation: 'drawCheck 480ms var(--ease-enter) 220ms forwards' }}
      />
    </svg>
  );
}

/**
 * A restrained success moment after a challenge completes. Only real numbers:
 * payout credited, final rank and final steps. One action.
 */
export function CelebrationModal({ isOpen, onClose, data, onPrimary, primaryLabel = 'View results' }: CelebrationModalProps) {
  if (!data) return null;
  const earned = data.payout > 0;

  const facts: Array<{ label: string; value: string }> = [];
  if (data.position) {
    facts.push({
      label: 'Final rank',
      value: data.totalParticipants ? `${data.position} of ${data.totalParticipants}` : `${data.position}`,
    });
  }
  if (typeof data.steps === 'number') {
    facts.push({ label: 'Steps', value: formatSteps(data.steps) });
  }
  if (typeof data.milestone === 'number') {
    facts.push({ label: 'Goal', value: formatSteps(data.milestone) });
  }

  return (
    <Sheet
      open={isOpen}
      onClose={onClose}
      size="sm"
      footer={
        <Button fullWidth size="lg" onClick={onPrimary ?? onClose}>
          {onPrimary ? primaryLabel : 'Done'}
        </Button>
      }
    >
      <div className="flex flex-col items-center pb-2 text-center">
        <span
          className={`scale-in inline-flex h-16 w-16 items-center justify-center rounded-2xl ${
            earned ? 'bg-reward-soft text-reward-ink' : 'bg-brand-soft text-brand'
          }`}
        >
          <DrawnCheck />
        </span>

        <p className="mt-4 text-caption text-text-muted">{data.challengeName}</p>
        <h2 className="mt-1 text-title text-text-primary">{earned ? 'You qualified and earned' : 'You reached the goal'}</h2>

        {earned ? (
          <>
            <p className="num mt-2 text-title-lg font-semibold text-reward-ink">{formatKES(data.payout)}</p>
            <p className="mt-1 text-callout text-text-secondary">Credited to your Step2Win wallet.</p>
          </>
        ) : (
          <p className="mt-2 max-w-[280px] text-callout text-text-secondary">
            You finished as a qualified participant. See the results for how the pool was shared.
          </p>
        )}

        {facts.length > 0 && (
          <dl
            style={{ gridTemplateColumns: `repeat(${facts.length}, minmax(0, 1fr))` }}
            className="mt-6 grid w-full divide-x divide-border-light rounded-card border border-border-light bg-bg-card py-3">
            {facts.map((fact) => (
              <div key={fact.label} className="min-w-0 px-2">
                <dt className="text-caption text-text-muted">{fact.label}</dt>
                <dd className="num mt-0.5 truncate text-headline text-text-primary">{fact.value}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </Sheet>
  );
}

export default CelebrationModal;
