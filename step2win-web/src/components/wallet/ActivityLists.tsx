import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertCircle, ArrowDownLeft, ArrowUpRight, ShieldCheck, Wallet } from 'lucide-react';
import { ListGroup, ListRow } from '../ui/ListRow';
import { IconTile, Pill } from '../ui/Pill';
import { Sheet } from '../ui/Sheet';
import Button from '../ui/Button';
import { Skeleton } from '../ui/Skeleton';
import { EmptyState } from '../ui/EmptyState';
import { ErrorInline } from '../ui/ErrorState';
import { useToast } from '../ui/Toast';
import { formatDateTime, formatKES } from '../../lib/format';
import { paymentsService } from '../../services/api';
import type { Transaction } from '../../types';
import { Note, SummaryList } from './FlowParts';
import {
  IN_FLIGHT_WITHDRAWAL,
  formatDestination,
  groupByDay,
  timeOfDay,
  toAmount,
  txConfig,
  withdrawalStatusInfo,
  type WithdrawalItem,
} from './walletModel';

// ── Shared ────────────────────────────────────────────────────────────────────

export function ActivitySkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div aria-busy="true" aria-label="Loading activity">
      <Skeleton className="mb-2 ml-1 h-3 w-16 rounded" />
      <div className="divide-y divide-border-light overflow-hidden rounded-card border border-border-light bg-bg-card">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 px-4 py-3">
            <Skeleton className="h-10 w-10 shrink-0 rounded-xl" />
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-3.5 w-2/3 rounded" />
              <Skeleton className="h-3 w-1/3 rounded" />
            </div>
            <Skeleton className="h-4 w-16 rounded" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Credits in success tone with "+", debits neutral with a true minus sign. */
function SignedAmount({ amount, className = '' }: { amount: number; className?: string }) {
  const credit = amount > 0;
  const text = `${credit ? '+' : amount < 0 ? '−' : ''}${formatKES(Math.abs(amount))}`;
  return (
    <span className={`num font-semibold ${credit ? 'text-success' : 'text-text-primary'} ${className}`}>
      <span aria-hidden>{text}</span>
      <span className="sr-only">{credit ? `Received ${formatKES(amount)}` : `Paid ${formatKES(Math.abs(amount))}`}</span>
    </span>
  );
}

// ── Transactions ──────────────────────────────────────────────────────────────

interface TransactionListProps {
  transactions: Transaction[];
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  onDeposit: () => void;
}

export function TransactionList({ transactions, isLoading, isError, onRetry, onDeposit }: TransactionListProps) {
  const [selected, setSelected] = useState<Transaction | null>(null);

  if (isLoading) return <ActivitySkeleton />;
  if (isError && transactions.length === 0) {
    return <ErrorInline message="We couldn't load your transactions." onRetry={onRetry} />;
  }
  if (transactions.length === 0) {
    return (
      <EmptyState
        icon={Wallet}
        title="No transactions yet"
        description="Deposits, challenge entries, payouts and withdrawals will appear here."
        action={{ label: 'Add money', onClick: onDeposit }}
      />
    );
  }

  return (
    <div className="space-y-5">
      {groupByDay(transactions).map((group) => (
        <ListGroup key={group.key} title={group.label}>
          {group.items.map((tx) => {
            const cfg = txConfig(tx);
            return (
              <ListRow
                key={tx.id}
                onClick={() => setSelected(tx)}
                leading={<IconTile icon={cfg.icon} tone={cfg.tone} />}
                title={tx.description || tx.type_display || cfg.label}
                subtitle={`${cfg.label} · ${timeOfDay(tx.created_at)}`}
                trailing={<SignedAmount amount={toAmount(tx.amount)} className="text-callout" />}
              />
            );
          })}
        </ListGroup>
      ))}
      <TransactionDetailSheet tx={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

function TransactionDetailSheet({ tx, onClose }: { tx: Transaction | null; onClose: () => void }) {
  // Keep the last transaction rendered while the sheet animates out.
  const [shown, setShown] = useState<Transaction | null>(tx);
  if (tx && tx !== shown) setShown(tx);
  const current = tx ?? shown;
  const cfg = current ? txConfig(current) : null;
  const amount = current ? toAmount(current.amount) : 0;

  return (
    <Sheet open={Boolean(tx)} onClose={onClose} title={cfg?.label ?? 'Transaction'} size="sm">
      {current && cfg && (
        <div className="space-y-5">
          <div className="flex flex-col items-center pt-2 text-center">
            <IconTile icon={cfg.icon} tone={cfg.tone} size="lg" />
            <SignedAmount amount={amount} className="mt-3 text-title-lg" />
            <p className="mt-1 text-callout text-text-secondary">{current.description || current.type_display}</p>
          </div>
          <SummaryList
            rows={[
              { label: 'Date', value: formatDateTime(current.created_at) },
              { label: 'Balance before', value: formatKES(current.balance_before) },
              { label: 'Balance after', value: formatKES(current.balance_after) },
              ...(current.reference_id ? [{ label: 'Reference', value: current.reference_id }] : []),
            ]}
          />
        </div>
      )}
    </Sheet>
  );
}

// ── Withdrawals ───────────────────────────────────────────────────────────────

interface WithdrawalListProps {
  withdrawals: WithdrawalItem[];
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  onWithdraw: () => void;
}

export function WithdrawalList({ withdrawals, isLoading, isError, onRetry, onWithdraw }: WithdrawalListProps) {
  const [selected, setSelected] = useState<WithdrawalItem | null>(null);

  if (isLoading) return <ActivitySkeleton rows={3} />;
  if (isError && withdrawals.length === 0) {
    return <ErrorInline message="We couldn't load your withdrawals." onRetry={onRetry} />;
  }
  if (withdrawals.length === 0) {
    return (
      <EmptyState
        icon={ArrowUpRight}
        title="No withdrawals yet"
        description="When you withdraw to M-Pesa, you can follow each request's status here."
        action={{ label: 'Withdraw', onClick: onWithdraw }}
      />
    );
  }

  return (
    <div className="space-y-5">
      {groupByDay(withdrawals).map((group) => (
        <ListGroup key={group.key} title={group.label}>
          {group.items.map((w) => {
            const status = withdrawalStatusInfo(w.status);
            return (
              <ListRow
                key={w.id}
                onClick={() => setSelected(w)}
                leading={<IconTile icon={ArrowUpRight} tone="neutral" />}
                title={<span className="num">{formatKES(w.amount_kes)}</span>}
                subtitle={`To ${formatDestination(w.destination) || w.method} · ${timeOfDay(w.created_at)}`}
                trailing={
                  <Pill tone={status.tone} dot={IN_FLIGHT_WITHDRAWAL.has(w.status) ? 'live' : undefined}>
                    {status.label}
                  </Pill>
                }
              />
            );
          })}
        </ListGroup>
      ))}
      <WithdrawalDetailSheet item={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

function WithdrawalDetailSheet({ item, onClose }: { item: WithdrawalItem | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const [shown, setShown] = useState<WithdrawalItem | null>(item);
  const [confirming, setConfirming] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState('');
  if (item && item !== shown) {
    setShown(item);
    setConfirming(false);
    setCancelError('');
  }
  const current = item ?? shown;
  const status = current ? withdrawalStatusInfo(current.status) : null;
  const canCancel = current?.status === 'pending_review';

  const cancel = async () => {
    if (!current) return;
    setCancelling(true);
    setCancelError('');
    try {
      await paymentsService.cancelWithdrawal(current.id);
      queryClient.invalidateQueries({ queryKey: ['withdrawals'] });
      queryClient.invalidateQueries({ queryKey: ['wallet'] });
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
      showToast({ message: `Withdrawal cancelled. ${formatKES(current.amount_kes)} is back in your balance.`, type: 'success' });
      onClose();
    } catch (err: any) {
      setCancelError(err?.response?.data?.error || 'We couldn’t cancel this withdrawal. Please try again.');
    } finally {
      setCancelling(false);
    }
  };

  const footer =
    current && canCancel ? (
      <div className="pb-3">
        {confirming ? (
          <div className="grid grid-cols-2 gap-3">
            <Button variant="secondary" size="lg" disabled={cancelling} onClick={() => setConfirming(false)}>
              Keep it
            </Button>
            <Button variant="danger" size="lg" isLoading={cancelling} loadingText="Cancelling…" onClick={cancel}>
              Yes, cancel
            </Button>
          </div>
        ) : (
          <Button variant="danger-soft" size="lg" fullWidth onClick={() => setConfirming(true)}>
            Cancel request
          </Button>
        )}
      </div>
    ) : undefined;

  return (
    <Sheet open={Boolean(item)} onClose={onClose} title="Withdrawal" size="sm" footer={footer} dismissible={!cancelling}>
      {current && status && (
        <div className="space-y-5">
          <div className="flex flex-col items-center pt-2 text-center">
            <span className="num text-title-lg text-text-primary">{formatKES(current.amount_kes)}</span>
            <Pill tone={status.tone} size="md" className="mt-2" dot={IN_FLIGHT_WITHDRAWAL.has(current.status) ? 'live' : undefined}>
              {status.label}
            </Pill>
            {status.hint && <p className="mt-2 text-callout text-text-secondary">{status.hint}</p>}
          </div>
          {current.fail_reason && (current.status === 'rejected' || current.status === 'failed') && (
            <Note icon={AlertCircle} tone="danger">
              <span className="font-semibold text-text-primary">Reason: </span>
              {current.fail_reason}
            </Note>
          )}
          <SummaryList
            rows={[
              { label: 'To', value: formatDestination(current.destination) },
              { label: 'Requested', value: formatDateTime(current.created_at) },
              { label: 'Last update', value: formatDateTime(current.updated_at) },
              ...(current.mpesa_ref ? [{ label: 'M-Pesa reference', value: current.mpesa_ref }] : []),
            ]}
          />
          {confirming && (
            <Note icon={ShieldCheck} tone="warning">
              Cancel this request? {formatKES(current.amount_kes)} will go straight back to your available balance.
            </Note>
          )}
          {cancelError && <ErrorInline message={cancelError} />}
        </div>
      )}
    </Sheet>
  );
}

// ── Pending deposit banner ────────────────────────────────────────────────────

/** Inline strip shown on the wallet while a closed deposit sheet still has news. */
export function DepositStatusStrip({
  state,
  amount,
  onOpen,
}: {
  state: 'waiting' | 'success' | 'failed' | 'timeout';
  amount: number;
  onOpen: () => void;
}) {
  const map = {
    waiting: { tone: 'brand' as const, title: 'Waiting for M-Pesa', body: `Approve ${formatKES(amount)} on your phone.`, icon: ArrowDownLeft },
    success: { tone: 'success' as const, title: 'Deposit received', body: `${formatKES(amount)} was added to your wallet.`, icon: ArrowDownLeft },
    failed: { tone: 'danger' as const, title: 'Deposit not completed', body: 'No money moved. Tap for details.', icon: AlertCircle },
    timeout: {
      tone: 'warning' as const,
      title: 'Deposit still pending',
      body: `We'll update your balance when M-Pesa confirms ${formatKES(amount)}.`,
      icon: ArrowDownLeft,
    },
  }[state];
  return (
    <div role="status" aria-live="polite">
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full min-h-[56px] items-center gap-3 rounded-card border border-border-light bg-bg-card px-4 py-3 text-left shadow-card active:!scale-100"
      >
        <IconTile icon={map.icon} tone={map.tone} size="sm" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-callout font-semibold text-text-primary">{map.title}</span>
            {state === 'waiting' && <span className="live-dot h-1.5 w-1.5 rounded-full bg-brand" aria-hidden />}
          </div>
          <p className="truncate text-caption text-text-muted">{map.body}</p>
        </div>
        <span className="text-callout font-semibold text-brand">View</span>
      </button>
    </div>
  );
}

