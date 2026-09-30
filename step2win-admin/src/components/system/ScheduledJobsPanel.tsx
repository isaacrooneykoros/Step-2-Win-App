/**
 * Scheduled jobs card for the Ops monitoring page.
 * Backend: GET /api/admin/monitoring/jobs/ and POST /api/admin/monitoring/jobs/<name>/run/
 * (apps/admin_api/jobs_views.py). Updates live on the "jobs.updated" realtime event
 * (see lib/realtime/router.ts); the list also refetches every minute as a fallback.
 */
import { Fragment, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, CircleSlash, Clock, Loader2, Pause, Play, XCircle } from 'lucide-react'
import { Panel } from '../ui/Card'
import { Button } from '../ui/Button'
import { ErrorState } from '../ui/ErrorState'
import { Skeleton } from '../ui/Skeleton'
import { ConfirmModal } from '../ConfirmModal'
import { cn } from '../../lib/cn'
import { formatDateTime, formatRelative } from '../../lib/format'
import { useLiveRefetchInterval } from '../../lib/realtime/useAdminRealtime'
import { http } from './http'
import { Textarea } from '../ui/Input'
import { consoleB } from '../consoleb/api'
import { usePermissions } from '../../lib/permissions'

export interface ScheduledJob {
  name: string
  task: string
  schedule: string
  priority: number
  lease_seconds: number
  interval_seconds: number
  last_started_at: string | null
  last_finished_at: string | null
  last_status: 'ok' | 'error' | 'skipped' | null
  last_duration_ms: number | null
  last_error: string | null
  last_result: string | null
  run_count: number
  running: boolean
  next_due_at: string | null
  due: boolean
  overdue: boolean
  paused?: boolean
  paused_at?: string | null
  paused_by?: string | null
  pause_reason?: string | null
}

export interface ScheduledJobsResponse {
  runner: 'builtin' | 'celery' | 'off'
  cron_configured: boolean
  timestamp: string
  jobs: ScheduledJob[]
}

export const JOBS_QUERY_KEY = ['admin', 'scheduled-jobs'] as const

const jobsApi = {
  list: () => http<ScheduledJobsResponse>('/api/admin/monitoring/jobs/'),
  run: (name: string) => http<{ name: string; status: string }>(`/api/admin/monitoring/jobs/${encodeURIComponent(name)}/run/`, { method: 'POST', body: {} }),
}

type JobState = 'running' | 'ok' | 'error' | 'skipped' | 'never'

const PILL: Record<JobState, { label: string; icon: typeof CheckCircle2; cls: string }> = {
  running: { label: 'Running', icon: Loader2, cls: 'bg-notice-soft text-notice' },
  ok: { label: 'OK', icon: CheckCircle2, cls: 'bg-success-soft text-success' },
  error: { label: 'Failed', icon: XCircle, cls: 'bg-danger-soft text-danger' },
  skipped: { label: 'Skipped', icon: CircleSlash, cls: 'bg-neutral-soft text-ink-secondary' },
  never: { label: 'Never run', icon: CircleSlash, cls: 'bg-neutral-soft text-ink-secondary' },
}

const stateOf = (j: ScheduledJob): JobState => (j.running ? 'running' : j.last_status ?? 'never')

function StatusPill({ job }: { job: ScheduledJob }) {
  const s = PILL[stateOf(job)]
  const Icon = s.icon
  return (
    <span className={cn('inline-flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded px-2 text-xs font-medium', s.cls)}>
      <Icon size={12} aria-hidden strokeWidth={2.25} className={job.running ? 'animate-spin' : undefined} />
      {s.label}
    </span>
  )
}

function PausedPill({ job }: { job: ScheduledJob }) {
  return (
    <span title={job.pause_reason ? `Paused by ${job.paused_by ?? 'staff'}: ${job.pause_reason}` : undefined}
      className="inline-flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded bg-warning-soft px-2 text-xs font-medium text-warning">
      <Pause size={12} aria-hidden strokeWidth={2.25} />
      Paused
    </span>
  )
}

/** Last runs of one job (GET /api/admin/monitoring/jobs/<name>/runs/). */
function JobHistory({ name }: { name: string }) {
  const q = useQuery({ queryKey: ['admin', 'scheduled-jobs', 'runs', name], queryFn: () => consoleB.jobRuns(name) })
  if (q.isLoading) return <Skeleton height={48} />
  if (q.error) return <ErrorState size="compact" error={q.error} onRetry={() => void q.refetch()} />
  const rows = q.data?.results ?? []
  if (!rows.length) return <p className="text-xs text-ink-muted">No runs recorded yet (history starts with this release).</p>
  return (
    <table className="w-full text-xs">
      <caption className="sr-only">Recent runs of {name}</caption>
      <thead className="text-ink-muted">
        <tr><th scope="col" className="py-1 pr-3 text-left font-medium">Started</th><th scope="col" className="py-1 pr-3 text-left font-medium">Trigger</th>
          <th scope="col" className="py-1 pr-3 text-left font-medium">Result</th><th scope="col" className="py-1 pr-3 text-right font-medium">Duration</th>
          <th scope="col" className="py-1 text-left font-medium">Detail</th></tr>
      </thead>
      <tbody className="divide-y divide-[var(--border)]">
        {rows.slice(0, 15).map((r) => (
          <tr key={r.id}>
            <td className="py-1 pr-3 text-ink-secondary" title={formatDateTime(r.started_at)}>{formatRelative(r.started_at)}</td>
            <td className="py-1 pr-3 text-ink-secondary">{r.trigger || '—'}</td>
            <td className={cn('py-1 pr-3 font-medium', r.status === 'error' ? 'text-danger' : 'text-success')}>{r.status === 'error' ? 'Failed' : 'OK'}</td>
            <td className="num py-1 pr-3 text-right text-ink-secondary">{formatDuration(r.duration_ms)}</td>
            <td className="mono max-w-[28rem] truncate py-1 text-2xs text-ink-muted" title={r.error ?? r.result ?? ''}>{r.error ?? r.result ?? '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function OverduePill() {
  return (
    <span className="inline-flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded bg-warning-soft px-2 text-xs font-medium text-warning">
      <Clock size={12} aria-hidden strokeWidth={2.25} />
      Overdue
    </span>
  )
}

function formatDuration(ms: number | null): string {
  if (ms === null || ms === undefined) return '—'
  if (ms < 1000) return `${ms} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`
}

function formatInterval(seconds: number): string {
  if (seconds % 86_400 === 0) return seconds === 86_400 ? 'daily' : `every ${seconds / 86_400} days`
  if (seconds % 3600 === 0) return seconds === 3600 ? 'hourly' : `every ${seconds / 3600}h`
  return `every ${Math.round(seconds / 60)} min`
}

const humanName = (name: string) => {
  const s = name.replace(/[-_]+/g, ' ')
  return s.charAt(0).toUpperCase() + s.slice(1)
}

const RUNNER_LABEL: Record<ScheduledJobsResponse['runner'], string> = {
  builtin: 'Built-in runner (web process + GitHub trigger)',
  celery: 'Celery worker',
  off: 'Runner switched off',
}

export function ScheduledJobsPanel() {
  const qc = useQueryClient()
  const refetchInterval = useLiveRefetchInterval(60_000)
  const q = useQuery({ queryKey: JOBS_QUERY_KEY, queryFn: jobsApi.list, refetchInterval })
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [confirm, setConfirm] = useState<ScheduledJob | null>(null)
  const [runError, setRunError] = useState<string | null>(null)
  const [pausing, setPausing] = useState<ScheduledJob | null>(null)
  const canPause = usePermissions().can('settings.system')
  const [pauseReason, setPauseReason] = useState('')

  const pause = useMutation({
    mutationFn: ({ job, paused }: { job: ScheduledJob; paused: boolean }) =>
      paused ? consoleB.pauseJob(job.name, pauseReason.trim()) : consoleB.resumeJob(job.name),
    onSuccess: () => { setPausing(null); setPauseReason(''); setRunError(null); void qc.invalidateQueries({ queryKey: JOBS_QUERY_KEY }) },
    onError: (err: Error) => { setPausing(null); setRunError(err.message) },
  })

  const run = useMutation({
    mutationFn: (name: string) => jobsApi.run(name),
    onSuccess: () => {
      setConfirm(null)
      setRunError(null)
      void qc.invalidateQueries({ queryKey: JOBS_QUERY_KEY })
    },
    onError: (err: Error) => {
      setConfirm(null)
      setRunError(err.message)
    },
  })

  const jobs = q.data?.jobs ?? []
  const failing = jobs.filter((j) => j.last_status === 'error')
  const overdue = jobs.filter((j) => j.overdue)
  const toggle = (name: string) => setOpen((o) => ({ ...o, [name]: !o[name] }))

  return (
    <Panel
      title="Scheduled jobs"
      description={
        q.data
          ? `${RUNNER_LABEL[q.data.runner]} · ${jobs.length} jobs · times in UTC${q.data.runner === 'builtin' && !q.data.cron_configured ? ' · CRON_SECRET not set, jobs only run while the server is awake' : ''}`
          : 'Background jobs and when they last ran'
      }
      actions={
        q.data && (failing.length > 0 || overdue.length > 0) ? (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-warning">
            <AlertTriangle size={13} aria-hidden />
            {[failing.length ? `${failing.length} failed` : '', overdue.length ? `${overdue.length} overdue` : ''].filter(Boolean).join(' · ')}
          </span>
        ) : undefined
      }
      padding="none"
    >
      {runError && (
        <div role="alert" className="flex items-start gap-2 border-b border-danger-line bg-danger-soft px-4 py-2 text-sm text-danger">
          <XCircle size={15} className="mt-0.5 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1">{runError}</span>
          <button type="button" className="text-xs font-medium underline" onClick={() => setRunError(null)}>Dismiss</button>
        </div>
      )}
      {q.isLoading ? (
        <div className="space-y-2 p-4">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} height={36} />)}</div>
      ) : q.error ? (
        <div className="p-4"><ErrorState size="compact" error={q.error} onRetry={() => void q.refetch()} title="Could not load the scheduled jobs" /></div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[46rem] text-sm">
            <caption className="sr-only">Scheduled jobs with their last run and status</caption>
            <thead className="border-b border-surface-border text-xs text-ink-muted">
              <tr>
                <th scope="col" className="px-4 py-2 text-left font-medium">Job</th>
                <th scope="col" className="px-4 py-2 text-left font-medium">Status</th>
                <th scope="col" className="px-4 py-2 text-left font-medium">Last run</th>
                <th scope="col" className="px-4 py-2 text-right font-medium">Duration</th>
                <th scope="col" className="px-4 py-2 text-left font-medium">Next due</th>
                <th scope="col" className="px-4 py-2 text-right font-medium"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {jobs.map((j) => {
                const expandable = true
                const isOpen = Boolean(open[j.name])
                return (
                  <Fragment key={j.name}>
                    <tr className={cn(j.last_status === 'error' && !j.running ? 'bg-danger-soft/40' : j.overdue && 'bg-warning-soft/40')}>
                      <td className="px-4 py-2.5 align-top">
                        <button
                          type="button"
                          className={cn('flex items-start gap-1 text-left', !expandable && 'cursor-default')}
                          onClick={() => expandable && toggle(j.name)}
                          aria-expanded={expandable ? isOpen : undefined}
                          disabled={!expandable}
                        >
                          {expandable ? (
                            isOpen ? <ChevronDown size={14} className="mt-0.5 shrink-0 text-ink-muted" aria-hidden /> : <ChevronRight size={14} className="mt-0.5 shrink-0 text-ink-muted" aria-hidden />
                          ) : <span className="w-[14px] shrink-0" aria-hidden />}
                          <span>
                            <span className="block font-medium text-ink-primary">{humanName(j.name)}</span>
                            <span className="mono block text-2xs text-ink-muted">{j.schedule} · {formatInterval(j.interval_seconds)}</span>
                          </span>
                        </button>
                      </td>
                      <td className="px-4 py-2.5 align-top">
                        <div className="flex flex-wrap gap-1">
                          <StatusPill job={j} />
                          {j.paused && <PausedPill job={j} />}
                          {j.overdue && !j.running && !j.paused && <OverduePill />}
                        </div>
                      </td>
                      <td className="px-4 py-2.5 align-top text-ink-secondary">
                        {j.last_started_at ? (
                          <span title={formatDateTime(j.last_started_at)}>{formatRelative(j.last_started_at)}</span>
                        ) : '—'}
                        {j.run_count > 0 && <span className="block text-2xs text-ink-muted">{j.run_count} run{j.run_count === 1 ? '' : 's'}</span>}
                      </td>
                      <td className="num px-4 py-2.5 text-right align-top text-ink-secondary">{formatDuration(j.last_duration_ms)}</td>
                      <td className="px-4 py-2.5 align-top text-ink-secondary">
                        {j.due ? <span className="font-medium text-ink-primary">Now</span> : j.next_due_at ? <span title={formatDateTime(j.next_due_at)}>{formatDateTime(j.next_due_at)}</span> : '—'}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-right align-top">
                        {canPause && <Button
                          size="sm"
                          variant="ghost"
                          className="mr-1"
                          leftIcon={j.paused ? <Play size={12} aria-hidden /> : <Pause size={12} aria-hidden />}
                          disabled={pause.isPending}
                          onClick={() => (j.paused ? pause.mutate({ job: j, paused: false }) : setPausing(j))}
                        >
                          {j.paused ? 'Resume' : 'Pause'}
                        </Button>}
                        <Button
                          size="sm"
                          variant="secondary"
                          leftIcon={<Play size={12} aria-hidden />}
                          disabled={j.running || q.data?.runner === 'off' || (run.isPending && run.variables === j.name)}
                          onClick={() => setConfirm(j)}
                        >
                          Run now
                        </Button>
                      </td>
                    </tr>
                    {expandable && isOpen && (
                      <tr className="bg-surface-base">
                        <td colSpan={6} className="px-4 py-2.5">
                          {j.last_error && (
                            <>
                              <p className="text-xs font-medium text-danger">Last error</p>
                              <pre className="mono mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded border border-danger-line bg-surface-card p-2 text-xs text-ink-primary">{j.last_error}</pre>
                            </>
                          )}
                          {j.last_result && (
                            <p className="mt-1 text-xs text-ink-muted">
                              Last result: <span className="mono text-ink-secondary">{j.last_result}</span>
                            </p>
                          )}
                          {j.paused && (
                            <p className="mt-1 text-xs text-warning">
                              Paused {j.paused_at ? formatRelative(j.paused_at) : ''} by {j.paused_by ?? 'staff'}{j.pause_reason ? `: ${j.pause_reason}` : ''}. No runner starts it until it is resumed; Run now still works.
                            </p>
                          )}
                          <p className="mb-1 mt-2 text-xs font-medium text-ink-secondary">Recent runs</p>
                          <JobHistory name={j.name} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <ConfirmModal
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        onConfirm={() => confirm && run.mutate(confirm.name)}
        loading={run.isPending}
        variant="warning"
        title="Run this job now?"
        message="The job runs once in the background, the same way the scheduler runs it. If it is already running this does nothing. The run is recorded in the audit log."
        details={confirm ? [
          { label: 'Job', value: humanName(confirm.name) },
          { label: 'Task', value: <span className="mono text-xs">{confirm.task}</span> },
          { label: 'Schedule', value: <span className="mono text-xs">{confirm.schedule}</span> },
        ] : undefined}
        confirmLabel="Run now"
      />
      <ConfirmModal
        open={pausing !== null}
        onClose={() => setPausing(null)}
        onConfirm={() => pausing && pause.mutate({ job: pausing, paused: true })}
        loading={pause.isPending}
        variant="warning"
        title="Pause this job?"
        message="Every runner (built-in ticker, GitHub trigger and Celery) skips the job until you resume it. Pausing money jobs delays settlement and payouts."
        details={pausing ? [{ label: 'Job', value: humanName(pausing.name) }, { label: 'Schedule', value: <span className="mono text-xs">{pausing.schedule}</span> }] : undefined}
        confirmLabel="Pause job"
        confirmDisabled={pauseReason.trim().length < 5}
      >
        <Textarea label="Reason (kept in the audit log)" rows={2} value={pauseReason} onChange={(e) => setPauseReason(e.target.value)} />
      </ConfirmModal>
    </Panel>
  )
}
