import { useCallback, useEffect, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { useQueryClient } from '@tanstack/react-query';
import { stepsService } from '../services/api/steps';
import { useToast } from '../components/ui/Toast';
import { useAuthStore } from '../store/authStore';
import { v4 as uuidv4 } from 'uuid';
import CryptoJS from 'crypto-js';
import { DeviceStepCounter } from '../plugins/deviceStepCounter';
import type { HourlyStep, LocationWaypoint, StepSyncForm, User } from '../types';
import {
  listOutboxItems,
  removeOutboxItem,
  touchOutboxRetry,
  upsertOutboxItem,
} from '../services/offlineSyncOutbox';

const HOURLY_SYNC_MIN_INTERVAL_MS = 5 * 60 * 1000;
const SILENT_SYNC_MIN_INTERVAL_MS = 30 * 1000;
const PERMISSIONS_BOOTSTRAP_DONE_KEY = 'permissions_bootstrap_done_v1';

type ActiveStepSession = {
  sessionId: string;
  sessionToken: string;
  expiresAt: string;
  nextSequenceNumber: number;
  deviceId: string;
  platform: 'android';
  appVersion: string;
  mlModelVersion: string;
};

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
  return Number.isFinite(expiresAt) ? expiresAt <= Date.now() : true;
}

function isExpiredSessionError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const maybeAxios = error as { response?: { status?: number; data?: { detail?: string; message?: string; error?: string } } };
  const statusCode = maybeAxios.response?.status;
  const message = `${maybeAxios.response?.data?.detail || ''} ${maybeAxios.response?.data?.message || ''} ${maybeAxios.response?.data?.error || ''}`.toLowerCase();
  return statusCode === 401 || statusCode === 403 || message.includes('expired') || message.includes('invalid session') || message.includes('could not be verified');
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

function isDuplicateSyncError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const maybeAxios = error as { response?: { status?: number; data?: { error?: string } } };
  return maybeAxios.response?.status === 409 || maybeAxios.response?.data?.error === 'Duplicate request';
}

export function useHealthSync() {
  const [isSyncing, setIsSyncing] = useState(false);
  const [isConnectingDevice, setIsConnectingDevice] = useState(false);
  const [permissionStatus, setPermissionStatus] = useState<'unknown' | 'granted' | 'denied' | 'unavailable'>('unknown');
  const hasAttemptedAutoEnableRef = useRef(false);
  const syncInFlightRef = useRef(false);
  const lastSyncedFingerprintRef = useRef('');
  const lastHourlySyncAtRef = useRef(0);
  const lastSilentSyncAtRef = useRef(0);
  const hourlyBaselineRef = useRef<{ key: string; baselineSteps: number }>({ key: '', baselineSteps: 0 });
  const activeStepSessionRef = useRef<ActiveStepSession | null>(null);
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const userId = useAuthStore((state) => state.user?.id);

  const ensureActiveStepSession = useCallback(async (): Promise<ActiveStepSession> => {
    const nativeSession = await DeviceStepCounter.startStepSession();
    const existing = activeStepSessionRef.current;

    if (existing && !isExpiredSessionPayload(existing)) {
      return existing;
    }

    if (nativeSession.session_id && nativeSession.session_token && nativeSession.expires_at) {
      const cached: ActiveStepSession = {
        sessionId: nativeSession.session_id,
        sessionToken: nativeSession.session_token,
        expiresAt: nativeSession.expires_at,
        nextSequenceNumber: nativeSession.next_sequence_number ?? 1,
        deviceId: nativeSession.device_id,
        platform: 'android',
        appVersion: nativeSession.app_version,
        mlModelVersion: nativeSession.ml_model_version,
      };
      activeStepSessionRef.current = cached;
      return cached;
    }

    const started = await stepsService.startSession({
      device_id: nativeSession.device_id,
      platform: 'android',
      app_version: nativeSession.app_version,
      ml_model_version: nativeSession.ml_model_version,
    });

    const created: ActiveStepSession = {
      sessionId: started.session_id,
      sessionToken: started.session_token,
      expiresAt: started.expires_at,
      nextSequenceNumber: started.sequence_start ?? 1,
      deviceId: nativeSession.device_id,
      platform: 'android',
      appVersion: nativeSession.app_version,
      mlModelVersion: nativeSession.ml_model_version,
    };

    await DeviceStepCounter.setActiveStepSession({
      session_id: created.sessionId,
      session_token: created.sessionToken,
      expires_at: created.expiresAt,
      next_sequence_number: created.nextSequenceNumber,
    }).catch(() => ({ saved: false }));

    activeStepSessionRef.current = created;
    return created;
  }, []);

  const clearActiveStepSession = useCallback(async () => {
    activeStepSessionRef.current = null;
    await DeviceStepCounter.clearActiveStepSession().catch(() => ({ cleared: false }));
  }, []);

  const submitHealthPayload = useCallback(async (healthPayload: StepSyncForm): Promise<void> => {
    let session = await ensureActiveStepSession();
    let payload = { ...healthPayload } as StepSyncForm & Record<string, unknown>;

    const attachSession = (sessionState: ActiveStepSession) => {
      const timestampClient = typeof payload.timestamp_client === 'string' && payload.timestamp_client.trim()
        ? payload.timestamp_client
        : new Date().toISOString();
      payload = {
        ...payload,
        device_id: sessionState.deviceId,
        session_id: sessionState.sessionId,
        session_token: sessionState.sessionToken,
        client_event_id: payload.client_event_id || uuidv4(),
        sequence_number: sessionState.nextSequenceNumber,
        timestamp_client: timestampClient,
        steps_total: payload.steps_total ?? payload.steps,
        steps_delta: payload.steps_delta ?? payload.steps,
      };
      payload.payload_hash = stablePayloadHash(payload);
    };

    attachSession(session);

    try {
      await stepsService.syncHealth(payload as StepSyncForm);
      session = { ...session, nextSequenceNumber: session.nextSequenceNumber + 1 };
      activeStepSessionRef.current = session;
      await DeviceStepCounter.setActiveStepSession({
        session_id: session.sessionId,
        session_token: session.sessionToken,
        expires_at: session.expiresAt,
        next_sequence_number: session.nextSequenceNumber,
      }).catch(() => ({ saved: false }));
      return;
    } catch (error) {
      if (!isExpiredSessionError(error)) {
        throw error;
      }

      await clearActiveStepSession();
      session = await ensureActiveStepSession();
      attachSession(session);
      await stepsService.syncHealth(payload as StepSyncForm);
      session = { ...session, nextSequenceNumber: session.nextSequenceNumber + 1 };
      activeStepSessionRef.current = session;
      await DeviceStepCounter.setActiveStepSession({
        session_id: session.sessionId,
        session_token: session.sessionToken,
        expires_at: session.expiresAt,
        next_sequence_number: session.nextSequenceNumber,
      }).catch(() => ({ saved: false }));
    }
  }, [clearActiveStepSession, ensureActiveStepSession]);

  const flushQueuedSync = useCallback(async () => {
    if (!userId || (typeof navigator !== 'undefined' && navigator.onLine === false)) {
      return;
    }

    const queue = await listOutboxItems(userId);
    if (queue.length === 0) {
      return;
    }

    for (const item of queue) {
      try {
        if (item.kind === 'health') {
          const healthPayload = item.payload as StepSyncForm;
          await submitHealthPayload(healthPayload);
        } else {
          const hourlyPayload = item.payload as { date: string; hourly: HourlyStep[]; waypoints: LocationWaypoint[] };
          await stepsService.syncHourly(hourlyPayload);
        }
        await removeOutboxItem(item.queueKey);
      } catch (error) {
        if (isDuplicateSyncError(error)) {
          await removeOutboxItem(item.queueKey);
          continue;
        }
        await touchOutboxRetry(item.queueKey);
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
    const platform = Capacitor.getPlatform();
    if (platform !== 'android') {
      setPermissionStatus('unavailable');
      return 'unavailable' as const;
    }

    try {
      const status = await DeviceStepCounter.checkPermissions();
      setPermissionStatus(status.activityRecognition === 'granted' ? 'granted' : 'denied');
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
    const platform = Capacitor.getPlatform();

    if (platform !== 'android') {
      setPermissionStatus('unavailable');
      if (!options?.silent) {
        showToast({
          message: 'Native step sensor tracking is currently available on Android only.',
          type: 'error',
        });
      }
      return false;
    }

    setIsConnectingDevice(true);
    try {
      await ensureAndroidStepPermissions();
      await DeviceStepCounter.startBackgroundCapture().catch(() => ({ running: false }));
      await DeviceStepCounter.getTodaySteps();

      await refreshPermissionStatus();
      if (!options?.silent) {
        showToast({ message: 'Physical activity permission enabled. Step tracking is ready.', type: 'success' });
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

  const runSyncHealth = useCallback(async (options?: { silent?: boolean }) => {
    if (syncInFlightRef.current) {
      return;
    }

    syncInFlightRef.current = true;
    setIsSyncing(true);
    let latestHealthPayload: any = null;
    let latestHourlyPayload: any = null;

    try {
      const platform = Capacitor.getPlatform();
      const isSilent = !!options?.silent;
      const permissionBootstrapDone = localStorage.getItem(PERMISSIONS_BOOTSTRAP_DONE_KEY) === 'true';

      if (isSilent && Date.now() - lastSilentSyncAtRef.current < SILENT_SYNC_MIN_INTERVAL_MS) {
        return;
      }

      if (platform !== 'android') {
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

      if (permissionBootstrapDone && permissionStatus !== 'granted') {
        if (!isSilent) {
          showToast({ message: 'Enable physical activity permission in Settings to sync steps.', type: 'warning' });
        }
        return;
      }

      let data;

      if (platform === 'android') {
        const profile = queryClient.getQueryData<User>(['profile']);
        const activeSession = await ensureActiveStepSession();
        data = await readAndroidSensorSteps(profile, activeSession);
        setPermissionStatus('granted');
      } else {
        return;
      }

      const fingerprint = [
        data.date,
        data.source,
        data.steps,
        data.distance_km ?? '',
        data.calories_active ?? '',
        data.active_minutes ?? '',
      ].join('|');

      if (isSilent && fingerprint === lastSyncedFingerprintRef.current) {
        return;
      }

      latestHealthPayload = data;
      if (userId) {
        await upsertOutboxItem({
          userId,
          kind: 'health',
          payload: data,
        });
      }

      const now = Date.now();
      const shouldSyncHourly = !isSilent || now - lastHourlySyncAtRef.current >= HOURLY_SYNC_MIN_INTERVAL_MS;
      if (shouldSyncHourly) {
        try {
          const pendingWaypoints = await DeviceStepCounter.getPendingWaypoints().catch(() => ({
            date: data.date,
            waypoints: [],
          }));
          const hourlySnapshot = buildHourlySnapshot(data, hourlyBaselineRef.current);
          hourlyBaselineRef.current = {
            key: `${data.date}:${hourlySnapshot.hour}`,
            baselineSteps: hourlySnapshot.baselineSteps,
          };

          latestHourlyPayload = {
            date: data.date,
            hourly: [{
              hour: hourlySnapshot.hour,
              steps: hourlySnapshot.steps,
              distance_km: hourlySnapshot.distance_km,
              calories: hourlySnapshot.calories,
            }],
            waypoints: pendingWaypoints.date === data.date ? pendingWaypoints.waypoints : [],
          };
          if (userId) {
            await upsertOutboxItem({
              userId,
              kind: 'hourly',
              payload: latestHourlyPayload,
            });
          }

          if (pendingWaypoints.waypoints.length > 0 && pendingWaypoints.date !== data.date) {
            const legacyWaypointPayload = {
              date: pendingWaypoints.date,
              hourly: [],
              waypoints: pendingWaypoints.waypoints,
            };
            if (userId) {
              await upsertOutboxItem({
                userId,
                kind: 'hourly',
                payload: legacyWaypointPayload,
              });
            }
            await DeviceStepCounter.clearPendingWaypoints().catch(() => ({ cleared: false }));
          }

          lastHourlySyncAtRef.current = now;
        } catch (hourlyError) {
          console.warn('Hourly/waypoint sync skipped:', hourlyError);
        }
      }

      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        if (!options?.silent) {
          showToast({ message: 'You are offline. Steps were saved in SQLite and will sync automatically when online.', type: 'info' });
        }
        return;
      }

      await flushQueuedSync();

      if (userId) {
        const remaining = await listOutboxItems(userId);
        if (remaining.length === 0) {
          lastSyncedFingerprintRef.current = fingerprint;
          if (isSilent) {
            lastSilentSyncAtRef.current = Date.now();
          }
        }
      }

      await queryClient.invalidateQueries({ queryKey: ['health'] });
      await queryClient.invalidateQueries({ queryKey: ['steps'] });
      await queryClient.invalidateQueries({ queryKey: ['challenges'] });
      await queryClient.invalidateQueries({ queryKey: ['profile'] });

      if (!options?.silent) {
        showToast({ message: 'Steps synced!', type: 'success' });
      }
    } catch (error) {
      console.error('Sync error:', error);
      const platform = Capacitor.getPlatform();
      if (platform === 'android') {
        setPermissionStatus('denied');
      }

      if (userId && (latestHealthPayload || latestHourlyPayload)) {
        if (latestHealthPayload) {
          await upsertOutboxItem({
            userId,
            kind: 'health',
            payload: latestHealthPayload,
          });
        }
        if (latestHourlyPayload) {
          await upsertOutboxItem({
            userId,
            kind: 'hourly',
            payload: latestHourlyPayload,
          });
        }

        if (isLikelyOfflineError(error)) {
          if (!options?.silent) {
            showToast({ message: 'Offline detected. Data stored in SQLite and will sync when connection returns.', type: 'info' });
          }
          return;
        }
      }

      if (!options?.silent) {
        showToast({ message: extractSyncErrorMessage(error), type: 'error' });
      }
    } finally {
      syncInFlightRef.current = false;
      setIsSyncing(false);
    }
  }, [connectDevice, flushQueuedSync, permissionStatus, queryClient, showToast, userId]);

  const syncHealth = useCallback(() => runSyncHealth(), [runSyncHealth]);
  const syncHealthSilent = useCallback(() => runSyncHealth({ silent: true }), [runSyncHealth]);

  return { syncHealth, syncHealthSilent, connectDevice, isSyncing, isConnectingDevice, permissionStatus, refreshPermissionStatus };
}

export function useAutoHealthSync(intervalMs: number = 1000) {
  const { syncHealthSilent, isSyncing } = useHealthSync();

  useEffect(() => {
    syncHealthSilent();

    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        syncHealthSilent();
      }
    }, intervalMs);

    return () => {
      window.clearInterval(interval);
    };
  }, [intervalMs, syncHealthSilent]);

  return { isSyncing };
}

async function readAndroidSensorSteps(profile: User | undefined, session: ActiveStepSession) {
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0];

  await ensureAndroidStepPermissions();
  await DeviceStepCounter.startBackgroundCapture().catch(() => ({ running: false }));
  const reading = await DeviceStepCounter.getTodaySteps();
  const steps = Math.max(0, Math.round(Number(reading.steps) || 0));

  const strideCm = clampNumber(profile?.stride_length_cm, 40, 130, 78);
  const weightKg = clampNumber(profile?.weight_kg, 30, 220, 70);
  const cadenceSpm = clampNumber(reading.cadence_spm, 0, 400, 0);
  const burstSteps5s = Math.max(0, Math.round(Number(reading.burst_steps_5s) || 0));
  const gaitConfidence = clampNumber(reading.gait_confidence, 0, 100, 0);
  const gaitDominantFreqHz = clampNumber(reading.gait_dominant_freq_hz, 0, 10, 0);
  const gaitAutocorr = clampNumber(reading.gait_autocorr, 0, 1, 0);
  const gaitIntervalStdMs = clampNumber(reading.gait_interval_std_ms, 0, 5000, 0);
  const gaitValidPeaks2s = Math.max(0, Math.round(Number(reading.gait_valid_peaks_2s) || 0));
  const gaitGyroVariance = clampNumber(reading.gait_gyro_variance, 0, 1000, 0);
  const gaitJerkRms = clampNumber(reading.gait_jerk_rms, 0, 1000, 0);
  const gaitState = typeof reading.gait_state === 'string' ? reading.gait_state : 'idle';
  const carryMode = typeof reading.carry_mode === 'string' ? reading.carry_mode : 'unknown';
  const mlMotionLabel = typeof reading.ml_motion_label === 'string' ? reading.ml_motion_label : 'other';
  const mlWalkProbability = clampNumber(reading.ml_walk_probability, 0, 1, 0);
  const mlShakeProbability = clampNumber(reading.ml_shake_probability, 0, 1, 0);
  const mlModelVersion = typeof reading.ml_model_version === 'string' ? reading.ml_model_version : null;

  const distanceMeters = steps * (strideCm / 100);
  const distance_km = steps > 0 ? parseFloat((distanceMeters / 1000).toFixed(2)) : null;

  // Dynamic MET estimate based on cadence + user weight for tighter calorie estimate.
  const cadenceForMet = cadenceSpm > 0 ? cadenceSpm : (steps > 0 ? Math.min(160, Math.max(60, steps / 60)) : 0);
  const met = cadenceForMet >= 130 ? 6.5 : cadenceForMet >= 110 ? 4.8 : cadenceForMet >= 90 ? 3.5 : 2.5;
  const active_minutes = steps > 0 ? Math.round(steps / 120) : null;
  const calories_active = active_minutes && active_minutes > 0
    ? Math.round((met * 3.5 * weightKg / 200) * active_minutes)
    : null;

  const timestampClient = typeof reading.timestamp_client === 'string' && reading.timestamp_client.trim()
    ? reading.timestamp_client
    : new Date().toISOString();
  const clientEventId = typeof reading.client_event_id === 'string' && reading.client_event_id.trim()
    ? reading.client_event_id
    : uuidv4();
  const sequenceNumber = Math.max(1, Math.round(Number(reading.sequence_number) || session.nextSequenceNumber || 1));
  const stepsTotal = Math.max(0, Math.round(Number(reading.steps_total) || steps));
  const stepsDelta = Math.max(0, Math.round(Number(reading.steps_delta) || steps));

  const payload = {
    date: dateStr,
    source: 'device_sensor' as const,
    steps,
    distance_km,
    calories_active,
    active_minutes,
    cadence_spm: cadenceSpm,
    burst_steps_5s: burstSteps5s,
    gait_state: gaitState,
    gait_confidence: gaitConfidence,
    gait_dominant_freq_hz: gaitDominantFreqHz,
    gait_autocorr: gaitAutocorr,
    gait_interval_std_ms: gaitIntervalStdMs,
    gait_valid_peaks_2s: gaitValidPeaks2s,
    gait_gyro_variance: gaitGyroVariance,
    gait_jerk_rms: gaitJerkRms,
    carry_mode: carryMode,
    ml_motion_label: mlMotionLabel,
    ml_walk_probability: mlWalkProbability,
    ml_shake_probability: mlShakeProbability,
    ml_model_version: mlModelVersion,
    smoothed_walk_probability: clampNumber(reading.smoothed_walk_probability, 0, 1, mlWalkProbability),
    smoothed_shake_probability: clampNumber(reading.smoothed_shake_probability, 0, 1, mlShakeProbability),
    ml_window_count: Math.max(0, Math.round(Number(reading.ml_window_count) || 0)),
    ml_confidence_stability: clampNumber(reading.ml_confidence_stability, 0, 1, 0),
    motion_entropy: clampNumber(reading.motion_entropy, 0, 10, 0),
    device_id: typeof reading.device_id === 'string' ? reading.device_id : session.deviceId,
    session_id: session.sessionId,
    session_token: session.sessionToken,
    client_event_id: clientEventId,
    sequence_number: sequenceNumber,
    timestamp_client: timestampClient,
    steps_delta: stepsDelta,
    steps_total: stepsTotal,
    payload_hash: '',
  };

  payload.payload_hash = stablePayloadHash(payload);

  return payload;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, n));
}

async function ensureAndroidStepPermissions() {
  const status = await DeviceStepCounter.checkPermissions();
  if (status.activityRecognition === 'granted') {
    return;
  }

  const requested = await DeviceStepCounter.requestPermissions();
  if (requested.activityRecognition !== 'granted') {
    throw new Error('Physical activity permission is required to count your steps.');
  }
}

function buildHourlySnapshot(data: {
  date: string;
  steps: number;
  distance_km?: number | null;
  calories_active?: number | null;
}, state: { key: string; baselineSteps: number }) {
  const hour = new Date().getHours();
  const key = `${data.date}:${hour}`;
  const totalSteps = Math.max(0, Math.round(Number(data.steps) || 0));

  let baselineSteps = state.baselineSteps;
  if (state.key !== key) {
    baselineSteps = totalSteps;
  }

  const hourlySteps = Math.max(0, totalSteps - baselineSteps);
  const ratio = totalSteps > 0 ? hourlySteps / totalSteps : 0;
  const totalDistance = Math.max(0, Number(data.distance_km) || 0);
  const totalCalories = Math.max(0, Number(data.calories_active) || 0);

  return {
    hour: Number.isFinite(hour) ? hour : 0,
    steps: hourlySteps,
    distance_km: Number((totalDistance * ratio).toFixed(3)),
    calories: Number((totalCalories * ratio).toFixed(1)),
    baselineSteps,
  };
}
