import { useSyncExternalStore } from 'react';

/**
 * Tiny shared state for the first seconds of a session: whether the animated boot splash is
 * still covering the app (it turns false as soon as the splash starts its hand-off, so screens
 * can enter while it leaves) and whether the onboarding overlay is open. Screens underneath use it
 * to hold back their own entrance motion and prompts until they are actually visible.
 */
type LaunchState = {
  bootSplashActive: boolean;
  onboardingOpen: boolean;
};

let state: LaunchState = { bootSplashActive: false, onboardingOpen: false };
const listeners = new Set<() => void>();

function set(patch: Partial<LaunchState>) {
  const next = { ...state, ...patch };
  if (next.bootSplashActive === state.bootSplashActive && next.onboardingOpen === state.onboardingOpen) return;
  state = next;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const setBootSplashActive = (active: boolean) => set({ bootSplashActive: active });
export const setOnboardingOpen = (open: boolean) => set({ onboardingOpen: open });
export const isBootSplashActive = () => state.bootSplashActive;

export function useBootSplashActive(): boolean {
  return useSyncExternalStore(subscribe, () => state.bootSplashActive, () => false);
}

export function useOnboardingOpen(): boolean {
  return useSyncExternalStore(subscribe, () => state.onboardingOpen, () => false);
}
