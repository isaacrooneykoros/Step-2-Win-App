import { useCallback, useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { useQueryClient } from '@tanstack/react-query';
import { stepsService } from '../services/api/steps';
import { useToast } from '../components/ui/Toast';
import { v4 as uuidv4 } from 'uuid';

/**
 * Fetches a single-use server-issued nonce before each sync request.
 *
 * Why: the previous approach embedded APP_SIGNING_SECRET as a VITE_ env
 * variable, which means it is compiled into the JS bundle and visible to
 * anyone who decompiles the APK. A server-held nonce is never shipped in
 * the client, making each sync request non-replayable.
 *
 * The nonce is stored on the server (Redis, 120 s TTL) and consumed on
 * first use — a second identical request is rejected.
 */
async function fetchSyncNonce(): Promise<string | null> {
  try {
    const result = await stepsService.getSyncNonce();
    return result.nonce;
  } catch {
    // If the nonce endpoint fails (e.g. network blip), continue without it.
    // The server-side middleware degrades gracefully when Redis is unavailable.
    return null;
  }
}

function buildSyncHeaders(nonce: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    'X-Idempotency-Key': uuidv4(),
  };
  if (nonce) {
    headers['X-Sync-Nonce'] = nonce;
  }
  return headers;
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
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  const runSyncHealth = useCallback(async (options?: { silent?: boolean }) => {
    setIsSyncing(true);
    try {
      const platform = Capacitor.getPlatform();
      let data;

      if (platform === 'android') {
        data = await readAndroidHealthConnect();
      } else if (platform === 'ios') {
        data = await readAppleHealth();
      } else {
        data = simulateData();
      }

      // Fetch a server-issued nonce before each sync.  The nonce is stored in
      // Redis (120 s TTL) and consumed on first use — preventing replay attacks
      // without embedding any secret in the client bundle.
      const nonce = await fetchSyncNonce();
      await stepsService.syncHealth(data, buildSyncHeaders(nonce));

      await queryClient.invalidateQueries({ queryKey: ['health'] });
      await queryClient.invalidateQueries({ queryKey: ['steps'] });
      await queryClient.invalidateQueries({ queryKey: ['challenges'] });
      await queryClient.invalidateQueries({ queryKey: ['profile'] });

      if (!options?.silent) {
        showToast({ message: 'Steps synced!', type: 'success' });
      }
    } catch (error) {
      console.error('Sync error:', error);
      if (!options?.silent) {
        showToast({ message: extractSyncErrorMessage(error), type: 'error' });
      }
    } finally {
      setIsSyncing(false);
    }
  }, [queryClient, showToast]);

  const syncHealth = useCallback(() => runSyncHealth(), [runSyncHealth]);
  const syncHealthSilent = useCallback(() => runSyncHealth({ silent: true }), [runSyncHealth]);

  return { syncHealth, syncHealthSilent, isSyncing };
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
  let HealthConnect: any;
  try {
    const moduleName = 'capacitor-health-connect';
    const mod = await import(/* @vite-ignore */ moduleName);
    HealthConnect = mod.HealthConnect;
  } catch {
    return simulateData();
  }

  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);

  const startOfDay = start.toISOString();
  const endOfDay = end.toISOString();
  const dateStr = new Date().toISOString().split('T')[0];

  try {
    await HealthConnect.requestHealthPermissions({
      read: ['Steps', 'ActiveCaloriesBurned'],
      write: [],
    });
  } catch {
    return simulateData();
  }

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

  // When Health Connect does not report distance, omit it rather than estimating.
  // The server anti-cheat uses distance as one signal; an omitted value is safer
  // than a value derived from a fixed stride length that varies widely across users.
  const distance_km = null;
  const active_minutes = steps > 0 ? Math.floor(steps / 100) : null;

  return { date: dateStr, source: 'google_fit' as const, steps, distance_km, calories_active, active_minutes };
}

async function readAppleHealth() {
  let HealthKit: any;
  try {
    const moduleName = '@capacitor-community/health-kit';
    const mod = await import(/* @vite-ignore */ moduleName);
    HealthKit = mod.HealthKit;
  } catch {
    return simulateData();
  }

  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);

  const startOfDay = start.toISOString();
  const endOfDay = end.toISOString();
  const dateStr = new Date().toISOString().split('T')[0];

  await HealthKit.requestAuthorization({
    read: [
      'HKQuantityTypeIdentifierStepCount',
      'HKQuantityTypeIdentifierDistanceWalkingRunning',
      'HKQuantityTypeIdentifierActiveEnergyBurned',
      'HKQuantityTypeIdentifierAppleExerciseTime',
    ],
  });

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
    distance_km: null,  // Do not estimate — varies too much per user stride length
    calories_active: Math.floor(steps * 0.04),
    active_minutes: Math.floor(steps / 100),
  };
}
