/**
 * Realtime connection state + short-lived "just changed" markers used for
 * highlight-on-update. Markers expire on their own (timers live here, so
 * components stay pure: they only read the store).
 */
import { create } from 'zustand'

export type ConnectionStatus =
  | 'idle' // not started (signed out)
  | 'connecting' // first attempt
  | 'live' // authenticated and receiving events
  | 'reconnecting' // dropped; retrying with backoff (no polling yet)
  | 'polling' // down for more than POLL_AFTER_MS; queries poll as a fallback
  | 'paused' // tab hidden; socket closed to save server resources

/** Domains that rows can be highlighted by. Ids are stringified. */
export type FlashDomain = 'user' | 'steps' | 'challenge' | 'withdrawal' | 'ticket' | 'flag' | 'wallet' | 'payment'

const FLASH_MS = 2200
const KPI_FLASH_MS = 4000

interface RealtimeState {
  status: ConnectionStatus
  /** Epoch ms of the last events frame. */
  lastEventAt: number | null
  /** Epoch ms when the socket last went down (null while live). */
  downSince: number | null
  /** Epoch ms of the next reconnect attempt, when one is scheduled. */
  nextRetryAt: number | null
  /** Events frames received in this session (diagnostics / tooltip). */
  frames: number
  flashing: Partial<Record<FlashDomain, Record<string, true>>>
  /** True briefly after an event that moves dashboard numbers. */
  kpiLive: boolean
  setStatus: (status: ConnectionStatus, extra?: Partial<Pick<RealtimeState, 'downSince' | 'nextRetryAt'>>) => void
  noteFrame: () => void
  flash: (domain: FlashDomain, ids: Array<string | number>) => void
  pulseKpis: () => void
}

/** `${domain}|${id}` -> epoch ms when the highlight ends. One sweeper timer expires them in batches. */
const flashExpiry = new Map<string, number>()
let sweepTimer: ReturnType<typeof setTimeout> | null = null
let kpiTimer: ReturnType<typeof setTimeout> | null = null

function scheduleSweep(delay: number) {
  if (sweepTimer) return
  sweepTimer = setTimeout(sweepFlashes, Math.max(50, delay + 20))
}

function sweepFlashes() {
  sweepTimer = null
  const now = Date.now()
  const expired = new Map<FlashDomain, string[]>()
  let nextAt = Infinity
  for (const [key, until] of flashExpiry) {
    if (until <= now) {
      flashExpiry.delete(key)
      const sep = key.indexOf('|')
      const domain = key.slice(0, sep) as FlashDomain
      const list = expired.get(domain) ?? []
      list.push(key.slice(sep + 1))
      expired.set(domain, list)
    } else if (until < nextAt) {
      nextAt = until
    }
  }
  if (expired.size) {
    useRealtimeStore.setState((s) => {
      const flashing = { ...s.flashing }
      for (const [domain, ids] of expired) {
        const rest = { ...(flashing[domain] ?? {}) }
        for (const id of ids) delete rest[id]
        flashing[domain] = rest
      }
      return { flashing }
    })
  }
  if (flashExpiry.size) scheduleSweep(nextAt - now)
}
/** Highlighting hundreds of rows at once is noise; cap per event batch. */
const MAX_FLASH_PER_BATCH = 60

export const useRealtimeStore = create<RealtimeState>((set, get) => ({
  status: 'idle',
  lastEventAt: null,
  downSince: null,
  nextRetryAt: null,
  frames: 0,
  flashing: {},
  kpiLive: false,

  setStatus: (status, extra) => {
    const cur = get()
    const downSince =
      extra?.downSince !== undefined ? extra.downSince : status === 'live' || status === 'idle' ? null : cur.downSince
    const nextRetryAt = extra?.nextRetryAt !== undefined ? extra.nextRetryAt : status === 'live' ? null : cur.nextRetryAt
    if (cur.status === status && cur.downSince === downSince && cur.nextRetryAt === nextRetryAt) return
    set({ status, downSince, nextRetryAt })
  },

  noteFrame: () => set((s) => ({ lastEventAt: Date.now(), frames: s.frames + 1 })),

  flash: (domain, ids) => {
    if (!ids.length) return
    const list = ids.slice(0, MAX_FLASH_PER_BATCH).map(String)
    const until = Date.now() + FLASH_MS
    const cur = get().flashing[domain]
    let added = false
    for (const id of list) {
      flashExpiry.set(`${domain}|${id}`, until)
      if (!cur?.[id]) added = true
    }
    // One store update per batch (not per id): subscribers re-render at most once per frame.
    if (added) {
      set((s) => {
        const next = { ...(s.flashing[domain] ?? {}) }
        for (const id of list) next[id] = true
        return { flashing: { ...s.flashing, [domain]: next } }
      })
    }
    scheduleSweep(FLASH_MS)
  },

  pulseKpis: () => {
    if (kpiTimer) clearTimeout(kpiTimer)
    if (!get().kpiLive) set({ kpiLive: true })
    kpiTimer = setTimeout(() => {
      kpiTimer = null
      set({ kpiLive: false })
    }, KPI_FLASH_MS)
  },
}))

/** `true` while the row for `id` in `domain` was changed by a live event in the last ~2 s. */
export function useIsFlashing(domain: FlashDomain) {
  const map = useRealtimeStore((s) => s.flashing[domain])
  return (id: string | number | null | undefined) => id !== null && id !== undefined && Boolean(map?.[String(id)])
}
