import { useEffect, useMemo, useState } from 'react';
import { adminApi } from '../services/adminApi';
import type { AdminChallenge, AdminTransaction, AdminUser, AdminWithdrawal, DashboardOverview } from '../types/admin';
import { LineChart, Line, BarChart, Bar, PieChart, Pie, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, Cell } from 'recharts';
import { TrendingUp, Users, DollarSign, Activity } from 'lucide-react';
import { formatKES } from '../utils/currency';

type Timeframe = 'week' | 'month' | 'all';

export function AnalyticsPage() {
  const [overview, setOverview] = useState<DashboardOverview | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [challenges, setChallenges] = useState<AdminChallenge[]>([]);
  const [transactions, setTransactions] = useState<AdminTransaction[]>([]);
  const [withdrawals, setWithdrawals] = useState<AdminWithdrawal[]>([]);
  const [timeframe, setTimeframe] = useState<Timeframe>('month');
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([
      adminApi.getOverview(),
      adminApi.getUsers(),
      adminApi.getChallenges(),
      adminApi.getTransactions(),
      adminApi.getWithdrawals(),
    ])
      .then(([overviewData, usersData, challengesData, transactionsData, withdrawalsData]) => {
        setOverview(overviewData);
        setUsers(usersData);
        setChallenges(challengesData);
        setTransactions(transactionsData);
        setWithdrawals(withdrawalsData);
      })
      .catch((err: Error) => setError(err.message));
  }, []);

  const metrics = useMemo(() => {
    const now = new Date();
    const cutoff = new Date(now);

    if (timeframe === 'week') {
      cutoff.setDate(now.getDate() - 7);
    } else if (timeframe === 'month') {
      cutoff.setDate(now.getDate() - 30);
    } else {
      cutoff.setFullYear(2000);
    }

    const filteredTx = transactions.filter((tx) => new Date(tx.created_at) >= cutoff);
    const filteredW = withdrawals.filter((w) => new Date(w.created_at) >= cutoff);

    const totalVolume = filteredTx.reduce((sum, tx) => sum + Number(tx.amount), 0);
    const deposits = filteredTx.filter((tx) => tx.type === 'deposit').reduce((sum, tx) => sum + Number(tx.amount), 0);
    const payouts = filteredTx.filter((tx) => tx.type === 'payout').reduce((sum, tx) => sum + Number(tx.amount), 0);
    const withdrawalsAmount = filteredW.reduce((sum, w) => sum + Number(w.amount), 0);

    const activeUsers = users.filter((u) => u.is_active).length;
    const suspendedUsers = users.length - activeUsers;
    const pendingChallenges = challenges.filter((c) => c.status === 'pending').length;
    const activeChallenges = challenges.filter((c) => c.status === 'active').length;
    const completedChallenges = challenges.filter((c) => c.status === 'completed').length;

    return {
      totalVolume,
      deposits,
      payouts,
      withdrawalsAmount,
      activeUsers,
      suspendedUsers,
      pendingChallenges,
      activeChallenges,
      completedChallenges,
    };
  }, [transactions, withdrawals, users, challenges, timeframe]);

  // Chart data transformations
  const transactionTrendData = useMemo(() => {
    const now = new Date();
    const days = timeframe === 'week' ? 7 : timeframe === 'month' ? 30 : 90;
    const data: { date: string; deposits: number; payouts: number; withdrawals: number }[] = [];

    for (let i = days - 1; i >= 0; i--) {
      const targetDate = new Date(now);
      targetDate.setDate(now.getDate() - i);
      const dateStr = targetDate.toISOString().split('T')[0];

      const dayDeposits = transactions
        .filter((tx) => tx.type === 'deposit' && tx.created_at.startsWith(dateStr))
        .reduce((sum, tx) => sum + Number(tx.amount), 0);

      const dayPayouts = transactions
        .filter((tx) => tx.type === 'payout' && tx.created_at.startsWith(dateStr))
        .reduce((sum, tx) => sum + Number(tx.amount), 0);

      const dayWithdrawals = withdrawals
        .filter((w) => w.created_at.startsWith(dateStr))
        .reduce((sum, w) => sum + Number(w.amount), 0);

      data.push({
        date: targetDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        deposits: Number(dayDeposits.toFixed(2)),
        payouts: Number(dayPayouts.toFixed(2)),
        withdrawals: Number(dayWithdrawals.toFixed(2)),
      });
    }

    return data;
  }, [transactions, withdrawals, timeframe]);

  const userGrowthData = useMemo(() => {
    const now = new Date();
    const days = timeframe === 'week' ? 7 : timeframe === 'month' ? 30 : 90;
    const data: { date: string; newUsers: number; totalUsers: number }[] = [];

    for (let i = days - 1; i >= 0; i--) {
      const targetDate = new Date(now);
      targetDate.setDate(now.getDate() - i);
      const dateStr = targetDate.toISOString().split('T')[0];

      const newUsersCount = users.filter((u) => u.created_at?.startsWith(dateStr)).length;
      const totalUsersUntilDate = users.filter((u) => new Date(u.created_at || '') <= targetDate).length;

      data.push({
        date: targetDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        newUsers: newUsersCount,
        totalUsers: totalUsersUntilDate,
      });
    }

    return data;
  }, [users, timeframe]);

  const challengeStatusData = useMemo(() => {
    return [
      { name: 'Pending', value: metrics.pendingChallenges, color: '#fbbf24' },
      { name: 'Active', value: metrics.activeChallenges, color: '#00f5e9' },
      { name: 'Completed', value: metrics.completedChallenges, color: '#22c55e' },
      { name: 'Cancelled', value: challenges.filter((c) => c.status === 'cancelled').length, color: '#ef4444' },
    ];
  }, [metrics, challenges]);

  const revenueBreakdownData = useMemo(() => {
    return [
      { category: 'Deposits', amount: metrics.deposits },
      { category: 'Payouts', amount: metrics.payouts },
      { category: 'Withdrawals', amount: metrics.withdrawalsAmount },
    ];
  }, [metrics]);

  if (error) {
    return <p className="error">{error}</p>;
  }

  if (!overview) {
    return <p>Loading analytics...</p>;
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 style={{ fontSize: '24px', fontWeight: 600, color: '#fff' }}>Analytics Dashboard</h1>
        <div className="filters" style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <label htmlFor="timeframe" style={{ color: '#64748b' }}>Timeframe</label>
          <select 
            id="timeframe" 
            value={timeframe} 
            onChange={(event) => setTimeframe(event.target.value as Timeframe)}
            style={{ 
              padding: '8px 12px', 
              borderRadius: '6px', 
              background: '#1a2332', 
              border: '1px solid #2d3748',
              color: '#fff',
              cursor: 'pointer'
            }}
          >
            <option value="week">Last 7 days</option>
            <option value="month">Last 30 days</option>
            <option value="all">All time</option>
          </select>
        </div>
      </div>

      {/* Key Metrics Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: '16px' }}>
        <article className="stat-card" style={{ background: 'linear-gradient(135deg, #1e3a8a 0%, #1e40af 100%)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div>
              <h3 style={{ fontSize: '14px', color: '#93c5fd', marginBottom: '8px' }}>Transaction Volume</h3>
              <p style={{ fontSize: '28px', fontWeight: 700, color: '#fff' }}>{formatKES(metrics.totalVolume)}</p>
            </div>
            <DollarSign size={32} color="#60a5fa" />
          </div>
        </article>

        <article className="stat-card" style={{ background: 'linear-gradient(135deg, #065f46 0%, #047857 100%)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div>
              <h3 style={{ fontSize: '14px', color: '#6ee7b7', marginBottom: '8px' }}>Deposits</h3>
              <p style={{ fontSize: '28px', fontWeight: 700, color: '#fff' }}>{formatKES(metrics.deposits)}</p>
            </div>
            <TrendingUp size={32} color="#34d399" />
          </div>
        </article>

        <article className="stat-card" style={{ background: 'linear-gradient(135deg, #7c2d12 0%, #9a3412 100%)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div>
              <h3 style={{ fontSize: '14px', color: '#fca5a5', marginBottom: '8px' }}>Payouts</h3>
              <p style={{ fontSize: '28px', fontWeight: 700, color: '#fff' }}>{formatKES(metrics.payouts)}</p>
            </div>
            <TrendingUp size={32} color="#f87171" style={{ transform: 'rotate(180deg)' }} />
          </div>
        </article>

        <article className="stat-card" style={{ background: 'linear-gradient(135deg, #0e7490 0%, #0891b2 100%)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div>
              <h3 style={{ fontSize: '14px', color: '#67e8f9', marginBottom: '8px' }}>Active Users</h3>
              <p style={{ fontSize: '28px', fontWeight: 700, color: '#fff' }}>{metrics.activeUsers}</p>
            </div>
            <Users size={32} color="#22d3ee" />
          </div>
        </article>
      </div>

      {/* Transaction Trends Chart */}
      <div className="stat-card">
        <h3 style={{ fontSize: '18px', fontWeight: 600, marginBottom: '20px', color: '#fff' }}>
          <Activity size={20} style={{ display: 'inline', marginRight: '8px', verticalAlign: 'middle' }} />
          Transaction Trends
        </h3>
        <ResponsiveContainer width="100%" height={300}>
          <AreaChart data={transactionTrendData}>
            <defs>
              <linearGradient id="colorDeposits" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#22c55e" stopOpacity={0.3}/>
                <stop offset="95%" stopColor="#22c55e" stopOpacity={0}/>
              </linearGradient>
              <linearGradient id="colorPayouts" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#ef4444" stopOpacity={0.3}/>
                <stop offset="95%" stopColor="#ef4444" stopOpacity={0}/>
              </linearGradient>
              <linearGradient id="colorWithdrawals" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#fbbf24" stopOpacity={0.3}/>
                <stop offset="95%" stopColor="#fbbf24" stopOpacity={0}/>
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#2d3748" />
            <XAxis dataKey="date" stroke="#64748b" />
            <YAxis stroke="#64748b" />
            <Tooltip 
              contentStyle={{ background: '#1a2332', border: '1px solid #2d3748', borderRadius: '6px' }}
              labelStyle={{ color: '#fff' }}
            />
            <Legend />
            <Area type="monotone" dataKey="deposits" stroke="#22c55e" fillOpacity={1} fill="url(#colorDeposits)" />
            <Area type="monotone" dataKey="payouts" stroke="#ef4444" fillOpacity={1} fill="url(#colorPayouts)" />
            <Area type="monotone" dataKey="withdrawals" stroke="#fbbf24" fillOpacity={1} fill="url(#colorWithdrawals)" />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* Charts Grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(400px, 1fr))', gap: '16px' }}>
        {/* User Growth Chart */}
        <div className="stat-card">
          <h3 style={{ fontSize: '18px', fontWeight: 600, marginBottom: '20px', color: '#fff' }}>User Growth</h3>
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={userGrowthData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#2d3748" />
              <XAxis dataKey="date" stroke="#64748b" />
              <YAxis stroke="#64748b" />
              <Tooltip 
                contentStyle={{ background: '#1a2332', border: '1px solid #2d3748', borderRadius: '6px' }}
                labelStyle={{ color: '#fff' }}
              />
              <Legend />
              <Line type="monotone" dataKey="newUsers" stroke="#00f5e9" strokeWidth={2} name="New Users" />
              <Line type="monotone" dataKey="totalUsers" stroke="#60a5fa" strokeWidth={2} name="Total Users" />
            </LineChart>
          </ResponsiveContainer>
        </div>

        {/* Challenge Status Distribution */}
        <div className="stat-card">
          <h3 style={{ fontSize: '18px', fontWeight: 600, marginBottom: '20px', color: '#fff' }}>Challenge Distribution</h3>
          <ResponsiveContainer width="100%" height={300}>
            <PieChart>
              <Pie
                data={challengeStatusData}
                cx="50%"
                cy="50%"
                labelLine={false}
                label={({ name, value }) => `${name}: ${value}`}
                outerRadius={100}
                fill="#8884d8"
                dataKey="value"
              >
                {challengeStatusData.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={entry.color} />
                ))}
              </Pie>
              <Tooltip 
                contentStyle={{ background: '#1a2332', border: '1px solid #2d3748', borderRadius: '6px' }}
              />
            </PieChart>
          </ResponsiveContainer>
        </div>

        {/* Revenue Breakdown */}
        <div className="stat-card">
          <h3 style={{ fontSize: '18px', fontWeight: 600, marginBottom: '20px', color: '#fff' }}>Revenue Breakdown</h3>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={revenueBreakdownData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#2d3748" />
              <XAxis dataKey="category" stroke="#64748b" />
              <YAxis stroke="#64748b" />
              <Tooltip 
                contentStyle={{ background: '#1a2332', border: '1px solid #2d3748', borderRadius: '6px' }}
                labelStyle={{ color: '#fff' }}
              />
              <Bar dataKey="amount" fill="#00f5e9" />
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Additional Metrics */}
        <div className="stat-card">
          <h3 style={{ fontSize: '18px', fontWeight: 600, marginBottom: '20px', color: '#fff' }}>Additional Metrics</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '12px', background: '#1a2332', borderRadius: '6px' }}>
              <span style={{ color: '#64748b' }}>Pending Challenges</span>
              <span style={{ color: '#fbbf24', fontWeight: 600 }}>{metrics.pendingChallenges}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '12px', background: '#1a2332', borderRadius: '6px' }}>
              <span style={{ color: '#64748b' }}>Active Challenges</span>
              <span style={{ color: '#00f5e9', fontWeight: 600 }}>{metrics.activeChallenges}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '12px', background: '#1a2332', borderRadius: '6px' }}>
              <span style={{ color: '#64748b' }}>Completed Challenges</span>
              <span style={{ color: '#22c55e', fontWeight: 600 }}>{metrics.completedChallenges}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '12px', background: '#1a2332', borderRadius: '6px' }}>
              <span style={{ color: '#64748b' }}>Suspended Users</span>
              <span style={{ color: '#ef4444', fontWeight: 600 }}>{metrics.suspendedUsers}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '12px', background: '#1a2332', borderRadius: '6px' }}>
              <span style={{ color: '#64748b' }}>Weekly Active Users</span>
              <span style={{ color: '#60a5fa', fontWeight: 600 }}>{overview.users.active_week}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '12px', background: '#1a2332', borderRadius: '6px' }}>
              <span style={{ color: '#64748b' }}>New Users (Week)</span>
              <span style={{ color: '#34d399', fontWeight: 600 }}>{overview.users.new_week}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
