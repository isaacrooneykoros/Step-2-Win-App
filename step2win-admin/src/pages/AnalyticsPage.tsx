import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { format } from 'date-fns'
import {
  ResponsiveContainer,
  CartesianGrid,
  Tooltip,
  XAxis,
  YAxis,
  Radar,
  RadarChart,
  PolarGrid,
  PolarAngleAxis,
  PolarRadiusAxis,
  RadialBarChart,
  RadialBar,
  ScatterChart,
  Scatter,
  Treemap,
  ComposedChart,
  Bar,
  Line,
} from 'recharts'
import { adminApi } from '../services/adminApi'
import type {
  AdminChallenge,
  AdminTransaction,
  AdminUser,
  AdminWithdrawal,
  DashboardOverview,
} from '../types/admin'
import { formatKES } from '../utils/currency'
import { Download, RefreshCw, ArrowRight } from 'lucide-react'

type Timeframe = 'week' | 'month' | 'all'

function transactionTypeLabel(type: string): string {
  switch (type) {
    case 'deposit':
      return 'Wallet Top-ups'
    case 'withdrawal':
      return 'M-Pesa/Bank Withdrawals'
    case 'challenge_entry':
      return 'Challenge Entry Fees'
    case 'payout':
      return 'Challenge Payouts'
    case 'fee':
      return 'Platform Fees'
    case 'refund':
      return 'Refunds'
    default:
      return type.replace('_', ' ')
  }
}

function Card({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-surface-border bg-[#0C1117] p-4">
      <h3 className="text-sm font-semibold text-ink-primary">{title}</h3>
      {subtitle && <p className="mt-0.5 text-[11px] text-ink-muted">{subtitle}</p>}
      <div className="mt-3">{children}</div>
    </section>
  )
}

export function AnalyticsPage() {
  const navigate = useNavigate()
  const [overview, setOverview] = useState<DashboardOverview | null>(null)
  const [users, setUsers] = useState<AdminUser[]>([])
  const [challenges, setChallenges] = useState<AdminChallenge[]>([])
  const [transactions, setTransactions] = useState<AdminTransaction[]>([])
  const [withdrawals, setWithdrawals] = useState<AdminWithdrawal[]>([])
  const [timeframe, setTimeframe] = useState<Timeframe>('month')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const loadAnalytics = () => {
    setLoading(true)
    Promise.all([
      adminApi.getOverview(timeframe === 'week' ? 7 : timeframe === 'month' ? 30 : 90),
      adminApi.getUsers(),
      adminApi.getChallenges(),
      adminApi.getTransactions(),
      adminApi.getWithdrawals(),
    ])
      .then(([overviewData, usersData, challengesData, transactionsData, withdrawalsData]) => {
        setError('')
        setOverview(overviewData)
        setUsers(usersData)
        setChallenges(challengesData)
        setTransactions(transactionsData)
        setWithdrawals(withdrawalsData)
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    loadAnalytics()
  }, [timeframe])

  const days = timeframe === 'week' ? 7 : timeframe === 'month' ? 30 : 90

  const filteredTransactions = useMemo(() => {
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - days)
    return transactions.filter((tx) => new Date(tx.created_at) >= cutoff)
  }, [transactions, days])

  const filteredWithdrawals = useMemo(() => {
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - days)
    return withdrawals.filter((w) => new Date(w.created_at) >= cutoff)
  }, [withdrawals, days])

  const summary = useMemo(() => {
    const deposits = filteredTransactions
      .filter((tx) => tx.type === 'deposit')
      .reduce((sum, tx) => sum + Number(tx.amount), 0)
    const payouts = filteredTransactions
      .filter((tx) => tx.type === 'payout')
      .reduce((sum, tx) => sum + Number(tx.amount), 0)
    const withdrawalAmount = filteredWithdrawals.reduce((sum, w) => sum + Number(w.amount), 0)

    const totalOrders = filteredTransactions.length + filteredWithdrawals.length
    const successRate = filteredWithdrawals.length
      ? Math.round((filteredWithdrawals.filter((w) => w.status === 'approved' || w.status === 'processing').length / filteredWithdrawals.length) * 100)
      : 100

    const activeUsers = overview?.users?.active_week ?? users.filter((u) => u.is_active).length
    const completedChallenges = overview?.challenges?.completed_month ?? challenges.filter((c) => c.status === 'completed').length

    return {
      deposits,
      payouts,
      withdrawalAmount,
      revenue: Math.max(0, deposits - payouts),
      totalOrders,
      successRate,
      activeUsers,
      completedChallenges,
    }
  }, [challenges, filteredTransactions, filteredWithdrawals, overview?.challenges?.completed_month, overview?.users?.active_week, users])

  const radarData = useMemo(() => {
    const totalUsers = Math.max(overview?.users?.total ?? users.length, 1)
    const totalChallengesFromOverview =
      (overview?.challenges_active ?? 0) +
      (overview?.challenges_pending ?? 0) +
      (overview?.challenges_completed ?? 0)
    const totalChallenges = Math.max(totalChallengesFromOverview || challenges.length, 1)
    const approvedOrProcessed = filteredWithdrawals.filter(
      (w) => w.status === 'approved' || w.status === 'processing'
    ).length
    const withdrawalApprovalRate = filteredWithdrawals.length
      ? (approvedOrProcessed / filteredWithdrawals.length) * 100
      : 0
    const marginRate = summary.deposits > 0
      ? (summary.revenue / summary.deposits) * 100
      : 0
    const payoutCoverage = (summary.payouts + summary.withdrawalAmount) > 0
      ? (summary.deposits / (summary.payouts + summary.withdrawalAmount)) * 100
      : 0

    return [
      { metric: 'Active Users', value: Math.max(0, Math.min(100, Math.round((summary.activeUsers / totalUsers) * 100))) },
      { metric: 'New User Share', value: Math.max(0, Math.min(100, Math.round(((overview?.users?.new_week ?? 0) / totalUsers) * 100))) },
      { metric: 'Challenge Ops', value: Math.max(0, Math.min(100, Math.round((summary.completedChallenges / totalChallenges) * 100))) },
      { metric: 'Withdrawal Approval', value: Math.max(0, Math.min(100, Math.round(withdrawalApprovalRate))) },
      { metric: 'Margin Rate', value: Math.max(0, Math.min(100, Math.round(marginRate))) },
      { metric: 'Payout Coverage', value: Math.max(0, Math.min(100, Math.round(payoutCoverage))) },
    ]
  }, [challenges.length, filteredWithdrawals, overview?.challenges_active, overview?.challenges_completed, overview?.challenges_pending, overview?.users?.new_week, overview?.users?.total, summary.activeUsers, summary.completedChallenges, summary.deposits, summary.payouts, summary.revenue, summary.withdrawalAmount, users.length])

  const transactionMixData = useMemo(() => {
    const totals = filteredTransactions.reduce<Record<string, number>>((acc, tx) => {
      const key = tx.type
      acc[key] = (acc[key] ?? 0) + Number(tx.amount)
      return acc
    }, {})
    const totalAmount = Object.values(totals).reduce((sum, value) => sum + value, 0)
    const palette = ['#22C55E', '#06B6D4', '#F59E0B', '#EF4444', '#8B5CF6', '#818CF8']

    return Object.entries(totals)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([name, value], index) => ({
        name: transactionTypeLabel(name),
        value: totalAmount > 0 ? Number(((value / totalAmount) * 100).toFixed(1)) : 0,
        fill: palette[index % palette.length],
      }))
  }, [filteredTransactions])

  const scatterData = useMemo(() => {
    const points = filteredTransactions.slice(-18).map((tx, idx) => {
      const amount = Number(tx.amount)
      return {
        x: idx + 1,
        y: Number((amount / 1000).toFixed(2)),
        z: tx.type === 'deposit' ? 180 : 120,
      }
    })
    return points.length ? points : [{ x: 1, y: 0.1, z: 120 }]
  }, [filteredTransactions])

  const allocationTree = useMemo(() => {
    const challengeEntry = filteredTransactions
      .filter((tx) => tx.type === 'challenge_entry')
      .reduce((sum, tx) => sum + Number(tx.amount), 0)
    const fee = filteredTransactions
      .filter((tx) => tx.type === 'fee')
      .reduce((sum, tx) => sum + Number(tx.amount), 0)

    return [
      { name: 'Wallet Top-ups', size: Math.max(1, Number(summary.deposits.toFixed(2))), fill: '#22C55E' },
      { name: 'Challenge Payouts', size: Math.max(1, Number(summary.payouts.toFixed(2))), fill: '#06B6D4' },
      { name: 'M-Pesa/Bank Withdrawals', size: Math.max(1, Number(summary.withdrawalAmount.toFixed(2))), fill: '#F59E0B' },
      { name: 'Challenge Entry Fees', size: Math.max(1, Number(challengeEntry.toFixed(2))), fill: '#EF4444' },
      { name: 'Platform Fees', size: Math.max(1, Number(fee.toFixed(2))), fill: '#8B5CF6' },
    ]
  }, [filteredTransactions, summary.deposits, summary.payouts, summary.withdrawalAmount])

  const trendData = useMemo(() => {
    const orderByDay = filteredTransactions.reduce<Record<string, number>>((acc, tx) => {
      const key = format(new Date(tx.created_at), 'MMM dd')
      acc[key] = (acc[key] ?? 0) + 1
      return acc
    }, {})

    if (overview?.revenue_chart?.length) {
      return overview.revenue_chart.map((item) => ({
        label: item.date,
        revenue: Math.max(0, Number(item.deposits) - Number(item.withdrawals)),
        orders: orderByDay[item.date] ?? 0,
      }))
    }

    const labels = Array.from({ length: days }, (_, index) => {
      const date = new Date()
      date.setDate(date.getDate() - (days - index - 1))
      return format(date, 'MMM dd')
    })

    return labels.map((label) => ({ label, revenue: 0, orders: orderByDay[label] ?? 0 }))
  }, [days, filteredTransactions, overview])

  const exportSummaryCSV = () => {
    const rows = [
      ['section', 'metric', 'value'],
      ['overview', 'total_users', overview?.users?.total ?? ''],
      ['overview', 'active_week', overview?.users?.active_week ?? ''],
      ['overview', 'new_week', overview?.users?.new_week ?? ''],
      ['overview', 'live_challenges', overview?.challenges?.live ?? ''],
      ['overview', 'week_deposits', overview?.finance?.week_deposits ?? ''],
      ['overview', 'week_withdrawals', overview?.finance?.week_withdrawals ?? ''],
      ['summary', 'revenue', summary.revenue],
      ['summary', 'deposits', summary.deposits],
      ['summary', 'payouts', summary.payouts],
      ['summary', 'withdrawal_amount', summary.withdrawalAmount],
      ['summary', 'total_orders', summary.totalOrders],
      ['summary', 'success_rate', summary.successRate],
    ]
    const csv = rows.map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `analytics-summary-${new Date().toISOString().slice(0, 10)}.csv`
    link.click()
    URL.revokeObjectURL(url)
  }

  if (error) {
    return <p className="text-down">{error}</p>
  }

  if (!overview) {
    return <p className="text-ink-secondary">Loading analytics...</p>
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-ink-primary">Charts</h1>
          <p className="text-xs text-ink-muted">Operational analytics based on live Step2Win activity</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap justify-end">
          <button
            type="button"
            onClick={() => loadAnalytics()}
            className="inline-flex items-center gap-2 rounded-xl border border-surface-border bg-[#0C1117] px-3 py-2 text-xs font-semibold text-ink-secondary hover:text-ink-primary"
          >
            <RefreshCw size={14} /> Refresh
          </button>
          <button
            type="button"
            onClick={exportSummaryCSV}
            className="inline-flex items-center gap-2 rounded-xl border border-surface-border bg-[#0C1117] px-3 py-2 text-xs font-semibold text-ink-secondary hover:text-ink-primary"
          >
            <Download size={14} /> Summary CSV
          </button>
          <button
            type="button"
            onClick={() => navigate('/transactions')}
            className="inline-flex items-center gap-2 rounded-xl border border-surface-border bg-[#0C1117] px-3 py-2 text-xs font-semibold text-ink-secondary hover:text-ink-primary"
          >
            Transactions <ArrowRight size={14} />
          </button>
          <button
            type="button"
            onClick={() => navigate('/withdrawals')}
            className="inline-flex items-center gap-2 rounded-xl border border-surface-border bg-[#0C1117] px-3 py-2 text-xs font-semibold text-ink-secondary hover:text-ink-primary"
          >
            Withdrawals <ArrowRight size={14} />
          </button>
          <button
            type="button"
            onClick={() => navigate('/reports')}
            className="inline-flex items-center gap-2 rounded-xl border border-surface-border bg-[#0C1117] px-3 py-2 text-xs font-semibold text-ink-secondary hover:text-ink-primary"
          >
            Reports <ArrowRight size={14} />
          </button>
          <div className="flex items-center gap-1 rounded-xl border border-surface-border bg-[#0C1117] p-1">
            {([
              { key: 'week', label: '7D' },
              { key: 'month', label: '30D' },
              { key: 'all', label: '90D' },
            ] as const).map((option) => (
              <button
                key={option.key}
                onClick={() => setTimeframe(option.key)}
                className="rounded-lg px-3 py-1.5 text-xs font-semibold transition"
                style={{
                  background: timeframe === option.key ? '#151A25' : 'transparent',
                  color: timeframe === option.key ? '#F0F2F8' : '#7B82A0',
                }}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {loading && (
        <div className="rounded-xl border border-surface-border bg-[#0C1117] px-4 py-3 text-xs text-ink-muted">
          Refreshing analytics...
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <div className="xl:col-span-2">
          <Card title="Team Skills Assessment" subtitle="Current KPI readiness across key areas">
            <ResponsiveContainer width="100%" height={230}>
              <RadarChart data={radarData}>
                <PolarGrid stroke="#1F2937" />
                <PolarAngleAxis dataKey="metric" tick={{ fill: '#7B82A0', fontSize: 11 }} />
                <PolarRadiusAxis domain={[0, 100]} tick={{ fill: '#3D4260', fontSize: 10 }} />
                <Radar name="Score" dataKey="value" stroke="#22C55E" fill="#22C55E" fillOpacity={0.35} />
              </RadarChart>
            </ResponsiveContainer>
          </Card>
        </div>

        <Card title="Transaction Mix" subtitle="Share by value across wallet and challenge flows">
          <ResponsiveContainer width="100%" height={200}>
            <RadialBarChart data={transactionMixData} innerRadius="20%" outerRadius="90%" barSize={10}>
              <RadialBar background dataKey="value" cornerRadius={8} />
              <Tooltip
                contentStyle={{ background: '#191C28', border: '1px solid #21263A', borderRadius: 10 }}
                formatter={(value: unknown, name: unknown) => [`${Number(value ?? 0)}%`, String(name ?? '')]}
              />
            </RadialBarChart>
          </ResponsiveContainer>
          <div className="mt-1 space-y-1">
            {transactionMixData.map((entry) => (
              <div key={entry.name} className="flex items-center justify-between text-xs">
                <span className="flex items-center gap-2 text-ink-secondary">
                  <span className="h-2 w-2 rounded-full" style={{ background: entry.fill }} />
                  {entry.name}
                </span>
                <span className="mono text-ink-primary">{entry.value}%</span>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <div className="xl:col-span-2">
          <Card title="Transaction Size Distribution" subtitle="Recent transaction amounts (KSh thousands)">
            <ResponsiveContainer width="100%" height={200}>
              <ScatterChart>
                <CartesianGrid stroke="#1F2937" strokeDasharray="3 3" />
                <XAxis dataKey="x" tick={{ fill: '#7B82A0', fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis dataKey="y" tick={{ fill: '#7B82A0', fontSize: 11 }} axisLine={false} tickLine={false} />
                <Tooltip
                  cursor={{ strokeDasharray: '3 3' }}
                  contentStyle={{ background: '#191C28', border: '1px solid #21263A', borderRadius: 10 }}
                  formatter={(value: unknown) => [`KSh ${Number(value ?? 0).toFixed(2)}k`, 'Value']}
                />
                <Scatter data={scatterData} fill="#22C55E" />
              </ScatterChart>
            </ResponsiveContainer>
          </Card>
        </div>

        <Card title="Cashflow Allocation" subtitle="Breakdown of live KSh movement by category">
          <ResponsiveContainer width="100%" height={200}>
            <Treemap data={allocationTree} dataKey="size" stroke="#0C1117" fill="#22C55E" />
          </ResponsiveContainer>
          <div className="mt-1 grid grid-cols-2 gap-1">
            {allocationTree.map((item) => (
              <p key={item.name} className="text-[11px] text-ink-secondary">
                {item.name}: <span className="mono text-ink-primary">{formatKES(item.size)}</span>
              </p>
            ))}
          </div>
        </Card>
      </div>

      <Card title="Net Margin & Transaction Trend" subtitle="Derived from deposits, payouts, withdrawals and order volume">
        <ResponsiveContainer width="100%" height={220}>
          <ComposedChart data={trendData}>
            <CartesianGrid stroke="#1F2937" strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="label" tick={{ fill: '#7B82A0', fontSize: 11 }} axisLine={false} tickLine={false} />
            <YAxis yAxisId="left" tick={{ fill: '#7B82A0', fontSize: 11 }} axisLine={false} tickLine={false} />
            <YAxis yAxisId="right" orientation="right" tick={{ fill: '#7B82A0', fontSize: 11 }} axisLine={false} tickLine={false} />
            <Tooltip
              contentStyle={{ background: '#191C28', border: '1px solid #21263A', borderRadius: 10 }}
              formatter={(value: unknown, name: unknown) => {
                if (name === 'revenue') return [formatKES(Number(value ?? 0)), 'Net Platform Margin']
                return [String(value ?? 0), 'Transactions']
              }}
            />
            <Bar yAxisId="right" dataKey="orders" fill="#06B6D4" radius={[4, 4, 0, 0]} />
            <Line yAxisId="left" type="monotone" dataKey="revenue" stroke="#22C55E" strokeWidth={2.2} dot={false} />
          </ComposedChart>
        </ResponsiveContainer>
        <div className="mt-2 grid grid-cols-2 gap-2 text-xs md:grid-cols-4">
          <div className="rounded-lg border border-surface-border bg-surface-base p-2">
            <p className="text-ink-muted">Revenue</p>
            <p className="mono font-semibold text-ink-primary">{formatKES(summary.revenue)}</p>
          </div>
          <div className="rounded-lg border border-surface-border bg-surface-base p-2">
            <p className="text-ink-muted">Wallet Top-ups</p>
            <p className="mono font-semibold text-up">{formatKES(summary.deposits)}</p>
          </div>
          <div className="rounded-lg border border-surface-border bg-surface-base p-2">
            <p className="text-ink-muted">Total Transactions</p>
            <p className="mono font-semibold text-ink-primary">{summary.totalOrders.toLocaleString()}</p>
          </div>
          <div className="rounded-lg border border-surface-border bg-surface-base p-2">
            <p className="text-ink-muted">Withdrawal Approval Rate</p>
            <p className="mono font-semibold text-up">{summary.successRate}%</p>
          </div>
        </div>
      </Card>
    </div>
  )
}
