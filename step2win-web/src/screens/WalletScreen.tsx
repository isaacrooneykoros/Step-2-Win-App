import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDownLeft, ArrowUpRight, Wallet, DollarSign, Building2, Trophy, Gift, Settings, TrendingUp } from 'lucide-react';
import { walletService, paymentsService } from '../services/api';
import { useToast } from '../components/ui/Toast';
import { BaseModal } from '../components/ui/BaseModal';
import { useDeposit } from '../hooks/useDeposit';
import type { Transaction } from '../types';
import { formatKES } from '../utils/currency';

type Tab = 'Transactions' | 'Withdrawals';

export default function WalletScreen() {
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const [activeTab, setActiveTab] = useState<Tab>('Transactions');
  const [showDepositModal, setShowDepositModal] = useState(false);
  const [depositAmount, setDepositAmount] = useState('');
  const [depositPhone, setDepositPhone] = useState('');
  const currentUser = (() => {
    try {
      return JSON.parse(localStorage.getItem('user') || 'null');
    } catch {
      return null;
    }
  })();

  // Withdrawal modal state
  const [showWithdrawModal, setShowWithdrawModal] = useState(false);
  const [withdrawAmount, setWithdrawAmount] = useState('');
  const [withdrawPhone, setWithdrawPhone] = useState(currentUser?.phone_number || '');
  const [withdrawState, setWithdrawState] = useState<'idle' | 'submitting' | 'success' | 'error'>('idle');
  const [withdrawError, setWithdrawError] = useState('');

  // M-Pesa deposit hook
  const { state: depositState, errorMsg: depositError, initiateDeposit, reset: resetDeposit } = useDeposit();

  const { data: walletData, isLoading: loadingWallet } = useQuery({
    queryKey: ['wallet'],
    queryFn: walletService.getSummary,
  });

  const { data: transactions = [], isLoading: loadingTransactions } = useQuery({
    queryKey: ['transactions'],
    queryFn: () => walletService.getTransactions(),
  });

  const { data: withdrawals = [], isLoading: loadingWithdrawals } = useQuery({
    queryKey: ['withdrawals'],
    queryFn: () => paymentsService.getWithdrawalHistory(),
  });

  const handleMpesaDeposit = () => {
    const amount = parseFloat(depositAmount);
    if (amount >= 10 && amount <= 100000 && depositPhone.trim()) {
      initiateDeposit(amount, depositPhone);
    } else {
      showToast({ message: 'Please enter valid amount (KES 10-100,000) and phone number', type: 'error' });
    }
  };

  const handleDepositModalClose = () => {
    setShowDepositModal(false);
    resetDeposit();
    setDepositAmount('');
    setDepositPhone('');
  };

  const handleWithdraw = async () => {
    const amount = parseFloat(withdrawAmount);
    if (amount < 10) {
      showToast({ message: 'Minimum withdrawal is KES 10', type: 'error' });
      return;
    }
    if (!withdrawPhone.trim()) {
      showToast({ message: 'Please enter your M-Pesa phone number', type: 'error' });
      return;
    }

    setWithdrawState('submitting');
    setWithdrawError('');
    try {
      await paymentsService.requestWithdrawal({
        method: 'mpesa',
        amount: amount,
        phone_number: withdrawPhone,
      });
      setWithdrawState('success');
      queryClient.invalidateQueries({ queryKey: ['wallet'] });
      queryClient.invalidateQueries({ queryKey: ['withdrawals'] });
    } catch (err: any) {
      setWithdrawError(err?.response?.data?.error || 'Withdrawal request failed. Please try again.');
      setWithdrawState('error');
    }
  };

  const handleWithdrawModalClose = () => {
    setShowWithdrawModal(false);
    setWithdrawState('idle');
    setWithdrawAmount('');
    setWithdrawPhone(currentUser?.phone_number || '');
    setWithdrawError('');
  };

  const resetWithdraw = () => {
    setWithdrawState('idle');
    setWithdrawError('');
  };

  const formatRelativeTime = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins} minute${diffMins > 1 ? 's' : ''} ago`;
    if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
    return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
  };

  const getStatusColor = (status: string) => {
    if (status === 'completed') return 'bg-success/20 text-success border border-success/30';
    if (status === 'processing' || status === 'approved' || status === 'pending_review') return 'bg-warning/20 text-warning border border-warning/30';
    if (status === 'rejected') return 'bg-error/20 text-error border border-error/30';
    if (status === 'failed' || status === 'cancelled') return 'bg-error/20 text-error border border-error/30';
    return 'bg-text-muted/20 text-text-muted border border-border';
  };

  const balance = (walletData?.balance || '0').toString();
  const lockedBalance = (walletData?.locked_balance || '0').toString();

  if (loadingWallet) {
    return (
      <div className="screen-enter pb-nav pt-4 px-4">
        <div className="skeleton h-40 rounded-4xl mb-4" />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
          <div className="skeleton h-14 rounded-2xl" />
          <div className="skeleton h-14 rounded-2xl" />
        </div>
        <div className="skeleton h-32 rounded-3xl" />
      </div>
    );
  }

  return (
    <div className="screen-enter pb-nav bg-bg-page">
      {/*  WALLET HERO CARD  */}
      <div className="pt-safe px-4 pt-4 pb-4">
        <div className="bg-white rounded-3xl p-6 shadow-sm">
          <div className="mb-3">
            <span className="text-text-muted text-xs font-medium uppercase tracking-widest">AVAILABLE BALANCE</span>
          </div>
          <div className="font-display text-5xl text-text-primary mb-4">
            {formatKES(balance)}
          </div>
          <div className="flex items-center gap-2 pt-4 border-t border-border">
            <div className="w-1.5 h-1.5 rounded-full bg-accent-yellow" />
            <span className="text-xs text-text-secondary">Locked in challenges:</span>
            <span className="text-xs font-semibold text-text-primary">{formatKES(lockedBalance)}</span>
          </div>
        </div>
      </div>

      {/*  ACTION BUTTONS  */}
      <div className="px-4 pb-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <button
            onClick={() => setShowDepositModal(true)}
            className="bg-accent-blue text-white py-4 rounded-2xl flex items-center justify-center gap-2 text-sm font-semibold shadow-sm"
          >
            <ArrowDownLeft size={18} strokeWidth={2.5} />
            Deposit
          </button>
          <button
            onClick={() => setShowWithdrawModal(true)}
            className="bg-bg-card border border-border text-text-primary py-4 rounded-2xl flex items-center justify-center gap-2 text-sm font-semibold"
          >
            <ArrowUpRight size={18} strokeWidth={2.5} />
            Withdraw
          </button>
        </div>
      </div>

      {/*  TAB SELECTOR  */}
      <div className="px-4 pb-4">
        <div className="flex bg-bg-input rounded-2xl p-1.5">
          {(['Transactions', 'Withdrawals'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`flex-1 py-2.5 rounded-xl text-sm font-semibold transition-all ${
                activeTab === tab
                  ? 'bg-white text-text-primary shadow-sm'
                  : 'text-text-muted'
              }`}
            >
              {tab}
            </button>
          ))}
        </div>
      </div>

      {activeTab === 'Transactions' && (
        <div className="mx-4 mb-6 bg-white rounded-3xl overflow-hidden shadow-sm">
          {loadingTransactions ? (
            [1, 2, 3].map((i) => (
              <div key={i} className="px-4 py-4 border-b border-border last:border-b-0">
                <div className="skeleton rounded" style={{ height: '14px', width: '65%' }} />
                <div className="skeleton mt-2 rounded" style={{ height: '12px', width: '35%' }} />
              </div>
            ))
          ) : transactions.length > 0 ? (
            transactions.map((tx: Transaction, idx: number) => {
              const amount = parseFloat((tx.amount || 0).toString());
              const isPositive = amount > 0;
              const typeConfig: Record<string, { Icon: any; bg: string }> = {
                deposit: { Icon: DollarSign, bg: 'bg-tint-yellow' },
                withdrawal: { Icon: Building2, bg: 'bg-tint-red' },
                challenge_entry: { Icon: Trophy, bg: 'bg-tint-blue' },
                payout: { Icon: Gift, bg: 'bg-tint-green' },
                fee: { Icon: Settings, bg: 'bg-tint-purple' },
              };
              const config = typeConfig[tx.type] || { Icon: Wallet, bg: 'bg-tint-blue' };
              const Icon = config.Icon;
              return (
                <div key={tx.id} className={`flex items-center gap-3 px-4 py-4 ${idx < transactions.length - 1 ? 'border-b border-border' : ''}`}>
                  <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${config.bg}`}>
                    <Icon className="w-5 h-5 text-text-muted" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-text-primary text-sm font-semibold truncate">{tx.description || tx.type_display}</p>
                    <p className="text-text-muted text-xs mt-0.5">{formatRelativeTime(tx.created_at)}</p>
                  </div>
                  <span className={`text-sm font-semibold flex-shrink-0 ${isPositive ? 'text-accent-green' : 'text-accent-red'}`}>
                    {isPositive ? '+' : ''}{formatKES(Math.abs(amount))}
                  </span>
                </div>
              );
            })
          ) : (
            <div className="px-4 py-16 text-center">
              <div className="w-16 h-16 rounded-full bg-tint-yellow flex items-center justify-center mx-auto mb-3">
                <Wallet size={28} className="text-accent-yellow" />
              </div>
              <p className="text-text-secondary text-sm">No transactions yet</p>
            </div>
          )}
        </div>
      )}

      {/*  WITHDRAWALS LIST  */}
      {activeTab === 'Withdrawals' && (
        <div className="px-4 pb-4">
          <div className="bg-white rounded-3xl overflow-hidden shadow-sm">
            {loadingWithdrawals ? (
              <div>
                {[1, 2, 3].map((i) => (
                  <div key={i} className="p-4 border-b border-border last:border-b-0">
                    <div className="skeleton h-10 rounded-2xl" />
                  </div>
                ))}
              </div>
            ) : withdrawals.length > 0 ? (
              withdrawals.map((withdrawal: any, idx: number) => (
                <div 
                  key={withdrawal.id} 
                  className={`flex items-center justify-between p-4 ${idx < withdrawals.length - 1 ? 'border-b border-border' : ''}`}
                >
                  <div>
                    <p className="text-text-primary text-sm font-semibold">
                      {formatKES(withdrawal.amount_kes || 0)}
                    </p>
                    <p className="text-text-muted text-xs mt-0.5">
                      {new Date(withdrawal.created_at).toLocaleDateString()}
                    </p>
                  </div>
                  <span className={`text-xs px-3 py-1.5 rounded-xl font-semibold ${getStatusColor(withdrawal.status)}`}>
                    {withdrawal.status}
                  </span>
                </div>
              ))
            ) : (
              <div className="px-4 py-16 text-center">
                <div className="w-16 h-16 rounded-full bg-tint-blue flex items-center justify-center mx-auto mb-3">
                  <TrendingUp size={28} className="text-accent-blue" />
                </div>
                <p className="text-text-secondary text-sm">No withdrawals yet</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/*  WITHDRAW MODAL  */}
      <BaseModal open={showWithdrawModal} onClose={handleWithdrawModalClose}>
        <h2 className="text-2xl font-black text-text-primary mb-2">Withdraw via M-Pesa</h2>
        <p className="text-sm text-text-muted mb-6">Request funds to be sent to your M-Pesa number</p>

        {withdrawState === 'idle' && (
          <>
            <div className="mb-4">
              <label className="block text-sm font-semibold text-text-secondary mb-2">Amount (KES)</label>
              <input
                type="number"
                min="10"
                max="70000"
                value={withdrawAmount}
                onChange={(e) => setWithdrawAmount(e.target.value)}
                placeholder="Enter amount"
                className="input-field w-full font-mono text-lg"
              />
              <p className="text-xs text-text-muted mt-2">Min: KES 10 | Max: KES 70,000</p>
            </div>

            <div className="mb-4">
              <label className="block text-sm font-semibold text-text-secondary mb-2">M-Pesa Phone Number</label>
              <input
                type="tel"
                value={withdrawPhone}
                onChange={(e) => setWithdrawPhone(e.target.value)}
                placeholder="07XXXXXXXX or 2547XXXXXXXX"
                className="input-field w-full font-mono text-lg"
              />
            </div>

            {/* Quick amount chips */}
            <div className="flex gap-2 mb-6">
              {[500, 1000, 5000, 10000].map(amt => (
                <button
                  key={amt}
                  onClick={() => setWithdrawAmount(String(amt))}
                  className={`flex-1 py-2 rounded-xl text-xs font-bold transition-colors ${
                    withdrawAmount === String(amt)
                      ? 'bg-accent-blue text-white'
                      : 'bg-bg-input text-text-secondary'
                  }`}
                >
                  KES {amt.toLocaleString()}
                </button>
              ))}
            </div>

            <div className="bg-bg-input rounded-2xl p-3 mb-6">
              <p className="text-xs text-text-muted">
                 Withdrawals are reviewed within 24 hours. Your balance will be held until processing is complete.
              </p>
            </div>

            <div className="flex gap-3">
              <button
                onClick={handleWithdrawModalClose}
                className="flex-1 btn-secondary py-3 rounded-2xl"
              >
                Cancel
              </button>
              <button
                onClick={handleWithdraw}
                disabled={!withdrawAmount || !withdrawPhone || parseFloat(withdrawAmount) < 10}
                className="flex-1 btn-primary py-3 rounded-2xl disabled:opacity-40"
              >
                Request Withdrawal
              </button>
            </div>
          </>
        )}

        {withdrawState === 'submitting' && (
          <div className="py-8 text-center">
            <div className="w-16 h-16 border-4 border-accent-blue border-t-transparent rounded-full animate-spin mx-auto mb-4" />
            <p className="text-text-primary text-sm font-semibold mb-2">Submitting request...</p>
            <p className="text-text-muted text-xs">Please wait</p>
          </div>
        )}

        {withdrawState === 'success' && (
          <div className="py-8 text-center">
            <div className="w-20 h-20 rounded-full bg-tint-green flex items-center justify-center mx-auto mb-4">
              <span className="text-4xl"></span>
            </div>
            <p className="text-text-primary text-lg font-bold mb-2">Withdrawal requested!</p>
            <p className="text-text-muted text-sm mb-6">Your request is being reviewed. Funds will be sent to your M-Pesa number within 24 hours.</p>
            <button
              onClick={handleWithdrawModalClose}
              className="w-full btn-primary py-3 rounded-2xl"
            >
              Done
            </button>
          </div>
        )}

        {withdrawState === 'error' && (
          <div className="py-8 text-center">
            <div className="w-20 h-20 rounded-full bg-red-50 flex items-center justify-center mx-auto mb-4">
              <span className="text-4xl"></span>
            </div>
            <p className="text-text-primary text-lg font-bold mb-2">Request failed</p>
            <p className="text-red-500 text-sm mb-6">{withdrawError || 'Please try again'}</p>
            <button
              onClick={resetWithdraw}
              className="w-full btn-primary py-3 rounded-2xl"
            >
              Try Again
            </button>
          </div>
        )}
      </BaseModal>

      {/*  DEPOSIT MODAL  */}
      <BaseModal open={showDepositModal} onClose={handleDepositModalClose}>
        <h2 className="text-2xl font-black text-text-primary mb-2">Deposit via M-Pesa</h2>
        <p className="text-sm text-text-muted mb-6">Add money to your wallet using M-Pesa STK Push</p>

        {depositState === 'idle' && (
          <>
            <div className="mb-4">
              <label className="block text-sm font-semibold text-text-secondary mb-2">Amount (KES)</label>
              <input
                type="number"
                min="10"
                max="100000"
                value={depositAmount}
                onChange={(e) => setDepositAmount(e.target.value)}
                placeholder="Enter amount"
                className="input-field w-full font-mono text-lg"
              />
              <p className="text-xs text-text-muted mt-2">Min: KES 10 | Max: KES 100,000</p>
            </div>

            <div className="mb-4">
              <label className="block text-sm font-semibold text-text-secondary mb-2">M-Pesa Phone Number</label>
              <input
                type="tel"
                value={depositPhone}
                onChange={(e) => setDepositPhone(e.target.value)}
                placeholder="07XXXXXXXX or 2547XXXXXXXX"
                className="input-field w-full font-mono text-lg"
              />
            </div>

            {/* Quick amount chips */}
            <div className="flex gap-2 mb-6">
              {[100, 500, 1000, 2000].map(amt => (
                <button
                  key={amt}
                  onClick={() => setDepositAmount(String(amt))}
                  className={`flex-1 py-2 rounded-xl text-xs font-bold transition-colors ${
                    depositAmount === String(amt)
                      ? 'bg-accent-blue text-white'
                      : 'bg-bg-input text-text-secondary'
                  }`}
                >
                  KES {amt}
                </button>
              ))}
            </div>

            <div className="flex gap-3">
              <button
                onClick={handleDepositModalClose}
                className="flex-1 btn-secondary py-3 rounded-2xl"
              >
                Cancel
              </button>
              <button
                onClick={handleMpesaDeposit}
                disabled={!depositAmount || !depositPhone || parseFloat(depositAmount) < 10}
                className="flex-1 btn-primary py-3 rounded-2xl disabled:opacity-40"
              >
                Send STK Push
              </button>
            </div>
          </>
        )}

        {depositState === 'sending' && (
          <div className="py-8 text-center">
            <div className="w-16 h-16 border-4 border-accent-blue border-t-transparent rounded-full animate-spin mx-auto mb-4" />
            <p className="text-text-primary text-sm font-semibold mb-2">Sending STK Push...</p>
            <p className="text-text-muted text-xs">Please wait</p>
          </div>
        )}

        {depositState === 'waiting' && (
          <div className="py-8 text-center">
            <div className="w-20 h-20 rounded-full bg-tint-yellow flex items-center justify-center mx-auto mb-4">
              <span className="text-4xl"></span>
            </div>
            <p className="text-text-primary text-lg font-bold mb-2">Check your phone</p>
            <p className="text-text-muted text-sm mb-4">Enter your M-Pesa PIN to complete the payment</p>
            <div className="bg-bg-input rounded-2xl p-3">
              <p className="text-xs text-text-muted">Waiting for confirmation...</p>
            </div>
          </div>
        )}

        {depositState === 'success' && (
          <div className="py-8 text-center">
            <div className="w-20 h-20 rounded-full bg-tint-green flex items-center justify-center mx-auto mb-4">
              <span className="text-4xl"></span>
            </div>
            <p className="text-text-primary text-lg font-bold mb-2">Deposit successful!</p>
            <p className="text-text-muted text-sm mb-6">KES {depositAmount} has been added to your wallet</p>
            <button
              onClick={handleDepositModalClose}
              className="w-full btn-primary py-3 rounded-2xl"
            >
              Done
            </button>
          </div>
        )}

        {depositState === 'failed' && (
          <div className="py-8 text-center">
            <div className="w-20 h-20 rounded-full bg-red-50 flex items-center justify-center mx-auto mb-4">
              <span className="text-4xl"></span>
            </div>
            <p className="text-text-primary text-lg font-bold mb-2">Payment not completed</p>
            <p className="text-red-500 text-sm mb-6">{depositError || 'Please try again'}</p>
            <button
              onClick={resetDeposit}
              className="w-full btn-primary py-3 rounded-2xl"
            >
              Try Again
            </button>
          </div>
        )}
      </BaseModal>

      {/*  WITHDRAW MODAL  */}
      <BaseModal open={showWithdrawModal} onClose={handleWithdrawModalClose}>
        <h2 className="text-2xl font-black text-text-primary mb-2">Withdraw via M-Pesa</h2>
        <p className="text-sm text-text-muted mb-6">Request funds to be sent to your M-Pesa number</p>

        {withdrawState === 'idle' && (
          <>
            <div className="mb-4">
              <label className="block text-sm font-semibold text-text-secondary mb-2">Amount (KES)</label>
              <input
                type="number"
                min="10"
                max="70000"
                value={withdrawAmount}
                onChange={(e) => setWithdrawAmount(e.target.value)}
                placeholder="Enter amount"
                className="input-field w-full font-mono text-lg"
              />
              <p className="text-xs text-text-muted mt-2">Min: KES 10 | Max: KES 70,000</p>
            </div>

            <div className="mb-4">
              <label className="block text-sm font-semibold text-text-secondary mb-2">M-Pesa Phone Number</label>
              <input
                type="tel"
                value={withdrawPhone}
                onChange={(e) => setWithdrawPhone(e.target.value)}
                placeholder="07XXXXXXXX or 2547XXXXXXXX"
                className="input-field w-full font-mono text-lg"
              />
            </div>

            {/* Quick amount chips */}
            <div className="flex gap-2 mb-6">
              {[500, 1000, 5000, 10000].map(amt => (
                <button
                  key={amt}
                  onClick={() => setWithdrawAmount(String(amt))}
                  className={`flex-1 py-2 rounded-xl text-xs font-bold transition-colors ${
                    withdrawAmount === String(amt)
                      ? 'bg-accent-blue text-white'
                      : 'bg-bg-input text-text-secondary'
                  }`}
                >
                  {amt >= 1000 ? `${amt / 1000}K` : amt}
                </button>
              ))}
            </div>

            <div className="bg-bg-input rounded-2xl p-3 mb-6">
              <p className="text-xs text-text-muted">
                 Withdrawals are reviewed within 24 hours. Your balance will be held until processing is complete.
              </p>
            </div>

            <div className="flex gap-3">
              <button
                onClick={handleWithdrawModalClose}
                className="flex-1 btn-secondary py-3 rounded-2xl"
              >
                Cancel
              </button>
              <button
                onClick={handleWithdraw}
                disabled={!withdrawAmount || !withdrawPhone || parseFloat(withdrawAmount) < 10}
                className="flex-1 btn-primary py-3 rounded-2xl disabled:opacity-40"
              >
                Request Withdrawal
              </button>
            </div>
          </>
        )}

        {withdrawState === 'submitting' && (
          <div className="py-8 text-center">
            <div className="w-16 h-16 border-4 border-accent-blue border-t-transparent rounded-full animate-spin mx-auto mb-4" />
            <p className="text-text-primary text-sm font-semibold mb-2">Submitting request...</p>
            <p className="text-text-muted text-xs">Please wait</p>
          </div>
        )}

        {withdrawState === 'success' && (
          <div className="py-8 text-center">
            <div className="w-20 h-20 rounded-full bg-tint-green flex items-center justify-center mx-auto mb-4">
              <span className="text-4xl"></span>
            </div>
            <p className="text-text-primary text-lg font-bold mb-2">Withdrawal requested!</p>
            <p className="text-text-muted text-sm mb-6">Your request is being reviewed. Funds will be sent to your M-Pesa number within 24 hours.</p>
            <button
              onClick={handleWithdrawModalClose}
              className="w-full btn-primary py-3 rounded-2xl"
            >
              Done
            </button>
          </div>
        )}

        {withdrawState === 'error' && (
          <div className="py-8 text-center">
            <div className="w-20 h-20 rounded-full bg-red-50 flex items-center justify-center mx-auto mb-4">
              <span className="text-4xl"></span>
            </div>
            <p className="text-text-primary text-lg font-bold mb-2">Request failed</p>
            <p className="text-red-500 text-sm mb-6">{withdrawError || 'Please try again'}</p>
            <button
              onClick={resetWithdraw}
              className="w-full btn-primary py-3 rounded-2xl"
            >
              Try Again
            </button>
          </div>
        )}
      </BaseModal>

    </div>
  );
}


