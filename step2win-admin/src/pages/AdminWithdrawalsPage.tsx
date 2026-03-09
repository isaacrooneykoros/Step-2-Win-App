import { useCallback, useEffect, useMemo, useState } from 'react';
import { Banknote, Check, CheckCircle, Clock, RefreshCw, X, XCircle } from 'lucide-react';
import { adminApi } from '../services/adminApi';
import type { WithdrawalQueueItem, WithdrawalStats } from '../types/admin';
import { formatKES } from '../utils/currency';

const tabs = [
  { key: 'pending_review', label: 'Pending Review' },
  { key: 'processing', label: 'Processing' },
  { key: 'completed', label: 'Completed' },
  { key: 'failed', label: 'Failed' },
  { key: 'rejected', label: 'Rejected' },
] as const;

export function AdminWithdrawalsPage() {
  const [activeTab, setActiveTab] = useState<(typeof tabs)[number]['key']>('pending_review');
  const [items, setItems] = useState<WithdrawalQueueItem[]>([]);
  const [stats, setStats] = useState<WithdrawalStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [rejectModal, setRejectModal] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  const selectedWithdrawal = useMemo(
    () => items.find((entry) => entry.id === rejectModal) || null,
    [items, rejectModal],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [queue, statsData] = await Promise.all([
        adminApi.getWithdrawalQueue(activeTab),
        adminApi.getWithdrawalStats(),
      ]);
      setItems(queue);
      setStats(statsData);
    } catch (err) {
      setError((err as Error).message || 'Failed to load withdrawals');
    } finally {
      setLoading(false);
    }
  }, [activeTab]);

  useEffect(() => {
    load();
  }, [load]);

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

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      {error && <p className="error">{error}</p>}

      <div className="grid-cards">
        <article className="stat-card">
          <h3><Clock size={14} style={{ verticalAlign: 'middle', marginRight: 6 }} /> Pending Review</h3>
          <p>{stats?.pending_count || 0}</p>
        </article>
        <article className="stat-card">
          <h3><Banknote size={14} style={{ verticalAlign: 'middle', marginRight: 6 }} /> Pending Value</h3>
          <p>{formatKES(stats?.pending_total_kes || 0)}</p>
        </article>
        <article className="stat-card">
          <h3><CheckCircle size={14} style={{ verticalAlign: 'middle', marginRight: 6 }} /> Completed Today</h3>
          <p>{stats?.completed_today || 0}</p>
        </article>
        <article className="stat-card">
          <h3><XCircle size={14} style={{ verticalAlign: 'middle', marginRight: 6 }} /> Failed Today</h3>
          <p>{stats?.failed_today || 0}</p>
        </article>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            style={{
              background: activeTab === tab.key ? 'rgba(0, 245, 233, 0.15)' : '#111f35',
              color: '#f0f6ff',
              border: '1px solid rgba(59, 139, 255, 0.2)',
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <table className="table">
        <thead>
          <tr>
            <th>User</th>
            <th>Amount</th>
            <th>Method</th>
            <th>Destination</th>
            <th>Age</th>
            <th>Status</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {!loading && items.length === 0 && (
            <tr>
              <td colSpan={7} style={{ color: '#8ba3c7' }}>No withdrawals found.</td>
            </tr>
          )}
          {items.map((withdrawal) => (
            <tr key={withdrawal.id}>
              <td>
                <div>{withdrawal.username}</div>
                <div style={{ color: '#8ba3c7', fontSize: 12 }}>{withdrawal.email}</div>
              </td>
              <td>{formatKES(withdrawal.amount_kes)}</td>
              <td>{withdrawal.method}</td>
              <td>{withdrawal.destination}</td>
              <td>{withdrawal.age_hours}h</td>
              <td>{withdrawal.status}</td>
              <td>
                {withdrawal.status === 'pending_review' && (
                  <div className="actions">
                    <button
                      onClick={() => handleApprove(withdrawal.id)}
                      style={{
                        background: 'rgba(0, 197, 106, 0.12)',
                        border: '1px solid rgba(0, 197, 106, 0.3)',
                        color: '#7ef0bb',
                      }}
                    >
                      <Check size={12} style={{ marginRight: 4 }} /> Approve
                    </button>
                    <button
                      onClick={() => {
                        setRejectModal(withdrawal.id);
                        setRejectReason('');
                      }}
                      style={{
                        background: 'rgba(255, 107, 107, 0.12)',
                        border: '1px solid rgba(255, 107, 107, 0.3)',
                        color: '#ff9b9b',
                      }}
                    >
                      <X size={12} style={{ marginRight: 4 }} /> Reject
                    </button>
                  </div>
                )}
                {withdrawal.status === 'failed' && (
                  <button
                    onClick={() => handleRetry(withdrawal.id)}
                    style={{
                      background: 'rgba(255, 196, 71, 0.12)',
                      border: '1px solid rgba(255, 196, 71, 0.3)',
                      color: '#ffd888',
                    }}
                  >
                    <RefreshCw size={12} style={{ marginRight: 4 }} /> Retry
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {rejectModal && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.55)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 50,
          }}
        >
          <div
            style={{
              width: '100%',
              maxWidth: 480,
              borderRadius: 16,
              padding: 20,
              background: '#1A1D2E',
              border: '1px solid #252840',
            }}
          >
            <h3 style={{ marginTop: 0 }}>Reject Withdrawal</h3>
            <p style={{ color: '#8ba3c7', fontSize: 13 }}>
              This will refund {formatKES(selectedWithdrawal?.amount_kes || 0)} to the user's wallet.
            </p>
            <textarea
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="Reason for rejection (shown to user)..."
              rows={3}
              style={{
                width: '100%',
                background: '#111f35',
                borderRadius: 10,
                padding: 10,
                color: '#f0f6ff',
                border: '1px solid #252840',
                resize: 'none',
                marginBottom: 14,
              }}
            />
            <div className="actions">
              <button
                onClick={() => setRejectModal(null)}
                style={{
                  flex: 1,
                  background: 'transparent',
                  color: '#8ba3c7',
                  border: '1px solid #252840',
                }}
              >
                Cancel
              </button>
              <button
                onClick={() => handleReject(rejectModal, rejectReason)}
                disabled={!rejectReason.trim()}
                style={{
                  flex: 1,
                  background: 'rgba(255, 107, 107, 0.12)',
                  color: '#ff9b9b',
                  border: '1px solid rgba(255, 107, 107, 0.3)',
                  opacity: rejectReason.trim() ? 1 : 0.5,
                  cursor: rejectReason.trim() ? 'pointer' : 'not-allowed',
                }}
              >
                Confirm Reject
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
