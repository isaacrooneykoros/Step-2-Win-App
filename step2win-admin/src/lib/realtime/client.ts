/**
 * Admin realtime socket (framework-agnostic).
 *
 * - Auth: the access token is sent as the first frame (never in the URL). The
 *   server asks for a fresh one before expiry; 4401 closes refresh and retry.
 * - Liveness: ping every 20 s; if nothing arrives for 45 s the socket is treated
 *   as dead (silent drops on mobile networks / sleeping servers) and replaced.
 * - Reconnect: exponential backoff with full jitter, capped at 30 s, reset on
 *   a successful hello. `online` and tab-visible events retry immediately.
 * - Flow control: acks the highest events seq so the server can bound its
 *   per-connection queue; a gap in `seq` or in the per-server counter `n`
 *   means events were missed, which triggers a resync.
 * - Every reconnect after the first hello triggers a resync (events may have
 *   been missed while down).
 */

export interface EventEntry {
  kind: string
  count: number
  items?: Array<Record<string, unknown>>
  of?: string
}

export interface EventsFrame {
  type: 'events'
  seq: number
  src: string
  n: number
  ts: string
  events: EventEntry[]
}

export type ResyncReason = 'reconnect' | 'gap' | 'backpressure' | 'visible'

export type ClientStatus = 'connecting' | 'live' | 'reconnecting' | 'paused' | 'stopped'

export interface RealtimeClientOptions {
  url: string
  /** Current access token (may be null/expired). */
  getToken: () => string | null
  /** Single-flight refresh; resolves to a new access token or null. */
  refreshToken: () => Promise<string | null>
  onEvents: (frame: EventsFrame) => void
  onResync: (reason: ResyncReason) => void
  onStatus: (status: ClientStatus, info: { nextRetryAt: number | null }) => void
}

const HEARTBEAT_MS = 20_000
const DEAD_AFTER_MS = 45_000
const BACKOFF_BASE_MS = 1_000
const BACKOFF_MAX_MS = 30_000
const FORBIDDEN_RETRY_MS = 60_000
const ACK_DEBOUNCE_MS = 200

type Timer = ReturnType<typeof setTimeout>

export class AdminRealtimeClient {
  private readonly opts: RealtimeClientOptions
  private ws: WebSocket | null = null
  private stopped = true
  private paused = false
  private attempt = 0
  private everLive = false
  private authed = false
  private forceRefresh = false
  private lastRx = 0
  private seq = 0
  private acked = 0
  private window = 32
  private srcN = new Map<string, number>()
  private retryTimer: Timer | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private ackTimer: Timer | null = null

  constructor(opts: RealtimeClientOptions) {
    this.opts = opts
  }

  start() {
    if (!this.stopped) return
    this.stopped = false
    this.paused = false
    this.attempt = 0
    void this.open()
  }

  stop() {
    this.stopped = true
    this.clearRetry()
    this.teardown(1000)
    this.opts.onStatus('stopped', { nextRetryAt: null })
  }

  /** Close the socket while the tab is hidden. */
  pause() {
    if (this.stopped || this.paused) return
    this.paused = true
    this.clearRetry()
    this.teardown(1000)
    this.opts.onStatus('paused', { nextRetryAt: null })
  }

  /** Tab visible again / network back: connect now, resync on hello. */
  resume() {
    if (this.stopped) return
    const wasPaused = this.paused
    this.paused = false
    if (this.ws && !wasPaused) return
    this.clearRetry()
    this.attempt = 0
    void this.open()
  }

  /** Push a renewed access token to an open socket. */
  renewAuth(token: string | null) {
    if (token && this.authed) this.send({ type: 'auth', token })
  }

  get isLive() {
    return this.authed
  }

  // ── connection ─────────────────────────────────────────────────────────────

  private async open() {
    if (this.stopped || this.paused || this.ws) return
    this.opts.onStatus(this.everLive ? 'reconnecting' : 'connecting', { nextRetryAt: null })

    let token = this.forceRefresh ? null : this.opts.getToken()
    if (!token) token = await this.opts.refreshToken()
    this.forceRefresh = false
    if (this.stopped || this.paused || this.ws) return
    if (!token) {
      // Session could not be renewed; the API layer handles the redirect to login.
      this.scheduleReconnect(BACKOFF_MAX_MS)
      return
    }

    let ws: WebSocket
    try {
      ws = new WebSocket(this.opts.url)
    } catch {
      this.scheduleReconnect()
      return
    }
    this.ws = ws
    this.authed = false
    this.lastRx = Date.now()

    ws.onopen = () => {
      if (this.ws !== ws) return
      this.send({ type: 'auth', token })
    }
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return
      this.lastRx = Date.now()
      this.handle(typeof ev.data === 'string' ? ev.data : '')
    }
    ws.onclose = (ev) => {
      if (this.ws !== ws) return
      this.onClosed(ev.code)
    }
    ws.onerror = () => {
      // onclose follows; nothing to do here.
    }
    this.startHeartbeat()
  }

  private handle(raw: string) {
    let msg: { type?: string; [k: string]: unknown }
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }
    switch (msg.type) {
      case 'hello': {
        const reconnect = this.everLive
        this.authed = true
        this.everLive = true
        this.attempt = 0
        this.seq = 0
        this.acked = 0
        this.srcN.clear()
        if (typeof msg.window === 'number' && msg.window > 0) this.window = msg.window
        this.opts.onStatus('live', { nextRetryAt: null })
        if (reconnect) this.opts.onResync('reconnect')
        break
      }
      case 'events': {
        const frame = msg as unknown as EventsFrame
        let gap = this.seq > 0 && frame.seq !== this.seq + 1
        this.seq = frame.seq
        const prevN = this.srcN.get(frame.src)
        if (prevN !== undefined && frame.n !== prevN + 1) gap = true
        this.srcN.set(frame.src, frame.n)
        this.opts.onEvents(frame)
        if (gap) this.opts.onResync('gap')
        this.scheduleAck()
        break
      }
      case 'resync':
        this.opts.onResync('backpressure')
        break
      case 'auth.expiring':
        void this.opts.refreshToken().then((t) => this.renewAuth(t))
        break
      default:
        break // pong, auth.ok
    }
  }

  private onClosed(code: number) {
    this.teardown()
    if (this.stopped || this.paused) return
    if (code === 4401) {
      this.forceRefresh = true
      this.scheduleReconnect()
    } else if (code === 4403) {
      // Not staff / origin not allowed. Polling keeps the console working; retry slowly.
      this.scheduleReconnect(FORBIDDEN_RETRY_MS)
    } else {
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect(minDelay = 0) {
    this.clearRetry()
    const exp = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** this.attempt)
    // Full jitter keeps many tabs/admins from reconnecting in lockstep after a restart.
    const delay = Math.max(minDelay, Math.round(exp / 2 + Math.random() * (exp / 2)))
    this.attempt = Math.min(this.attempt + 1, 10)
    const nextRetryAt = Date.now() + delay
    this.opts.onStatus('reconnecting', { nextRetryAt })
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      void this.open()
    }, delay)
  }

  private clearRetry() {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
  }

  private teardown(code?: number) {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
    if (this.ackTimer) clearTimeout(this.ackTimer)
    this.ackTimer = null
    const ws = this.ws
    this.ws = null
    this.authed = false
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null
      try {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(code ?? 1000)
      } catch {
        // already closing
      }
    }
  }

  // ── heartbeat / ack ──────────────────────────────────────────────────────────

  private startHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    let lastPing = Date.now()
    this.heartbeatTimer = setInterval(() => {
      const now = Date.now()
      if (now - this.lastRx > DEAD_AFTER_MS) {
        // Silent drop: no pong, no events. Replace the socket.
        this.teardown()
        if (!this.stopped && !this.paused) this.scheduleReconnect()
        return
      }
      if (this.authed && now - lastPing >= HEARTBEAT_MS) {
        lastPing = now
        this.send({ type: 'ping', t: now })
      }
    }, 5_000)
  }

  private scheduleAck() {
    if (this.seq - this.acked >= Math.max(1, Math.floor(this.window / 2))) {
      this.flushAck()
      return
    }
    if (this.ackTimer) return
    this.ackTimer = setTimeout(() => this.flushAck(), ACK_DEBOUNCE_MS)
  }

  private flushAck() {
    if (this.ackTimer) clearTimeout(this.ackTimer)
    this.ackTimer = null
    if (this.seq > this.acked && this.send({ type: 'ack', seq: this.seq })) this.acked = this.seq
  }

  private send(data: unknown): boolean {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return false
    try {
      ws.send(JSON.stringify(data))
      return true
    } catch {
      return false
    }
  }
}
