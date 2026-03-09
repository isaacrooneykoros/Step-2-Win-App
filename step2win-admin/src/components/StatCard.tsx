import { TrendingUp, TrendingDown } from 'lucide-react'
import { LineChart, Line, ResponsiveContainer, Tooltip } from 'recharts'

interface StatCardProps {
  title:       string
  value:       string | number
  icon:        React.ElementType
  trend?:      number          // e.g. 12.5 = +12.5%, -4.2 = -4.2%
  trendLabel?: string          // e.g. "vs last week"
  prefix?:     string          // e.g. "KSh "
  suffix?:     string          // e.g. " users"
  isMoney?:    boolean
  sparkData?:  number[]        // 7 data points for sparkline
  color:       'purple' | 'teal' | 'blue' | 'amber' | 'red' | 'indigo'
  onClick?:    () => void
}

const COLORS = {
  purple: { icon: '#22C55E', tint: 'rgba(34,197,94,0.12)', line: '#22C55E' },
  teal:   { icon: '#22D3A0', tint: 'rgba(34,211,160,0.12)',  line: '#22D3A0' },
  blue:   { icon: '#4F9CF9', tint: 'rgba(79,156,249,0.12)',  line: '#4F9CF9' },
  amber:  { icon: '#F5A623', tint: 'rgba(245,166,35,0.12)',  line: '#F5A623' },
  red:    { icon: '#F06060', tint: 'rgba(240,96,96,0.12)',   line: '#F06060' },
  indigo: { icon: '#818CF8', tint: 'rgba(129,140,248,0.12)', line: '#818CF8' },
}

export function StatCard({
  title, value, icon: Icon, trend, trendLabel,
  prefix = '', suffix = '', isMoney, sparkData, color, onClick,
}: StatCardProps) {
  const c          = COLORS[color]
  const isPositive = trend !== undefined && trend >= 0
  const sparkChart = sparkData?.map((v, i) => ({ i, v })) ?? []

  return (
    <div
      className="rounded-2xl p-6 cursor-default transition-all duration-200"
      style={{
        background: '#0C1117',
        border:     '1px solid #1A2430',
        boxShadow:  '0 1px 3px rgba(0,0,0,0.4)',
      }}
      onClick={onClick}>

      {/* Top row - Icon and Title */}
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-xl flex items-center justify-center"
            style={{ background: c.tint }}>
            <Icon size={20} style={{ color: c.icon }} />
          </div>
          <div>
            <p className="text-ink-secondary text-xs font-medium">{title}</p>
            {trendLabel && (
              <p className="text-ink-muted text-[10px] mt-0.5">{trendLabel}</p>
            )}
          </div>
        </div>

        {/* Trend chip */}
        {trend !== undefined && (
          <div className={`flex items-center gap-1 px-2 py-1 rounded-full text-xs font-semibold ${
            isPositive ? 'text-up' : 'text-down'
          }`} style={{
            background: isPositive ? 'rgba(34, 211, 160, 0.15)' : 'rgba(240, 96, 96, 0.15)'
          }}>
            {isPositive
              ? <TrendingUp  size={11} />
              : <TrendingDown size={11} />}
            {isPositive ? '+' : ''}{trend.toFixed(1)}%
          </div>
        )}
      </div>

      {/* Value - Big number */}
      <div className="mb-3">
        <p className={`text-3xl font-bold text-ink-primary ${isMoney ? 'mono' : ''}`}>
          {prefix}
          {typeof value === 'number' ? value.toLocaleString() : value}
          {suffix}
        </p>
      </div>

      {/* Sparkline */}
      {sparkData && sparkData.length > 0 && (
        <div className="mt-3 -mx-1">
          <ResponsiveContainer width="100%" height={36}>
            <LineChart data={sparkChart}>
              <Line
                type="monotone"
                dataKey="v"
                stroke={c.line}
                strokeWidth={1.5}
                dot={false}
                isAnimationActive={false}
              />
              <Tooltip
                contentStyle={{
                  background: '#191C28', border: '1px solid #21263A',
                  borderRadius: 8, fontSize: 11,
                }}
                itemStyle={{ color: c.icon }}
                labelStyle={{ display: 'none' }}
                formatter={(v: unknown) => [`${prefix}${Number(v).toLocaleString()}${suffix}`, '']}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  )
}
