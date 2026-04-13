export type ThemeMode = 'system' | 'light' | 'dark';

const THEME_MODE_KEY = 'theme_mode_v1';

export function loadThemeMode(): ThemeMode {
  const stored = localStorage.getItem(THEME_MODE_KEY);
  if (stored === 'light' || stored === 'dark' || stored === 'system') {
    return stored;
  }
  return 'system';
}

export function saveThemeMode(mode: ThemeMode) {
  localStorage.setItem(THEME_MODE_KEY, mode);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('theme-mode-change', { detail: mode }));
  }
}

export function applyThemeMode(mode: ThemeMode) {
  const root = document.documentElement;
  if (mode === 'system') {
    root.removeAttribute('data-theme');
    root.style.colorScheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    return;
  }

  root.setAttribute('data-theme', mode);
  root.style.colorScheme = mode;
}

export function isDarkMode(mode: ThemeMode) {
  if (mode === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  }
  return mode === 'dark';
}
