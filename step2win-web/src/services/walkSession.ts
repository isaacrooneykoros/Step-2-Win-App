import { useSyncExternalStore } from 'react';
import { v4 as uuidv4 } from 'uuid';
import {
  DeviceStepCounter,
  type StepSensorCapabilities,
  type WalkPoint,
  type WalkStartResult,
  type WalkState,
} from '../plugins/deviceStepCounter';
import { stepsService } from './api/steps';
import { getInstallId, timeZoneFields } from './deviceIdentity';
import { requestForegroundLocationPermission } from './locationPermissions';
import { appPlatform, hasNativeStepCounter, isAndroidApp, isIOSApp } from '../utils/platform';
import type { LatLng } from '../lib/polyline';
import type { WalkCounters, WalkFinishRequest, WalkSummary } from '../types';

/*
 * The user's walk, app-wide (the walk keeps going when the user leaves the walk screen).
 *
 * Native records everything (foreground service, GPS, gait evidence) and buffers the points.
 * This module drains the buffer about every 20 s into a queue persisted in localStorage
 * BEFORE uploading, so a point taken from the native buffer is never lost: offline, the
 * queue just grows and uploads later. Finishing stores the finish request too, so a walk that
 * ends offline (or while the app is closed) is uploaded on the next launch.
 */

export type WalkPhase = 'idle' | 'starting' | 'active' | 'finishing' | 'upload_pending' | 'finished';

export type WalkProblem =
  | 'web'
  | 'unsupported'
  | 'activity_permission'
  | 'location_permission'
  | 'gps_off'
  | 'offline'
  | 'server';

export interface WalkStore {
  phase: WalkPhase;
  walkId: string | null;
  startedAt: string | null;
  live: WalkState | null;
  route: LatLng[];
  /** Points recorded on this phone and not yet uploaded. */
  queued: number;
  /** True when the last upload attempt failed for connection reasons. */
  waitingForConnection: boolean;
  summary: WalkSummary | null;
  problem: WalkProblem | null;
  capabilities: StepSensorCapabilities | null;
}

interface PersistedWalk {
  walkId: string;
  clientWalkId: string;
  startedAt: string;
  queue: WalkPoint[];
  route: LatLng[];
  lastState: WalkState | null;
  /** Set once the walk has stopped: the finish request still to upload (points go separately). */
  finish?: Omit<WalkFinishRequest, 'points'>;
  /** The server refused a points upload for this walk: stop retrying, send them with finish. */
  pointsRejected?: boolean;
  lastSentSteps?: number;
}

const STORAGE_KEY = 'walk_session_v1';
const DRAIN_EVERY_MS = 20_000;
const FINISH_RETRY_MS = 60_000;
const MAX_POINTS_PER_CALL = 500;
const MAX_ROUTE_POINTS = 1500;
/** Fixes worse than this are uploaded (the server judges) but not drawn. */
const DRAW_MAX_ACCURACY_M = 60;

const initial: WalkStore = {
  phase: 'idle',
  walkId: null,
  startedAt: null,
  live: null,
  route: [],
  queued: 0,
  waitingForConnection: false,
  summary: null,
  problem: null,
  capabilities: null,
};

let store: WalkStore = initial;
let persisted: PersistedWalk | null = null;
const listeners = new Set<() => void>();

function setStore(patch: Partial<WalkStore>) {
  store = { ...store, ...patch };
  listeners.forEach((listener) => listener());
}

export function getWalkStore(): WalkStore {
  return store;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useWalkStore(): WalkStore {
  return useSyncExternalStore(subscribe, getWalkStore, getWalkStore);
}

// ── Persistence ────────────────────────────────────────────────────────────

function load(): PersistedWalk | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedWalk;
    if (!parsed || typeof parsed.walkId !== 'string' || !Array.isArray(parsed.queue)) return null;
    parsed.route = Array.isArray(parsed.route) ? parsed.route : [];
    return parsed;
  } catch {
    return null;
  }
}

function save() {
  if (!persisted) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(persisted));
  } catch {
    // Storage full: keep the queue in memory; the route is the first thing to trim.
    if (persisted.route.length > 200) {
      persisted.route = thin(persisted.route);
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(persisted));
      } catch {
        // Give up on persisting this round; the next save tries again.
      }
    }
  }
  setStore({ queued: persisted.queue.length, route: persisted.route });
}

function clearPersisted() {
  persisted = null;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to clear.
  }
}

function thin(route: LatLng[]): LatLng[] {
  return route.filter((_, i) => i % 2 === 0 || i === route.length - 1);
}

function appendRoute(points: WalkPoint[]) {
  if (!persisted) return;
  let route = persisted.route;
  for (const p of points) {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) continue;
    if (Number.isFinite(p.acc) && p.acc > DRAW_MAX_ACCURACY_M) continue;
    route.push([p.lat, p.lng]);
  }
  while (route.length > MAX_ROUTE_POINTS) route = thin(route);
  persisted.route = route;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function countersFrom(state: Partial<WalkState> | null | undefined): WalkCounters {
  const n = (v: unknown) => Math.max(0, Math.round(Number(v) || 0));
  return {
    steps: n(state?.steps),
    gait_verified_steps: n(state?.gaitVerifiedSteps),
    gait_shake_steps: n(state?.gaitShakeSteps),
    gait_unknown_steps: n(state?.gaitUnknownSteps),
    vehicle_seconds: n(state?.vehicleSeconds),
    mock_location: !!state?.mockLocation,
  };
}

/** Connection problems and "try later" answers; anything else is a real refusal. */
function isRetryable(error: unknown): boolean {
  const status = (error as { response?: { status?: number } })?.response?.status;
  if (status === undefined) return true;
  return status >= 500 || status === 429 || status === 408;
}

function offline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

// ── Live loop (listener + periodic drain) ──────────────────────────────────

let removeListener: (() => void) | null = null;
let drainTimer: number | undefined;
let finishRetryTimer: number | undefined;
let lastPersistAt = 0;
let windowHooksInstalled = false;

function installWindowHooks() {
  if (windowHooksInstalled || typeof window === 'undefined') return;
  windowHooksInstalled = true;
  window.addEventListener('online', () => {
    if (store.phase === 'active') void drain();
    if (store.phase === 'upload_pending') void uploadFinish();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (store.phase === 'active') void checkNativeState();
  });
}

function startLoop() {
  stopLoop();
  installWindowHooks();
  DeviceStepCounter.addListener('walkUpdate', (state) => onWalkUpdate(state))
    .then((handle) => {
      if (store.phase !== 'active') {
        void handle.remove();
        return;
      }
      removeListener = () => void handle.remove();
    })
    .catch(() => undefined);
  drainTimer = window.setInterval(() => void checkNativeState(), DRAIN_EVERY_MS);
}

function stopLoop() {
  removeListener?.();
  removeListener = null;
  window.clearInterval(drainTimer);
  drainTimer = undefined;
}

function onWalkUpdate(state: WalkState) {
  if (store.phase !== 'active' || !persisted) return;
  if (state.walkId && String(state.walkId) !== persisted.walkId) return;
  persisted.lastState = state;
  setStore({ live: state });
  if (Date.now() - lastPersistAt > 15_000) {
    lastPersistAt = Date.now();
    save();
  }
  if (!state.active) {
    void finishWalk({ autoEnded: !!state.autoEnded });
  }
}

async function checkNativeState() {
  if (store.phase !== 'active' || !persisted) return;
  const state = await DeviceStepCounter.getWalkState().catch(() => null);
  if (state) {
    if (!state.active) {
      await finishWalk({ autoEnded: !!state.autoEnded });
      return;
    }
    persisted.lastState = state;
    setStore({ live: state });
  }
  await drain();
}

/** The running drain; finishing waits for it so no point is dropped or sent twice. */
let draining: Promise<void> | null = null;

async function takeFromNative() {
  for (let round = 0; round < 10; round += 1) {
    const taken = (await DeviceStepCounter.takeWalkPoints({ max: MAX_POINTS_PER_CALL }).catch(() => ({ points: [] as WalkPoint[] }))).points || [];
    if (!persisted) return;
    if (taken.length > 0) {
      persisted.queue.push(...taken);
      appendRoute(taken);
      lastPersistAt = Date.now();
      save();
    }
    if (taken.length < MAX_POINTS_PER_CALL) break;
  }
}

/** Takes buffered points from native, persists them, then uploads what it can. */
function drain(): Promise<void> {
  if (draining) return draining;
  if (!persisted || store.phase !== 'active') return Promise.resolve();
  draining = (async () => {
    await takeFromNative();
    if (store.phase !== 'active') return;
    await uploadQueuedPoints();
  })().finally(() => {
    draining = null;
  });
  return draining;
}

async function uploadQueuedPoints() {
  if (!persisted || persisted.pointsRejected) return;
  if (offline()) {
    setStore({ waitingForConnection: persisted.queue.length > 0 });
    return;
  }
  const counters = countersFrom(persisted.lastState);
  const stepsChanged = counters.steps !== (persisted.lastSentSteps ?? -1);
  if (persisted.queue.length === 0 && !stepsChanged) return;

  try {
    do {
      const walk: PersistedWalk | null = persisted;
      if (!walk) return;
      const chunk = walk.queue.slice(0, MAX_POINTS_PER_CALL);
      await stepsService.sendWalkPoints(walk.walkId, { points: chunk, ...countersFrom(walk.lastState) });
      if (persisted !== walk) return;
      walk.queue.splice(0, chunk.length);
      walk.lastSentSteps = counters.steps;
      save();
    } while (persisted && persisted.queue.length > 0);
    setStore({ waitingForConnection: false });
  } catch (error) {
    if (!persisted) return;
    if (isRetryable(error)) {
      setStore({ waitingForConnection: true });
    } else {
      // Refused (e.g. the walk was ended on the server): keep the points for the finish call.
      persisted.pointsRejected = true;
      save();
    }
  }
}

// ── Start ──────────────────────────────────────────────────────────────────

export type StartWalkOutcome = { ok: true } | { ok: false; problem: WalkProblem };

function fail(problem: WalkProblem): StartWalkOutcome {
  setStore({ phase: 'idle', problem });
  return { ok: false, problem };
}

export async function loadSensorCapabilities(): Promise<StepSensorCapabilities | null> {
  if (!hasNativeStepCounter()) return null;
  if (store.capabilities) return store.capabilities;
  const caps = await DeviceStepCounter.getSensorCapabilities().catch(() => null);
  if (caps) setStore({ capabilities: caps });
  return caps;
}

let starting: Promise<StartWalkOutcome> | null = null;

/**
 * Capabilities -> motion permission -> location permission (first time it is ever asked) ->
 * server start -> native start -> device integrity (Android, best effort).
 */
export function startNewWalk(): Promise<StartWalkOutcome> {
  if (starting) return starting;
  starting = doStart().finally(() => {
    starting = null;
  });
  return starting;
}

async function doStart(): Promise<StartWalkOutcome> {
  if (!hasNativeStepCounter()) return fail('web');
  if (store.phase === 'active') return { ok: true };
  if (store.phase === 'finishing' || store.phase === 'upload_pending') return { ok: false, problem: 'server' };
  setStore({ phase: 'starting', problem: null, summary: null });

  const caps = await loadSensorCapabilities();
  if (caps && !caps.walkSupported) return fail('unsupported');

  const motion = await DeviceStepCounter.checkPermissions().catch(() => null);
  if (motion?.activityRecognition !== 'granted') {
    const asked = await DeviceStepCounter.requestPermissions().catch(() => null);
    if (asked?.activityRecognition !== 'granted') return fail('activity_permission');
  }

  const locationGranted = await requestForegroundLocationPermission().catch(() => false);
  if (!locationGranted) return fail('location_permission');

  if (offline()) return fail('offline');

  const startedAt = new Date().toISOString();
  const clientWalkId = uuidv4();
  const platform = appPlatform();
  const stepSource = isIOSApp() ? 'cmpedometer' : caps && !caps.hasStepCounter ? 'accelerometer' : 'step_counter';
  const tz = timeZoneFields();

  let started;
  try {
    started = await stepsService.startWalk({
      client_walk_id: clientWalkId,
      started_at: startedAt,
      tz_offset_minutes: tz.tz_offset_minutes,
      tz_name: tz.tz_name,
      install_id: await getInstallId(),
      platform,
      step_source: stepSource,
    });
  } catch (error) {
    const reachedServer = !!(error as { response?: unknown })?.response;
    return fail(reachedServer ? 'server' : 'offline');
  }

  const walkId = String(started.id);
  let result: WalkStartResult = await DeviceStepCounter.startWalk({ walkId }).catch(() => ({ started: false, reason: 'unsupported' as const }));
  if (!result.started && result.reason === 'already_active') {
    // A walk left running natively (its server walk was just ended by this start): replace it.
    await DeviceStepCounter.stopWalk().catch(() => null);
    result = await DeviceStepCounter.startWalk({ walkId }).catch(() => ({ started: false, reason: 'unsupported' as const }));
  }
  if (!result.started) {
    const reason = result.reason;
    return fail(
      reason === 'location_permission' || reason === 'activity_permission' || reason === 'gps_off' ? reason : 'unsupported',
    );
  }

  persisted = { walkId, clientWalkId, startedAt: started.started_at || startedAt, queue: [], route: [], lastState: null };
  save();
  setStore({
    phase: 'active',
    walkId,
    startedAt: persisted.startedAt,
    live: null,
    route: [],
    queued: 0,
    waitingForConnection: false,
    problem: null,
  });
  startLoop();

  if (isAndroidApp() && started.integrity_requested && started.integrity_nonce) {
    void sendWalkIntegrity(walkId, started.integrity_nonce);
  }
  return { ok: true };
}

async function sendWalkIntegrity(walkId: string, nonce: string) {
  try {
    const { token } = await DeviceStepCounter.requestIntegrityToken({ nonce });
    if (token) await stepsService.sendWalkIntegrity(walkId, token);
  } catch {
    // Best effort: the server records the walk as unchecked.
  }
}

// ── Finish ─────────────────────────────────────────────────────────────────

let finishing: Promise<void> | null = null;

/** Stops the walk on the phone, then uploads the rest (or keeps it for later when offline). */
export function finishWalk(options: { autoEnded?: boolean } = {}): Promise<void> {
  if (finishing) return finishing;
  finishing = doFinish(options).finally(() => {
    finishing = null;
  });
  return finishing;
}

async function doFinish({ autoEnded = false }: { autoEnded?: boolean }) {
  if (!persisted) return;
  stopLoop();
  setStore({ phase: 'finishing' });
  if (draining) await draining.catch(() => undefined);

  if (persisted && !persisted.finish) {
    const stopped = await DeviceStepCounter.stopWalk().catch(() => null);
    const finalState: Partial<WalkState> | null = stopped ?? persisted.lastState;
    const points = stopped?.points ?? [];
    if (points.length > 0) {
      persisted.queue.push(...points);
      appendRoute(points);
    }
    if (stopped) persisted.lastState = { ...stopped };
    persisted.finish = {
      ended_at: finalState?.endedAt || new Date().toISOString(),
      auto_ended: autoEnded || !!finalState?.autoEnded,
      ...countersFrom(finalState),
    };
    save();
    setStore({ live: persisted.lastState });
  }
  await uploadFinish();
}

async function uploadFinish() {
  const walk = persisted;
  if (!walk?.finish) return;
  window.clearTimeout(finishRetryTimer);
  if (offline()) {
    scheduleFinishRetry();
    return;
  }
  setStore({ phase: 'finishing' });
  try {
    while (!walk.pointsRejected && walk.queue.length > MAX_POINTS_PER_CALL) {
      const chunk = walk.queue.slice(0, MAX_POINTS_PER_CALL);
      try {
        await stepsService.sendWalkPoints(walk.walkId, { points: chunk, ...countersFrom(walk.lastState) });
        walk.queue.splice(0, chunk.length);
        save();
      } catch (error) {
        if (isRetryable(error)) throw error;
        walk.pointsRejected = true;
        save();
      }
    }
    const summary = await stepsService.finishWalk(walk.walkId, {
      ...walk.finish,
      points: walk.queue.slice(-MAX_POINTS_PER_CALL),
    });
    done(summary);
  } catch (error) {
    if (isRetryable(error)) {
      scheduleFinishRetry();
      return;
    }
    // Refused (e.g. already ended on the server): show what the server has, if anything.
    const summary = await stepsService.getWalk(walk.walkId).catch(() => null);
    done(summary);
  }
}

function scheduleFinishRetry() {
  setStore({ phase: 'upload_pending', waitingForConnection: true });
  installWindowHooks();
  window.clearTimeout(finishRetryTimer);
  finishRetryTimer = window.setTimeout(() => void uploadFinish(), FINISH_RETRY_MS);
}

function done(summary: WalkSummary | null) {
  clearPersisted();
  window.clearTimeout(finishRetryTimer);
  setStore({
    phase: 'finished',
    summary,
    queued: 0,
    waitingForConnection: false,
  });
}

/** "Try again" on the upload-pending screen. */
export function retryWalkUpload(): Promise<void> {
  return uploadFinish();
}

/** After the summary has been shown. */
export function dismissFinishedWalk() {
  if (store.phase !== 'finished' && store.phase !== 'idle') return;
  setStore({ ...initial, capabilities: store.capabilities });
}

export function clearWalkProblem() {
  if (store.problem) setStore({ problem: null });
}

// ── Resume (launch / reload) ───────────────────────────────────────────────

let resuming: Promise<void> | null = null;

export function resumeWalkIfAny(): Promise<void> {
  if (resuming) return resuming;
  resuming = doResume().finally(() => {
    resuming = null;
  });
  return resuming;
}

async function doResume() {
  if (!hasNativeStepCounter()) return;
  if (store.phase === 'active' || store.phase === 'finishing' || store.phase === 'starting') return;

  const saved = persisted ?? load();
  const state = await DeviceStepCounter.getWalkState().catch(() => null);

  if (!saved) {
    // Native is walking but the local record is gone (storage cleared): adopt the walk.
    if (state?.active && state.walkId) {
      persisted = {
        walkId: String(state.walkId),
        clientWalkId: '',
        startedAt: state.startedAt || new Date().toISOString(),
        queue: [],
        route: [],
        lastState: state,
      };
      save();
      setStore({ phase: 'active', walkId: persisted.walkId, startedAt: persisted.startedAt, live: state, problem: null });
      startLoop();
      void drain();
    }
    return;
  }

  persisted = saved;
  setStore({ walkId: saved.walkId, startedAt: saved.startedAt, route: saved.route, queued: saved.queue.length, live: saved.lastState });

  if (saved.finish) {
    await uploadFinish();
    return;
  }
  // Native didn't answer (yet): treat the walk as running; the loop checks again shortly.
  if (!state || (state.active && String(state.walkId) === saved.walkId)) {
    if (state) saved.lastState = state;
    setStore({ phase: 'active', live: state, problem: null });
    startLoop();
    void drain();
    return;
  }
  // The walk ended while the app was away (long pause, or the phone stopped the service).
  if (state && !state.active && String(state.walkId ?? saved.walkId) === saved.walkId) {
    saved.lastState = { ...state };
  }
  setStore({ phase: 'active' });
  await finishWalk({ autoEnded: !!state?.autoEnded });
}

/** Elapsed seconds of the running walk (counts locally between native updates). */
export function elapsedSeconds(now = Date.now()): number {
  const startedAt = store.live?.startedAt || store.startedAt;
  const start = startedAt ? Date.parse(startedAt) : NaN;
  if (!Number.isFinite(start)) return Math.max(0, Math.round(store.live?.elapsedS ?? 0));
  return Math.max(0, Math.round((now - start) / 1000));
}
