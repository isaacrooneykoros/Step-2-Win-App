import { useEffect, useState } from 'react';
import { adminApi } from '../services/adminApi';
import type { DashboardOverview } from '../types/admin';
import { formatKES } from '../utils/currency';

export function OverviewPage() {
  const [data, setData] = useState<DashboardOverview | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    adminApi
      .getOverview()
      .then(setData)
      .catch((err: Error) => setError(err.message));
  }, []);

  if (error) return <p className="error">{error}</p>;
  if (!data) return <p>Loading overview...</p>;

  return (
    <div className="grid-cards">
      <article className="stat-card">
        <h3>Total Users</h3>
        <p>{data.users.total}</p>
      </article>
      <article className="stat-card">
        <h3>Weekly Active Users</h3>
        <p>{data.users.active_week}</p>
      </article>
      <article className="stat-card">
        <h3>New Users (7d)</h3>
        <p>{data.users.new_week}</p>
      </article>
      <article className="stat-card">
        <h3>Live Challenges</h3>
        <p>{data.challenges.live}</p>
      </article>
      <article className="stat-card">
        <h3>Completed Challenges (30d)</h3>
        <p>{data.challenges.completed_month}</p>
      </article>
      <article className="stat-card">
        <h3>XP Distributed (7d)</h3>
        <p>{data.gamification.xp_distributed_week}</p>
      </article>
      <article className="stat-card">
        <h3>Deposits (7d)</h3>
        <p>{formatKES(data.finance.week_deposits)}</p>
      </article>
      <article className="stat-card">
        <h3>Withdrawals (7d)</h3>
        <p>{formatKES(data.finance.week_withdrawals)}</p>
      </article>
      <article className="stat-card">
        <h3>Pending Withdrawals</h3>
        <p>{formatKES(data.finance.pending_withdrawals)}</p>
      </article>
    </div>
  );
}
