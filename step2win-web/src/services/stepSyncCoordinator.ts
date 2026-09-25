import { useSyncExternalStore } from 'react';

/**
 * App-wide step-sync coordination, shared by every component that calls useHealthSync():
 * one sync in flight at a time, the server's Retry-After, exponential backoff with jitter,
 * and the adaptive foreground thresholds.
 *
 * Why module state: several screens mount useHealthSync() at once (layout, settings, the
 * Step sync screen); per-hook refs let them run overlapping syncs and ignore each other's
 * backoff. Here there is exactly one clock and one "don't call before" time.
 */

type SyncState = {
  syncing: boolean;
  /** Epoch ms before which no upload may be attempted (Retry-After / backoff). */
  retryAt: number;
  failures: number;
  lastSyncAt: number;
  /** Today's step total at the last successful sync (drives the foreground thresholds). */
  lastSyncedSteps: number;
  nearDeadline: boolean;
};

let state: SyncState = {
  syncing: false,
  retryAt: 0,
  failures: 0,
  lastSyncAt: 0,
  lastSyncedSteps: 0,
  nearDeadline: false,
};
const listeners = new Set<() => void>();

export function getSyncState(): SyncState {
  return state;
}

export function patchSyncState(patch: Partial<SyncState>) {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useSyncState(): SyncState {
  return useSyncExternalStore(subscribe, getSyncState, getSyncState);
}

// ── One sync at a time, app-wide ───────────────────────────────────────────

let inFlight: Promise<void> | null = null;

/** Runs `task` unless a sync is already running (then joins that one). */
export function runExclusive(task: () => Promise<void>): Promise<void> {
  if (inFlight) return inFlight;
  patchSyncState({ syncing: true });
  inFlight = task().finally(() => {
    inFlight = null;
    patchSyncState({ syncing: false });
  });
  return inFlight;
}

// ── Backoff / Retry-After ──────────────────────────────────────────────────

const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 30 * 60_000;

export function inBackoff(now = Date.now()): boolean {
  return now < state.retryAt;
}

/** "Equal jitter": half fixed, half random, so a fleet of phones spreads out. */
export function backoffDelayMs(failures: number): number {
  const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1));
  return ceiling / 2 + Math.random() * (ceiling / 2);
}

export function noteFailure() {
  const failures = state.failures + 1;
  patchSyncState({ failures, retryAt: Date.now() + backoffDelayMs(failures) });
}

export function noteSuccess(steps?: number) {
  patchSyncState({
    failures: 0,
    retryAt: 0,
    lastSyncAt: Date.now(),
    ...(typeof steps === 'number' ? { lastSyncedSteps: steps } : {}),
  });
}

/** Seconds (or HTTP date) from a Retry-After header, in ms; null if absent/invalid. */
export function parseRetryAfter(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim();
  if (!text) return null;
  const seconds = Number(text);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(text);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

/**
 * If the error is a 429/503 from the server, remember its Retry-After (+ up to 30% random
 * spread) and return true. Every sync trigger then waits, including "Sync now".
 */
export function honourRetryAfter(error: unknown): boolean {
  const response = (error as { response?: { status?: number; headers?: Record<string, unknown> } })?.response;
  const status = response?.status;
  if (status !== 429 && status !== 503) return false;
  const headers = response?.headers ?? {};
  const header = headers['retry-after'] ?? headers['Retry-After'];
  const wait = parseRetryAfter(header) ?? backoffDelayMs(state.failures + 1);
  patchSyncState({ retryAt: Date.now() + Math.max(2_000, wait * (1 + Math.random() * 0.3)) });
  return true;
}

export function setRetryAtIso(iso: string | null | undefined) {
  if (!iso) return;
  const at = Date.parse(iso);
  if (Number.isFinite(at) && at > state.retryAt) patchSyncState({ retryAt: at });
}

/** Per-item backoff for queued uploads that failed (1 min, 2 min, ... 1 h), with jitter. */
export function itemBackoffMs(retryCount: number): number {
  if (retryCount <= 0) return 0;
  const ceiling = Math.min(60 * 60_000, 60_000 * 2 ** Math.min(6, retryCount - 1));
  return ceiling / 2 + Math.random() * (ceiling / 2);
}

export function sleep(ms: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, ms));
}

/** Pause between queued uploads (the server allows one sync per second per user). */
export function pace() {
  return sleep(1_000 + Math.random() * 800);
}

// ── Foreground cadence ─────────────────────────────────────────────────────

export const FOREGROUND = {
  /** New steps that justify an upload right away (debounced). */
  stepThreshold: 75,
  saverStepThreshold: 300,
  /** While steps keep coming, upload at least this often. */
  walkingMinIntervalMs: 60_000,
  saverWalkingMinIntervalMs: 5 * 60_000,
  deadlineMinIntervalMs: 30_000,
  /** Quiet safety net while the app is open (cheap: no request if nothing changed). */
  safetyIntervalMs: 5 * 60_000,
  saverSafetyIntervalMs: 15 * 60_000,
  /** Let a burst of steps settle before uploading. */
  debounceMs: 10_000,
} as const;

/** Local calendar date (YYYY-MM-DD) — the phone's day, not UTC. */
export function localDateString(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Last 2 h of an active challenge's end date (local time). */
export function isNearDeadline(windows: Array<{ start: string; end: string }>, now = new Date()): boolean {
  const today = localDateString(now);
  if (!windows.some((w) => w.end === today)) return false;
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  return midnight.getTime() - now.getTime() <= 2 * 60 * 60_000;
}
