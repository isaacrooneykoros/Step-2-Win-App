import { useEffect, useMemo, useState } from 'react';
import { Ban, CheckCircle2, ShieldAlert, ShieldCheck, XCircle } from 'lucide-react';
import { adminApi } from '../services/adminApi';
import type { AdminChallenge, AdminUser, AdminWithdrawal } from '../types/admin';
import { formatKES } from '../utils/currency';

export function ModerationPage() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [challenges, setChallenges] = useState<AdminChallenge[]>([]);
  const [withdrawals, setWithdrawals] = useState<AdminWithdrawal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

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
        await adminApi.banUser(user.id);
      } else {
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

  if (loading) {
    return <p>Loading moderation queue...</p>;
  }

  if (error) {
    return <p className="error">{error}</p>;
  }

  return (
    <div className="space-y-6">
      <div className="grid-cards">
        <article className="stat-card">
          <h3>
            <ShieldAlert size={16} style={{ verticalAlign: 'middle', marginRight: 6 }} />
            Pending Challenges
          </h3>
          <p>{pendingChallenges.length}</p>
        </article>
        <article className="stat-card">
          <h3>
            <Ban size={16} style={{ verticalAlign: 'middle', marginRight: 6 }} />
            Banned Users
          </h3>
          <p>{bannedUsers.length}</p>
        </article>
        <article className="stat-card">
          <h3>
            <ShieldCheck size={16} style={{ verticalAlign: 'middle', marginRight: 6 }} />
            Pending Withdrawals
          </h3>
          <p>{pendingWithdrawals.length}</p>
        </article>
      </div>

      <div>
        <h3>Challenge Moderation</h3>
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Creator</th>
              <th>Status</th>
              <th>Pool</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {pendingChallenges.map((challenge) => (
              <tr key={challenge.id}>
                <td>{challenge.name}</td>
                <td>{challenge.created_by_username}</td>
                <td>{challenge.status}</td>
                <td>{formatKES(challenge.total_pool)}</td>
                <td>
                  <button onClick={() => handleChallengeAction(challenge.id, 'approve')}>Approve</button>
                  <button onClick={() => handleChallengeAction(challenge.id, 'cancel')}>Cancel</button>
                </td>
              </tr>
            ))}
            {pendingChallenges.length === 0 && (
              <tr>
                <td colSpan={5}>No pending challenges.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div>
        <h3>User Moderation</h3>
        <table className="table">
          <thead>
            <tr>
              <th>Username</th>
              <th>Email</th>
              <th>Status</th>
              <th>Wallet</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id}>
                <td>{user.username}</td>
                <td>{user.email}</td>
                <td>{user.is_active ? 'Active' : 'Banned'}</td>
                <td>{formatKES(user.wallet_balance)}</td>
                <td>
                  <button onClick={() => handleToggleBan(user)}>
                    {user.is_active ? 'Ban User' : 'Unban User'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div>
        <h3>Withdrawal Moderation</h3>
        <table className="table">
          <thead>
            <tr>
              <th>User</th>
              <th>Amount</th>
              <th>Status</th>
              <th>Created</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {pendingWithdrawals.map((withdrawal) => (
              <tr key={withdrawal.id}>
                <td>{withdrawal.user_username}</td>
                <td>{formatKES(withdrawal.amount)}</td>
                <td>{withdrawal.status}</td>
                <td>{new Date(withdrawal.created_at).toLocaleString()}</td>
                <td>
                  <button onClick={() => handleWithdrawalAction(withdrawal.id, 'approve')}>
                    <CheckCircle2 size={14} style={{ verticalAlign: 'middle', marginRight: 4 }} /> Approve
                  </button>
                  <button onClick={() => handleWithdrawalAction(withdrawal.id, 'reject')}>
                    <XCircle size={14} style={{ verticalAlign: 'middle', marginRight: 4 }} /> Reject
                  </button>
                </td>
              </tr>
            ))}
            {pendingWithdrawals.length === 0 && (
              <tr>
                <td colSpan={5}>No pending withdrawals.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
