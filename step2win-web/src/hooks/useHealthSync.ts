import { useCallback, useEffect, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { useQueryClient } from '@tanstack/react-query';
import { stepsService } from '../services/api/steps';
import { useToast } from '../components/ui/Toast';
import { useAuthStore } from '../store/authStore';
import { v4 as uuidv4 } from 'uuid';
import CryptoJS from 'crypto-js';

const APP_SIGNING_SECRET = import.meta.env.VITE_APP_SIGNING_SECRET || '';

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
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const userId = useAuthStore((state) => state.user?.id);

  const connectDevice = useCallback(async (options?: { silent?: boolean }) => {
    const platform = Capacitor.getPlatform();

    if (platform !== 'android' && platform !== 'ios') {
      setPermissionStatus('unavailable');
      if (!options?.silent) {
        showToast({
          message: 'Device step permissions are only available in the mobile app.',
          type: 'error',
        });
      }
      return false;
    }

    setIsConnectingDevice(true);
    try {
      if (platform === 'android') {
        await ensureAndroidHealthPermissions();
      } else {
        await ensureAppleHealthPermissions();
      }

      setPermissionStatus('granted');
      if (!options?.silent) {
        showToast({ message: 'Device step access enabled.', type: 'success' });
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
  }, [showToast]);

  const runSyncHealth = useCallback(async (options?: { silent?: boolean }) => {
    setIsSyncing(true);
    try {
      const platform = Capacitor.getPlatform();

      if (platform === 'android' || platform === 'ios') {
        const shouldAutoEnable = !hasAttemptedAutoEnableRef.current || permissionStatus !== 'granted';
        if (shouldAutoEnable) {
          hasAttemptedAutoEnableRef.current = true;
          const enabled = await connectDevice({ silent: true });
          if (!enabled) {
            return;
          }
        }
      }

      let data;

      if (platform === 'android') {
        data = await readAndroidHealthConnect();
        setPermissionStatus('granted');
      } else if (platform === 'ios') {
        data = await readAppleHealth();
        setPermissionStatus('granted');
      } else {
        setPermissionStatus('unavailable');
        data = simulateData();
      }

      await stepsService.syncHealth(data, buildSignedHeaders(String(userId ?? ''), data));

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
      if (platform === 'android' || platform === 'ios') {
        setPermissionStatus('denied');
      }
      if (!options?.silent) {
        showToast({ message: extractSyncErrorMessage(error), type: 'error' });
      }
    } finally {
      setIsSyncing(false);
    }
  }, [connectDevice, permissionStatus, queryClient, showToast, userId]);

  const syncHealth = useCallback(() => runSyncHealth(), [runSyncHealth]);
  const syncHealthSilent = useCallback(() => runSyncHealth({ silent: true }), [runSyncHealth]);

  return { syncHealth, syncHealthSilent, connectDevice, isSyncing, isConnectingDevice, permissionStatus };
}

export function useAutoHealthSync(intervalMs: number = 180000) {
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

async function readAndroidHealthConnect() {
  const HealthConnect = await getHealthConnectModule();

  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);

  const startOfDay = start.toISOString();
  const endOfDay = end.toISOString();
  const dateStr = new Date().toISOString().split('T')[0];

  await ensureAndroidHealthPermissions();

  const timeRangeFilter = {
    operator: 'between',
    startTime: startOfDay,
    endTime: endOfDay,
  };

  const stepsRecords = await HealthConnect.readRecords({
    type: 'Steps',
    timeRangeFilter,
  }).catch(() => ({ records: [] }));

  const caloriesRecords = await HealthConnect.readRecords({
    type: 'ActiveCaloriesBurned',
    timeRangeFilter,
  }).catch(() => ({ records: [] }));

  const stepItems = Array.isArray((stepsRecords as any)?.records)
    ? (stepsRecords as any).records
    : [];
  const calorieItems = Array.isArray((caloriesRecords as any)?.records)
    ? (caloriesRecords as any).records
    : [];

  const steps = stepItems.reduce((sum: number, item: any) => {
    return sum + (Number(item?.count) || 0);
  }, 0);

  const calories_active = calorieItems.length
    ? Math.round(
        calorieItems.reduce((sum: number, item: any) => {
          return sum + (Number(item?.energy?.value) || 0);
        }, 0)
      )
    : null;

  const distance_km = steps > 0 ? parseFloat((steps * 0.0008).toFixed(2)) : null;
  const active_minutes = steps > 0 ? Math.floor(steps / 100) : null;

  return { date: dateStr, source: 'google_fit' as const, steps, distance_km, calories_active, active_minutes };
}

async function readAppleHealth() {
  const HealthKit = await getHealthKitModule();

  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);

  const startOfDay = start.toISOString();
  const endOfDay = end.toISOString();
  const dateStr = new Date().toISOString().split('T')[0];

  await ensureAppleHealthPermissions();

  const steps = await HealthKit.getStatisticsQuantity({
    identifier: 'HKQuantityTypeIdentifierStepCount',
    startDate: startOfDay,
    endDate: endOfDay,
    unit: 'count',
  }).then((r: any) => Math.round(r.quantity ?? 0)).catch(() => 0);

  const distance_km = await HealthKit.getStatisticsQuantity({
    identifier: 'HKQuantityTypeIdentifierDistanceWalkingRunning',
    startDate: startOfDay,
    endDate: endOfDay,
    unit: 'km',
  }).then((r: any) => (r.quantity ? parseFloat(r.quantity.toFixed(2)) : null)).catch(() => null);

  const calories_active = await HealthKit.getStatisticsQuantity({
    identifier: 'HKQuantityTypeIdentifierActiveEnergyBurned',
    startDate: startOfDay,
    endDate: endOfDay,
    unit: 'kcal',
  }).then((r: any) => (r.quantity ? Math.round(r.quantity) : null)).catch(() => null);

  const active_minutes = await HealthKit.getStatisticsQuantity({
    identifier: 'HKQuantityTypeIdentifierAppleExerciseTime',
    startDate: startOfDay,
    endDate: endOfDay,
    unit: 'min',
  }).then((r: any) => (r.quantity ? Math.round(r.quantity) : null)).catch(() => null);

  return { date: dateStr, source: 'apple_health' as const, steps, distance_km, calories_active, active_minutes };
}

function simulateData() {
  const steps = Math.floor(Math.random() * 8000) + 2000;
  return {
    date: new Date().toISOString().split('T')[0],
    source: 'manual' as const,
    steps,
    distance_km: parseFloat((steps * 0.0008).toFixed(2)),
    calories_active: Math.floor(steps * 0.04),
    active_minutes: Math.floor(steps / 100),
  };
}

async function getHealthConnectModule() {
  try {
    const moduleName = 'capacitor-health-connect';
    const mod = await import(/* @vite-ignore */ moduleName);
    return mod.HealthConnect;
  } catch {
    throw new Error('Health Connect is not available on this device.');
  }
}

async function ensureAndroidHealthPermissions() {
  const HealthConnect = await getHealthConnectModule();
  try {
    await HealthConnect.requestHealthPermissions({
      read: ['Steps', 'ActiveCaloriesBurned'],
      write: [],
    });
  } catch {
    throw new Error('Device step permission is required. Please allow access to continue.');
  }
}

async function getHealthKitModule() {
  try {
    const moduleName = '@capacitor-community/health-kit';
    const mod = await import(/* @vite-ignore */ moduleName);
    return mod.HealthKit;
  } catch {
    throw new Error('Apple Health is not available on this device.');
  }
}

async function ensureAppleHealthPermissions() {
  const HealthKit = await getHealthKitModule();
  try {
    await HealthKit.requestAuthorization({
      read: [
        'HKQuantityTypeIdentifierStepCount',
        'HKQuantityTypeIdentifierDistanceWalkingRunning',
        'HKQuantityTypeIdentifierActiveEnergyBurned',
        'HKQuantityTypeIdentifierAppleExerciseTime',
      ],
    });
  } catch {
    throw new Error('Device step permission is required. Please allow access to continue.');
  }
}
