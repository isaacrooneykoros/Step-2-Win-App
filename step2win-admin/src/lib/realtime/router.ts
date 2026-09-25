/**
 * Turns pushed events into React Query refreshes.
 *
 * Pushed payloads are hints, not truth: each event maps to the query keys it
 * can affect and those are invalidated (active queries refetch, inactive ones
 * are marked stale). A per-key throttle makes a burst cost at most one refetch
 * per key per `gap` (leading edge + one trailing refetch), and a refetch is
 * never cancelled mid-flight: if one is running, the next waits for it.
 * Cheap, unambiguous changes (a status) are also patched straight into cached lists.
 */
import type { QueryClient, QueryKey } from '@tanstack/react-query'
import type { EventEntry, EventsFrame } from './client'
import { useRealtimeStore, type FlashDomain } from './store'

interface Target {
  key: QueryKey
  /** Minimum ms between two refetches of this key. */
  gap: number
}

const FAST = 1_200
const LIST = 2_000
const HEAVY = 5_000
const VERY_HEAVY = 10_000
/** Per-entity keys beyond this in one batch fall back to the prefix. */
const MAX_ENTITY_KEYS = 25
/** Throttle slots kept before idle ones are pruned. */
const MAX_SLOTS = 400

const K = {
  users: ['admin', 'users'],
  userStats: ['admin', 'user-stats'],
  userOverview: ['admin', 'user-overview'],
  overview: ['admin', 'overview'],
  pulse: ['admin', 'realtime', 'pulse'],
  stepLogs: ['admin', 'step-logs'],
  stepHourly: ['admin', 'step-hourly'],
  challenges: ['admin', 'challenges'],
  challengeStats: ['admin', 'challenge-stats'],
  challengeResults: ['admin', 'challenge-results'],
  ledger: ['admin', 'finance', 'ledger'],
  withdrawals: ['admin', 'finance', 'withdrawals'],
  withdrawal: ['admin', 'finance', 'withdrawal'],
  analytics: ['admin', 'finance', 'analytics'],
  report: ['admin', 'finance', 'report'],
  withdrawalStats: ['admin', 'withdrawal-stats'],
  notifications: ['admin', 'notifications'],
  fraud: ['admin', 'fraud-overview'],
  trust: ['admin', 'trust'],
  ops: ['admin', 'ops-monitoring'],
  audit: ['admin', 'audit-logs'],
  jobs: ['admin', 'scheduled-jobs'],
  supportQueue: ['support', 'queue'],
  conversation: ['support', 'conversation'],
} as const

const t = (key: QueryKey, gap = FAST): Target => ({ key, gap })

function ids(entry: EventEntry, field: string): Array<string | number> {
  const out: Array<string | number> = []
  for (const item of entry.items ?? []) {
    const v = item[field]
    if (typeof v === 'number' || typeof v === 'string') out.push(v)
  }
  return out
}

/** Per-entity keys like ['admin','user-overview', 12]; collapses to the prefix when there are many. */
function perEntity(prefix: QueryKey, values: Array<string | number>, gap = FAST): Target[] {
  if (!values.length) return []
  if (values.length > MAX_ENTITY_KEYS) return [t(prefix, gap)]
  return [...new Set(values)].map((v) => t([...prefix, v], gap))
}

function targetsFor(entry: EventEntry): Target[] {
  const domain = entry.kind.split('.')[0]
  const bulk = entry.kind.endsWith('.bulk_changed')
  const users = bulk ? [] : ids(entry, 'user_id')

  switch (bulk ? `${domain}.*bulk` : entry.kind) {
    case 'user.registered':
    case 'user.deleted':
      return [t(K.users, LIST), t(K.userStats, LIST), t(K.overview, HEAVY), t(K.pulse, 3_000), ...perEntity(K.userOverview, ids(entry, 'id'))]
    case 'user.updated':
      return [t(K.users, LIST), ...perEntity(K.userOverview, ids(entry, 'id'))]
    case 'user.*bulk':
      return [t(K.users, HEAVY), t(K.userStats, HEAVY), t(K.overview, VERY_HEAVY), t(K.userOverview, HEAVY)]
    case 'session.login':
    case 'session.updated':
    case 'device.updated':
      return [t(K.users, LIST), t(K.pulse, 3_000), ...perEntity(K.userOverview, users)]
    case 'session.*bulk':
    case 'device.*bulk':
      return [t(K.users, HEAVY), t(K.pulse, 5_000), t(K.userOverview, HEAVY)]
    case 'steps.updated':
      return [
        t(K.stepLogs, LIST), t(K.users, LIST), t(K.overview, HEAVY), t(K.pulse, 3_000),
        ...perEntity(K.userOverview, users), ...perEntity(K.stepHourly, users),
      ]
    case 'steps.*bulk':
      return [t(K.stepLogs, HEAVY), t(K.users, HEAVY), t(K.overview, VERY_HEAVY), t(K.pulse, 5_000), t(K.userOverview, HEAVY), t(K.stepHourly, HEAVY)]
    case 'challenge.created':
    case 'challenge.updated':
    case 'challenge.deleted':
      return [t(K.challenges, LIST), t(K.challengeStats, LIST), t(K.overview, HEAVY), ...perEntity(K.challengeResults, ids(entry, 'id'))]
    case 'challenge.joined':
    case 'challenge.left':
      return [
        t(K.challenges, LIST), t(K.challengeStats, LIST),
        ...perEntity(K.challengeResults, ids(entry, 'challenge_id')), ...perEntity(K.userOverview, users),
      ]
    case 'challenge.progress':
      return perEntity(K.challengeResults, ids(entry, 'challenge_id'), LIST)
    case 'challenge.*bulk':
      return [t(K.challenges, HEAVY), t(K.challengeStats, HEAVY), t(K.challengeResults, HEAVY), t(K.overview, VERY_HEAVY)]
    case 'wallet.transaction':
      return [t(K.ledger, LIST), t(K.users, LIST), t(K.overview, HEAVY), t(K.analytics, VERY_HEAVY), ...perEntity(K.userOverview, users)]
    case 'wallet.*bulk':
      return [t(K.ledger, HEAVY), t(K.users, HEAVY), t(K.overview, VERY_HEAVY), t(K.analytics, VERY_HEAVY), t(K.userOverview, HEAVY)]
    case 'payment.updated':
      return [t(K.ledger, LIST), t(K.overview, HEAVY), t(K.ops, VERY_HEAVY), t(K.analytics, VERY_HEAVY), t(K.report, VERY_HEAVY), ...perEntity(K.userOverview, users)]
    case 'payment.*bulk':
      return [t(K.ledger, HEAVY), t(K.overview, VERY_HEAVY), t(K.ops, VERY_HEAVY), t(K.analytics, VERY_HEAVY), t(K.report, VERY_HEAVY)]
    case 'withdrawal.updated':
    case 'withdrawal.legacy':
      return [
        t(K.withdrawals), t(K.withdrawalStats), t(K.notifications), t(K.overview, HEAVY), t(K.ops, VERY_HEAVY),
        ...perEntity(K.withdrawal, entry.kind === 'withdrawal.updated' ? ids(entry, 'id') : []), ...perEntity(K.userOverview, users),
      ]
    case 'withdrawal.*bulk':
      return [t(K.withdrawals, HEAVY), t(K.withdrawal, HEAVY), t(K.withdrawalStats, HEAVY), t(K.notifications, HEAVY), t(K.overview, VERY_HEAVY), t(K.ops, VERY_HEAVY)]
    case 'support.ticket':
      return [t(K.supportQueue), t(K.notifications), ...perEntity(K.conversation, ids(entry, 'id')), ...perEntity(K.userOverview, users)]
    case 'support.message':
      return [t(K.supportQueue), t(K.notifications), ...perEntity(K.conversation, ids(entry, 'ticket_id'))]
    case 'support.*bulk':
      return [t(K.supportQueue, HEAVY), t(K.notifications, HEAVY), t(K.conversation, HEAVY)]
    case 'trust.flag':
    case 'trust.activity':
    case 'trust.review':
      return [t(K.trust, LIST), t(K.fraud), t(K.notifications), t(K.ops, VERY_HEAVY), ...perEntity(K.userOverview, users)]
    case 'trust.score':
      return [t(K.trust, HEAVY), t(K.users, LIST), ...perEntity(K.userOverview, users)]
    case 'trust.*bulk':
      return [t(K.trust, HEAVY), t(K.fraud, HEAVY), t(K.notifications, HEAVY), t(K.users, HEAVY), t(K.ops, VERY_HEAVY)]
    case 'audit.logged':
    case 'audit.*bulk':
      return [t(K.audit, LIST), t(K.notifications, LIST)]
    case 'jobs.updated':
    case 'jobs.*bulk':
      return [t(K.jobs, LIST)]
    default:
      return []
  }
}

/** Beyond this many changed rows in one batch, highlighting is noise (and costs renders). */
const MAX_FLASH_ITEMS = 30

/** Rows to highlight for an entry. */
function flashesFor(entry: EventEntry): Array<[FlashDomain, Array<string | number>]> {
  if (!entry.items || entry.items.length > MAX_FLASH_ITEMS) return []
  switch (entry.kind) {
    case 'user.registered':
    case 'user.updated':
      return [['user', ids(entry, 'id')]]
    case 'session.login':
    case 'trust.score':
      return [['user', ids(entry, 'user_id')]]
    case 'steps.updated':
      return [['steps', ids(entry, 'user_id')], ['user', ids(entry, 'user_id')]]
    case 'challenge.created':
    case 'challenge.updated':
      return [['challenge', ids(entry, 'id')]]
    case 'challenge.joined':
    case 'challenge.left':
      return [['challenge', ids(entry, 'challenge_id')]]
    case 'withdrawal.updated':
      return [['withdrawal', ids(entry, 'id')]]
    case 'wallet.transaction':
      return [['wallet', ids(entry, 'id')], ['user', ids(entry, 'user_id')]]
    case 'payment.updated':
      return [['payment', ids(entry, 'id')]]
    case 'support.ticket':
      return [['ticket', ids(entry, 'id')]]
    case 'support.message':
      return [['ticket', ids(entry, 'ticket_id')]]
    case 'trust.flag':
    case 'trust.review':
      return [['flag', ids(entry, 'id')], ['user', ids(entry, 'user_id')]]
    default:
      return []
  }
}

const KPI_KINDS = /^(user\.(registered|deleted|bulk_changed)|steps\.|challenge\.(created|updated|deleted|bulk_changed)|wallet\.|payment\.|withdrawal\.|trust\.(flag|bulk_changed)|support\.ticket)/

interface PagedRows {
  results: Array<{ id: number | string; status?: string }>
}

function isPaged(v: unknown): v is PagedRows {
  return Boolean(v && typeof v === 'object' && Array.isArray((v as PagedRows).results))
}

export class EventRouter {
  private readonly qc: QueryClient
  private readonly slots = new Map<string, { last: number; timer: ReturnType<typeof setTimeout> | null; key: QueryKey; gap: number }>()
  private lastResync = 0
  private resyncTimer: ReturnType<typeof setTimeout> | null = null
  private disposed = false

  constructor(qc: QueryClient) {
    this.qc = qc
  }

  handle = (frame: EventsFrame) => {
    const store = useRealtimeStore.getState()
    store.noteFrame()
    let kpi = false
    for (const entry of frame.events) {
      this.patch(entry)
      for (const target of targetsFor(entry)) this.request(target)
      for (const [domain, list] of flashesFor(entry)) store.flash(domain, list)
      if (KPI_KINDS.test(entry.kind)) kpi = true
    }
    if (kpi) store.pulseKpis()
  }

  /** Something may have been missed: refetch everything on screen (at most every 2 s). */
  resync = () => {
    if (this.disposed || this.resyncTimer) return
    const wait = this.lastResync + 2_000 - Date.now()
    const run = () => {
      this.resyncTimer = null
      this.lastResync = Date.now()
      void this.qc.invalidateQueries({ refetchType: 'active' }, { cancelRefetch: false })
    }
    if (wait <= 0) run()
    else this.resyncTimer = setTimeout(run, wait)
  }

  dispose() {
    this.disposed = true
    for (const slot of this.slots.values()) if (slot.timer) clearTimeout(slot.timer)
    this.slots.clear()
    if (this.resyncTimer) clearTimeout(this.resyncTimer)
  }

  private request(target: Target) {
    if (this.disposed) return
    const id = JSON.stringify(target.key)
    let slot = this.slots.get(id)
    if (!slot) {
      if (this.slots.size >= MAX_SLOTS) this.prune()
      slot = { last: 0, timer: null, key: target.key, gap: target.gap }
      this.slots.set(id, slot)
    }
    slot.gap = Math.max(slot.gap, target.gap)
    if (slot.timer) return // a trailing refetch is already scheduled; it will see this change
    const wait = slot.last + slot.gap - Date.now()
    const s = slot
    if (wait <= 0) this.fire(s)
    else s.timer = setTimeout(() => this.fire(s), wait)
  }

  /** Per-entity keys come and go with user ids; forget idle ones so the map stays bounded. */
  private prune() {
    const cutoff = Date.now() - 30_000
    for (const [id, slot] of this.slots) if (!slot.timer && slot.last < cutoff) this.slots.delete(id)
  }

  private fire(slot:{ last: number; timer: ReturnType<typeof setTimeout> | null; key: QueryKey; gap: number }) {
    slot.timer = null
    if (this.disposed) return
    if (this.qc.isFetching({ queryKey: slot.key }) > 0) {
      // Don't cancel a running refetch (under a storm it would never finish). Wait for it,
      // then refetch once more: it may have read data from before this change committed.
      slot.timer = setTimeout(() => this.fire(slot), 300)
      return
    }
    slot.last = Date.now()
    slot.gap = 0 // the next request sets the gap it needs
    void this.qc.invalidateQueries({ queryKey: slot.key }, { cancelRefetch: false })
  }

  /** Status changes are unambiguous: show them right away, the refetch confirms. */
  private patch(entry: EventEntry) {
    const prefix =
      entry.kind === 'withdrawal.updated' ? K.withdrawals : entry.kind === 'support.ticket' ? K.supportQueue : null
    if (!prefix || !entry.items) return
    const changes = new Map<string, string>()
    for (const item of entry.items) {
      if ((typeof item.id === 'number' || typeof item.id === 'string') && typeof item.status === 'string') {
        changes.set(String(item.id), item.status)
      }
    }
    if (!changes.size) return
    this.qc.setQueriesData({ queryKey: prefix }, (old: unknown) => {
      if (!isPaged(old)) return old
      let touched = false
      const results = old.results.map((row) => {
        const status = changes.get(String(row.id))
        if (status === undefined || row.status === status) return row
        touched = true
        return { ...row, status }
      })
      return touched ? { ...old, results } : old
    })
  }
}
