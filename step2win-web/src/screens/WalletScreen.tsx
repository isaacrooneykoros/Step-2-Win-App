import { useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { walletService, paymentsService, authService } from '../services/api';
import { useAuthStore } from '../store/authStore';
import { useDeposit } from '../hooks/useDeposit';
import { ScreenHeader } from '../components/ui/ScreenHeader';
import { Segmented } from '../components/ui/Segmented';
import { ErrorState } from '../components/ui/ErrorState';
import { StatTile } from '../components/ui/StatTile';
import { formatKESShort } from '../lib/format';
import type { Transaction, User } from '../types';
import { BalanceHero, BalanceHeroSkeleton } from '../components/wallet/BalanceHero';
import { DepositSheet } from '../components/wallet/DepositSheet';
import { WithdrawSheet } from '../components/wallet/WithdrawSheet';
import { DepositStatusStrip, TransactionList, WithdrawalList } from '../components/wallet/ActivityLists';
import { IN_FLIGHT_WITHDRAWAL, formatPhoneDisplay, toAmount, type WithdrawalItem } from '../components/wallet/walletModel';

type Tab = 'transactions' | 'withdrawals';

export default function WalletScreen() {
  const { user } = useAuthStore();
  const [activeTab, setActiveTab] = useState<Tab>('transactions');
  const [depositOpen, setDepositOpen] = useState(false);
  const [depositKey, setDepositKey] = useState(0);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [withdrawKey, setWithdrawKey] = useState(0);
  const activityRef = useRef<HTMLElement>(null);

  // M-Pesa deposit hook
  const deposit = useDeposit();

  const walletQuery = useQuery({
    queryKey: ['wallet'],
    queryFn: walletService.getSummary,
  });

  const transactionsQuery = useQuery({
    queryKey: ['transactions'],
    queryFn: () => walletService.getTransactions(),
  });

  const withdrawalsQuery = useQuery<WithdrawalItem[]>({
    queryKey: ['withdrawals'],
    queryFn: () => paymentsService.getWithdrawalHistory(),
  });

  const { data: profile } = useQuery<User>({
    queryKey: ['profile'],
    queryFn: authService.getProfile,
  });

  const walletData = walletQuery.data;
  const transactions: Transaction[] = transactionsQuery.data ?? [];
  const withdrawals: WithdrawalItem[] = Array.isArray(withdrawalsQuery.data) ? withdrawalsQuery.data : [];

  const total = toAmount(walletData?.balance);
  const locked = toAmount(walletData?.locked_balance);
  // `available_balance` is balance minus locked; fall back to that if an older API omits it.
  const available = walletData?.available_balance != null ? toAmount(walletData.available_balance) : Math.max(0, total - locked);

  const pending = useMemo(() => {
    const inFlight = withdrawals.filter((w) => IN_FLIGHT_WITHDRAWAL.has(w.status));
    return { count: inFlight.length, amount: inFlight.reduce((sum, w) => sum + toAmount(w.amount_kes), 0) };
  }, [withdrawals]);

  const defaultPhone = formatPhoneDisplay(profile?.phone_number || user?.phone_number || '');

  const showActivity = (tab: Tab) => {
    setActiveTab(tab);
    requestAnimationFrame(() => activityRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };

  const openDeposit = () => {
    // A finished or fresh flow starts clean; an in-flight one re-opens where it is.
    if (deposit.state === 'idle') setDepositKey((k) => k + 1);
    setDepositOpen(true);
  };

  const closeDeposit = () => {
    setDepositOpen(false);
    if (deposit.state === 'success' || deposit.state === 'failed' || deposit.state === 'timeout') {
      // Let the sheet animate out before its content switches back to the form.
      window.setTimeout(deposit.reset, 320);
    }
  };

  const openWithdraw = () => {
    setWithdrawKey((k) => k + 1);
    setWithdrawOpen(true);
  };

  const depositStrip =
    !depositOpen && deposit.attempt && deposit.state !== 'idle' && deposit.state !== 'sending' ? deposit.state : null;

  return (
    <div className="pb-nav">
      <ScreenHeader variant="large" title="Wallet" subtitle="Your balance, entries and payouts" />

      <div className="space-y-6 px-5">
        {walletQuery.isLoading ? (
          <BalanceHeroSkeleton />
        ) : walletQuery.isError && !walletData ? (
          <div className="rounded-card border border-border-light bg-bg-card shadow-card">
            <ErrorState
              title="We couldn't load your balance"
              description="Your money is safe. Check your connection and try again."
              onRetry={() => walletQuery.refetch()}
              isRetrying={walletQuery.isFetching}
            />
          </div>
        ) : (
          <BalanceHero
            available={available}
            locked={locked}
            total={total}
            pendingWithdrawals={pending.amount}
            pendingCount={pending.count}
            onDeposit={openDeposit}
            onWithdraw={openWithdraw}
            onShowWithdrawals={() => showActivity('withdrawals')}
          />
        )}

        {depositStrip && deposit.attempt && (
          <DepositStatusStrip state={depositStrip} amount={deposit.attempt.amount} onOpen={() => setDepositOpen(true)} />
        )}

        {walletData && (
          <section aria-label="Lifetime totals" className="grid grid-cols-3 gap-3 rounded-card bg-bg-sunken px-4 py-3">
            <StatTile label="Deposited" value={formatKESShort(walletData.total_deposited)} />
            <StatTile label="Withdrawn" value={formatKESShort(walletData.total_withdrawn)} />
            <StatTile
              label="Earned"
              value={<span className="text-reward-ink">{formatKESShort(walletData.total_earned)}</span>}
            />
          </section>
        )}

        <section ref={activityRef} aria-label="Wallet activity" className="scroll-mt-20 space-y-4">
          <Segmented
            label="Wallet activity"
            value={activeTab}
            onChange={setActiveTab}
            options={[
              { value: 'transactions', label: 'Transactions' },
              { value: 'withdrawals', label: 'Withdrawals', count: pending.count },
            ]}
          />
          <div role="tabpanel" aria-label={activeTab === 'transactions' ? 'Transactions' : 'Withdrawals'}>
            {activeTab === 'transactions' ? (
              <TransactionList
                transactions={transactions}
                isLoading={transactionsQuery.isLoading}
                isError={transactionsQuery.isError}
                onRetry={() => transactionsQuery.refetch()}
                onDeposit={openDeposit}
              />
            ) : (
              <WithdrawalList
                withdrawals={withdrawals}
                isLoading={withdrawalsQuery.isLoading}
                isError={withdrawalsQuery.isError}
                onRetry={() => withdrawalsQuery.refetch()}
                onWithdraw={openWithdraw}
              />
            )}
          </div>
        </section>
      </div>

      <DepositSheet
        key={`deposit-${depositKey}`}
        open={depositOpen}
        onClose={closeDeposit}
        deposit={deposit}
        defaultPhone={defaultPhone}
        availableBalance={walletData ? available : null}
        balanceRefreshing={walletQuery.isFetching}
        onViewTransactions={() => {
          closeDeposit();
          showActivity('transactions');
        }}
      />

      <WithdrawSheet
        key={`withdraw-${withdrawKey}`}
        open={withdrawOpen}
        onClose={() => setWithdrawOpen(false)}
        available={available}
        defaultPhone={defaultPhone}
        onViewWithdrawals={() => {
          setWithdrawOpen(false);
          showActivity('withdrawals');
        }}
      />
    </div>
  );
}
