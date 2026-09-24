import { useSyncExternalStore } from 'react';
import { App as CapacitorApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { resolveApiBaseUrl } from '../config/network';

/**
 * Keeps the hosted API warm while the app is open.
 *
 * The server sleeps after ~15 min without traffic and takes ~30 s to wake. This
 * wakes it the moment the app starts (during the splash and onboarding) so login
 * is quick, keeps it awake while the user lingers on signed-out screens, and
 * re-wakes it when the app returns from the background after a long break.
 * Pings are tiny, skip while offline or hidden, and stop whenever real API
 * traffic is already keeping the server awake.
 */

export type ServerStatus = 'unknown' | 'waking' | 'ready' | 'offline';

const KEEPALIVE_MS = 4 * 60_000; // well inside the ~15 min idle window
const STALE_AFTER_MS = 10 * 60_000; // after this long unseen, assume it may have slept
const PING_TIMEOUT_MS = 45_000; // a cold start can take ~30 s
const RETRY_DELAYS_MS = [2_000, 4_000, 8_000, 15_000];
const SLOW_WAKE_MS = 2_500; // a reply slower than this means it was asleep
const FRESH_MS = 60_000; // answered this recently: no need to ping again

let status: ServerStatus = 'unknown';
let lastSeenAt = 0; // last time the server answered anything (ping or API call)
let inFlight: Promise<void> | null = null;
let keepAliveTimer: number | undefined;
let started = false;
const listeners = new Set<() => void>();

function setStatus(next: ServerStatus) {
  if (next === status) return;
  status = next;
  listeners.forEach((listener) => listener());
}

function isOffline() {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

async function pingOnce(): Promise<boolean> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), PING_TIMEOUT_MS);
  const startedAt = performance.now();
  try {
    const res = await fetch(`${resolveApiBaseUrl()}/api/health/?deep=1`, {
      method: 'GET',
      cache: 'no-store',
      credentials: 'omit',
      signal: controller.signal,
    });
    if (!res.ok) return false;
    if (performance.now() - startedAt > SLOW_WAKE_MS && import.meta.env.DEV) {
      console.info(`[warmup] server woke up in ${Math.round(performance.now() - startedAt)} ms`);
    }
    return true;
  } catch {
    return false;
  } finally {
    window.clearTimeout(timer);
  }
}

/** Wake the server now (deduplicated). Retries with backoff while it's starting up. */
export function warmServer(): Promise<void> {
  if (inFlight) return inFlight;
  if (status === 'ready' && Date.now() - lastSeenAt < FRESH_MS) return Promise.resolve();
  inFlight = (async () => {
    for (let attempt = 0; ; attempt++) {
      if (isOffline()) {
        setStatus('offline');
        return;
      }
      if (status !== 'ready' || Date.now() - lastSeenAt > STALE_AFTER_MS) setStatus('waking');
      if (await pingOnce()) {
        noteServerActivity();
        return;
      }
      if (attempt >= RETRY_DELAYS_MS.length) {
        setStatus(isOffline() ? 'offline' : 'unknown');
        return;
      }
      await new Promise((resolve) => window.setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
    }
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/** Called for every successful API response: real traffic already keeps the server awake. */
export function noteServerActivity() {
  lastSeenAt = Date.now();
  setStatus('ready');
}

function scheduleKeepAlive() {
  window.clearInterval(keepAliveTimer);
  keepAliveTimer = window.setInterval(() => {
    if (document.visibilityState !== 'visible' || isOffline()) return;
    if (Date.now() - lastSeenAt < KEEPALIVE_MS) return; // recent traffic already did the job
    void warmServer();
  }, KEEPALIVE_MS / 2);
}

function onReturn() {
  if (document.visibilityState !== 'visible') return;
  if (Date.now() - lastSeenAt > STALE_AFTER_MS) void warmServer();
}

/** Start once at app launch, before React renders. */
export function startServerWarmup() {
  if (started || typeof window === 'undefined') return;
  started = true;

  // Open DNS + TLS to the API early; the first real request then skips the handshake.
  try {
    const origin = new URL(resolveApiBaseUrl()).origin;
    if (!document.querySelector(`link[rel="preconnect"][href="${origin}"]`)) {
      const link = document.createElement('link');
      link.rel = 'preconnect';
      link.href = origin;
      link.crossOrigin = 'anonymous';
      document.head.appendChild(link);
    }
  } catch {
    // Unparseable base URL: the ping below still works or fails on its own.
  }

  void warmServer();
  scheduleKeepAlive();
  document.addEventListener('visibilitychange', onReturn);
  window.addEventListener('online', () => void warmServer());
  if (Capacitor.isNativePlatform()) {
    void CapacitorApp.addListener('resume', onReturn).catch(() => undefined);
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Current server status, for screens that want to explain a slow first request. */
export function useServerStatus(): ServerStatus {
  return useSyncExternalStore(subscribe, () => status, () => status);
}
