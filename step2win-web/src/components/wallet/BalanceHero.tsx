import { ArrowDownLeft, ArrowUpRight, Clock, Lock } from 'lucide-react';
import Button from '../ui/Button';
import AnimatedNumber from '../ui/AnimatedNumber';
import { Skeleton } from '../ui/Skeleton';
import { formatKES } from '../../lib/format';

interface BalanceHeroProps {
  available: number;
  locked: number;
  total: number;
  /** Sum of withdrawals still in review / processing (already deducted). */
  pendingWithdrawals: number;
  pendingCount: number;
  onDeposit: () => void;
  onWithdraw: () => void;
  onShowWithdrawals: () => void;
}

/** The wallet's single visual anchor: what the user can use right now, and why the rest isn't. */
export function BalanceHero({
  available,
  locked,
  total,
  pendingWithdrawals,
  pendingCount,
  onDeposit,
  onWithdraw,
  onShowWithdrawals,
}: BalanceHeroProps) {
  return (
    <section aria-labelledby="balance-label" className="rounded-card border border-border-light bg-bg-card p-5 shadow-card">
      <p id="balance-label" className="eyebrow">
        Available balance
      </p>
      <AnimatedNumber
        value={available}
        format={formatKES}
        startFromValue
        className="mt-1 block text-display leading-none tracking-tight text-text-primary"
      />
      <p className="mt-2 text-caption text-text-muted">Ready to join challenges or withdraw to M-Pesa.</p>

      <dl className="mt-4 divide-y divide-border-light border-t border-border-light">
        <div className="flex items-start gap-3 py-3">
          <Lock size={16} className="mt-0.5 shrink-0 text-text-muted" aria-hidden />
          <div className="min-w-0 flex-1">
            <dt className="text-callout text-text-primary">Locked in challenges</dt>
            <dd className="text-caption text-text-muted">Entry contributions held until your challenges finish.</dd>
          </div>
          <dd className="num shrink-0 text-callout font-semibold text-text-primary">{formatKES(locked)}</dd>
        </div>
        {pendingWithdrawals > 0 && (
          <div className="flex items-start gap-3 py-3">
            <Clock size={16} className="mt-0.5 shrink-0 text-warning" aria-hidden />
            <div className="min-w-0 flex-1">
              <dt className="text-callout text-text-primary">
                Withdrawal{pendingCount === 1 ? '' : 's'} in progress
              </dt>
              <dd className="text-caption text-text-muted">
                Already deducted from your balance.{' '}
                <button type="button" onClick={onShowWithdrawals} className="font-semibold text-brand underline-offset-2 hover:underline">
                  Track
                </button>
              </dd>
            </div>
            <dd className="num shrink-0 text-callout font-semibold text-text-primary">{formatKES(pendingWithdrawals)}</dd>
          </div>
        )}
        <div className="flex items-start gap-3 pt-3">
          <span className="w-4 shrink-0" aria-hidden />
          <div className="min-w-0 flex-1">
            <dt className="text-callout text-text-secondary">Total balance</dt>
            <dd className="text-caption text-text-muted">Available + locked</dd>
          </div>
          <dd className="num shrink-0 text-callout font-semibold text-text-secondary">{formatKES(total)}</dd>
        </div>
      </dl>

      <div className="mt-5 grid grid-cols-2 gap-3">
        <Button size="lg" className="px-4" onClick={onDeposit} leftIcon={<ArrowDownLeft size={18} strokeWidth={2.25} className="shrink-0" aria-hidden />}>
          Deposit
        </Button>
        <Button size="lg" className="px-4" variant="outline" onClick={onWithdraw} leftIcon={<ArrowUpRight size={18} strokeWidth={2.25} className="shrink-0" aria-hidden />}>
          Withdraw
        </Button>
      </div>
    </section>
  );
}

export function BalanceHeroSkeleton() {
  return (
    <div className="rounded-card border border-border-light bg-bg-card p-5 shadow-card" aria-busy="true" aria-label="Loading balance">
      <Skeleton className="h-3 w-28 rounded" />
      <Skeleton className="mt-3 h-10 w-52 rounded-lg" />
      <Skeleton className="mt-3 h-3 w-56 rounded" />
      <div className="mt-5 space-y-4 border-t border-border-light pt-4">
        <Skeleton className="h-4 w-full rounded" />
        <Skeleton className="h-4 w-3/4 rounded" />
      </div>
      <div className="mt-5 grid grid-cols-2 gap-3">
        <Skeleton className="h-[52px] rounded-2xl" />
        <Skeleton className="h-[52px] rounded-2xl" />
      </div>
    </div>
  );
}
