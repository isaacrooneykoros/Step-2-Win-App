import { useEffect, useState, useMemo } from 'react';
import { ArrowLeftRight, ArrowDownCircle, ArrowUpCircle, Receipt, X, Copy } from 'lucide-react';
import { adminApi } from '../services/adminApi';
import type { AdminTransaction } from '../types/admin';
import { formatKES } from '../utils/currency';
import { PageHeader } from '../components/PageHeader';
import { AdminTable } from '../components/AdminTable';
import { StatCard } from '../components/StatCard';

export function TransactionsPage() {
  const [items, setItems] = useState<AdminTransaction[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [sortKey, setSortKey] = useState<string>('created_at');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [selectedTransaction, setSelectedTransaction] = useState<AdminTransaction | null>(null);
  const [copiedLabel, setCopiedLabel] = useState('');

  useEffect(() => {
    adminApi
      .getTransactions()
      .then(setItems)
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  const filteredItems = useMemo(() => {
    return items.filter((tx) => {
      const searchLower = searchTerm.toLowerCase();
      return (
        tx.user_username?.toLowerCase().includes(searchLower) ||
        tx.type.toLowerCase().includes(searchLower) ||
        tx.description?.toLowerCase().includes(searchLower) ||
        tx.reference_id?.toLowerCase().includes(searchLower)
      );
    });
  }, [items, searchTerm]);

  const sortedItems = useMemo(() => {
    const sorted = [...filteredItems];
    sorted.sort((a, b) => {
      let aVal: string | number = '';
      let bVal: string | number = '';
      
      if (sortKey === 'created_at') {
        aVal = new Date(a.created_at).getTime();
        bVal = new Date(b.created_at).getTime();
      } else if (sortKey === 'amount') {
        aVal = Math.abs(parseFloat(a.amount));
        bVal = Math.abs(parseFloat(b.amount));
      } else if (sortKey === 'user') {
        aVal = a.user_username || 'System';
        bVal = b.user_username || 'System';
      } else if (sortKey === 'type') {
        aVal = a.type;
        bVal = b.type;
      }

      if (typeof aVal === 'string' && typeof bVal === 'string') {
        return sortDir === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
      }
      return sortDir === 'asc' ? (aVal as number) - (bVal as number) : (bVal as number) - (aVal as number);
    });
    return sorted;
  }, [filteredItems, sortKey, sortDir]);

  const stats = useMemo(() => {
    const deposits = items.filter(tx => parseFloat(tx.amount) > 0);
    const withdrawals = items.filter(tx => parseFloat(tx.amount) < 0);
    const totalDeposits = deposits.reduce((sum, tx) => sum + parseFloat(tx.amount), 0);
    const totalWithdrawals = Math.abs(withdrawals.reduce((sum, tx) => sum + parseFloat(tx.amount), 0));
    
    return {
      totalTransactions: items.length,
      totalDeposits,
      totalWithdrawals,
      netFlow: totalDeposits - totalWithdrawals,
    };
  }, [items]);

  const handleSort = (key: string) => {
    if (sortKey === key) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  };

  const getTypeIcon = (amount: string) => {
    const numAmount = parseFloat(amount);
    if (numAmount > 0) return <ArrowDownCircle size={14} style={{ color: '#22c55e' }} />;
    if (numAmount < 0) return <ArrowUpCircle size={14} style={{ color: '#ef4444' }} />;
    return <Receipt size={14} style={{ color: '#64748b' }} />;
  };

  const getTypeBadge = (type: string) => {
    const styles: Record<string, { bg: string; color: string }> = {
      deposit: { bg: 'rgba(34, 197, 94, 0.12)', color: '#22c55e' },
      withdrawal: { bg: 'rgba(239, 68, 68, 0.12)', color: '#ef4444' },
      refund: { bg: 'rgba(59, 130, 246, 0.12)', color: '#3b82f6' },
      reward: { bg: 'rgba(168, 85, 247, 0.12)', color: '#a855f7' },
      fee: { bg: 'rgba(245, 158, 11, 0.12)', color: '#f59e0b' },
    };
    const style = styles[type.toLowerCase()] || { bg: 'rgba(100, 116, 139, 0.12)', color: '#64748b' };
    
    return (
      <span
        style={{
          display: 'inline-block',
          padding: '4px 10px',
          borderRadius: '6px',
          fontSize: '12px',
          fontWeight: 600,
          background: style.bg,
          color: style.color,
        }}
      >
        {type}
      </span>
    );
  };

  const copyToClipboard = async (label: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedLabel(label);
      window.setTimeout(() => setCopiedLabel(''), 2000);
    } catch {
      setCopiedLabel('');
    }
  };

  const columns = [
    {
      key: 'user',
      label: 'User',
      sortable: true,
      render: (tx: AdminTransaction) => (
        <div>
          <div style={{ color: '#f0f6ff', fontWeight: 600 }}>
            {tx.user_username || 'System'}
          </div>
        </div>
      ),
    },
    {
      key: 'type',
      label: 'Type',
      sortable: true,
      render: (tx: AdminTransaction) => (
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {getTypeIcon(tx.amount)}
          {getTypeBadge(tx.type)}
        </div>
      ),
    },
    {
      key: 'amount',
      label: 'Amount',
      sortable: true,
      render: (tx: AdminTransaction) => {
        const numAmount = parseFloat(tx.amount);
        return (
          <div
            style={{
              fontWeight: 700,
              fontFamily: 'monospace',
              color: numAmount > 0 ? '#22c55e' : numAmount < 0 ? '#ef4444' : '#64748b',
            }}
          >
            {numAmount > 0 ? '+' : ''}
            {formatKES(tx.amount)}
          </div>
        );
      },
    },
    {
      key: 'description',
      label: 'Description',
      render: (tx: AdminTransaction) => (
        <div style={{ color: '#8ba3c7', fontSize: '13px' }}>
          {tx.description || '-'}
        </div>
      ),
    },
    {
      key: 'reference',
      label: 'Reference',
      render: (tx: AdminTransaction) => (
        <button
          type="button"
          onClick={() => {
            if (tx.reference_id) {
              void copyToClipboard('Reference copied', tx.reference_id)
            }
          }}
          disabled={!tx.reference_id}
          style={{
            color: tx.reference_id ? '#64748b' : '#4b5563',
            fontSize: '12px',
            fontFamily: 'monospace',
            cursor: tx.reference_id ? 'pointer' : 'default',
          }}
        >
          {tx.reference_id || '-'}
        </button>
      ),
    },
    {
      key: 'created_at',
      label: 'Date',
      sortable: true,
      render: (tx: AdminTransaction) => (
        <div style={{ color: '#8ba3c7', fontSize: '13px' }}>
          {new Date(tx.created_at).toLocaleString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          })}
        </div>
      ),
    },
  ];

  if (error) {
    return (
      <div style={{ padding: '20px' }}>
        <div
          style={{
            padding: '16px',
            borderRadius: '12px',
            background: 'rgba(239, 68, 68, 0.12)',
            color: '#ef4444',
            border: '1px solid rgba(239, 68, 68, 0.3)',
          }}
        >
          {error}
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      <PageHeader
        title="Transactions"
        subtitle={`${stats.totalTransactions} total transactions`}
      />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '16px' }}>
        <StatCard
          title="Total Transactions"
          value={stats.totalTransactions}
          icon={ArrowLeftRight}
          color="blue"
        />
        <StatCard
          title="Total Deposits"
          value={formatKES(stats.totalDeposits)}
          icon={ArrowDownCircle}
          color="purple"
        />
        <StatCard
          title="Total Withdrawals"
          value={formatKES(stats.totalWithdrawals)}
          icon={ArrowUpCircle}
          color="red"
        />
        <StatCard
          title="Net Flow"
          value={formatKES(stats.netFlow)}
          icon={Receipt}
          color={stats.netFlow >= 0 ? 'teal' : 'amber'}
        />
      </div>

      <AdminTable
        title="All Transactions"
        subtitle={`Showing ${sortedItems.length} of ${items.length} transactions`}
        columns={columns}
        data={sortedItems}
        isLoading={loading}
        rowKey={(tx) => tx.id.toString()}
        searchValue={searchTerm}
        onSearchChange={setSearchTerm}
        searchPlaceholder="Search transactions..."
        emptyMessage="No transactions found"
        sortKey={sortKey}
        sortDir={sortDir}
        onSort={handleSort}
        onRowClick={(tx) => setSelectedTransaction(tx)}
      />

      {selectedTransaction && (
        <div className="fixed inset-0 z-50 flex items-center justify-center px-4" style={{ background: 'rgba(0,0,0,0.7)' }}>
          <div className="w-full max-w-2xl rounded-2xl border border-[#21263A] bg-[#13161F] shadow-2xl overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b border-[#21263A]">
              <div>
                <p className="text-ink-primary text-lg font-semibold">Transaction Details</p>
                <p className="text-ink-muted text-xs">Drill-down view with quick copy actions</p>
              </div>
              <button
                type="button"
                onClick={() => setSelectedTransaction(null)}
                className="w-8 h-8 rounded-lg flex items-center justify-center"
                style={{ background: '#0E1016', border: '1px solid #21263A' }}>
                <X size={14} color="#7B82A0" />
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 p-5">
              <div className="rounded-xl p-4" style={{ background: '#0E1016', border: '1px solid #21263A' }}>
                <p className="text-ink-muted text-xs uppercase tracking-wide mb-1">User</p>
                <p className="text-ink-primary font-semibold">{selectedTransaction.user_username || 'System'}</p>
                <p className="text-ink-muted text-xs mt-1">ID: {selectedTransaction.user ?? 'n/a'}</p>
              </div>
              <div className="rounded-xl p-4" style={{ background: '#0E1016', border: '1px solid #21263A' }}>
                <p className="text-ink-muted text-xs uppercase tracking-wide mb-1">Amount</p>
                <p className="text-ink-primary font-semibold mono">
                  {parseFloat(selectedTransaction.amount) > 0 ? '+' : ''}{formatKES(selectedTransaction.amount)}
                </p>
                <p className="text-ink-muted text-xs mt-1">Type: {selectedTransaction.type}</p>
              </div>
              <div className="rounded-xl p-4 md:col-span-2" style={{ background: '#0E1016', border: '1px solid #21263A' }}>
                <p className="text-ink-muted text-xs uppercase tracking-wide mb-1">Description</p>
                <p className="text-ink-secondary text-sm">{selectedTransaction.description || '-'}</p>
              </div>
              <div className="rounded-xl p-4" style={{ background: '#0E1016', border: '1px solid #21263A' }}>
                <p className="text-ink-muted text-xs uppercase tracking-wide mb-1">Balance Before</p>
                <p className="text-ink-primary font-semibold mono">{formatKES(selectedTransaction.balance_before)}</p>
              </div>
              <div className="rounded-xl p-4" style={{ background: '#0E1016', border: '1px solid #21263A' }}>
                <p className="text-ink-muted text-xs uppercase tracking-wide mb-1">Balance After</p>
                <p className="text-ink-primary font-semibold mono">{formatKES(selectedTransaction.balance_after)}</p>
              </div>
              <div className="rounded-xl p-4 md:col-span-2" style={{ background: '#0E1016', border: '1px solid #21263A' }}>
                <p className="text-ink-muted text-xs uppercase tracking-wide mb-1">Reference</p>
                <div className="flex items-center justify-between gap-3">
                  <p className="text-ink-secondary mono text-sm break-all">{selectedTransaction.reference_id || '—'}</p>
                  {selectedTransaction.reference_id && (
                    <button
                      type="button"
                      onClick={() => void copyToClipboard('Reference copied', selectedTransaction.reference_id || '')}
                      className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold"
                      style={{ background: '#191C28', border: '1px solid #21263A', color: '#D4DEFF' }}>
                      <Copy size={13} />
                      Copy
                    </button>
                  )}
                </div>
                {copiedLabel && (
                  <p className="text-up text-xs mt-2">{copiedLabel}</p>
                )}
              </div>
              <div className="rounded-xl p-4 md:col-span-2" style={{ background: '#0E1016', border: '1px solid #21263A' }}>
                <p className="text-ink-muted text-xs uppercase tracking-wide mb-1">Created</p>
                <p className="text-ink-secondary text-sm">{new Date(selectedTransaction.created_at).toLocaleString()}</p>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
