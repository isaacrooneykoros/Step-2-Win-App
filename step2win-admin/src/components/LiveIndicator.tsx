import { format } from 'date-fns'
import { cn } from '../lib/cn'
import { useRealtimeStore, type ConnectionStatus } from '../lib/realtime/store'

const META: Record<Exclude<ConnectionStatus, 'idle'>, { label: string; dot: string; text: string; help: string }> = {
  live: {
    label: 'Live',
    dot: 'bg-success',
    text: 'text-ink-secondary',
    help: 'Live: changes from customer phones appear within a couple of seconds.',
  },
  connecting: {
    label: 'Connecting',
    dot: 'bg-ink-disabled',
    text: 'text-ink-muted',
    help: 'Connecting to live updates…',
  },
  reconnecting: {
    label: 'Reconnecting',
    dot: 'bg-warning',
    text: 'text-ink-muted',
    help: 'Live updates dropped. Reconnecting; the page refreshes everything once back.',
  },
  polling: {
    label: 'Polling',
    dot: 'bg-warning',
    text: 'text-warning',
    help: 'Live updates unavailable. Pages refresh every 30–60 seconds until the connection returns.',
  },
  paused: {
    label: 'Paused',
    dot: 'bg-ink-disabled',
    text: 'text-ink-muted',
    help: 'Paused while this tab is in the background.',
  },
}

/** Small, calm connection state for the top bar. Fixed width: no layout shift between states. */
export function LiveIndicator() {
  const status = useRealtimeStore((s) => s.status)
  const lastEventAt = useRealtimeStore((s) => s.lastEventAt)
  const nextRetryAt = useRealtimeStore((s) => s.nextRetryAt)
  if (status === 'idle') return null
  const m = META[status]
  const detail = [
    m.help,
    lastEventAt ? `Last update ${format(lastEventAt, 'HH:mm:ss')}.` : null,
    status !== 'live' && nextRetryAt ? `Next attempt ${format(nextRetryAt, 'HH:mm:ss')}.` : null,
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <span
      role="status"
      aria-live="polite"
      title={detail}
      className="inline-flex h-9 w-9 shrink-0 items-center justify-center gap-1.5 rounded-md text-xs font-medium sm:w-[104px] sm:justify-start sm:px-2"
    >
      <span aria-hidden className={cn('h-2 w-2 shrink-0 rounded-full', m.dot)} />
      <span className={cn('hidden truncate sm:inline', m.text)}>{m.label}</span>
      <span className="sr-only sm:hidden">{m.label}</span>
    </span>
  )
}
