import { useNavigate } from 'react-router-dom';
import { ArrowRight, BadgeCheck, CircleSlash, RotateCcw, Trophy } from 'lucide-react';
import { Sheet } from '../ui/Sheet';
import Button from '../ui/Button';
import { Pill, type Tone } from '../ui/Pill';
import { Avatar } from '../ui/Avatar';
import { formatKESShort, formatShortDate, formatSteps } from '../../lib/format';
import { useAuthStore } from '../../store/authStore';
import type { MyRecentResults } from '../../types';

interface ResultsSheetProps {
  open: boolean;
  onClose: () => void;
  results: MyRecentResults;
}

export function resultOutcome(result: NonNullable<MyRecentResults['my_result']>): {
  label: string;
  tone: Tone;
  icon: typeof Trophy;
} {
  if (result.payout_method === 'refund') return { label: 'Refunded', tone: 'info', icon: RotateCcw };
  if (Number(result.payout_kes) > 0) return { label: 'Paid out', tone: 'reward', icon: Trophy };
  if (result.qualified) return { label: 'Qualified', tone: 'success', icon: BadgeCheck };
  return { label: 'Did not qualify', tone: 'neutral', icon: CircleSlash };
}

/** Latest finished challenge: your outcome, the summary and the top of the final leaderboard. */
export function ResultsSheet({ open, onClose, results }: ResultsSheetProps) {
  const navigate = useNavigate();
  const me = useAuthStore((s) => s.user?.username);
  const { challenge, my_result: mine, summary, leaderboard = [] } = results;
  const outcome = mine ? resultOutcome(mine) : null;
  const paid = mine ? Number(mine.payout_kes) : 0;

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Latest result"
      description={challenge ? `${challenge.name} · ended ${formatShortDate(challenge.end_date)}` : undefined}
      footer={
        challenge ? (
          <Button
            fullWidth
            variant="secondary"
            rightIcon={<ArrowRight size={18} aria-hidden />}
            onClick={() => {
              onClose();
              navigate(`/challenges/${challenge.id}/results`);
            }}
          >
            View full results
          </Button>
        ) : undefined
      }
    >
      {mine && outcome && (
        <div className="rounded-card bg-bg-sunken p-4">
          <Pill tone={outcome.tone} icon={outcome.icon}>
            {outcome.label}
          </Pill>
          <p className={`num mt-3 text-title-lg ${paid > 0 ? 'text-reward-ink' : 'text-text-primary'}`}>
            {formatKESShort(mine.payout_kes)}
          </p>
          <p className="mt-1 text-callout text-text-secondary">
            <span className="num">{formatSteps(mine.final_steps)}</span> steps
            {mine.final_rank ? (
              <>
                {' · '}finished <span className="num font-semibold text-text-primary">#{mine.final_rank}</span>
              </>
            ) : null}
          </p>
          {mine.tied_with_count > 0 && (
            <p className="mt-3 border-t border-border-light pt-3 text-caption text-text-secondary">
              {mine.payout_method === 'dead_heat'
                ? `Tied with ${mine.tied_with_count} other${mine.tied_with_count === 1 ? '' : 's'} — the prize was split equally.`
                : `Tie broken by ${mine.tiebreaker_label || 'the challenge tiebreaker'}.`}
            </p>
          )}
        </div>
      )}

      {summary && (
        <dl className="mt-4 grid grid-cols-3 divide-x divide-border-light rounded-card border border-border-light">
          {[
            { label: 'Players', value: formatSteps(summary.total_participants) },
            { label: 'Qualified', value: formatSteps(summary.qualified_count) },
            { label: 'Net pool', value: challenge ? formatKESShort(challenge.net_pool) : '—' },
          ].map((s) => (
            <div key={s.label} className="min-w-0 px-2 py-3 text-center">
              <dt className="text-caption text-text-muted">{s.label}</dt>
              <dd className="num mt-0.5 truncate text-headline text-text-primary">{s.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {leaderboard.length > 0 && (
        <section className="mt-5">
          <h3 className="eyebrow mb-2 px-1">Final standings</h3>
          <ol className="divide-y divide-border-light overflow-hidden rounded-card border border-border-light">
            {leaderboard.slice(0, 5).map((row, i) => {
              const won = Number(row.payout_kes) > 0;
              const isMe = row.username === me;
              return (
                <li key={`${row.username}-${i}`} className={`flex items-center gap-3 px-4 py-3 ${isMe ? 'bg-brand-soft/60' : ''}`}>
                  <span
                    className={`num w-6 shrink-0 text-center text-callout font-semibold ${
                      row.final_rank === 1 ? 'text-reward-ink' : 'text-text-muted'
                    }`}
                  >
                    {row.final_rank ?? '–'}
                  </span>
                  <Avatar name={row.username} size="sm" highlight={isMe} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-callout font-semibold text-text-primary">
                      {row.username}
                      {isMe && <span className="font-normal text-text-muted"> (you)</span>}
                    </p>
                    <p className="num text-caption text-text-muted">
                      {formatSteps(row.final_steps)} steps{row.tied_with_count > 0 ? ' · tied' : ''}
                    </p>
                  </div>
                  <span className={`num shrink-0 text-callout font-semibold ${won ? 'text-reward-ink' : 'text-text-muted'}`}>
                    {row.payout_method === 'refund' ? 'Refund' : won ? formatKESShort(row.payout_kes) : '—'}
                  </span>
                </li>
              );
            })}
          </ol>
        </section>
      )}
    </Sheet>
  );
}

export default ResultsSheet;
