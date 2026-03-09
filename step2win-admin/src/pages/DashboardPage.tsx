import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Users, Trophy, TrendingUp, Clock,
} from 'lucide-react'
import {
  AreaChart, Area, BarChart, Bar, LineChart, Line,
  PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts'
import { StatCard }   from '../components/StatCard'
import { PageHeader } from '../components/PageHeader'
import { format }     from 'date-fns'
import { adminApi } from '../services/adminApi'

// ── Custom chart tooltip ────────────────────────────────────────────────────
function ChartTooltip({ active, payload, label, prefix = '' }: {
  active?: boolean
  payload?: Array<{ name: string; value: number; color: string }>
  label?: string
  prefix?: string
}) {
  if (!active || !payload?.length) return null
  return (
    <div className="rounded-xl p-3 text-xs"
      style={{ background: '#191C28', border: '1px solid #21263A',
               boxShadow: '0 8px 24px rgba(0,0,0,0.4)' }}>
      <p className="text-ink-secondary mb-2">{label}</p>
      {payload.map((e) => (
        <div key={e.name} className="flex items-center gap-2 mb-1">
          <div className="w-2 h-2 rounded-full" style={{ background: e.color }} />
          <span className="text-ink-primary font-semibold mono">
            {prefix}{Number(e.value).toLocaleString()}
          </span>
          <span className="text-ink-muted capitalize">{e.name}</span>
        </div>
      ))}
    </div>
  )
}

// ── Period selector ─────────────────────────────────────────────────────────
function PeriodSelector({
  value, onChange
}: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex gap-1 p-1 rounded-xl"
      style={{ background: '#0E1016' }}>
      {['7D', '30D', '90D'].map(p => (
        <button
          key={p}
          onClick={() => onChange(p)}
          className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-all"
          style={{
            background: value === p ? '#13161F' : 'transparent',
            color:      value === p ? '#F0F2F8' : '#7B82A0',
            boxShadow:  value === p ? '0 1px 4px rgba(0,0,0,0.3)' : 'none',
          }}>
          {p}
        </button>
      ))}
    </div>
  )
}

export function DashboardPage() {
  const [period, setPeriod] = useState('7D')
  const days = period === '7D' ? 7 : period === '30D' ? 30 : 90

  // Fetch overview data with dynamic days parameter
  const { data: stats, isLoading, error } = useQuery({
    queryKey: ['admin', 'overview', days],
    queryFn:  () => adminApi.getOverview(days),
    refetchInterval: 60_000,  // auto-refresh every minute
  })

  const today = format(new Date(), 'MMMM d, yyyy')

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-96">
        <p className="text-ink-secondary">Loading dashboard...</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-96 space-y-4">
        <p className="text-red-400 text-lg">Failed to load dashboard data</p>
        <p className="text-ink-muted text-sm">
          {error instanceof Error ? error.message : 'An error occurred'}
        </p>
        <button
          onClick={() => window.location.reload()}
          className="px-4 py-2 rounded-xl text-sm font-medium transition-colors"
          style={{ background: '#7C6FF7', color: '#fff' }}>
          Reload Dashboard
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-6 fade-in">

      {/* Header */}
      <PageHeader
        title="Dashboard"
        subtitle={`Welcome back. Here's your platform overview · ${today}`}
        actions={<PeriodSelector value={period} onChange={setPeriod} />}
      />

      {/* ── STAT CARDS ROW ── */}
      <div className="grid grid-cols-4 gap-3">
        <StatCard
          title="Total Users"
          value={stats?.total_users ?? '—'}
          icon={Users}
          trend={stats?.user_growth_pct}
          trendLabel={`vs last ${days} days`}
          sparkData={stats?.user_spark}
          color="purple"
        />
        <StatCard
          title="Revenue (KSh)"
          value={stats?.revenue_kes ?? '—'}
          icon={TrendingUp}
          trend={stats?.revenue_growth_pct}
          trendLabel="platform fees collected"
          prefix="KSh "
          isMoney
          sparkData={stats?.revenue_spark}
          color="teal"
        />
        <StatCard
          title="Active Challenges"
          value={stats?.live_challenges ?? '—'}
          icon={Trophy}
          trend={stats?.challenge_growth_pct}
          sparkData={stats?.challenge_spark}
          color="blue"
        />
        <StatCard
          title="Pending Withdrawals"
          value={stats?.pending_withdrawals_count ?? '—'}
          icon={Clock}
          color="amber"
          trendLabel={`KSh ${(stats?.pending_withdrawals_amount ?? 0).toLocaleString()} total`}
        />
      </div>

      {/* ── MAIN CHARTS ROW ── */}
      <div className="grid grid-cols-3 gap-5">

        {/* Revenue area chart — 2 columns */}
        <div className="col-span-2 rounded-2xl p-6"
          style={{ background: '#0C1117', border: '1px solid #1A2430' }}>
          <div className="flex items-center justify-between mb-6">
            <div>
              <h3 className="text-ink-primary font-bold text-base">Revenue Overview</h3>
              <p className="text-ink-muted text-xs mt-1">
                Deposits vs Withdrawals (KSh)
              </p>
            </div>
            {/* Add period tabs here if needed */}
          </div>
          <ResponsiveContainer width="100%" height={240}>
            <AreaChart data={stats?.revenue_chart ?? []}
              margin={{ top: 5, right: 5, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="depGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor="#22C55E" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#22C55E" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="wdGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor="#F06060" stopOpacity={0.2} />
                  <stop offset="95%" stopColor="#F06060" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#21263A" vertical={false} />
              <XAxis dataKey="date" tick={{ fill: '#3D4260', fontSize: 11 }}
                axisLine={false} tickLine={false} />
              <YAxis tick={{ fill: '#3D4260', fontSize: 11 }}
                axisLine={false} tickLine={false}
                tickFormatter={v => `${v >= 1000 ? `${(v/1000).toFixed(0)}k` : v}`} />
              <Tooltip content={<ChartTooltip prefix="KSh " />} />
              <Area type="monotone" dataKey="deposits" stroke="#22C55E"
                strokeWidth={2} fill="url(#depGrad)" name="Deposits" />
              <Area type="monotone" dataKey="withdrawals" stroke="#F06060"
                strokeWidth={2} fill="url(#wdGrad)" name="Withdrawals" />
            </AreaChart>
          </ResponsiveContainer>
          {/* Legend */}
          <div className="flex items-center gap-5 mt-3">
            {[['#22C55E','Deposits'],['#F06060','Withdrawals']].map(([c,l]) => (
              <div key={l} className="flex items-center gap-2">
                <div className="w-3 h-1 rounded" style={{ background: c }} />
                <span className="text-ink-muted text-xs">{l}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Challenge status donut — 1 column */}
        <div className="rounded-2xl p-6"
          style={{ background: '#0C1117', border: '1px solid #1A2430' }}>
          <h3 className="text-ink-primary font-bold text-base mb-1">Challenges</h3>
          <p className="text-ink-muted text-xs mb-5">Status breakdown</p>
          <ResponsiveContainer width="100%" height={180}>
            <PieChart>
              <Pie
                data={[
                  { name: 'Active',    value: stats?.challenges_active    ?? 0 },
                  { name: 'Pending',   value: stats?.challenges_pending   ?? 0 },
                  { name: 'Completed', value: stats?.challenges_completed ?? 0 },
                ]}
                cx="50%" cy="50%"
                innerRadius={55} outerRadius={78}
                paddingAngle={2} dataKey="value">
                {['#22C55E','#F5A623','#22D3A0'].map((c, i) => (
                  <Cell key={i} fill={c} />
                ))}
              </Pie>
              <Tooltip
                contentStyle={{ background: '#191C28', border: '1px solid #21263A',
                                borderRadius: 10, fontSize: 12 }} />
            </PieChart>
          </ResponsiveContainer>
          <div className="space-y-2.5 mt-2">
            {[
              ['#22C55E', 'Active',    stats?.challenges_active],
              ['#F5A623', 'Pending',   stats?.challenges_pending],
              ['#22D3A0', 'Completed', stats?.challenges_completed],
            ].map(([c, l, v]) => (
              <div key={String(l)} className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <div className="w-2.5 h-2.5 rounded-full" style={{ background: String(c) }} />
                  <span className="text-ink-secondary text-xs">{String(l)}</span>
                </div>
                <span className="text-ink-primary text-sm font-bold mono">
                  {Number(v ?? 0).toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── SECOND ROW: User growth + Step activity ── */}
      <div className="grid grid-cols-2 gap-5">
        <div className="rounded-2xl p-6"
          style={{ background: '#0C1117', border: '1px solid #1A2430' }}>
          <h3 className="text-ink-primary font-bold text-base mb-1">User Signups</h3>
          <p className="text-ink-muted text-xs mb-5">New registrations per day</p>
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={stats?.user_chart ?? []}
              margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#21263A" vertical={false} />
              <XAxis dataKey="date" tick={{ fill: '#3D4260', fontSize: 11 }}
                axisLine={false} tickLine={false} />
              <YAxis tick={{ fill: '#3D4260', fontSize: 11 }}
                axisLine={false} tickLine={false} />
              <Tooltip
                contentStyle={{ background: '#191C28', border: '1px solid #21263A',
                                borderRadius: 10, fontSize: 12 }}
                cursor={{ fill: 'rgba(34,197,94,0.08)' }} />
              <Bar dataKey="users" fill="#22C55E"
                radius={[5, 5, 0, 0]} name="New Users" />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="rounded-2xl p-6"
          style={{ background: '#0C1117', border: '1px solid #1A2430' }}>
          <h3 className="text-ink-primary font-bold text-base mb-1">Platform Steps</h3>
          <p className="text-ink-muted text-xs mb-5">Total steps synced per day</p>
          <ResponsiveContainer width="100%" height={180}>
            <LineChart data={stats?.step_chart ?? []}
              margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#21263A" vertical={false} />
              <XAxis dataKey="date" tick={{ fill: '#3D4260', fontSize: 11 }}
                axisLine={false} tickLine={false} />
              <YAxis tick={{ fill: '#3D4260', fontSize: 11 }}
                axisLine={false} tickLine={false}
                tickFormatter={v => `${(v/1000).toFixed(0)}k`} />
              <Tooltip
                contentStyle={{ background: '#191C28', border: '1px solid #21263A',
                                borderRadius: 10, fontSize: 12 }}
                formatter={(v: unknown) => [`${(Number(v)/1000).toFixed(1)}k steps`, '']} />
              <Line type="monotone" dataKey="steps" stroke="#22D3A0"
                strokeWidth={2.5} dot={false} name="Steps" />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* ── RECENT ACTIVITY FEED ── */}
      <div className="grid grid-cols-3 gap-4">

        {/* Recent withdrawals — 2 col */}
        <div className="col-span-2 rounded-2xl overflow-hidden"
          style={{ background: '#0C1117', border: '1px solid #1A2430' }}>
          <div className="flex items-center justify-between px-5 py-4"
            style={{ borderBottom: '1px solid #21263A' }}>
            <div>
              <h3 className="text-ink-primary font-bold">Pending Withdrawals</h3>
              <p className="text-ink-muted text-xs mt-0.5">Requires your approval</p>
            </div>
            <a href="/withdrawals"
              className="text-prime text-xs font-semibold hover:underline">
              View all →
            </a>
          </div>
          <table className="w-full">
            <thead>
              <tr style={{ borderBottom: '1px solid #21263A' }}>
                {['User', 'Amount', 'M-Pesa', 'Requested', 'Action'].map(h => (
                  <th key={h} className="px-5 py-3 text-left text-ink-muted
                                         text-xs font-semibold uppercase tracking-wider">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(stats?.pending_withdrawals_list ?? []).slice(0, 5).map((w: {
                id: number
                username: string
                amount: number
                phone: string
                created_at: string
              }) => (
                <tr key={w.id} style={{ borderBottom: '1px solid #1C1F2E' }}>
                  <td className="px-5 py-3.5">
                    <p className="text-ink-primary text-sm font-medium">{w.username}</p>
                  </td>
                  <td className="px-5 py-3.5">
                    <span className="text-ink-primary text-sm mono font-semibold">
                      KSh {Number(w.amount).toLocaleString()}
                    </span>
                  </td>
                  <td className="px-5 py-3.5">
                    <span className="text-ink-secondary text-sm">{w.phone}</span>
                  </td>
                  <td className="px-5 py-3.5">
                    <span className="text-ink-muted text-xs">{w.created_at}</span>
                  </td>
                  <td className="px-5 py-3.5">
                    <button className="px-2.5 py-1 rounded-md text-[11px] font-semibold"
                      style={{ background: 'rgba(34,197,94,0.14)', color: '#22C55E' }}>
                      Review
                    </button>
                  </td>
                </tr>
              ))}
              {(stats?.pending_withdrawals_list ?? []).length === 0 && (
                <tr>
                  <td colSpan={5} className="px-5 py-8 text-center text-ink-muted text-sm">
                    No pending withdrawals 🎉
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Recent signups — 1 col */}
        <div className="rounded-2xl overflow-hidden"
          style={{ background: '#0C1117', border: '1px solid #1A2430' }}>
          <div className="flex items-center justify-between px-5 py-4"
            style={{ borderBottom: '1px solid #21263A' }}>
            <div>
              <h3 className="text-ink-primary font-bold">New Users</h3>
              <p className="text-ink-muted text-xs mt-0.5">Latest registrations</p>
            </div>
            <a href="/users"
              className="text-prime text-xs font-semibold hover:underline">
              View all →
            </a>
          </div>
          <div className="divide-y" style={{ borderColor: '#1C1F2E' }}>
            {(stats?.recent_users ?? []).slice(0, 6).map((u: { id: number; username: string; email: string; joined: string }) => (
              <div key={u.id} className="flex items-center gap-3 px-4 py-3">
                <div className="w-8 h-8 rounded-full flex items-center justify-center
                                text-xs font-bold text-white"
                  style={{ background: 'linear-gradient(135deg, #22C55E, #16A34A)', flexShrink: 0 }}>
                  {u.username?.slice(0, 2).toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-ink-primary text-sm font-medium truncate">
                    {u.username}
                  </p>
                  <p className="text-ink-muted text-xs truncate">{u.email}</p>
                </div>
                <span className="text-ink-muted text-[10px]" style={{ flexShrink: 0 }}>
                  {u.joined}
                </span>
              </div>
            ))}
          </div>
        </div>

      </div>
    </div>
  )
}
