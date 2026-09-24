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

// Matches --bg-page in index.css so the browser chrome / status bar blends with the app.
const THEME_COLORS = { light: '#F6F5F2', dark: '#0F1112' } as const;

function syncThemeColorMeta(resolved: 'light' | 'dark' | null) {
  document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((meta) => {
    if (resolved) {
      meta.content = THEME_COLORS[resolved];
    } else {
      // System mode: restore each tag's media-matched colour.
      meta.content = meta.media.includes('dark') ? THEME_COLORS.dark : THEME_COLORS.light;
    }
  });
}

export function applyThemeMode(mode: ThemeMode) {
  const root = document.documentElement;
  if (mode === 'system') {
    root.removeAttribute('data-theme');
    root.style.colorScheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    syncThemeColorMeta(null);
    return;
  }

  root.setAttribute('data-theme', mode);
  root.style.colorScheme = mode;
  syncThemeColorMeta(mode);
}

export function isDarkMode(mode: ThemeMode) {
  if (mode === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  }
  return mode === 'dark';
}
