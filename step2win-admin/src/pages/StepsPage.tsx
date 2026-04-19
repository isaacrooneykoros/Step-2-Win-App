import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Activity, Calendar, Download, Footprints, RefreshCw, Search } from 'lucide-react'
import { BarChart, Bar, CartesianGrid, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import { PageHeader } from '../components/PageHeader'
import { StatCard } from '../components/StatCard'
import { adminApi } from '../services/adminApi'
import { useAuthStore } from '../store/authStore'
import { API_BASE } from '../config/network'

interface StepsLogItem {
  id: number | string
  user_id: number
  username: string
  email: string
  date: string
  synced_at: string
  source?: string | null
  steps: number
  approved_steps?: number
  submitted_steps?: number
  distance_km?: number | null
  calories_active?: number | null
  active_minutes?: number | null
  is_suspicious: boolean
  trust_status?: string
  flags_raised?: number
}

interface StepsLogsResponse {
  total: number
  results: StepsLogItem[]
  summary: {
    total_steps: number
    users_with_logs: number
    first_log_at: string | null
    last_log_at: string | null
  }
}

interface StepsHourlyResponse {
  user_id: number
  date: string | null
  hours: Array<{
    hour: number
    label: string
    steps: number
    distance_km: number
    calories: number
  }>
  summary: {
    total_steps: number
    total_distance_km: number
    total_calories: number
  }
}

const PAGE_SIZE = 50

export function StepsPage() {
  const navigate = useNavigate()
  const accessToken = useAuthStore((state) => state.accessToken)

  const [logs, setLogs] = useState<StepsLogItem[]>([])
  const [liveEvents, setLiveEvents] = useState<StepsLogItem[]>([])
  const [total, setTotal] = useState(0)
  const [summary, setSummary] = useState<StepsLogsResponse['summary']>({
    total_steps: 0,
    users_with_logs: 0,
    first_log_at: null,
    last_log_at: null,
  })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [liveConnected, setLiveConnected] = useState(false)
  const [onlyLiveChanges, setOnlyLiveChanges] = useState(false)
  const [selectedLog, setSelectedLog] = useState<StepsLogItem | null>(null)
  const [hourly, setHourly] = useState<StepsHourlyResponse | null>(null)
  const [hourlyLoading, setHourlyLoading] = useState(false)

  const [search, setSearch] = useState('')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [suspicious, setSuspicious] = useState<'all' | 'true' | 'false'>('all')
  const [order, setOrder] = useState<'asc' | 'desc'>('asc')
  const [offset, setOffset] = useState(0)

  const loadLogs = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const response = await adminApi.getStepsLogs({
        search: search || undefined,
        from_date: fromDate || undefined,
        to_date: toDate || undefined,
        suspicious: suspicious === 'all' ? undefined : suspicious,
        order,
        limit: PAGE_SIZE,
        offset,
      }) as StepsLogsResponse

      setLogs(response.results || [])
      setTotal(response.total || 0)
      setSummary(response.summary || {
        total_steps: 0,
        users_with_logs: 0,
        first_log_at: null,
        last_log_at: null,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load step logs')
    } finally {
      setLoading(false)
    }
  }, [search, fromDate, toDate, suspicious, order, offset])

  const loadHourly = useCallback(async (userId: number, date?: string) => {
    setHourlyLoading(true)
    try {
      const response = await adminApi.getStepsHourlyBreakdown({ user_id: userId, date }) as StepsHourlyResponse
      setHourly(response)
    } catch {
      setHourly(null)
    } finally {
      setHourlyLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadLogs()
  }, [loadLogs])

  useEffect(() => {
    if (!accessToken) {
      setLiveConnected(false)
      return
    }

    const wsBase = API_BASE.replace(/^http/, 'ws').replace(/\/$/, '')
    const socket = new WebSocket(`${wsBase}/ws/admin/steps/live/?token=${encodeURIComponent(accessToken)}`)

    socket.onopen = () => setLiveConnected(true)
    socket.onerror = () => setLiveConnected(false)
    socket.onclose = () => setLiveConnected(false)

    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data)
        if (message.type !== 'admin.steps.update' || !message.payload) {
          return
        }

        const payload = message.payload as StepsLogItem
        const liveRow: StepsLogItem = {
          id: `live-${payload.user_id}-${payload.date}-${payload.synced_at}`,
          user_id: payload.user_id,
          username: payload.username,
          email: payload.email || '',
          date: payload.date,
          synced_at: payload.synced_at,
          source: payload.source,
          steps: payload.steps ?? payload.approved_steps ?? 0,
          approved_steps: payload.approved_steps,
          submitted_steps: payload.submitted_steps,
          distance_km: payload.distance_km,
          calories_active: payload.calories_active,
          active_minutes: payload.active_minutes,
          is_suspicious: Boolean(payload.is_suspicious),
          trust_status: payload.trust_status,
          flags_raised: payload.flags_raised,
        }

        setLiveEvents((prev) => [liveRow, ...prev].slice(0, 30))

        setLogs((prev) => {
          const targetIndex = prev.findIndex((row) => row.user_id === liveRow.user_id && row.date === liveRow.date)
          if (targetIndex === -1) {
            return prev
          }
          const next = [...prev]
          next[targetIndex] = {
            ...next[targetIndex],
            steps: liveRow.steps,
            synced_at: liveRow.synced_at,
            source: liveRow.source,
            is_suspicious: liveRow.is_suspicious,
            distance_km: liveRow.distance_km,
            calories_active: liveRow.calories_active,
            active_minutes: liveRow.active_minutes,
            approved_steps: liveRow.approved_steps,
            submitted_steps: liveRow.submitted_steps,
            trust_status: liveRow.trust_status,
            flags_raised: liveRow.flags_raised,
          }
          return next
        })
      } catch {
        // Ignore malformed websocket payloads.
      }
    }

    return () => {
      socket.close()
    }
  }, [accessToken])

  const displayedRows = useMemo(() => {
    return onlyLiveChanges ? liveEvents : logs
  }, [onlyLiveChanges, liveEvents, logs])

  const currentPage = onlyLiveChanges ? 1 : Math.floor(offset / PAGE_SIZE) + 1
  const totalPages = onlyLiveChanges ? 1 : Math.max(1, Math.ceil(total / PAGE_SIZE))

  const liveTotal = useMemo(() => {
    return liveEvents.reduce((sum, row) => sum + Number(row.steps || 0), 0)
  }, [liveEvents])

  const exportCsv = () => {
    const headers = ['date', 'synced_at', 'username', 'email', 'steps', 'source', 'distance_km', 'calories_active', 'active_minutes', 'is_suspicious']
    const rows = [
      headers,
      ...displayedRows.map((row) => headers.map((header) => String((row as unknown as Record<string, unknown>)[header] ?? ''))),
    ]

    const csv = rows.map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `admin-steps-${new Date().toISOString().slice(0, 10)}.csv`
    link.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Steps Logs"
        subtitle={`${total.toLocaleString()} historical records from first sync to current activity`}
        actions={(
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={() => void loadLogs()}
              className="px-3 py-2 rounded-xl text-xs font-semibold flex items-center gap-2"
              style={{ background: '#13161F', border: '1px solid #21263A', color: '#D4DEFF' }}
            >
              <RefreshCw size={13} /> Refresh
            </button>
            <button
              onClick={exportCsv}
              className="px-3 py-2 rounded-xl text-xs font-semibold flex items-center gap-2"
              style={{ background: '#00f5e9', border: 'none', color: '#091120' }}
            >
              <Download size={13} /> Export CSV
            </button>
            <button
              onClick={() => setOnlyLiveChanges((v) => !v)}
              className="px-3 py-2 rounded-xl text-xs font-semibold"
              style={{
                background: onlyLiveChanges ? 'rgba(34,211,160,0.18)' : '#191C28',
                border: `1px solid ${onlyLiveChanges ? 'rgba(34,211,160,0.35)' : '#21263A'}`,
                color: onlyLiveChanges ? '#22D3A0' : '#D4DEFF',
              }}
            >
              {onlyLiveChanges ? 'Only Live Changes: ON' : 'Only Live Changes: OFF'}
            </button>
            <span
              className="inline-flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-semibold"
              style={{
                background: liveConnected ? 'rgba(34,211,160,0.12)' : 'rgba(148,163,184,0.12)',
                color: liveConnected ? '#22D3A0' : '#94A3B8',
                border: `1px solid ${liveConnected ? 'rgba(34,211,160,0.24)' : 'rgba(148,163,184,0.24)'}`,
              }}
            >
              <span className="w-2 h-2 rounded-full" style={{ background: liveConnected ? '#22D3A0' : '#94A3B8' }} />
              {liveConnected ? 'Realtime connected' : 'Realtime offline'}
            </span>
          </div>
        )}
      />

      {error && (
        <div className="rounded-xl p-3 text-sm" style={{ background: 'rgba(240,96,96,0.12)', border: '1px solid rgba(240,96,96,0.25)', color: '#FCA5A5' }}>
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <StatCard title="Total Step Logs" value={total} icon={Footprints} color="teal" />
        <StatCard title="Users With Logs" value={summary.users_with_logs} icon={Activity} color="blue" />
        <StatCard title="Total Logged Steps" value={summary.total_steps.toLocaleString()} icon={Footprints} color="purple" />
        <StatCard title="Live Buffer Steps" value={liveTotal.toLocaleString()} icon={Calendar} color="amber" />
      </div>

      <div className="rounded-2xl p-4" style={{ background: '#0C1117', border: '1px solid #21263A' }}>
        <div className="grid grid-cols-1 md:grid-cols-6 gap-3 items-end">
          <label className="block md:col-span-2">
            <span className="text-xs text-ink-muted">Search User</span>
            <div className="mt-1 relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted" />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="username or email"
                className="w-full pl-9 pr-3 py-2 rounded-xl text-sm outline-none"
                style={{ background: '#13161F', border: '1px solid #21263A', color: '#F0F2F8' }}
              />
            </div>
          </label>

          <label className="block">
            <span className="text-xs text-ink-muted">From</span>
            <input
              type="date"
              value={fromDate}
              onChange={(event) => setFromDate(event.target.value)}
              className="mt-1 w-full px-3 py-2 rounded-xl text-sm outline-none"
              style={{ background: '#13161F', border: '1px solid #21263A', color: '#F0F2F8' }}
            />
          </label>

          <label className="block">
            <span className="text-xs text-ink-muted">To</span>
            <input
              type="date"
              value={toDate}
              onChange={(event) => setToDate(event.target.value)}
              className="mt-1 w-full px-3 py-2 rounded-xl text-sm outline-none"
              style={{ background: '#13161F', border: '1px solid #21263A', color: '#F0F2F8' }}
            />
          </label>

          <label className="block">
            <span className="text-xs text-ink-muted">Suspicious</span>
            <select
              value={suspicious}
              onChange={(event) => setSuspicious(event.target.value as 'all' | 'true' | 'false')}
              className="mt-1 w-full px-3 py-2 rounded-xl text-sm outline-none"
              style={{ background: '#13161F', border: '1px solid #21263A', color: '#F0F2F8' }}
            >
              <option value="all">All</option>
              <option value="true">Suspicious</option>
              <option value="false">Clean</option>
            </select>
          </label>

          <label className="block">
            <span className="text-xs text-ink-muted">Order</span>
            <select
              value={order}
              onChange={(event) => setOrder(event.target.value as 'asc' | 'desc')}
              className="mt-1 w-full px-3 py-2 rounded-xl text-sm outline-none"
              style={{ background: '#13161F', border: '1px solid #21263A', color: '#F0F2F8' }}
            >
              <option value="asc">First to Current</option>
              <option value="desc">Current to First</option>
            </select>
          </label>
        </div>

        <div className="flex items-center gap-2 mt-3">
          <button
            onClick={() => { setOffset(0); void loadLogs() }}
            className="px-3 py-2 rounded-xl text-xs font-semibold"
            style={{ background: '#00f5e9', color: '#091120' }}
          >
            Apply Filters
          </button>
          <button
            onClick={() => {
              setSearch('')
              setFromDate('')
              setToDate('')
              setSuspicious('all')
              setOrder('asc')
              setOffset(0)
            }}
            className="px-3 py-2 rounded-xl text-xs font-semibold"
            style={{ background: '#191C28', border: '1px solid #21263A', color: '#D4DEFF' }}
          >
            Reset
          </button>
        </div>
      </div>

      <div className="rounded-2xl overflow-hidden" style={{ background: '#0C1117', border: '1px solid #21263A' }}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ background: '#13161F', borderBottom: '1px solid #21263A' }}>
                <th className="px-4 py-3 text-left text-xs text-ink-muted">Date</th>
                <th className="px-4 py-3 text-left text-xs text-ink-muted">Synced At</th>
                <th className="px-4 py-3 text-left text-xs text-ink-muted">User</th>
                <th className="px-4 py-3 text-left text-xs text-ink-muted">Steps</th>
                <th className="px-4 py-3 text-left text-xs text-ink-muted">Source</th>
                <th className="px-4 py-3 text-left text-xs text-ink-muted">Distance</th>
                <th className="px-4 py-3 text-left text-xs text-ink-muted">Flags</th>
                <th className="px-4 py-3 text-left text-xs text-ink-muted">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-ink-muted">Loading step logs...</td>
                </tr>
              ) : displayedRows.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-ink-muted">No step logs found.</td>
                </tr>
              ) : (
                displayedRows.map((row) => {
                  const isSelected = selectedLog?.id === row.id
                  return (
                  <tr
                    key={row.id}
                    onClick={() => {
                      setSelectedLog(row)
                      void loadHourly(row.user_id, row.date)
                    }}
                    className="cursor-pointer"
                    style={{
                      borderBottom: '1px solid #1C1F2E',
                      background: isSelected ? 'rgba(79,156,249,0.08)' : 'transparent',
                    }}
                  >
                    <td className="px-4 py-3 text-ink-secondary">{row.date}</td>
                    <td className="px-4 py-3 text-ink-secondary">{new Date(row.synced_at).toLocaleString()}</td>
                    <td className="px-4 py-3">
                      <p className="text-ink-primary font-semibold">{row.username}</p>
                      <p className="text-ink-muted text-xs">{row.email || '-'}</p>
                    </td>
                    <td className="px-4 py-3 text-ink-primary font-semibold mono">{Number(row.steps || 0).toLocaleString()}</td>
                    <td className="px-4 py-3 text-ink-secondary">{row.source || '-'}</td>
                    <td className="px-4 py-3 text-ink-secondary">{row.distance_km != null ? `${row.distance_km.toFixed(2)} km` : '-'}</td>
                    <td className="px-4 py-3">
                      <span
                        className="inline-flex px-2 py-1 rounded-lg text-xs font-semibold"
                        style={{
                          background: row.is_suspicious ? 'rgba(240,96,96,0.14)' : 'rgba(34,211,160,0.14)',
                          color: row.is_suspicious ? '#FCA5A5' : '#22D3A0',
                        }}
                      >
                        {row.is_suspicious ? 'Suspicious' : 'Clean'}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <button
                          onClick={(event) => {
                            event.stopPropagation()
                            setSelectedLog(row)
                            void loadHourly(row.user_id, row.date)
                          }}
                          className="px-2 py-1 rounded-lg text-xs font-semibold"
                          style={{ background: '#191C28', border: '1px solid #21263A', color: '#D4DEFF' }}
                        >
                          Hourly
                        </button>
                        <button
                          onClick={(event) => {
                            event.stopPropagation()
                            navigate(`/users?openUserId=${row.user_id}`)
                          }}
                          className="px-2 py-1 rounded-lg text-xs font-semibold"
                          style={{ background: 'rgba(79,156,249,0.14)', border: '1px solid rgba(79,156,249,0.25)', color: '#93C5FD' }}
                        >
                          Open User
                        </button>
                      </div>
                    </td>
                  </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="flex items-center justify-between">
        <p className="text-xs text-ink-muted">
          Page {currentPage} of {totalPages}
          {!onlyLiveChanges && summary.first_log_at && summary.last_log_at ? ` • Range ${summary.first_log_at} to ${summary.last_log_at}` : ''}
        </p>
        {!onlyLiveChanges && (
        <div className="flex items-center gap-2">
          <button
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            disabled={offset === 0}
            className="px-3 py-2 rounded-xl text-xs font-semibold disabled:opacity-40"
            style={{ background: '#191C28', border: '1px solid #21263A', color: '#D4DEFF' }}
          >
            Previous
          </button>
          <button
            onClick={() => setOffset(offset + PAGE_SIZE)}
            disabled={offset + PAGE_SIZE >= total}
            className="px-3 py-2 rounded-xl text-xs font-semibold disabled:opacity-40"
            style={{ background: '#191C28', border: '1px solid #21263A', color: '#D4DEFF' }}
          >
            Next
          </button>
        </div>
        )}
      </div>

      <div className="rounded-2xl p-4" style={{ background: '#0C1117', border: '1px solid #21263A' }}>
        <h3 className="text-sm font-semibold text-ink-primary">Hourly Breakdown</h3>
        {selectedLog ? (
          <p className="text-xs text-ink-muted mt-1">
            {selectedLog.username} • {selectedLog.date}
          </p>
        ) : (
          <p className="text-xs text-ink-muted mt-1">Select any row and click Hourly to see the server-side hour-by-hour chart.</p>
        )}

        <div className="mt-3" style={{ height: 240 }}>
          {hourlyLoading ? (
            <p className="text-xs text-ink-muted">Loading hourly breakdown...</p>
          ) : hourly?.hours?.length ? (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={hourly.hours}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1F2937" />
                <XAxis dataKey="label" tick={{ fill: '#7B82A0', fontSize: 11 }} interval={2} />
                <YAxis tick={{ fill: '#7B82A0', fontSize: 11 }} />
                <Tooltip
                  contentStyle={{ background: '#191C28', border: '1px solid #21263A', borderRadius: 10 }}
                  labelStyle={{ color: '#F0F2F8' }}
                />
                <Bar dataKey="steps" fill="#22C55E" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <p className="text-xs text-ink-muted">No hourly data available for the selected user/day.</p>
          )}
        </div>
      </div>

      <div className="rounded-2xl p-4" style={{ background: '#0C1117', border: '1px solid #21263A' }}>
        <h3 className="text-sm font-semibold text-ink-primary">Live Step Events</h3>
        <p className="text-xs text-ink-muted mt-1">Realtime updates as users sync steps right now.</p>

        <div className="mt-3 space-y-2 max-h-72 overflow-auto">
          {liveEvents.length === 0 ? (
            <p className="text-xs text-ink-muted">No live events yet. Waiting for next sync event...</p>
          ) : (
            liveEvents.map((event) => (
              <div key={event.id} className="rounded-xl p-3" style={{ background: '#13161F', border: '1px solid #21263A' }}>
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm text-ink-primary font-semibold">{event.username}</p>
                  <p className="text-xs text-ink-muted">{new Date(event.synced_at).toLocaleTimeString()}</p>
                </div>
                <div className="mt-1 flex items-center gap-4 text-xs">
                  <span className="text-ink-secondary">Steps: <strong className="text-ink-primary">{Number(event.steps || 0).toLocaleString()}</strong></span>
                  <span className="text-ink-secondary">Source: <strong className="text-ink-primary">{event.source || '-'}</strong></span>
                  <span className="text-ink-secondary">Trust: <strong className="text-ink-primary">{event.trust_status || '-'}</strong></span>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
