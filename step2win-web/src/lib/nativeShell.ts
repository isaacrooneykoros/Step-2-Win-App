import { Capacitor, SystemBars, SystemBarsStyle } from '@capacitor/core';
import { SplashScreen } from '@capacitor/splash-screen';
import { Keyboard } from '@capacitor/keyboard';

/**
 * Native chrome around the WebView: system bar icon colours that follow the in-app theme,
 * keyboard handling and splash timing. No-ops on the web.
 *
 * Capacitor 8 / Android 15+ (targetSdk 36) always draw edge-to-edge, so bar background colours
 * can no longer be set: the page background shows through and the layout pads itself with
 * env(safe-area-inset-*) (SystemBars injects --safe-area-inset-* for older WebViews). Same on iOS.
 */

const isNative = () => Capacitor.isNativePlatform();

let splashHidden = false;

/** Hide the launch splash (called once auth state is restored). Safe to call repeatedly. */
export function hideNativeSplash() {
  if (!isNative() || splashHidden) return;
  splashHidden = true;
  SplashScreen.hide({ fadeOutDuration: 200 }).catch(() => null);
}

function resolvedTheme(): 'light' | 'dark' {
  const attr = document.documentElement.getAttribute('data-theme');
  if (attr === 'dark' || attr === 'light') return attr;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

let lastApplied: string | null = null;

async function syncStatusBar() {
  const theme = resolvedTheme();
  if (theme === lastApplied) return;
  lastApplied = theme;
  try {
    // SystemBarsStyle.Dark = light icons (for a dark background) and vice versa.
    await SystemBars.setStyle({ style: theme === 'dark' ? SystemBarsStyle.Dark : SystemBarsStyle.Light });
  } catch {
    lastApplied = null;
  }
}

function initKeyboard() {
  const root = document.documentElement;
  Keyboard.addListener('keyboardWillShow', (info) => {
    root.classList.add('keyboard-open');
    root.style.setProperty('--keyboard-height', `${info.keyboardHeight}px`);
  }).catch(() => null);
  Keyboard.addListener('keyboardDidShow', () => {
    // adjustResize shrinks the WebView; make sure the focused field is still in view.
    const active = document.activeElement as HTMLElement | null;
    if (active && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) {
      active.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }).catch(() => null);
  Keyboard.addListener('keyboardWillHide', () => {
    root.classList.remove('keyboard-open');
    root.style.removeProperty('--keyboard-height');
  }).catch(() => null);
}

export function initNativeShell() {
  if (!isNative()) return;

  void syncStatusBar();
  // Theme changes: Settings toggles data-theme / style on <html>; "System" follows the OS.
  new MutationObserver(() => void syncStatusBar()).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme', 'style'],
  });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => void syncStatusBar());

  initKeyboard();

  // Safety net: never leave the splash up if startup stalls.
  window.setTimeout(hideNativeSplash, 6000);
}
