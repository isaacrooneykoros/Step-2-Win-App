import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { stepsService } from '../services/api/steps';
import { challengesService } from '../services/api/challenges';
import { resolveApiBaseUrl } from '../config/network';
import { useToast } from '../components/ui/Toast';
import { useAuthStore } from '../store/authStore';
import { v4 as uuidv4 } from 'uuid';
import CryptoJS from 'crypto-js';
import { DeviceStepCounter, type NativeSyncResult, type StepHistoryDay } from '../plugins/deviceStepCounter';
import { openAppSettings } from '../plugins/appSystem';
import { hasNativeStepCounter, isAndroidApp, isIOSApp, permissionCopy } from '../utils/platform';
import type { ChallengeDetail, HourlyStep, LocationWaypoint, StepSyncForm, User } from '../types';
import {
  listOutboxItems,
  removeOutboxItem,
  touchOutboxRetry,
  upsertOutboxItem,
} from '../services/offlineSyncOutbox';
import { DATA_SAVER_HOURLY_SYNC_INTERVAL_MS, HOURLY_SYNC_INTERVAL_MS, isDataSaverOn } from './useDataSaver';
import { loadPreferences } from '../components/settings/preferences';
import {
  FOREGROUND,
  getSyncState,
  honourRetryAfter,
  inBackoff,
  isNearDeadline,
  itemBackoffMs,
  localDateString,
  noteFailure,
  noteSuccess,
  pace,
  patchSyncState,
  runExclusive,
  setRetryAtIso,
  useSyncState,
} from '../services/stepSyncCoordinator';

/*
 * Step sync, adaptive instead of always-on.
 *
 * Android: the native layer owns capture and upload (DeviceStepCounter.syncNow): hardware
 * step counter -> durable ledger -> one uploader shared with WorkManager (app closed/killed)
 * and the walking service. The web layer only pushes settings (API URL, stride, Data Saver,
 * challenge dates) and asks for a sync on meaningful change.
 *
 * iOS: CoreMotion keeps ~7 days of history, so the web layer uploads (SQLite outbox) and
 * catches up past days from the history when the app comes back.
 *
 * Both: one sync in flight app-wide, Retry-After and exponential backoff with jitter.
 */

function hourlySyncIntervalMs() {
  return isDataSaverOn() ? DATA_SAVER_HOURLY_SYNC_INTERVAL_MS : HOURLY_SYNC_INTERVAL_MS;
}

const PERMISSIONS_BOOTSTRAP_DONE_KEY = 'permissions_bootstrap_done_v1';
const IOS_ACKED_KEY = 'step_sync_acked_days_v1';
const IOS_CATCH_UP_EVERY_MS = 6 * 60 * 60_000;
const CHALLENGE_WINDOWS_STALE_MS = 10 * 60_000;
const NATIVE_CONFIG_REFRESH_MS = 30 * 60_000;

type ActiveStepSession = {
  sessionId: string;
  sessionToken: string;
  expiresAt: string;
  nextSequenceNumber: number;
  deviceId: string;
  platform: 'android' | 'ios';
  appVersion: string;
  mlModelVersion: string;
};

type SyncOptions = { silent?: boolean; force?: boolean; reason?: string };

// Module-level (shared by every useHealthSync instance).
let activeStepSession: ActiveStepSession | null = null;
let lastSyncedFingerprint = '';
let lastHourlySyncAt = 0;
let lastIosCatchUpAt = 0;
let captureEnabledThisSession = false;
let lastNativeConfigKey = '';
let lastNativeConfigAt = 0;

function roundProbability(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return null;
  }
  return Math.max(0, Math.min(1, Number(n.toFixed(4))));
}

function stablePayloadHash(payload: Record<string, unknown>): string {
  const ordered = {
    session_id: payload.session_id ?? null,
    client_event_id: payload.client_event_id ?? null,
    sequence_number: payload.sequence_number ?? null,
    timestamp_client: payload.timestamp_client ?? null,
    steps_delta: payload.steps_delta ?? null,
    steps_total: payload.steps_total ?? null,
    ml_motion_label: payload.ml_motion_label ?? null,
    ml_walk_probability: roundProbability(payload.ml_walk_probability),
    ml_shake_probability: roundProbability(payload.ml_shake_probability),
    ml_model_version: payload.ml_model_version ?? null,
  };

  return CryptoJS.SHA256(JSON.stringify(ordered)).toString();
}

function isExpiredSessionPayload(session: ActiveStepSession | null): boolean {
  if (!session) {
    return true;
  }

  const expiresAt = Date.parse(session.expiresAt);
  return Number.isFinite(expiresAt) ? expiresAt <= Date.now() + 60_000 : true;
}

function isExpiredSessionError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const maybeAxios = error as { response?: { status?: number; data?: { detail?: string; message?: string; error?: string; replay_detected?: boolean } } };
  const statusCode = maybeAxios.response?.status;
  const data = maybeAxios.response?.data;
  const message = `${data?.detail || ''} ${data?.message || ''} ${data?.error || ''}`.toLowerCase();
  return (
    !!data?.replay_detected ||
    message.includes('expired') ||
    message.includes('invalid session') ||
    message.includes('could not be verified') ||
    (statusCode === 401 && !!data?.replay_detected)
  );
}

function extractSyncErrorMessage(error: unknown): string {
  if (typeof error !== 'object' || error === null) {
    return 'Sync failed. Try again.';
  }

  const maybeAxios = error as {
    response?: { data?: { error?: string; detail?: string; message?: string } };
    message?: string;
  };

  const serverMessage =
    maybeAxios.response?.data?.error ||
    maybeAxios.response?.data?.detail ||
    maybeAxios.response?.data?.message;

  if (typeof serverMessage === 'string' && serverMessage.trim()) {
    return serverMessage;
  }

  if (typeof maybeAxios.message === 'string' && maybeAxios.message.trim()) {
    return maybeAxios.message;
  }

  return 'Sync failed. Try again.';
}

function isLikelyOfflineError(error: unknown): boolean {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return true;
  }

  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const maybeAxios = error as { code?: string; message?: string };
  const message = (maybeAxios.message || '').toLowerCase();
  return maybeAxios.code === 'ERR_NETWORK' || message.includes('network') || message.includes('failed to fetch');
}

function isServerOrNetworkError(error: unknown): boolean {
  const status = (error as { response?: { status?: number } })?.response?.status;
  return status === undefined || status >= 500;
}

function isDuplicateSyncError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const maybeAxios = error as { response?: { status?: number; data?: { error?: string } } };
  return maybeAxios.response?.status === 409 || maybeAxios.response?.data?.error === 'Duplicate request';
}

function formatClock(ms: number) {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// ── Native (Android) configuration ─────────────────────────────────────────

async function activeChallengeWindows(queryClient: QueryClient): Promise<Array<{ start: string; end: string }>> {
  let challenges: ChallengeDetail[] | undefined;
  try {
    challenges = await queryClient.fetchQuery({
      queryKey: ['challenges', 'my'],
      queryFn: challengesService.getMyChallenges,
      staleTime: CHALLENGE_WINDOWS_STALE_MS,
    });
  } catch {
    challenges = queryClient.getQueryData<ChallengeDetail[]>(['challenges', 'my']);
  }
  return (challenges || [])
    .filter((c) => c && c.status === 'active' && c.start_date && c.end_date)
    .map((c) => ({ start: String(c.start_date).slice(0, 10), end: String(c.end_date).slice(0, 10) }));
}

async function configureNativeSync(queryClient: QueryClient, profile: User | undefined) {
  const windows = await activeChallengeWindows(queryClient);
  patchSyncState({ nearDeadline: isNearDeadline(windows) });
  const config = {
    apiBaseUrl: resolveApiBaseUrl(),
    strideCm: clampNumber(profile?.stride_length_cm, 40, 130, 78),
    weightKg: clampNumber(profile?.weight_kg, 30, 220, 70),
    dataSaver: isDataSaverOn(),
    challengeWindows: windows,
  };
  const key = `${JSON.stringify(config)}|${localDateString()}`;
  if (key === lastNativeConfigKey && Date.now() - lastNativeConfigAt < NATIVE_CONFIG_REFRESH_MS) {
    return;
  }
  const result = await DeviceStepCounter.configureSync(config);
  lastNativeConfigKey = key;
  lastNativeConfigAt = Date.now();
  patchSyncState({ nearDeadline: !!result?.nearDeadline || isNearDeadline(windows) });
}

async function enableSmartCaptureOnce() {
  if (captureEnabledThisSession) return;
  captureEnabledThisSession = true;
  // Android: arms WorkManager + walking triggers (no always-on service). iOS: enables
  // foreground route capture.
  await DeviceStepCounter.startBackgroundCapture().catch(() => ({ running: false }));
}

// ── iOS acknowledged-days bookkeeping (for history catch-up) ───────────────

function readIosAcked(userId: number): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(`${IOS_ACKED_KEY}:${userId}`) || '{}') || {};
  } catch {
    return {};
  }
}

function writeIosAcked(userId: number, date: string, steps: number) {
  const acked = readIosAcked(userId);
  acked[date] = Math.max(steps, acked[date] || 0);
  const cutoff = localDateString(new Date(Date.now() - 10 * 86_400_000));
  Object.keys(acked).forEach((day) => {
    if (day < cutoff) delete acked[day];
  });
  try {
    localStorage.setItem(`${IOS_ACKED_KEY}:${userId}`, JSON.stringify(acked));
  } catch {
    // Storage full/unavailable: catch-up just re-sends (idempotent on the server).
  }
}

export function useHealthSync() {
  const [isConnectingDevice, setIsConnectingDevice] = useState(false);
  const [permissionStatus, setPermissionStatus] = useState<'unknown' | 'granted' | 'denied' | 'unavailable'>('unknown');
  const hasAttemptedAutoEnableRef = useRef(false);
  const { syncing: isSyncing } = useSyncState();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const userId = useAuthStore((state) => state.user?.id);

  const ensureActiveStepSession = useCallback(async (): Promise<ActiveStepSession> => {
    const nativeSession = await DeviceStepCounter.startStepSession();
    const existing = activeStepSession;

    // The native store is shared with the Android background uploader: prefer it.
    if (nativeSession.session_id && nativeSession.session_token && nativeSession.expires_at) {
      const cached: ActiveStepSession = {
        sessionId: nativeSession.session_id,
        sessionToken: nativeSession.session_token,
        expiresAt: nativeSession.expires_at,
        nextSequenceNumber: nativeSession.next_sequence_number ?? 1,
        deviceId: nativeSession.device_id,
        platform: nativeSession.platform ?? 'android',
        appVersion: nativeSession.app_version,
        mlModelVersion: nativeSession.ml_model_version,
      };
      if (!isExpiredSessionPayload(cached)) {
        activeStepSession = cached;
        return cached;
      }
    } else if (existing && !isExpiredSessionPayload(existing)) {
      return existing;
    }

    const started = await stepsService.startSession({
      device_id: nativeSession.device_id,
      platform: nativeSession.platform ?? 'android',
      app_version: nativeSession.app_version,
      ml_model_version: nativeSession.ml_model_version,
    });

    const created: ActiveStepSession = {
      sessionId: started.session_id,
      sessionToken: started.session_token,
      expiresAt: started.expires_at,
      nextSequenceNumber: started.sequence_start ?? 1,
      deviceId: nativeSession.device_id,
      platform: nativeSession.platform ?? 'android',
      appVersion: nativeSession.app_version,
      mlModelVersion: nativeSession.ml_model_version,
    };

    await DeviceStepCounter.setActiveStepSession({
      session_id: created.sessionId,
      session_token: created.sessionToken,
      expires_at: created.expiresAt,
      next_sequence_number: created.nextSequenceNumber,
    }).catch(() => ({ saved: false }));

    activeStepSession = created;
    return created;
  }, []);

  const clearActiveStepSession = useCallback(async () => {
    activeStepSession = null;
    await DeviceStepCounter.clearActiveStepSession().catch(() => ({ cleared: false }));
  }, []);

  /**
   * Sends one reading. The reading keeps its client_event_id and timestamp_client across
   * retries, so the server recognises a resend as the same reading (idempotent). The
   * sequence number is claimed at send time from the native store shared with the
   * Android background uploader, so it only ever increases.
   */
  const submitHealthPayload = useCallback(async (healthPayload: StepSyncForm): Promise<void> => {
    let session = await ensureActiveStepSession();
    let payload = { ...healthPayload } as StepSyncForm & Record<string, unknown>;

    const attachSession = async (sessionState: ActiveStepSession) => {
      const timestampClient = typeof payload.timestamp_client === 'string' && payload.timestamp_client.trim()
        ? payload.timestamp_client
        : new Date().toISOString();
      let sequence = sessionState.nextSequenceNumber;
      try {
        sequence = (await DeviceStepCounter.claimSequence()).sequence_number;
      } catch {
        // Older native build without claimSequence: fall back to the cached counter.
        sessionState.nextSequenceNumber += 1;
      }
      payload = {
        ...payload,
        device_id: sessionState.deviceId,
        session_id: sessionState.sessionId,
        session_token: sessionState.sessionToken,
        client_event_id: payload.client_event_id || uuidv4(),
        sequence_number: sequence,
        timestamp_client: timestampClient,
        steps_total: payload.steps_total ?? payload.steps,
        steps_delta: payload.steps_delta ?? payload.steps,
      };
      payload.payload_hash = stablePayloadHash(payload);
    };

    await attachSession(session);

    try {
      await stepsService.syncHealth(payload as StepSyncForm);
    } catch (error) {
      if (!isExpiredSessionError(error)) {
        throw error;
      }
      await clearActiveStepSession();
      session = await ensureActiveStepSession();
      await attachSession(session);
      await stepsService.syncHealth(payload as StepSyncForm);
    }
  }, [clearActiveStepSession, ensureActiveStepSession]);

  /**
   * Drains the durable SQLite outbox: oldest first, paced, per-item backoff, and stops at
   * the first 429/503 (Retry-After) or network/server failure (exponential backoff).
   */
  const flushQueuedSync = useCallback(async () => {
    if (!userId || (typeof navigator !== 'undefined' && navigator.onLine === false)) {
      return;
    }
    if (inBackoff()) {
      return;
    }

    const queue = await listOutboxItems(userId);
    if (queue.length === 0) {
      return;
    }

    let sent = 0;
    for (const item of queue) {
      const lastTry = Date.parse(item.updatedAt);
      if (item.retryCount > 0 && Number.isFinite(lastTry) && Date.now() - lastTry < itemBackoffMs(item.retryCount)) {
        continue;
      }
      if (sent > 0) await pace();
      sent += 1;
      try {
        if (item.kind === 'health') {
          const healthPayload = item.payload as StepSyncForm;
          await submitHealthPayload(healthPayload);
          if (isIOSApp() && healthPayload.date) writeIosAcked(userId, String(healthPayload.date), Number(healthPayload.steps) || 0);
        } else {
          const hourlyPayload = item.payload as { date: string; hourly: HourlyStep[]; waypoints: LocationWaypoint[] };
          await stepsService.syncHourly(hourlyPayload);
        }
        await removeOutboxItem(item.queueKey);
        noteSuccess();
      } catch (error) {
        if (isDuplicateSyncError(error)) {
          await removeOutboxItem(item.queueKey);
          continue;
        }
        await touchOutboxRetry(item.queueKey);
        if (honourRetryAfter(error)) {
          break; // the server asked everyone to slow down
        }
        if (isServerOrNetworkError(error)) {
          noteFailure();
          break;
        }
        // 4xx for this item only: it waits (per-item backoff), the rest continue.
      }
    }
  }, [submitHealthPayload, userId]);

  useEffect(() => {
    const onOnline = () => {
      void flushQueuedSync();
    };

    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [flushQueuedSync]);

  const refreshPermissionStatus = useCallback(async () => {
    if (!hasNativeStepCounter()) {
      setPermissionStatus('unavailable');
      return 'unavailable' as const;
    }

    try {
      const status = await DeviceStepCounter.checkPermissions();
      setPermissionStatus(
        status.activityRecognition === 'granted' ? 'granted' : status.activityRecognition === 'unavailable' ? 'unavailable' : 'denied',
      );
      return status.activityRecognition;
    } catch {
      setPermissionStatus('denied');
      return 'denied' as const;
    }
  }, []);

  useEffect(() => {
    void refreshPermissionStatus();

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void refreshPermissionStatus();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [refreshPermissionStatus]);

  const connectDevice = useCallback(async (options?: { silent?: boolean }) => {
    if (!hasNativeStepCounter()) {
      setPermissionStatus('unavailable');
      if (!options?.silent) {
        showToast({
          message: 'Step counting needs the Step2Win app on your Android phone or iPhone.',
          type: 'error',
        });
      }
      return false;
    }

    setIsConnectingDevice(true);
    try {
      const current = await DeviceStepCounter.checkPermissions();
      if (current.activityRecognition === 'denied' && !options?.silent) {
        // Android stops showing the dialog after repeated denials; iOS only ever asks once.
        const opened = await openAppSettings();
        showToast({
          message: opened ? permissionCopy().motionOpenedSettingsHint : permissionCopy().motionBlockedHint,
          type: 'info',
        });
        return false;
      }
      await ensureStepPermissions();
      captureEnabledThisSession = false;
      await enableSmartCaptureOnce();
      await DeviceStepCounter.getTodaySteps();

      await refreshPermissionStatus();
      if (!options?.silent) {
        showToast({ message: `${permissionCopy().motionName} is allowed. Step tracking is ready.`, type: 'success' });
      }
      return true;
    } catch (error) {
      setPermissionStatus('denied');
      if (!options?.silent) {
        showToast({ message: extractSyncErrorMessage(error), type: 'error' });
      }
      return false;
    } finally {
      setIsConnectingDevice(false);
    }
  }, [refreshPermissionStatus, showToast]);

  const invalidateStepQueries = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ['health'] });
    await queryClient.invalidateQueries({ queryKey: ['steps'] });
    await queryClient.invalidateQueries({ queryKey: ['challenges'] });
    await queryClient.invalidateQueries({ queryKey: ['profile'] });
  }, [queryClient]);

  /** Android: the native uploader does the work; this pushes settings and reports back. */
  const runAndroidNativeSync = useCallback(async (options: SyncOptions, profile: User | undefined) => {
    const isSilent = !!options.silent;
    await configureNativeSync(queryClient, profile).catch(() => undefined);
    await enableSmartCaptureOnce();

    const reading = await DeviceStepCounter.getTodaySteps().catch(() => null);
    const stepsNow = reading ? Math.max(0, Math.round(Number(reading.steps) || 0)) : getSyncState().lastSyncedSteps;

    let result: NativeSyncResult = await DeviceStepCounter.syncNow({ force: !!options.force, reason: options.reason || 'app' });
    if (result.status === 'auth') {
      // Access token expired: any authenticated call lets the API client refresh it
      // (the native uploader never refreshes while the app is open, to avoid races).
      await stepsService.getTodayHealth().catch(() => null);
      result = await DeviceStepCounter.syncNow({ force: !!options.force, reason: options.reason || 'app' });
    }
    setRetryAtIso(result.retryAt);

    // Leftovers from the old web-layer outbox (before this version) still drain once.
    if (userId && (await listOutboxItems(userId)).length > 0) {
      await flushQueuedSync();
    }

    if (result.status === 'ok' || result.status === 'nothing') {
      noteSuccess(stepsNow);
    }
    if (result.uploaded > 0) {
      await invalidateStepQueries();
    }

    if (isSilent) return;
    switch (result.status) {
      case 'ok':
        showToast({ message: 'Steps synced!', type: 'success' });
        break;
      case 'nothing':
        showToast({ message: 'Your steps are up to date.', type: 'success' });
        break;
      case 'offline':
        showToast({ message: 'You are offline. Your steps are saved on this phone and will upload automatically.', type: 'info' });
        break;
      case 'backoff':
      case 'throttled':
        showToast({
          message: result.retryAt
            ? `The server is busy. Your steps are saved and will upload after ${formatClock(Date.parse(result.retryAt))}.`
            : 'The server is busy. Your steps are saved and will upload shortly.',
          type: 'info',
        });
        break;
      case 'busy':
        showToast({ message: 'Already syncing…', type: 'info' });
        break;
      case 'signed_out':
      case 'auth':
        showToast({ message: 'Sign in again to upload your steps. They are saved on this phone.', type: 'warning' });
        break;
      default:
        showToast({ message: 'Some steps could not upload yet. They are saved and will be retried.', type: 'info' });
    }
  }, [flushQueuedSync, invalidateStepQueries, queryClient, showToast, userId]);

  /** iOS (and the fallback): web-layer outbox, with catch-up from CoreMotion history. */
  const runOutboxSync = useCallback(async (options: SyncOptions, profile: User | undefined) => {
    const isSilent = !!options.silent;
    let latestHealthPayload: StepSyncForm | null = null;
    let latestHourlyPayload: { date: string; hourly: HourlyStep[]; waypoints: LocationWaypoint[] } | null = null;
    const waypointCursors: Array<{ date: string; upTo: string | null }> = [];

    try {
      await enableSmartCaptureOnce();
      const activeSession = await ensureActiveStepSession();
      const data = await readNativeSensorSteps(profile, activeSession);
      setPermissionStatus('granted');

      const fingerprint = [data.date, data.source, data.steps].join('|');
      const now = Date.now();
      const catchUpDue = !!options.force || now - lastIosCatchUpAt >= IOS_CATCH_UP_EVERY_MS;
      if (isSilent && !options.force && fingerprint === lastSyncedFingerprint && !catchUpDue) {
        return;
      }

      latestHealthPayload = data;
      if (userId) {
        await upsertOutboxItem({ userId, kind: 'health', payload: data });
      }

      // Hourly breakdown: CoreMotion history when available (exact), else the local ledger.
      let history: StepHistoryDay[] = [];
      if (isIOSApp() && catchUpDue) {
        history = (await DeviceStepCounter.getStepHistory({ days: 7 }).catch(() => ({ days: [] as StepHistoryDay[] }))).days || [];
        lastIosCatchUpAt = now;
      }
      const todayHistory = history.find((d) => d.date === data.date);
      const hourlyLedger = userId ? recordHourlySteps(userId, data.steps, data.date) : null;
      const shouldSyncHourly = !isSilent || !!options.force || now - lastHourlySyncAt >= hourlySyncIntervalMs();
      if (shouldSyncHourly && userId && hourlyLedger) {
        try {
          // Route points are optional: skipped on Data Saver.
          const pendingWaypoints = isDataSaverOn()
            ? { date: data.date, waypoints: [] as LocationWaypoint[] }
            : await DeviceStepCounter.getPendingWaypoints().catch(() => ({ date: data.date, waypoints: [] as LocationWaypoint[] }));

          latestHourlyPayload = {
            date: data.date,
            hourly: todayHistory ? historyToHourly(todayHistory, data) : ledgerToHourly(hourlyLedger, data),
            waypoints: pendingWaypoints.date === data.date ? pendingWaypoints.waypoints : [],
          };
          await upsertHourlyMerged(userId, latestHourlyPayload);
          if (latestHourlyPayload.waypoints.length > 0) {
            waypointCursors.push({ date: latestHourlyPayload.date, upTo: lastRecordedAt(latestHourlyPayload.waypoints) });
          }
          if (pendingWaypoints.waypoints.length > 0 && pendingWaypoints.date !== data.date) {
            await upsertHourlyMerged(userId, { date: pendingWaypoints.date, hourly: [], waypoints: pendingWaypoints.waypoints });
            waypointCursors.push({ date: pendingWaypoints.date, upTo: lastRecordedAt(pendingWaypoints.waypoints) });
          }
          lastHourlySyncAt = now;
        } catch (hourlyError) {
          console.warn('Hourly/waypoint sync skipped:', hourlyError);
        }
      }

      // Offline catch-up: past days the phone recorded but the server never confirmed.
      if (userId && history.length > 0) {
        const acked = readIosAcked(userId);
        for (const day of history) {
          if (day.date >= data.date || day.steps <= (acked[day.date] || 0)) continue;
          const pastPayload = buildHealthPayload(day.steps, day.date, profile, null, activeSession);
          await upsertOutboxItem({ userId, kind: 'health', payload: pastPayload });
          await upsertHourlyMerged(userId, { date: day.date, hourly: historyToHourly(day, pastPayload), waypoints: [] });
        }
      }

      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        if (!isSilent) {
          showToast({ message: 'You are offline. Your steps are saved on this phone and will sync automatically.', type: 'info' });
        }
        return;
      }
      if (inBackoff()) {
        if (!isSilent) {
          showToast({ message: `The server is busy. Your steps are saved and will upload after ${formatClock(getSyncState().retryAt)}.`, type: 'info' });
        }
        return;
      }

      await flushQueuedSync();

      if (userId) {
        const remaining = await listOutboxItems(userId);
        // Route points that reached the server can leave the native buffer (only up to the
        // last uploaded point, so anything captured meanwhile is kept for the next upload).
        for (const cursor of waypointCursors) {
          const stillQueued = remaining.some((item) => item.kind === 'hourly' && item.payload?.date === cursor.date);
          if (!stillQueued && cursor.upTo) {
            await DeviceStepCounter.clearPendingWaypoints({ date: cursor.date, upTo: cursor.upTo }).catch(() => null);
          }
        }
        if (remaining.length === 0) {
          lastSyncedFingerprint = fingerprint;
          noteSuccess(data.steps);
        }
      }

      await invalidateStepQueries();

      if (!isSilent) {
        showToast({ message: 'Steps synced!', type: 'success' });
      }
    } catch (error) {
      console.error('Sync error:', error);
      // Only a real permission check may flip the status; network/server errors must not
      // make the UI claim step counting is off.
      void refreshPermissionStatus();
      honourRetryAfter(error);

      if (userId && latestHealthPayload) {
        await upsertOutboxItem({ userId, kind: 'health', payload: latestHealthPayload });
      }
      if (userId && latestHourlyPayload) {
        await upsertOutboxItem({ userId, kind: 'hourly', payload: latestHourlyPayload });
      }
      if (isLikelyOfflineError(error)) {
        if (!isSilent) {
          showToast({ message: 'Offline. Your steps are saved on this phone and will sync when the connection returns.', type: 'info' });
        }
        return;
      }
      if (!isSilent) {
        showToast({ message: extractSyncErrorMessage(error), type: 'error' });
      }
    }
  }, [ensureActiveStepSession, flushQueuedSync, invalidateStepQueries, refreshPermissionStatus, showToast, userId]);

  const runSyncHealth = useCallback((options?: SyncOptions) => runExclusive(async () => {
    const isSilent = !!options?.silent;
    const permissionBootstrapDone = localStorage.getItem(PERMISSIONS_BOOTSTRAP_DONE_KEY) === 'true';

    if (!hasNativeStepCounter()) {
      setPermissionStatus('unavailable');
      return;
    }

    const shouldAutoEnable = !permissionBootstrapDone && (
      !hasAttemptedAutoEnableRef.current || permissionStatus === 'unknown'
    );
    if (shouldAutoEnable) {
      hasAttemptedAutoEnableRef.current = true;
      if (isSilent) {
        return;
      }
      const enabled = await connectDevice();
      if (!enabled) {
        return;
      }
    }

    if (permissionBootstrapDone && permissionStatus !== 'granted' && permissionStatus !== 'unknown') {
      if (!isSilent) {
        showToast({ message: `Allow ${permissionCopy().motionName} in ${permissionCopy().settingsName} to sync steps.`, type: 'warning' });
      }
      return;
    }

    // Background syncs never raise the system permission dialog (it would land on top of
    // onboarding or whatever the user is doing); asking is left to the permission sheet.
    const current = await DeviceStepCounter.checkPermissions().catch(() => null);
    if (current?.activityRecognition !== 'granted') {
      if (isSilent) return;
      await ensureStepPermissions();
    }
    setPermissionStatus('granted');

    const profile = queryClient.getQueryData<User>(['profile']);
    if (isAndroidApp()) {
      try {
        await runAndroidNativeSync(options || {}, profile);
      } catch (error) {
        console.warn('Native step sync unavailable, using the web outbox:', error);
        await runOutboxSync(options || {}, profile);
      }
      return;
    }
    await runOutboxSync(options || {}, profile);
  }), [connectDevice, permissionStatus, queryClient, runAndroidNativeSync, runOutboxSync, showToast]);

  const syncHealth = useCallback(() => runSyncHealth({ reason: 'manual', force: true }), [runSyncHealth]);
  const syncHealthSilent = useCallback(() => runSyncHealth({ silent: true, reason: 'auto' }), [runSyncHealth]);
  /** Silent sync that also catches up and refreshes settings — for launch and app resume. */
  const syncHealthNow = useCallback(() => runSyncHealth({ silent: true, force: true, reason: 'resume' }), [runSyncHealth]);
  /** Silent sync with a reason (the adaptive scheduler in useSmartStepSync). */
  const requestSync = useCallback((reason: string) => runSyncHealth({ silent: true, reason }), [runSyncHealth]);

  return { syncHealth, syncHealthSilent, syncHealthNow, requestSync, connectDevice, isSyncing, isConnectingDevice, permissionStatus, refreshPermissionStatus };
}

/**
 * Foreground cadence while the app is open — event-driven, not polling:
 * - Android: the native "stepsChanged" event (at most every 3 s). Upload when >= 75 new steps
 *   (300 on Data Saver) have piled up (debounced 10 s), or every >= 60 s while steps keep
 *   coming (5 min on Data Saver, 30 s in the last 2 h before a challenge ends).
 * - iOS: a cheap local CoreMotion read every 60 s, same thresholds.
 * - A 5-minute safety net (15 on Data Saver); with nothing new it sends nothing.
 * Launch and resume syncs are done by the caller (they also catch up and refresh settings).
 */
export function useSmartStepSync(requestSync: (reason: string) => Promise<void>) {
  const requestRef = useRef(requestSync);
  requestRef.current = requestSync;

  useEffect(() => {
    if (!hasNativeStepCounter()) return undefined;
    let debounceTimer: number | undefined;
    let cancelled = false;

    const thresholds = () => {
      const saver = loadPreferences().dataSaver;
      const { nearDeadline } = getSyncState();
      return {
        steps: nearDeadline ? 1 : saver ? FOREGROUND.saverStepThreshold : FOREGROUND.stepThreshold,
        minInterval: nearDeadline
          ? FOREGROUND.deadlineMinIntervalMs
          : saver
            ? FOREGROUND.saverWalkingMinIntervalMs
            : FOREGROUND.walkingMinIntervalMs,
      };
    };

    const onSteps = (steps: number) => {
      if (cancelled || document.visibilityState !== 'visible') return;
      const { lastSyncedSteps, lastSyncAt, syncing } = getSyncState();
      const fresh = steps - lastSyncedSteps;
      if (fresh <= 0 || syncing || inBackoff()) return;
      const t = thresholds();
      const due = fresh >= t.steps || Date.now() - lastSyncAt >= t.minInterval;
      if (!due) return;
      window.clearTimeout(debounceTimer);
      debounceTimer = window.setTimeout(
        () => void requestRef.current('steps'),
        fresh >= t.steps ? FOREGROUND.debounceMs : 2_000,
      );
    };

    let removeListener: (() => void) | undefined;
    let pollTimer: number | undefined;
    if (isAndroidApp()) {
      DeviceStepCounter.addListener('stepsChanged', (data) => onSteps(Number(data?.steps) || 0))
        .then((handle) => {
          if (cancelled) void handle.remove();
          else removeListener = () => void handle.remove();
        })
        .catch(() => undefined);
    } else {
      pollTimer = window.setInterval(() => {
        if (document.visibilityState !== 'visible') return;
        DeviceStepCounter.getTodaySteps()
          .then((reading) => onSteps(Math.round(Number(reading.steps) || 0)))
          .catch(() => undefined);
      }, 60_000);
    }

    const safetyTimer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      const every = loadPreferences().dataSaver ? FOREGROUND.saverSafetyIntervalMs : FOREGROUND.safetyIntervalMs;
      if (Date.now() - getSyncState().lastSyncAt >= every) void requestRef.current('safety');
    }, 60_000);

    return () => {
      cancelled = true;
      window.clearTimeout(debounceTimer);
      window.clearInterval(pollTimer);
      window.clearInterval(safetyTimer);
      removeListener?.();
    };
  }, []);
}

/** @deprecated Kept for compatibility; the layout uses useSmartStepSync (event-driven). */
export function useAutoHealthSync(intervalMs: number = FOREGROUND.safetyIntervalMs) {
  const { syncHealthSilent, isSyncing } = useHealthSync();

  useEffect(() => {
    syncHealthSilent();

    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        syncHealthSilent();
      }
    }, Math.max(60_000, intervalMs));

    return () => {
      window.clearInterval(interval);
    };
  }, [intervalMs, syncHealthSilent]);

  return { isSyncing };
}

/**
 * Reads today's steps from the native plugin and builds the /sync payload. iOS has no
 * gait/ML features (`gait_available: false`): those fields are sent as null so the backend
 * skips those checks instead of scoring zeros.
 */
async function readNativeSensorSteps(profile: User | undefined, session: ActiveStepSession) {
  await ensureStepPermissions();
  const reading = await DeviceStepCounter.getTodaySteps();
  const steps = Math.max(0, Math.round(Number(reading.steps) || 0));
  // The phone's own calendar day (the old code used the UTC date, which put steps taken
  // after local midnight east of UTC on the previous day).
  const date = typeof reading.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(reading.date) ? reading.date : localDateString();
  return buildHealthPayload(steps, date, profile, reading, session);
}

function buildHealthPayload(
  steps: number,
  date: string,
  profile: User | undefined,
  reading: Awaited<ReturnType<typeof DeviceStepCounter.getTodaySteps>> | null,
  session: ActiveStepSession,
): StepSyncForm {
  const hasGait = !!reading && reading.gait_available !== false;
  // Android keeps its existing neutral defaults; iOS / history days (no gait features) send null.
  const gaitNum = (value: unknown, min: number, max: number) => (hasGait ? clampNumber(value, min, max, 0) : null);
  const gaitInt = (value: unknown) => (hasGait ? Math.max(0, Math.round(Number(value) || 0)) : null);

  const strideCm = clampNumber(profile?.stride_length_cm, 40, 130, 78);
  const weightKg = clampNumber(profile?.weight_kg, 30, 220, 70);
  const cadenceSpm = reading ? clampNumber(reading.cadence_spm, 0, 400, 0) : 0;
  const burstSteps5s = reading ? Math.max(0, Math.round(Number(reading.burst_steps_5s) || 0)) : 0;
  const mlWalkProbability = gaitNum(reading?.ml_walk_probability, 0, 1);
  const mlShakeProbability = gaitNum(reading?.ml_shake_probability, 0, 1);

  const distanceMeters = steps * (strideCm / 100);
  const distance_km = steps > 0 ? parseFloat((distanceMeters / 1000).toFixed(2)) : null;

  // Dynamic MET estimate based on cadence + user weight for tighter calorie estimate.
  const cadenceForMet = cadenceSpm > 0 ? cadenceSpm : (steps > 0 ? Math.min(160, Math.max(60, steps / 60)) : 0);
  const met = cadenceForMet >= 130 ? 6.5 : cadenceForMet >= 110 ? 4.8 : cadenceForMet >= 90 ? 3.5 : 2.5;
  // At least one active minute once there are steps (the server rejects steps without time).
  const active_minutes = steps > 0 ? Math.max(1, Math.round(steps / 120)) : null;
  const calories_active = active_minutes && active_minutes > 0
    ? Math.round((met * 3.5 * weightKg / 200) * active_minutes)
    : null;

  const payload: StepSyncForm = {
    date,
    source: 'device_sensor',
    steps,
    distance_km,
    calories_active,
    active_minutes,
    cadence_spm: cadenceSpm,
    burst_steps_5s: burstSteps5s,
    gait_state: reading && typeof reading.gait_state === 'string' ? reading.gait_state : hasGait ? 'idle' : null,
    gait_confidence: gaitNum(reading?.gait_confidence, 0, 100),
    gait_dominant_freq_hz: gaitNum(reading?.gait_dominant_freq_hz, 0, 10),
    gait_autocorr: gaitNum(reading?.gait_autocorr, 0, 1),
    gait_interval_std_ms: gaitNum(reading?.gait_interval_std_ms, 0, 5000),
    gait_valid_peaks_2s: gaitInt(reading?.gait_valid_peaks_2s),
    gait_gyro_variance: gaitNum(reading?.gait_gyro_variance, 0, 1000),
    gait_jerk_rms: gaitNum(reading?.gait_jerk_rms, 0, 1000),
    carry_mode: reading && typeof reading.carry_mode === 'string' ? reading.carry_mode : hasGait ? 'unknown' : null,
    ml_motion_label: reading && typeof reading.ml_motion_label === 'string' ? reading.ml_motion_label : hasGait ? 'other' : null,
    ml_walk_probability: mlWalkProbability,
    ml_shake_probability: mlShakeProbability,
    ml_model_version: reading && typeof reading.ml_model_version === 'string' ? reading.ml_model_version : session.mlModelVersion || null,
    smoothed_walk_probability: hasGait ? clampNumber(reading?.smoothed_walk_probability, 0, 1, mlWalkProbability ?? 0) : null,
    smoothed_shake_probability: hasGait ? clampNumber(reading?.smoothed_shake_probability, 0, 1, mlShakeProbability ?? 0) : null,
    ml_window_count: gaitInt(reading?.ml_window_count),
    ml_confidence_stability: gaitNum(reading?.ml_confidence_stability, 0, 1),
    motion_entropy: gaitNum(reading?.motion_entropy, 0, 10),
    device_id: reading && typeof reading.device_id === 'string' ? reading.device_id : session.deviceId,
    // A fresh reading: its id + timestamp stay fixed through retries (idempotency).
    client_event_id: uuidv4(),
    timestamp_client: new Date().toISOString(),
    steps_total: steps,
    steps_delta: steps,
  };

  return payload;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, n));
}

async function ensureStepPermissions() {
  const status = await DeviceStepCounter.checkPermissions();
  if (status.activityRecognition === 'granted') {
    return;
  }
  if (status.activityRecognition === 'unavailable') {
    throw new Error('This phone doesn’t report steps to apps, so Step2Win can’t count them here.');
  }

  const requested = await DeviceStepCounter.requestPermissions();
  if (requested.activityRecognition !== 'granted') {
    throw new Error(`${permissionCopy().motionName} permission is required to count your steps.`);
  }
}

type HourlyLedger = { date: string; lastTotal: number; hours: Record<string, number> };

const HOURLY_LEDGER_KEY = 'hourly_step_ledger_v1';

/**
 * iOS fallback when CoreMotion history isn't available: attributes new steps (since the
 * previous reading) to the current local hour. The first reading of a day only sets the
 * baseline — steps taken while the app was closed aren't guessed into an hour.
 */
function recordHourlySteps(userId: number, totalSteps: number, today: string): HourlyLedger {
  const key = `${HOURLY_LEDGER_KEY}:${userId}`;
  const total = Math.max(0, Math.round(Number(totalSteps) || 0));
  let ledger: HourlyLedger | null = null;
  try {
    ledger = JSON.parse(localStorage.getItem(key) || 'null');
  } catch {
    ledger = null;
  }
  if (!ledger || ledger.date !== today) {
    ledger = { date: today, lastTotal: total, hours: {} };
  } else {
    const delta = total - ledger.lastTotal;
    if (delta > 0) {
      const hour = String(new Date().getHours());
      ledger.hours[hour] = (ledger.hours[hour] || 0) + delta;
    }
    ledger.lastTotal = total; // also absorbs sensor resets (negative delta)
  }
  try {
    localStorage.setItem(key, JSON.stringify(ledger));
  } catch {
    // Storage unavailable: the ledger lives for this run only.
  }
  return ledger;
}

function ledgerToHourly(
  ledger: HourlyLedger,
  data: { steps: number; distance_km?: number | null; calories_active?: number | null },
): HourlyStep[] {
  return hoursToHourly(Object.entries(ledger.hours).map(([hour, steps]) => [Number(hour), steps]), data);
}

function historyToHourly(
  day: StepHistoryDay,
  data: { steps: number; distance_km?: number | null; calories_active?: number | null },
): HourlyStep[] {
  return hoursToHourly((day.hours || []).map((steps, hour) => [hour, Math.max(0, Math.round(Number(steps) || 0))]), data);
}

function hoursToHourly(
  entries: Array<[number, number]>,
  data: { steps: number; distance_km?: number | null; calories_active?: number | null },
): HourlyStep[] {
  const totalSteps = Math.max(1, Math.round(Number(data.steps) || 0));
  const totalDistance = Math.max(0, Number(data.distance_km) || 0);
  const totalCalories = Math.max(0, Number(data.calories_active) || 0);
  return entries
    .filter(([hour, steps]) => Number.isFinite(hour) && hour >= 0 && hour <= 23 && steps > 0)
    .map(([hour, steps]) => {
      const ratio = Math.min(1, steps / totalSteps);
      return {
        hour,
        steps,
        distance_km: Number((totalDistance * ratio).toFixed(3)),
        calories: Number((totalCalories * ratio).toFixed(1)),
      };
    })
    .sort((a, b) => a.hour - b.hour);
}

function lastRecordedAt(waypoints: LocationWaypoint[]): string | null {
  let latest: string | null = null;
  let latestMs = -Infinity;
  for (const w of waypoints) {
    const ms = Date.parse(String(w.recorded_at));
    if (Number.isFinite(ms) && ms > latestMs) {
      latestMs = ms;
      latest = String(w.recorded_at);
    }
  }
  return latest;
}

/** One outbox row per day: merge with any not-yet-uploaded row so nothing is overwritten. */
async function upsertHourlyMerged(
  userId: number,
  payload: { date: string; hourly: HourlyStep[]; waypoints: LocationWaypoint[] },
) {
  const existing = (await listOutboxItems(userId)).find((item) => item.kind === 'hourly' && item.payload?.date === payload.date);
  let merged = payload;
  if (existing) {
    const prev = existing.payload as { hourly?: HourlyStep[]; waypoints?: LocationWaypoint[] };
    const hours = new Map<number, HourlyStep>();
    (prev.hourly || []).forEach((h) => hours.set(h.hour, h));
    // A bucket only grows: keep the larger of the queued and the new value.
    payload.hourly.forEach((h) => {
      const before = hours.get(h.hour);
      if (!before || h.steps >= before.steps) hours.set(h.hour, h);
    });
    const points = new Map<string, LocationWaypoint>();
    [...(prev.waypoints || []), ...payload.waypoints].forEach((w) => points.set(String(w.recorded_at), w));
    merged = {
      date: payload.date,
      hourly: [...hours.values()].sort((a, b) => a.hour - b.hour),
      waypoints: [...points.values()].slice(-500),
    };
  }
  await upsertOutboxItem({ userId, kind: 'hourly', payload: merged });
}
