import { useEffect, useRef, useState } from 'react';
import { loadPreferences, usePreference } from '../components/settings/preferences';

/**
 * Motion tokens. Mirrors the CSS custom properties in index.css so JS-driven
 * animation (count-ups, SVG progress) stays in step with CSS transitions.
 */
export const duration = {
  instant: 80,
  fast: 150,
  normal: 240,
  deliberate: 420,
  /** Progress rings / count-ups: long enough to read, short enough not to wait on. */
  data: 900,
} as const;

export const easing = {
  standard: 'cubic-bezier(0.2, 0, 0, 1)',
  enter: 'cubic-bezier(0.05, 0.7, 0.1, 1)',
  exit: 'cubic-bezier(0.3, 0, 0.8, 0.15)',
  spring: 'cubic-bezier(0.34, 1.36, 0.64, 1)',
} as const;

/** Ease-out cubic, used for numeric interpolation. */
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

export function readReducedMotion(): boolean {
  if (typeof window === 'undefined') return false;
  if (document.documentElement.classList.contains('reduce-motion')) return true;
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

/**
 * Rich motion (3D scenes, choreographed sequences) runs only when neither reduced motion
 * (OS or in-app) nor Data saver is on. Otherwise screens show static / minimal-fade versions.
 */
export function readRichMotion(): boolean {
  return !readReducedMotion() && !loadPreferences().dataSaver;
}

/** True when the OS or the in-app setting asks for reduced motion. */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(readReducedMotion);

  useEffect(() => {
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(readReducedMotion());
    media?.addEventListener?.('change', update);
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => {
      media?.removeEventListener?.('change', update);
      observer.disconnect();
    };
  }, []);

  return reduced;
}

/** Live version of `readRichMotion` for components. */
export function useRichMotion(): boolean {
  const reduced = usePrefersReducedMotion();
  const dataSaver = usePreference('dataSaver');
  return !reduced && !dataSaver;
}

/**
 * Animates from the previously displayed value to `target`.
 * Only ever interpolates between real values — the first render starts at 0
 * unless `startFromTarget` is set (useful when the value is already known from cache).
 */
export function useCountUp(target: number, options: { duration?: number; startFromTarget?: boolean } = {}): number {
  const { duration: ms = duration.data, startFromTarget = false } = options;
  const reduced = usePrefersReducedMotion();
  const [value, setValue] = useState(startFromTarget ? target : 0);
  // Last value actually painted. Interrupted animations (new data, StrictMode's
  // mount→unmount→mount) resume from here instead of jumping or stalling.
  const shownRef = useRef(startFromTarget ? target : 0);

  useEffect(() => {
    const safeTarget = Number.isFinite(target) ? target : 0;
    if (reduced || ms <= 0) {
      shownRef.current = safeTarget;
      setValue(safeTarget);
      return;
    }

    const from = shownRef.current;
    if (from === safeTarget) {
      setValue(safeTarget);
      return;
    }

    let frame = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / ms);
      const next = t >= 1 ? safeTarget : from + (safeTarget - from) * easeOut(t);
      shownRef.current = next;
      setValue(next);
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, ms, reduced]);

  return value;
}
