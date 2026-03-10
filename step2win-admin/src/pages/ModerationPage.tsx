import { useEffect, useMemo, useState } from 'react';
import { Ban, CheckCircle2, XCircle, UserX, Trophy, Banknote } from 'lucide-react';
import { adminApi } from '../services/adminApi';
import type { AdminChallenge, AdminUser, AdminWithdrawal } from '../types/admin';
import { formatKES } from '../utils/currency';
import { PageHeader } from '../components/PageHeader';
import { AdminTable } from '../components/AdminTable';
import { StatCard } from '../components/StatCard';
import { StatusBadge } from '../components/StatusBadge';

export function ModerationPage() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [challenges, setChallenges] = useState<AdminChallenge[]>([]);
  const [withdrawals, setWithdrawals] = useState<AdminWithdrawal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [activeTab, setActiveTab] = useState<'challenges' | 'users' | 'withdrawals'>('challenges');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const [usersData, challengesData, withdrawalsData] = await Promise.all([
        adminApi.getUsers(),
        adminApi.getChallenges(),
        adminApi.getWithdrawals(),
      ]);
      setUsers(usersData);
      setChallenges(challengesData);
      setWithdrawals(withdrawalsData);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const bannedUsers = useMemo(() => users.filter((u) => !u.is_active), [users]);
  const pendingChallenges = useMemo(() => challenges.filter((c) => c.status === 'pending'), [challenges]);
  const pendingWithdrawals = useMemo(() => withdrawals.filter((w) => w.status === 'pending'), [withdrawals]);

  const handleToggleBan = async (user: AdminUser) => {
    try {
      if (user.is_active) {
        if (!confirm(`Ban user ${user.username}?`)) return;
        await adminApi.banUser(user.id);
      } else {
        if (!confirm(`Unban user ${user.username}?`)) return;
        await adminApi.unbanUser(user.id);
      }
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleChallengeAction = async (id: number, action: 'approve' | 'cancel') => {
    try {
      if (action === 'approve') {
        await adminApi.approveChallenge(id);
      } else {
        await adminApi.cancelChallenge(id);
      }
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleWithdrawalAction = async (id: number, action: 'approve' | 'reject') => {
    try {
      if (action === 'approve') {
        await adminApi.approveWithdrawal(id);
      } else {
        await adminApi.rejectWithdrawal(id, 'Rejected by admin moderation');
      }
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const challengeColumns = [
    {
      key: 'name',
      label: 'Challenge Name',
      sortable: true,
      render: (c: AdminChallenge) => (
        <div style={{ color: '#f0f6ff', fontWeight: 600 }}>{c.name}</div>
      ),
    },
    {
      key: 'creator',
      label: 'Creator',
      render: (c: AdminChallenge) => (
        <div style={{ color: '#8ba3c7' }}>{c.created_by_username}</div>
      ),
    },
    {
      key: 'status',
      label: 'Status',
      render: (c: AdminChallenge) => <StatusBadge variant={c.status} />,
    },
    {
      key: 'pool',
      label: 'Pool',
      sortable: true,
      render: (c: AdminChallenge) => (
        <div style={{ fontWeight: 700, fontFamily: 'monospace', color: '#22c55e' }}>
          {formatKES(c.total_pool)}
        </div>
      ),
    },
    {
      key: 'actions',
      label: 'Actions',
      render: (c: AdminChallenge) => (
        <div style={{ display: 'flex', gap: '8px' }}>
          <button
            onClick={() => handleChallengeAction(c.id, 'approve')}
            style={{
              padding: '6px 12px',
              borderRadius: '6px',
              border: 'none',
              background: 'rgba(34, 197, 94, 0.12)',
              color: '#22c55e',
              fontSize: '12px',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            <CheckCircle2 size={12} style={{ verticalAlign: 'middle', marginRight: 4 }} />
            Approve
          </button>
          <button
            onClick={() => handleChallengeAction(c.id, 'cancel')}
            style={{
              padding: '6px 12px',
              borderRadius: '6px',
              border: 'none',
              background: 'rgba(239, 68, 68, 0.12)',
              color: '#ef4444',
              fontSize: '12px',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            <XCircle size={12} style={{ verticalAlign: 'middle', marginRight: 4 }} />
            Cancel
          </button>
        </div>
      ),
    },
  ];

  const userColumns = [
    {
      key: 'username',
      label: 'Username',
      sortable: true,
      render: (u: AdminUser) => (
        <div style={{ color: '#f0f6ff', fontWeight: 600 }}>{u.username}</div>
      ),
    },
    {
      key: 'email',
      label: 'Email',
      render: (u: AdminUser) => (
        <div style={{ color: '#8ba3c7', fontSize: '13px' }}>{u.email}</div>
      ),
    },
    {
      key: 'status',
      label: 'Status',
      render: (u: AdminUser) => (
        <StatusBadge variant={u.is_active ? 'active' : 'banned'} />
      ),
    },
    {
      key: 'wallet',
      label: 'Wallet',
      sortable: true,
      render: (u: AdminUser) => (
        <div style={{ fontWeight: 700, fontFamily: 'monospace', color: '#8ba3c7' }}>
          {formatKES(u.wallet_balance)}
        </div>
      ),
    },
    {
      key: 'actions',
      label: 'Actions',
      render: (u: AdminUser) => (
        <button
          onClick={() => handleToggleBan(u)}
          style={{
            padding: '6px 12px',
            borderRadius: '6px',
            border: 'none',
            background: u.is_active ? 'rgba(239, 68, 68, 0.12)' : 'rgba(34, 197, 94, 0.12)',
            color: u.is_active ? '#ef4444' : '#22c55e',
            fontSize: '12px',
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          {u.is_active ? (
            <>
              <Ban size={12} style={{ verticalAlign: 'middle', marginRight: 4 }} />
              Ban User
            </>
          ) : (
            <>
              <CheckCircle2 size={12} style={{ verticalAlign: 'middle', marginRight: 4 }} />
              Unban User
            </>
          )}
        </button>
      ),
    },
  ];

  const withdrawalColumns = [
    {
      key: 'user',
      label: 'User',
      render: (w: AdminWithdrawal) => (
        <div style={{ color: '#f0f6ff', fontWeight: 600 }}>{w.user_username}</div>
      ),
    },
    {
      key: 'amount',
      label: 'Amount',
      sortable: true,
      render: (w: AdminWithdrawal) => (
        <div style={{ fontWeight: 700, fontFamily: 'monospace', color: '#ef4444' }}>
          {formatKES(w.amount)}
        </div>
      ),
    },
    {
      key: 'status',
      label: 'Status',
      render: (w: AdminWithdrawal) => {
        const variantMap: Record<string, 'pending' | 'completed' | 'failed' | 'active'> = {
          pending: 'pending',
          approved: 'completed',
          rejected: 'failed',
          processing: 'active',
        };
        return <StatusBadge variant={variantMap[w.status] || 'pending'} />;
      },
    },
    {
      key: 'created',
      label: 'Created',
      sortable: true,
      render: (w: AdminWithdrawal) => (
        <div style={{ color: '#8ba3c7', fontSize: '13px' }}>
          {new Date(w.created_at).toLocaleString('en-US', {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          })}
        </div>
      ),
    },
    {
      key: 'actions',
      label: 'Actions',
      render: (w: AdminWithdrawal) => (
        <div style={{ display: 'flex', gap: '8px' }}>
          <button
            onClick={() => handleWithdrawalAction(w.id, 'approve')}
            style={{
              padding: '6px 12px',
              borderRadius: '6px',
              border: 'none',
              background: 'rgba(34, 197, 94, 0.12)',
              color: '#22c55e',
              fontSize: '12px',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            <CheckCircle2 size={12} style={{ verticalAlign: 'middle', marginRight: 4 }} />
            Approve
          </button>
          <button
            onClick={() => handleWithdrawalAction(w.id, 'reject')}
            style={{
              padding: '6px 12px',
              borderRadius: '6px',
              border: 'none',
              background: 'rgba(239, 68, 68, 0.12)',
              color: '#ef4444',
              fontSize: '12px',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            <XCircle size={12} style={{ verticalAlign: 'middle', marginRight: 4 }} />
            Reject
          </button>
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
        title="Moderation Queue"
        subtitle="Review and approve pending challenges, users, and withdrawals"
      />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '16px' }}>
        <StatCard
          title="Pending Challenges"
          value={pendingChallenges.length}
          icon={Trophy}
          color="amber"
        />
        <StatCard
          title="Banned Users"
          value={bannedUsers.length}
          icon={UserX}
          color="red"
        />
        <StatCard
          title="Pending Withdrawals"
          value={pendingWithdrawals.length}
          icon={Banknote}
          color="blue"
        />
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: '8px', borderBottom: '1px solid #21263A', paddingBottom: '8px' }}>
        {[
          { key: 'challenges' as const, label: 'Challenges', icon: Trophy },
          { key: 'users' as const, label: 'Users', icon: UserX },
          { key: 'withdrawals' as const, label: 'Withdrawals', icon: Banknote },
        ].map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            style={{
              padding: '10px 20px',
              borderRadius: '8px',
              border: 'none',
              background: activeTab === tab.key ? 'rgba(79, 156, 249, 0.12)' : 'transparent',
              color: activeTab === tab.key ? '#4F9CF9' : '#8ba3c7',
              fontSize: '14px',
              fontWeight: 600,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
            }}
          >
            <tab.icon size={16} />
            {tab.label}
          </button>
        ))}
      </div>

      {/* Content based on active tab */}
      {activeTab === 'challenges' && (
        <AdminTable
          title="Pending Challenges"
          subtitle={`${pendingChallenges.length} challenge${pendingChallenges.length !== 1 ? 's' : ''} awaiting approval`}
          columns={challengeColumns}
          data={pendingChallenges}
          isLoading={loading}
          rowKey={(c) => c.id.toString()}
          emptyMessage="No pending challenges"
        />
      )}

      {activeTab === 'users' && (
        <AdminTable
          title="All Users"
          subtitle={`${users.length} total users • ${bannedUsers.length} banned`}
          columns={userColumns}
          data={users}
          isLoading={loading}
          rowKey={(u) => u.id.toString()}
          emptyMessage="No users found"
        />
      )}

      {activeTab === 'withdrawals' && (
        <AdminTable
          title="Pending Withdrawals"
          subtitle={`${pendingWithdrawals.length} withdrawal${pendingWithdrawals.length !== 1 ? 's' : ''} awaiting approval`}
          columns={withdrawalColumns}
          data={pendingWithdrawals}
          isLoading={loading}
          rowKey={(w) => w.id.toString()}
          emptyMessage="No pending withdrawals"
        />
      )}
    </div>
  );
}
