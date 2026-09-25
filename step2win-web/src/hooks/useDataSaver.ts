import { loadPreferences, usePreference } from '../components/settings/preferences';

/**
 * Data saver — one switch in Settings, applied everywhere the app spends mobile data:
 * - step sync: uploads after 300 new steps / every 5 min while walking (instead of 75 / 1 min),
 *   background every 60 min instead of 30 (challenge days stay at 15), route points skipped;
 *   resume / manual sync stay immediate (see useSmartStepSync and SyncPolicy.java)
 * - hourly uploads batched to every 30 minutes instead of every 5
 * - no automatic polling (React Query `refetchInterval`) — screens refresh on open, pull and resume
 * - live step updates socket paused
 * - activity maps show a "Load map" button instead of downloading tiles automatically
 * - smaller profile photo uploads
 */
export const STEP_SYNC_INTERVAL_MS = 30_000;
export const DATA_SAVER_STEP_SYNC_INTERVAL_MS = 5 * 60_000;
export const HOURLY_SYNC_INTERVAL_MS = 5 * 60_000;
export const DATA_SAVER_HOURLY_SYNC_INTERVAL_MS = 30 * 60_000;

export function isDataSaverOn(): boolean {
  return loadPreferences().dataSaver;
}

export function useDataSaver() {
  const dataSaver = usePreference('dataSaver');
  return {
    dataSaver,
    stepSyncIntervalMs: dataSaver ? DATA_SAVER_STEP_SYNC_INTERVAL_MS : STEP_SYNC_INTERVAL_MS,
    /** Pass a normal polling interval; returns `false` (no polling) while data saver is on. */
    pollInterval: (ms: number | false): number | false => (dataSaver ? false : ms),
  };
}

/** Polling interval for React Query that switches off instantly when data saver is enabled. */
export function usePollInterval(ms: number | false): number | false {
  const dataSaver = usePreference('dataSaver');
  return dataSaver ? false : ms;
}
