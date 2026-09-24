/**
 * Theme preference. Stored in localStorage under `s2w_admin_theme` and applied
 * as <html data-theme="light|dark|system">. index.html applies the saved value
 * before first paint; this store keeps React in sync and persists changes.
 */
import { create } from 'zustand'

export type ThemePreference = 'light' | 'dark' | 'system'

const STORAGE_KEY = 's2w_admin_theme'

function readPreference(): ThemePreference {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved === 'light' || saved === 'dark' || saved === 'system') return saved
  } catch {
    // storage unavailable (private mode) — fall through to default
  }
  return 'light'
}

function apply(pref: ThemePreference) {
  if (typeof document !== 'undefined') document.documentElement.setAttribute('data-theme', pref)
}

interface ThemeState {
  preference: ThemePreference
  setPreference: (pref: ThemePreference) => void
}

export const useThemeStore = create<ThemeState>((set) => {
  const initial = readPreference()
  apply(initial)
  return {
    preference: initial,
    setPreference: (pref) => {
      try {
        localStorage.setItem(STORAGE_KEY, pref)
      } catch {
        // ignore — the choice still applies for this session
      }
      apply(pref)
      set({ preference: pref })
    },
  }
})

/** Resolved theme ('light' | 'dark') for code that must branch (rare — prefer CSS variables). */
export function resolveTheme(pref: ThemePreference): 'light' | 'dark' {
  if (pref !== 'system') return pref
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}
