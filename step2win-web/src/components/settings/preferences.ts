import { useCallback, useEffect, useSyncExternalStore } from 'react';

/**
 * Local app preferences. Persisted under `app_preferences_v1` — MainLayout reads the
 * notification keys from the same storage, so the shape must stay stable.
 */
export type PreferencesState = {
  pushNotifications: boolean;
  challengeReminders: boolean;
  payoutAlerts: boolean;
  biometricsLock: boolean;
  reduceMotion: boolean;
  dataSaver: boolean;
};

export const PREFS_KEY = 'app_preferences_v1';
const PREFS_EVENT = 'app-preferences-change';

const DEFAULT_PREFERENCES: PreferencesState = {
  pushNotifications: true,
  challengeReminders: true,
  payoutAlerts: true,
  biometricsLock: false,
  reduceMotion: false,
  dataSaver: false,
};

function readPreferences(): PreferencesState {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return { ...DEFAULT_PREFERENCES };
    return { ...DEFAULT_PREFERENCES, ...(JSON.parse(raw) as Partial<PreferencesState>) };
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

// Cached snapshot so useSyncExternalStore gets a stable reference between changes.
let snapshot: PreferencesState | null = null;

export function loadPreferences(): PreferencesState {
  if (!snapshot) snapshot = readPreferences();
  return snapshot;
}

/** Persist one preference and notify every subscriber (hooks, services) immediately. */
export function savePreference<K extends keyof PreferencesState>(key: K, value: PreferencesState[K]) {
  const next = { ...loadPreferences(), [key]: value };
  snapshot = next;
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(next));
  } catch {
    // Storage full / unavailable: keep the in-memory value for this session.
  }
  window.dispatchEvent(new CustomEvent(PREFS_EVENT));
}

export function subscribePreferences(listener: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key !== PREFS_KEY) return;
    snapshot = readPreferences();
    listener();
  };
  window.addEventListener(PREFS_EVENT, listener);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(PREFS_EVENT, listener);
    window.removeEventListener('storage', onStorage);
  };
}

/** Shared, live preferences: every screen and hook sees a change the moment it's saved. */
export function usePreferences() {
  const preferences = useSyncExternalStore(subscribePreferences, loadPreferences, loadPreferences);

  useEffect(() => {
    document.documentElement.classList.toggle('reduce-motion', preferences.reduceMotion);
  }, [preferences.reduceMotion]);

  const setPreference = useCallback((key: keyof PreferencesState, value: boolean) => {
    savePreference(key, value);
  }, []);

  return { preferences, setPreference };
}

/** Subscribe to a single preference. */
export function usePreference<K extends keyof PreferencesState>(key: K): PreferencesState[K] {
  return useSyncExternalStore(
    subscribePreferences,
    () => loadPreferences()[key],
    () => loadPreferences()[key],
  );
}
