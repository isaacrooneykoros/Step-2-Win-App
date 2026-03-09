import { useEffect, useState, useCallback } from 'react';
import { Download, FileBarChart2, DollarSign, Users, Activity, TrendingUp, Calendar } from 'lucide-react';
import { adminApi } from '../services/adminApi';
import { LineChart, Line, BarChart, Bar, AreaChart, Area, PieChart, Pie, Cell, ResponsiveContainer, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts';
import { formatKES } from '../utils/currency';

interface RevenueReport {
  summary: {
    total_deposits: number;
    total_payouts: number;
    total_withdrawals: number;
    platform_fees: number;
    net_revenue: number;
    deposit_count: number;
    payout_count: number;
    withdrawal_count: number;
  };
  daily_data: Array<{
    date: string;
    revenue: number;
    deposits: number;
  }>;
}

interface RetentionReport {
  summary: {
    total_users: number;
    active_users: number;
    overall_retention: number;
  };
  weekly_data: Array<{
    week_start: string;
    new_users: number;
    active_users: number;
    retention_rate: number;
  }>;
}

interface ChallengeReport {
  summary: {
    total_challenges: number;
    completed: number;
    cancelled: number;
    active: number;
    pending: number;
    completion_rate: number;
    avg_participants: number;
    total_prize_pool: number;
    total_participants: number;
    winners_count: number;
  };
  daily_data: Array<{
    date: string;
    count: number;
  }>;
  status_breakdown: Record<string, number>;
}

interface TransactionReport {
  summary: {
    total_volume: number;
    total_transactions: number;
    total_deposits: number;
    total_payouts: number;
    avg_transaction_value: number;
  };
  daily_data: Array<{
    date: string;
    deposit_amount: number;
    deposit_count: number;
    payout_amount: number;
    payout_count: number;
    total_volume: number;
  }>;
}

export function ReportsPage() {
  const [revenueData, setRevenueData] = useState<RevenueReport | null>(null);
  const [retentionData, setRetentionData] = useState<RetentionReport | null>(null);
  const [challengeData, setChallengeData] = useState<ChallengeReport | null>(null);
  const [transactionData, setTransactionData] = useState<TransactionReport | null>(null);
  const [timePeriod, setTimePeriod] = useState<number>(30);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const loadReports = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [revenue, retention, challenges, transactions] = await Promise.all([
        adminApi.getRevenueReport(timePeriod) as Promise<RevenueReport>,
        adminApi.getUserRetention(timePeriod) as Promise<RetentionReport>,
        adminApi.getChallengeAnalytics(timePeriod) as Promise<ChallengeReport>,
        adminApi.getTransactionTrends(timePeriod) as Promise<TransactionReport>,
      ]);
      setRevenueData(revenue);
      setRetentionData(retention);
      setChallengeData(challenges);
      setTransactionData(transactions);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [timePeriod]);

  useEffect(() => {
    loadReports();
  }, [loadReports]);

  const exportToCSV = (data: Record<string, unknown>[], filename: string) => {
    const headers = Object.keys(data[0] || {});
    const rows = [
      headers,
      ...data.map(row => headers.map(h => row[h] ?? ''))
    ];
    const csv = rows.map(row => row.map(cell => `"${String(cell).replaceAll('"', '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${filename}-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const statusColors: Record<string, string> = {
    pending: '#fbbf24',
    active: '#00f5e9',
    completed: '#22c55e',
    cancelled: '#ef4444',
  };

  if (loading) {
    return (
      <div style={{ padding: '40px', textAlign: 'center', color: '#64748b' }}>
        <Activity size={32} style={{ margin: '0 auto 16px' }} />
        <p>Loading reports...</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h1 style={{ fontSize: '24px', fontWeight: 600, color: '#fff', marginBottom: '4px' }}>
            <FileBarChart2 size={24} style={{ display: 'inline', marginRight: '8px', verticalAlign: 'middle' }} />
            Advanced Reports
          </h1>
          <p style={{ color: '#64748b', fontSize: '14px' }}>
            Comprehensive analytics with revenue, retention, and performance metrics
          </p>
        </div>
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
          <Calendar size={16} style={{ color: '#64748b' }} />
          <select
            value={timePeriod}
            onChange={(e) => setTimePeriod(Number(e.target.value))}
            style={{
              padding: '8px 16px',
              background: '#1a2332',
              border: '1px solid #2d3748',
              borderRadius: '6px',
              color: '#fff',
              cursor: 'pointer',
            }}
          >
            <option value={7}>Last 7 Days</option>
            <option value={30}>Last 30 Days</option>
            <option value={90}>Last 90 Days</option>
            <option value={180}>Last 6 Months</option>
          </select>
        </div>
      </div>

      {error && (
        <div style={{ padding: '12px', background: '#7f1d1d', borderRadius: '6px', color: '#fca5a5' }}>
          {error}
        </div>
      )}

      {/* Revenue Report */}
      {revenueData && (
        <div className="stat-card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
            <h2 style={{ fontSize: '18px', fontWeight: 600, color: '#fff', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <DollarSign size={20} />
              Revenue Analytics
            </h2>
            <button
              onClick={() => exportToCSV(revenueData.daily_data, 'revenue-report')}
              style={{
                padding: '6px 12px',
                background: '#00f5e9',
                color: '#091120',
                border: 'none',
                borderRadius: '6px',
                cursor: 'pointer',
                fontSize: '14px',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
              }}
            >
              <Download size={16} /> Export CSV
            </button>
          </div>

          {/* Summary Cards */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '16px', marginBottom: '24px' }}>
            <div style={{ padding: '16px', background: 'linear-gradient(135deg, #065f46 0%, #064e3b 100%)', borderRadius: '8px' }}>
              <p style={{ color: '#6ee7b7', fontSize: '13px', marginBottom: '4px' }}>Platform Fees</p>
              <p style={{ fontSize: '24px', fontWeight: 700, color: '#fff' }}>
                {formatKES(revenueData.summary.platform_fees)}
              </p>
            </div>
            <div style={{ padding: '16px', background: 'linear-gradient(135deg, #0e7490 0%, #0c4a6e 100%)', borderRadius: '8px' }}>
              <p style={{ color: '#67e8f9', fontSize: '13px', marginBottom: '4px' }}>Total Deposits</p>
              <p style={{ fontSize: '24px', fontWeight: 700, color: '#fff' }}>
                {formatKES(revenueData.summary.total_deposits)}
              </p>
              <p style={{ color: '#a5f3fc', fontSize: '12px' }}>{revenueData.summary.deposit_count} transactions</p>
            </div>
            <div style={{ padding: '16px', background: 'linear-gradient(135deg, #7c2d12 0%, #431407 100%)', borderRadius: '8px' }}>
              <p style={{ color: '#fdba74', fontSize: '13px', marginBottom: '4px' }}>Total Payouts</p>
              <p style={{ fontSize: '24px', fontWeight: 700, color: '#fff' }}>
                {formatKES(revenueData.summary.total_payouts)}
              </p>
              <p style={{ color: '#fed7aa', fontSize: '12px' }}>{revenueData.summary.payout_count} payouts</p>
            </div>
            <div style={{ padding: '16px', background: 'linear-gradient(135deg, #6b21a8 0%, #581c87 100%)', borderRadius: '8px' }}>
              <p style={{ color: '#e9d5ff', fontSize: '13px', marginBottom: '4px' }}>Net Revenue</p>
              <p style={{ fontSize: '24px', fontWeight: 700, color: '#fff' }}>
                {formatKES(revenueData.summary.net_revenue)}
              </p>
            </div>
          </div>

          {/* Revenue Chart */}
          <ResponsiveContainer width="100%" height={300}>
            <AreaChart data={revenueData.daily_data}>
              <defs>
                <linearGradient id="colorRevenue" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#00f5e9" stopOpacity={0.8} />
                  <stop offset="95%" stopColor="#00f5e9" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#2d3748" />
              <XAxis dataKey="date" stroke="#64748b" style={{ fontSize: '12px' }} />
              <YAxis stroke="#64748b" style={{ fontSize: '12px' }} />
              <Tooltip
                contentStyle={{ background: '#1a2332', border: '1px solid #2d3748', borderRadius: '6px' }}
                labelStyle={{ color: '#fff' }}
              />
              <Legend />
              <Area type="monotone" dataKey="revenue" stroke="#00f5e9" fillOpacity={1} fill="url(#colorRevenue)" name="Platform Revenue" />
              <Area type="monotone" dataKey="deposits" stroke="#22c55e" fillOpacity={0.3} fill="#22c55e" name="Total Deposits" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* User Retention Report */}
      {retentionData && (
        <div className="stat-card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
            <h2 style={{ fontSize: '18px', fontWeight: 600, color: '#fff', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Users size={20} />
              User Retention Analysis
            </h2>
            <button
              onClick={() => exportToCSV(retentionData.weekly_data, 'retention-report')}
              style={{
                padding: '6px 12px',
                background: '#00f5e9',
                color: '#091120',
                border: 'none',
                borderRadius: '6px',
                cursor: 'pointer',
                fontSize: '14px',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
              }}
            >
              <Download size={16} /> Export CSV
            </button>
          </div>

          {/* Summary Cards */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '16px', marginBottom: '24px' }}>
            <div style={{ padding: '16px', background: 'linear-gradient(135deg, #1e40af 0%, #1e3a8a 100%)', borderRadius: '8px' }}>
              <p style={{ color: '#93c5fd', fontSize: '13px', marginBottom: '4px' }}>Total Users</p>
              <p style={{ fontSize: '24px', fontWeight: 700, color: '#fff' }}>
                {retentionData.summary.total_users.toLocaleString()}
              </p>
            </div>
            <div style={{ padding: '16px', background: 'linear-gradient(135deg, #065f46 0%, #064e3b 100%)', borderRadius: '8px' }}>
              <p style={{ color: '#6ee7b7', fontSize: '13px', marginBottom: '4px' }}>Active Users</p>
              <p style={{ fontSize: '24px', fontWeight: 700, color: '#fff' }}>
                {retentionData.summary.active_users.toLocaleString()}
              </p>
            </div>
            <div style={{ padding: '16px', background: 'linear-gradient(135deg, #7c2d12 0%, #431407 100%)', borderRadius: '8px' }}>
              <p style={{ color: '#fdba74', fontSize: '13px', marginBottom: '4px' }}>Retention Rate</p>
              <p style={{ fontSize: '24px', fontWeight: 700, color: '#fff' }}>
                {retentionData.summary.overall_retention}%
              </p>
            </div>
          </div>

          {/* Retention Chart */}
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={retentionData.weekly_data}>
              <CartesianGrid strokeDasharray="3 3" stroke="#2d3748" />
              <XAxis dataKey="week_start" stroke="#64748b" style={{ fontSize: '12px' }} />
              <YAxis stroke="#64748b" style={{ fontSize: '12px' }} />
              <Tooltip
                contentStyle={{ background: '#1a2332', border: '1px solid #2d3748', borderRadius: '6px' }}
                labelStyle={{ color: '#fff' }}
              />
              <Legend />
              <Bar dataKey="new_users" fill="#3b82f6" name="New Users" />
              <Bar dataKey="active_users" fill="#22c55e" name="Active Users" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Challenge Analytics */}
      {challengeData && (
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '20px' }}>
          <div className="stat-card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <h2 style={{ fontSize: '18px', fontWeight: 600, color: '#fff', display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Activity size={20} />
                Challenge Performance
              </h2>
              <button
                onClick={() => exportToCSV(challengeData.daily_data, 'challenge-report')}
                style={{
                  padding: '6px 12px',
                  background: '#00f5e9',
                  color: '#091120',
                  border: 'none',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  fontSize: '14px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                }}
              >
                <Download size={16} /> Export CSV
              </button>
            </div>

            {/* Summary Stats */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '12px', marginBottom: '20px' }}>
              <div>
                <p style={{ color: '#64748b', fontSize: '13px' }}>Total Challenges</p>
                <p style={{ fontSize: '20px', fontWeight: 700, color: '#fff' }}>{challengeData.summary.total_challenges}</p>
              </div>
              <div>
                <p style={{ color: '#64748b', fontSize: '13px' }}>Completion Rate</p>
                <p style={{ fontSize: '20px', fontWeight: 700, color: '#22c55e' }}>{challengeData.summary.completion_rate}%</p>
              </div>
              <div>
                <p style={{ color: '#64748b', fontSize: '13px' }}>Total Participants</p>
                <p style={{ fontSize: '20px', fontWeight: 700, color: '#fff' }}>{challengeData.summary.total_participants}</p>
              </div>
            </div>

            {/* Daily Challenge Creation Chart */}
            <ResponsiveContainer width="100%" height={250}>
              <LineChart data={challengeData.daily_data}>
                <CartesianGrid strokeDasharray="3 3" stroke="#2d3748" />
                <XAxis dataKey="date" stroke="#64748b" style={{ fontSize: '12px' }} />
                <YAxis stroke="#64748b" style={{ fontSize: '12px' }} />
                <Tooltip
                  contentStyle={{ background: '#1a2332', border: '1px solid #2d3748', borderRadius: '6px' }}
                  labelStyle={{ color: '#fff' }}
                />
                <Line type="monotone" dataKey="count" stroke="#00f5e9" strokeWidth={2} name="Challenges Created" />
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* Status Breakdown Pie Chart */}
          <div className="stat-card">
            <h3 style={{ fontSize: '16px', fontWeight: 600, marginBottom: '16px', color: '#fff' }}>
              Status Distribution
            </h3>
            <ResponsiveContainer width="100%" height={300}>
              <PieChart>
                <Pie
                  data={Object.entries(challengeData.status_breakdown).map(([name, value]) => ({ name, value }))}
                  cx="50%"
                  cy="50%"
                  labelLine={false}
                  label={({ name, percent }) => `${name} ${((percent || 0) * 100).toFixed(0)}%`}
                  outerRadius={80}
                  fill="#8884d8"
                  dataKey="value"
                >
                  {Object.keys(challengeData.status_breakdown).map((key) => (
                    <Cell key={key} fill={statusColors[key] || '#94a3b8'} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{ background: '#1a2332', border: '1px solid #2d3748', borderRadius: '6px' }}
                />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Transaction Trends */}
      {transactionData && (
        <div className="stat-card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
            <h2 style={{ fontSize: '18px', fontWeight: 600, color: '#fff', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <TrendingUp size={20} />
              Transaction Trends
            </h2>
            <button
              onClick={() => exportToCSV(transactionData.daily_data, 'transaction-report')}
              style={{
                padding: '6px 12px',
                background: '#00f5e9',
                color: '#091120',
                border: 'none',
                borderRadius: '6px',
                cursor: 'pointer',
                fontSize: '14px',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
              }}
            >
              <Download size={16} /> Export CSV
            </button>
          </div>

          {/* Summary Cards */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '12px', marginBottom: '24px' }}>
            <div style={{ padding: '12px', background: '#1a2332', borderRadius: '6px', borderLeft: '3px solid #22c55e' }}>
              <p style={{ color: '#64748b', fontSize: '12px' }}>Total Volume</p>
              <p style={{ fontSize: '18px', fontWeight: 700, color: '#fff' }}>
                {formatKES(transactionData.summary.total_volume)}
              </p>
            </div>
            <div style={{ padding: '12px', background: '#1a2332', borderRadius: '6px', borderLeft: '3px solid #3b82f6' }}>
              <p style={{ color: '#64748b', fontSize: '12px' }}>Total Transactions</p>
              <p style={{ fontSize: '18px', fontWeight: 700, color: '#fff' }}>
                {transactionData.summary.total_transactions.toLocaleString()}
              </p>
            </div>
            <div style={{ padding: '12px', background: '#1a2332', borderRadius: '6px', borderLeft: '3px solid #fbbf24' }}>
              <p style={{ color: '#64748b', fontSize: '12px' }}>Avg Transaction</p>
              <p style={{ fontSize: '18px', fontWeight: 700, color: '#fff' }}>
                {formatKES(transactionData.summary.avg_transaction_value)}
              </p>
            </div>
          </div>

          {/* Transaction Volume Chart */}
          <ResponsiveContainer width="100%" height={300}>
            <AreaChart data={transactionData.daily_data}>
              <defs>
                <linearGradient id="colorDeposits" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#22c55e" stopOpacity={0.8} />
                  <stop offset="95%" stopColor="#22c55e" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="colorPayouts" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.8} />
                  <stop offset="95%" stopColor="#f59e0b" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#2d3748" />
              <XAxis dataKey="date" stroke="#64748b" style={{ fontSize: '12px' }} />
              <YAxis stroke="#64748b" style={{ fontSize: '12px' }} />
              <Tooltip
                contentStyle={{ background: '#1a2332', border: '1px solid #2d3748', borderRadius: '6px' }}
                labelStyle={{ color: '#fff' }}
              />
              <Legend />
              <Area type="monotone" dataKey="deposit_amount" stroke="#22c55e" fillOpacity={1} fill="url(#colorDeposits)" name="Deposits" />
              <Area type="monotone" dataKey="payout_amount" stroke="#f59e0b" fillOpacity={1} fill="url(#colorPayouts)" name="Payouts" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
