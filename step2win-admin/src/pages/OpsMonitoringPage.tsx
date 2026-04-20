import { useQuery } from '@tanstack/react-query'
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Database,
  RefreshCw,
  ShieldAlert,
  Siren,
} from 'lucide-react'
import { PageHeader } from '../components/PageHeader'
import { adminApi } from '../services/adminApi'

function metricTone(breach: boolean) {
  return breach
    ? { border: '1px solid rgba(240,96,96,0.35)', background: 'rgba(240,96,96,0.08)' }
    : { border: '1px solid #1A2430', background: '#0C1117' }
}

function formatNumber(value: number): string {
  return Number(value).toLocaleString()
}

export function OpsMonitoringPage() {
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['admin', 'ops-monitoring'],
    queryFn: () => adminApi.getOpsMonitoring(),
    refetchInterval: 60_000,
  })

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-96">
        <p className="text-ink-secondary">Loading operational monitoring...</p>
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="flex flex-col items-center justify-center h-96 gap-3">
        <p className="text-red-400 text-lg font-semibold">Failed to load ops monitoring data</p>
        <p className="text-ink-muted text-sm">
          {error instanceof Error ? error.message : 'Unexpected response from server'}
        </p>
        <button
          onClick={() => void refetch()}
          className="px-4 py-2 rounded-xl text-sm font-medium transition-colors"
          style={{ background: '#4F9CF9', color: '#fff' }}>
          Retry
        </button>
      </div>
    )
  }

  const metrics = data.metrics
  const thresholds = data.thresholds
  const drift = data.anti_cheat_drift

  return (
    <div className="space-y-6 fade-in">
      <PageHeader
        title="Ops Monitoring"
        subtitle="Financial reconciliation health, queue pressure, and duplicate-risk indicators"
        actions={(
          <button
            onClick={() => void refetch()}
            disabled={isFetching}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-semibold"
            style={{
              background: '#121726',
              border: '1px solid #26314B',
              color: '#D4DEFF',
            }}>
            <RefreshCw size={14} className={isFetching ? 'animate-spin' : ''} />
            {isFetching ? 'Refreshing...' : 'Refresh'}
          </button>
        )}
      />

      <div
        className="rounded-2xl p-5"
        style={{
          border: data.ok ? '1px solid rgba(34,197,94,0.35)' : '1px solid rgba(240,96,96,0.35)',
          background: data.ok ? 'rgba(34,197,94,0.08)' : 'rgba(240,96,96,0.08)',
        }}>
        <div className="flex items-center gap-3">
          {data.ok ? <CheckCircle2 size={18} color="#22C55E" /> : <AlertTriangle size={18} color="#F06060" />}
          <p className="text-sm font-semibold" style={{ color: data.ok ? '#6EE7B7' : '#FCA5A5' }}>
            {data.ok ? 'System status is healthy' : `Detected ${data.breaches.length} active breach(es)`}
          </p>
        </div>
        <p className="text-xs mt-2 text-ink-secondary">
          Last reconciliation snapshot: {new Date(data.timestamp).toLocaleString()}
        </p>
      </div>

      {!data.ok && (
        <div className="rounded-2xl p-5" style={{ background: '#0C1117', border: '1px solid #1A2430' }}>
          <h3 className="text-ink-primary text-sm font-semibold mb-3">Breaches</h3>
          <div className="space-y-2">
            {data.breaches.map((breach) => (
              <div key={breach} className="rounded-xl px-3 py-2 text-xs" style={{
                border: '1px solid rgba(240,96,96,0.35)',
                background: 'rgba(240,96,96,0.08)',
                color: '#FCA5A5',
              }}>
                {breach}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="rounded-2xl p-5" style={metricTone(metrics.callback_failure_rate_pct > thresholds.max_callback_failure_rate_pct)}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Siren size={16} color="#F5A623" />
              <p className="text-xs uppercase tracking-wide text-ink-muted">Callback Failure Rate</p>
            </div>
            <p className="mono text-sm text-ink-secondary">max {thresholds.max_callback_failure_rate_pct}%</p>
          </div>
          <p className="mt-3 text-2xl font-bold text-ink-primary">{metrics.callback_failure_rate_pct.toFixed(2)}%</p>
          <p className="text-xs text-ink-muted mt-2">
            {formatNumber(metrics.callback_failures_24h)} failed out of {formatNumber(metrics.callback_total_24h)} callbacks (24h)
          </p>
        </div>

        <div className="rounded-2xl p-5" style={metricTone(metrics.unprocessed_callbacks > thresholds.max_unprocessed_callbacks)}>
          <div className="flex items-center gap-2">
            <Clock3 size={16} color="#4F9CF9" />
            <p className="text-xs uppercase tracking-wide text-ink-muted">Unprocessed Callbacks</p>
          </div>
          <p className="mt-3 text-2xl font-bold text-ink-primary">{formatNumber(metrics.unprocessed_callbacks)}</p>
          <p className="text-xs text-ink-muted mt-2">Threshold: {formatNumber(thresholds.max_unprocessed_callbacks)}</p>
        </div>

        <div className="rounded-2xl p-5" style={metricTone(metrics.stuck_processing_withdrawals > thresholds.max_stuck_processing)}>
          <div className="flex items-center gap-2">
            <ShieldAlert size={16} color="#F06060" />
            <p className="text-xs uppercase tracking-wide text-ink-muted">Stuck Processing Withdrawals</p>
          </div>
          <p className="mt-3 text-2xl font-bold text-ink-primary">{formatNumber(metrics.stuck_processing_withdrawals)}</p>
          <p className="text-xs text-ink-muted mt-2">Threshold: {formatNumber(thresholds.max_stuck_processing)}</p>
        </div>

        <div className="rounded-2xl p-5" style={metricTone(metrics.negative_balance_users > thresholds.max_negative_balance_users)}>
          <div className="flex items-center gap-2">
            <Database size={16} color="#22C55E" />
            <p className="text-xs uppercase tracking-wide text-ink-muted">Negative Balance Users</p>
          </div>
          <p className="mt-3 text-2xl font-bold text-ink-primary">{formatNumber(metrics.negative_balance_users)}</p>
          <p className="text-xs text-ink-muted mt-2">Threshold: {formatNumber(thresholds.max_negative_balance_users)}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="rounded-2xl p-5" style={{ background: '#0C1117', border: '1px solid #1A2430' }}>
          <h3 className="text-ink-primary text-sm font-semibold">Withdrawal Queue</h3>
          <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
            <div className="rounded-xl p-3" style={{ background: '#111827' }}>
              <p className="text-ink-muted text-xs">Items in queue</p>
              <p className="mono text-lg font-semibold text-ink-primary mt-1">{formatNumber(metrics.withdrawal_queue.count)}</p>
            </div>
            <div className="rounded-xl p-3" style={{ background: '#111827' }}>
              <p className="text-ink-muted text-xs">Oldest age (hours)</p>
              <p className="mono text-lg font-semibold text-ink-primary mt-1">{metrics.withdrawal_queue.oldest_age_hours}</p>
            </div>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
            <div className="rounded-xl p-3" style={{ background: '#111827' }}>
              <p className="text-ink-muted text-xs">Stuck pending payments</p>
              <p className="mono text-lg font-semibold text-ink-primary mt-1">{formatNumber(metrics.stuck_pending_payments)}</p>
            </div>
            <div className="rounded-xl p-3" style={{ background: '#111827' }}>
              <p className="text-ink-muted text-xs">Open fraud flags</p>
              <p className="mono text-lg font-semibold text-ink-primary mt-1">{formatNumber(metrics.fraud_open_flags)}</p>
            </div>
          </div>
        </div>

        <div className="rounded-2xl p-5" style={{ background: '#0C1117', border: '1px solid #1A2430' }}>
          <h3 className="text-ink-primary text-sm font-semibold">Duplicate Idempotency Rejections (Today)</h3>
          <div className="mt-3 space-y-2">
            {Object.entries(metrics.duplicate_request_rejections_today).map(([scope, count]) => (
              <div key={scope} className="flex items-center justify-between rounded-xl px-3 py-2" style={{ background: '#111827' }}>
                <p className="text-xs text-ink-secondary">{scope}</p>
                <p className="mono text-sm font-semibold text-ink-primary">{formatNumber(count)}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="rounded-2xl p-5" style={{ background: '#0C1117', border: '1px solid #1A2430' }}>
        <h3 className="text-ink-primary text-sm font-semibold">Duplicate Gateway References</h3>
        <p className="text-xs text-ink-muted mt-1">Completed payments that currently share the same M-Pesa reference.</p>
        <div className="mt-3 overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="text-left text-ink-muted border-b" style={{ borderColor: '#1A2430' }}>
                <th className="py-2 pr-3">Reference</th>
                <th className="py-2">Count</th>
              </tr>
            </thead>
            <tbody>
              {metrics.duplicate_gateway_references.length === 0 && (
                <tr>
                  <td colSpan={2} className="py-3 text-ink-secondary">No duplicate gateway references detected.</td>
                </tr>
              )}
              {metrics.duplicate_gateway_references.map((row) => (
                <tr key={`${row.mpesa_reference}-${row.c}`} className="border-b" style={{ borderColor: '#121726' }}>
                  <td className="py-2 pr-3 mono text-ink-secondary">{row.mpesa_reference}</td>
                  <td className="py-2 text-ink-primary font-semibold">{formatNumber(row.c)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {drift && (
        <div className="rounded-2xl p-5" style={{ background: '#0C1117', border: '1px solid #1A2430' }}>
          <div className="flex items-center justify-between">
            <h3 className="text-ink-primary text-sm font-semibold">Anti-Cheat Shadow Drift</h3>
            <p className="text-xs text-ink-muted">
              {drift.window.enough_samples
                ? `Window: last ${drift.window.hours}h`
                : `Sampling: ${drift.metrics.sample_count}/${drift.thresholds.min_samples}`}
            </p>
          </div>

          <div className="mt-3 grid grid-cols-1 lg:grid-cols-3 gap-3 text-sm">
            <div className="rounded-xl p-3" style={metricTone(drift.metrics.avg_abs_delta_pct > drift.thresholds.max_avg_abs_delta_pct)}>
              <p className="text-ink-muted text-xs">Average Absolute Delta</p>
              <p className="mono text-lg font-semibold text-ink-primary mt-1">
                {drift.metrics.avg_abs_delta_pct.toFixed(2)}%
              </p>
            </div>
            <div className="rounded-xl p-3" style={metricTone(drift.metrics.high_drift_ratio_pct > drift.thresholds.max_high_drift_ratio_pct)}>
              <p className="text-ink-muted text-xs">High Drift Ratio</p>
              <p className="mono text-lg font-semibold text-ink-primary mt-1">
                {drift.metrics.high_drift_ratio_pct.toFixed(2)}%
              </p>
            </div>
            <div className="rounded-xl p-3" style={metricTone(drift.metrics.review_mismatch_ratio_pct > drift.thresholds.max_review_mismatch_ratio_pct)}>
              <p className="text-ink-muted text-xs">Review Mismatch Ratio</p>
              <p className="mono text-lg font-semibold text-ink-primary mt-1">
                {drift.metrics.review_mismatch_ratio_pct.toFixed(2)}%
              </p>
            </div>
          </div>

          {drift.breaches.length > 0 && (
            <div className="mt-4 space-y-2">
              {drift.breaches.map((breach) => (
                <div key={breach} className="rounded-xl px-3 py-2 text-xs" style={{
                  border: '1px solid rgba(240,96,96,0.35)',
                  background: 'rgba(240,96,96,0.08)',
                  color: '#FCA5A5',
                }}>
                  {breach}
                </div>
              ))}
            </div>
          )}

          {drift.metrics.top_drift_examples.length > 0 && (
            <div className="mt-4 overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="text-left text-ink-muted border-b" style={{ borderColor: '#1A2430' }}>
                    <th className="py-2 pr-3">User</th>
                    <th className="py-2 pr-3">Date</th>
                    <th className="py-2 pr-3">Legacy</th>
                    <th className="py-2 pr-3">Shadow</th>
                    <th className="py-2">Abs Delta %</th>
                  </tr>
                </thead>
                <tbody>
                  {drift.metrics.top_drift_examples.map((row) => (
                    <tr key={`${row.user_id}-${row.date}`} className="border-b" style={{ borderColor: '#121726' }}>
                      <td className="py-2 pr-3 mono text-ink-secondary">{row.user_id}</td>
                      <td className="py-2 pr-3 text-ink-secondary">{row.date}</td>
                      <td className="py-2 pr-3 mono text-ink-secondary">{formatNumber(row.legacy_steps)}</td>
                      <td className="py-2 pr-3 mono text-ink-secondary">{formatNumber(row.shadow_verified_steps)}</td>
                      <td className="py-2 text-ink-primary font-semibold">{row.abs_delta_pct.toFixed(2)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
