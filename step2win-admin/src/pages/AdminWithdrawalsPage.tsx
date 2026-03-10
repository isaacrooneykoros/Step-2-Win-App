import { useCallback, useEffect, useMemo, useState } from 'react';
import { Banknote, Check, CheckCircle2, Clock, RefreshCw, X, XCircle, TrendingDown, AlertCircle } from 'lucide-react';
import { adminApi } from '../services/adminApi';
import type { WithdrawalQueueItem, WithdrawalStats } from '../types/admin';
import { formatKES } from '../utils/currency';
import { PageHeader } from '../components/PageHeader';
import { StatCard } from '../components/StatCard';
import { AdminTable } from '../components/AdminTable';
import { StatusBadge } from '../components/StatusBadge';

const tabs = [
  { key: 'pending_review', label: 'Pending Review', icon: Clock },
  { key: 'processing', label: 'Processing', icon: TrendingDown },
  { key: 'completed', label: 'Completed', icon: CheckCircle2 },
  { key: 'failed', label: 'Failed', icon: AlertCircle },
  { key: 'rejected', label: 'Rejected', icon: XCircle },
] as const;

export function AdminWithdrawalsPage() {
  const [activeTab, setActiveTab] = useState<(typeof tabs)[number]['key']>('pending_review');
  const [items, setItems] = useState<WithdrawalQueueItem[]>([]);
  const [stats, setStats] = useState<WithdrawalStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [rejectModal, setRejectModal] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [sortKey, setSortKey] = useState<string>('created_at');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  const selectedWithdrawal = useMemo(
    () => items.find((entry) => entry.id === rejectModal) || null,
    [items, rejectModal],
  );

  const load = useCallback(async () => {
    try {
      const [queue, statsData] = await Promise.all([
        adminApi.getWithdrawalQueue(activeTab),
        adminApi.getWithdrawalStats(),
      ]);
      setItems(queue);
      setStats(statsData);
      setError('');
    } catch (err) {
      setError((err as Error).message || 'Failed to load withdrawals');
    } finally {
      setLoading(false);
    }
  }, [activeTab]);

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  const filteredItems = useMemo(() => {
    return items.filter((w) => {
      const searchLower = searchTerm.toLowerCase();
      return (
        w.username.toLowerCase().includes(searchLower) ||
        w.email.toLowerCase().includes(searchLower) ||
        w.destination.toLowerCase().includes(searchLower) ||
        w.method.toLowerCase().includes(searchLower)
      );
    });
  }, [items, searchTerm]);

  const sortedItems = useMemo(() => {
    const sorted = [...filteredItems];
    sorted.sort((a, b) => {
      let aVal: string | number = '';
      let bVal: string | number = '';

      if (sortKey === 'amount_kes') {
        aVal = parseFloat(a.amount_kes);
        bVal = parseFloat(b.amount_kes);
      } else if (sortKey === 'username') {
        aVal = a.username;
        bVal = b.username;
      } else if (sortKey === 'age_hours') {
        aVal = a.age_hours;
        bVal = b.age_hours;
      } else {
        aVal = a.id;
        bVal = b.id;
      }

      if (typeof aVal === 'string' && typeof bVal === 'string') {
        return sortDir === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
      }
      return sortDir === 'asc' ? (aVal as number) - (bVal as number) : (bVal as number) - (aVal as number);
    });
    return sorted;
  }, [filteredItems, sortKey, sortDir]);

  const handleApprove = async (id: string) => {
    try {
      await adminApi.approveWithdrawalRequest(id);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleReject = async (id: string, reason: string) => {
    try {
      await adminApi.rejectWithdrawalRequest(id, reason);
      setRejectModal(null);
      setRejectReason('');
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleRetry = async (id: string) => {
    try {
      await adminApi.retryFailedWithdrawal(id);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleSort = (key: string) => {
    if (sortKey === key) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  };

  const getStatusVariant = (status: string): 'pending' | 'completed' | 'cancelled' | 'failed' | 'active' => {
    const map: Record<string, 'pending' | 'completed' | 'cancelled' | 'failed' | 'active'> = {
      pending_review: 'pending',
      processing: 'active',
      completed: 'completed',
      failed: 'failed',
      rejected: 'cancelled',
    };
    return map[status] || 'pending';
  };

  const columns = [
    {
      key: 'user',
      label: 'User',
      sortable: true,
      render: (w: WithdrawalQueueItem) => (
        <div>
          <div style={{ color: '#f0f6ff', fontWeight: 600 }}>{w.username}</div>
          <div style={{ color: '#8ba3c7', fontSize: '12px' }}>{w.email}</div>
        </div>
      ),
    },
    {
      key: 'amount_kes',
      label: 'Amount',
      sortable: true,
      render: (w: WithdrawalQueueItem) => (
        <div style={{ fontWeight: 700, fontFamily: 'monospace', color: '#ef4444' }}>
          {formatKES(w.amount_kes)}
        </div>
      ),
    },
    {
      key: 'method',
      label: 'Method',
      render: (w: WithdrawalQueueItem) => (
        <span
          style={{
            display: 'inline-block',
            padding: '4px 10px',
            borderRadius: '6px',
            fontSize: '12px',
            fontWeight: 600,
            background: 'rgba(79, 156, 249, 0.12)',
            color: '#4F9CF9',
            textTransform: 'capitalize',
          }}
        >
          {w.method}
        </span>
      ),
    },
    {
      key: 'destination',
      label: 'Destination',
      render: (w: WithdrawalQueueItem) => (
        <div style={{ color: '#8ba3c7', fontSize: '13px', fontFamily: 'monospace' }}>
          {w.destination}
        </div>
      ),
    },
    {
      key: 'age_hours',
      label: 'Age',
      sortable: true,
      render: (w: WithdrawalQueueItem) => (
        <div style={{ color: '#64748b', fontSize: '13px' }}>
          {w.age_hours > 24 ? `${Math.floor(w.age_hours / 24)}d` : `${w.age_hours}h`}
        </div>
      ),
    },
    {
      key: 'status',
      label: 'Status',
      render: (w: WithdrawalQueueItem) => (
        <StatusBadge variant={getStatusVariant(w.status)} />
      ),
    },
    {
      key: 'actions',
      label: 'Actions',
      render: (w: WithdrawalQueueItem) => (
        <div style={{ display: 'flex', gap: '8px' }}>
          {w.status === 'pending_review' && (
            <>
              <button
                onClick={() => handleApprove(w.id)}
                style={{
                  padding: '6px 12px',
                  borderRadius: '6px',
                  border: 'none',
                  background: 'rgba(34, 197, 94, 0.12)',
                  color: '#22c55e',
                  fontSize: '12px',
                  fontWeight: 600,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px',
                }}
              >
                <Check size={12} />
                Approve
              </button>
              <button
                onClick={() => {
                  setRejectModal(w.id);
                  setRejectReason('');
                }}
                style={{
                  padding: '6px 12px',
                  borderRadius: '6px',
                  border: 'none',
                  background: 'rgba(239, 68, 68, 0.12)',
                  color: '#ef4444',
                  fontSize: '12px',
                  fontWeight: 600,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px',
                }}
              >
                <X size={12} />
                Reject
              </button>
            </>
          )}
          {w.status === 'failed' && (
            <button
              onClick={() => handleRetry(w.id)}
              style={{
                padding: '6px 12px',
                borderRadius: '6px',
                border: 'none',
                background: 'rgba(245, 158, 11, 0.12)',
                color: '#f59e0b',
                fontSize: '12px',
                fontWeight: 600,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '4px',
              }}
            >
              <RefreshCw size={12} />
              Retry
            </button>
          )}
        </div>
      ),
    },
  ];

  const tabButtons = tabs.map((tab) => {
    const TabIcon = tab.icon;
    return (
      <button
        key={tab.key}
        onClick={() => setActiveTab(tab.key)}
        style={{
          padding: '10px 16px',
          borderRadius: '8px',
          border: 'none',
          background: activeTab === tab.key ? 'rgba(79, 156, 249, 0.12)' : 'transparent',
          color: activeTab === tab.key ? '#4F9CF9' : '#8ba3c7',
          fontSize: '13px',
          fontWeight: 600,
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          transition: 'all 0.2s',
        }}
      >
        <TabIcon size={16} />
        {tab.label}
      </button>
    );
  });

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
        title="Withdrawal Management"
        subtitle="Review and manage user withdrawal requests"
      />

      {/* Stats Grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '16px' }}>
        <StatCard
          title="Pending Review"
          value={stats?.pending_count || 0}
          icon={Clock}
          color="amber"
        />
        <StatCard
          title="Pending Value"
          value={formatKES(stats?.pending_total_kes || 0)}
          icon={Banknote}
          color="red"
        />
        <StatCard
          title="Completed Today"
          value={stats?.completed_today || 0}
          icon={CheckCircle2}
          color="purple"
        />
        <StatCard
          title="Failed Today"
          value={stats?.failed_today || 0}
          icon={AlertCircle}
          color="indigo"
        />
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: '4px', borderBottom: '1px solid #21263A', paddingBottom: '8px', overflowX: 'auto' }}>
        {tabButtons}
      </div>

      {/* Table */}
      <AdminTable
        title={`${tabs.find(t => t.key === activeTab)?.label || 'Withdrawals'}`}
        subtitle={`${sortedItems.length} of ${items.length} withdrawal${items.length !== 1 ? 's' : ''}`}
        columns={columns}
        data={sortedItems}
        isLoading={loading}
        rowKey={(w) => w.id}
        searchValue={searchTerm}
        onSearchChange={setSearchTerm}
        searchPlaceholder="Search by username, email, or destination..."
        emptyMessage="No withdrawals found"
        sortKey={sortKey}
        sortDir={sortDir}
        onSort={handleSort}
      />

      {/* Reject Modal */}
      {rejectModal && selectedWithdrawal && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.75)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 50,
            padding: '16px',
          }}
          onClick={() => setRejectModal(null)}
        >
          <div
            style={{
              background: '#0C1117',
              borderRadius: '16px',
              border: '1px solid #21263A',
              boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)',
              maxWidth: '500px',
              width: '100%',
              overflow: 'hidden',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div
              style={{
                padding: '24px',
                background: 'linear-gradient(135deg, #1e293b 0%, #0f172a 100%)',
                borderBottom: '1px solid #21263A',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <AlertCircle size={24} style={{ color: '#ef4444' }} />
                <h3 style={{ fontSize: '18px', fontWeight: 700, color: '#fff', margin: 0 }}>
                  Reject Withdrawal
                </h3>
              </div>
              <button
                onClick={() => setRejectModal(null)}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: '#64748b',
                  cursor: 'pointer',
                  padding: '8px',
                  fontSize: '18px',
                }}
              >
                ✕
              </button>
            </div>

            {/* Modal Body */}
            <div style={{ padding: '24px' }}>
              <div style={{ marginBottom: '20px' }}>
                <p style={{ color: '#8ba3c7', fontSize: '14px', margin: '0 0 12px 0' }}>
                  <strong>User:</strong> {selectedWithdrawal.username}
                </p>
                <p style={{ color: '#8ba3c7', fontSize: '14px', margin: '0 0 12px 0' }}>
                  <strong>Amount:</strong>{' '}
                  <span style={{ fontFamily: 'monospace', color: '#ef4444', fontWeight: 700 }}>
                    {formatKES(selectedWithdrawal.amount_kes)}
                  </span>
                </p>
                <p style={{ color: '#8ba3c7', fontSize: '13px', margin: 0 }}>
                  This amount will be refunded to the user's wallet.
                </p>
              </div>

              <div style={{ marginBottom: '20px' }}>
                <label
                  style={{
                    display: 'block',
                    marginBottom: '8px',
                    color: '#64748b',
                    fontSize: '13px',
                    fontWeight: 600,
                  }}
                >
                  Reason for Rejection (shown to user)
                </label>
                <textarea
                  value={rejectReason}
                  onChange={(e) => setRejectReason(e.target.value)}
                  placeholder="Enter rejection reason..."
                  rows={4}
                  style={{
                    width: '100%',
                    padding: '12px',
                    borderRadius: '8px',
                    border: '1px solid #21263A',
                    background: '#13161F',
                    color: '#f0f6ff',
                    fontSize: '13px',
                    fontFamily: 'inherit',
                    resize: 'none',
                  }}
                />
              </div>

              {/* Modal Actions */}
              <div style={{ display: 'flex', gap: '12px' }}>
                <button
                  onClick={() => setRejectModal(null)}
                  style={{
                    flex: 1,
                    padding: '12px',
                    borderRadius: '8px',
                    border: '1px solid #21263A',
                    background: 'transparent',
                    color: '#8ba3c7',
                    fontWeight: 600,
                    cursor: 'pointer',
                    transition: 'all 0.2s',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'rgba(100, 116, 139, 0.1)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'transparent';
                  }}
                >
                  Cancel
                </button>
                <button
                  onClick={() => handleReject(rejectModal, rejectReason)}
                  disabled={!rejectReason.trim()}
                  style={{
                    flex: 1,
                    padding: '12px',
                    borderRadius: '8px',
                    border: 'none',
                    background:
                      rejectReason.trim() ? 'linear-gradient(135deg, #ef4444 0%, #dc2626 100%)' : 'rgba(239, 68, 68, 0.3)',
                    color: '#fff',
                    fontWeight: 700,
                    cursor: rejectReason.trim() ? 'pointer' : 'not-allowed',
                    transition: 'all 0.2s',
                  }}
                  onMouseEnter={(e) => {
                    if (rejectReason.trim()) {
                      e.currentTarget.style.transform = 'translateY(-2px)';
                      e.currentTarget.style.boxShadow = '0 8px 16px rgba(239, 68, 68, 0.4)';
                    }
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.transform = 'translateY(0)';
                    e.currentTarget.style.boxShadow = 'none';
                  }}
                >
                  Confirm Rejection
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
