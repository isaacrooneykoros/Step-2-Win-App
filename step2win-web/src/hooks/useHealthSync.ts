import { useCallback, useEffect, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { useQueryClient } from '@tanstack/react-query';
import { stepsService } from '../services/api/steps';
import { useToast } from '../components/ui/Toast';
import { useAuthStore } from '../store/authStore';
import { v4 as uuidv4 } from 'uuid';
import CryptoJS from 'crypto-js';
import { DeviceStepCounter } from '../plugins/deviceStepCounter';
import type { User } from '../types';

const APP_SIGNING_SECRET = import.meta.env.VITE_APP_SIGNING_SECRET || '';
const HOURLY_SYNC_MIN_INTERVAL_MS = 5 * 60 * 1000;

function buildSignedHeaders(userId: string, body: object): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const bodyHash = CryptoJS.SHA256(JSON.stringify(body)).toString();
  const message = `${userId}:${timestamp}:${bodyHash}`;
  return {
    'X-App-Signature': CryptoJS.HmacSHA256(message, APP_SIGNING_SECRET).toString(),
    'X-Timestamp': timestamp,
    'X-Idempotency-Key': uuidv4(),
  };
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

export function useHealthSync() {
  const [isSyncing, setIsSyncing] = useState(false);
  const [isConnectingDevice, setIsConnectingDevice] = useState(false);
  const [permissionStatus, setPermissionStatus] = useState<'unknown' | 'granted' | 'denied' | 'unavailable'>('unknown');
  const hasAttemptedAutoEnableRef = useRef(false);
  const syncInFlightRef = useRef(false);
  const lastSyncedFingerprintRef = useRef('');
  const lastHourlySyncAtRef = useRef(0);
  const hourlyBaselineRef = useRef<{ key: string; baselineSteps: number }>({ key: '', baselineSteps: 0 });
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const userId = useAuthStore((state) => state.user?.id);

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
    try {
      const platform = Capacitor.getPlatform();

      if (platform !== 'android') {
        setPermissionStatus('unavailable');
        return;
      }

      const shouldAutoEnable = !hasAttemptedAutoEnableRef.current || permissionStatus !== 'granted';
      if (shouldAutoEnable) {
        hasAttemptedAutoEnableRef.current = true;
        if (options?.silent) {
          return;
        }
        const enabled = await connectDevice();
        if (!enabled) {
          return;
        }
      }

      let data;

      if (platform === 'android') {
        const profile = queryClient.getQueryData<User>(['profile']);
        data = await readAndroidSensorSteps(profile);
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

      if (options?.silent && fingerprint === lastSyncedFingerprintRef.current) {
        return;
      }

      await stepsService.syncHealth(data, buildSignedHeaders(String(userId ?? ''), data));
      lastSyncedFingerprintRef.current = fingerprint;

      const now = Date.now();
      const shouldSyncHourly = !options?.silent || now - lastHourlySyncAtRef.current >= HOURLY_SYNC_MIN_INTERVAL_MS;
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

          if (pendingWaypoints.waypoints.length > 0 && pendingWaypoints.date !== data.date) {
            await stepsService.syncHourly({
              date: pendingWaypoints.date,
              hourly: [],
              waypoints: pendingWaypoints.waypoints,
            });
            await DeviceStepCounter.clearPendingWaypoints().catch(() => ({ cleared: false }));
          }

          await stepsService.syncHourly({
            date: data.date,
            hourly: [{
              hour: hourlySnapshot.hour,
              steps: hourlySnapshot.steps,
              distance_km: hourlySnapshot.distance_km,
              calories: hourlySnapshot.calories,
            }],
            waypoints: pendingWaypoints.date === data.date ? pendingWaypoints.waypoints : [],
          });

          if (pendingWaypoints.waypoints.length > 0 && pendingWaypoints.date === data.date) {
            await DeviceStepCounter.clearPendingWaypoints().catch(() => ({ cleared: false }));
          }

          lastHourlySyncAtRef.current = now;
        } catch (hourlyError) {
          console.warn('Hourly/waypoint sync skipped:', hourlyError);
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
      if (!options?.silent) {
        showToast({ message: extractSyncErrorMessage(error), type: 'error' });
      }
    } finally {
      syncInFlightRef.current = false;
      setIsSyncing(false);
    }
  }, [connectDevice, permissionStatus, queryClient, showToast, userId]);

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

async function readAndroidSensorSteps(profile?: User) {
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

  const distanceMeters = steps * (strideCm / 100);
  const distance_km = steps > 0 ? parseFloat((distanceMeters / 1000).toFixed(2)) : null;

  // Dynamic MET estimate based on cadence + user weight for tighter calorie estimate.
  const cadenceForMet = cadenceSpm > 0 ? cadenceSpm : (steps > 0 ? Math.min(160, Math.max(60, steps / 60)) : 0);
  const met = cadenceForMet >= 130 ? 6.5 : cadenceForMet >= 110 ? 4.8 : cadenceForMet >= 90 ? 3.5 : 2.5;
  const active_minutes = steps > 0 ? Math.round(steps / 120) : null;
  const calories_active = active_minutes && active_minutes > 0
    ? Math.round((met * 3.5 * weightKg / 200) * active_minutes)
    : null;

  return {
    date: dateStr,
    source: 'device_sensor' as const,
    steps,
    distance_km,
    calories_active,
    active_minutes,
    cadence_spm: cadenceSpm,
    burst_steps_5s: burstSteps5s,
  };
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
