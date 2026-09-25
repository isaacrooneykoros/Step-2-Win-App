import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { API_BASE } from '../../config/network'
import { refreshAccessToken, useAuthStore } from '../../store/authStore'
import { AdminRealtimeClient } from './client'
import { EventRouter } from './router'
import { useRealtimeStore } from './store'

/** After this long without a live socket, queries fall back to polling. */
export const POLL_AFTER_MS = 30_000
/** Close the socket when the tab has been hidden this long. */
const HIDDEN_PAUSE_MS = 30_000

export function adminEventsUrl(apiBase = API_BASE): string {
  const url = new URL(apiBase)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/ws/admin/events/`
  url.search = ''
  return url.toString()
}

/**
 * Keeps one realtime socket open while an admin is signed in (mount once, in
 * the app shell). Events invalidate the affected queries; reconnects, gaps and
 * backpressure trigger a resync of everything on screen.
 */
export function useAdminRealtime() {
  const qc = useQueryClient()
  const signedIn = useAuthStore((s) => Boolean(s.accessToken && s.user?.is_staff))

  useEffect(() => {
    const store = useRealtimeStore.getState()
    if (!signedIn) {
      store.setStatus('idle')
      return
    }

    const router = new EventRouter(qc)
    let pollTimer: ReturnType<typeof setTimeout> | null = null
    const clearPollTimer = () => {
      if (pollTimer) clearTimeout(pollTimer)
      pollTimer = null
    }

    const client = new AdminRealtimeClient({
      url: adminEventsUrl(),
      getToken: () => useAuthStore.getState().accessToken,
      refreshToken: refreshAccessToken,
      onEvents: router.handle,
      onResync: () => router.resync(),
      onStatus: (status, { nextRetryAt }) => {
        const s = useRealtimeStore.getState()
        if (status === 'live') {
          clearPollTimer()
          s.setStatus('live', { downSince: null, nextRetryAt: null })
          return
        }
        if (status === 'stopped') {
          clearPollTimer()
          s.setStatus('idle', { downSince: null, nextRetryAt: null })
          return
        }
        if (status === 'paused') {
          clearPollTimer()
          s.setStatus('paused', { downSince: null, nextRetryAt: null })
          return
        }
        // connecting / reconnecting: after POLL_AFTER_MS down, switch queries to polling.
        const downSince = s.downSince ?? Date.now()
        if (s.status === 'polling' || Date.now() - downSince >= POLL_AFTER_MS) {
          enterPolling(nextRetryAt)
          return
        }
        s.setStatus(status, { downSince, nextRetryAt })
        if (!pollTimer) {
          pollTimer = setTimeout(() => {
            pollTimer = null
            const cur = useRealtimeStore.getState().status
            if (cur !== 'live' && cur !== 'paused' && cur !== 'idle') enterPolling()
          }, Math.max(0, downSince + POLL_AFTER_MS - Date.now()))
        }
      },
    })

    // Entering polling: refresh what is on screen now (intervals only start ticking from here).
    function enterPolling(nextRetryAt?: number | null) {
      const s = useRealtimeStore.getState()
      if (s.status !== 'polling') router.resync()
      s.setStatus('polling', nextRetryAt === undefined ? undefined : { nextRetryAt })
    }

    // While down, a successful API response means the server is back: reconnect now
    // instead of waiting out the backoff (up to 30 s). At most every 5 s.
    let lastNudge = 0
    const unsubscribeCache = qc.getQueryCache().subscribe((event) => {
      if (event.type !== 'updated' || event.action.type !== 'success') return
      const st = useRealtimeStore.getState().status
      if (st !== 'reconnecting' && st !== 'polling') return
      const now = Date.now()
      if (now - lastNudge < 5_000) return
      lastNudge = now
      client.resume()
    })

    // Hidden tab: keep the socket for a short while, then close it. Visible: reconnect and resync.
    let hiddenTimer: ReturnType<typeof setTimeout> | null = null
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        if (!hiddenTimer) hiddenTimer = setTimeout(() => { hiddenTimer = null; client.pause() }, HIDDEN_PAUSE_MS)
      } else {
        if (hiddenTimer) clearTimeout(hiddenTimer)
        hiddenTimer = null
        // Back from a paused (closed) socket: what is on screen may be old. Refresh it now;
        // the reconnect's hello resyncs again once live.
        if (useRealtimeStore.getState().status === 'paused') router.resync()
        client.resume()
      }
    }
    const onOnline = () => client.resume()
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('online', onOnline)

    // Renewed access tokens (any refresh path in the app) are pushed to the open socket.
    const unsubscribe = useAuthStore.subscribe((state, prev) => {
      if (state.accessToken && state.accessToken !== prev.accessToken) client.renewAuth(state.accessToken)
    })

    client.start()
    return () => {
      unsubscribe()
      unsubscribeCache()
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('online', onOnline)
      if (hiddenTimer) clearTimeout(hiddenTimer)
      clearPollTimer()
      client.stop()
      router.dispose()
    }
  }, [signedIn, qc])
}

/**
 * `refetchInterval` for a query: no polling while the socket is live (events
 * drive refetches); `fallbackMs` polling when realtime is down for over 30 s.
 */
export function useLiveRefetchInterval(fallbackMs: number): number | false {
  const status = useRealtimeStore((s) => s.status)
  return status === 'polling' || status === 'idle' ? fallbackMs : false
}
