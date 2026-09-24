import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { PREFS_KEY } from './components/settings/preferences';
import { initNativeShell } from './lib/nativeShell';
import { initBiometricLock } from './lib/biometricLock';
import { applyThemeMode, loadThemeMode } from './config/theme';
import { preloadBootSplash, shouldShowBootSplash } from './components/splash/BootSplash';

// Apply the in-app "reduce motion" preference before first paint (Settings keeps it in sync afterwards).
try {
  const prefs = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
  document.documentElement.classList.toggle('reduce-motion', prefs.reduceMotion === true);
} catch {
  // Ignore malformed preferences.
}

// Apply the saved theme before the first frame so the launch splash is painted in the right palette.
try {
  applyThemeMode(loadThemeMode());
} catch {
  // Storage unavailable: App applies the default theme.
}

// Start fetching the splash animation chunks while React renders the static first frame.
if (shouldShowBootSplash()) preloadBootSplash();

// Status bar, keyboard and splash handling on Android (no-op on the web).
initNativeShell();
// Arms the app lock before the first render so protected content never flashes.
initBiometricLock();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
