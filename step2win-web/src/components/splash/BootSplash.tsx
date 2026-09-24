import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Capacitor } from '@capacitor/core';
import { BrandMark, Wordmark } from '../brand/BrandMark';
import { hideNativeSplash } from '../../lib/nativeShell';
import { readRichMotion } from '../../lib/motion';
import { setBootSplashActive } from '../../lib/launchState';
import type { SplashController } from './splashMotion';

/**
 * In-app launch splash. It takes over from the native splash (same background, same logo,
 * same position, so the hand-off is invisible), animates while auth and the first screen load
 * underneath, and never holds the app back: ~1.5 s of motion, capped near 2 s in total.
 *
 * Only this small shell is in the main bundle. The choreography (anime.js) and the 3D mark
 * (Three.js) are separate chunks that load in parallel; if they are slow or WebGL is missing the
 * SVG mark animates instead, and with reduced motion or Data saver the splash is a quiet fade.
 */

/** Logo size in CSS px. Matches the native splash icon (res/drawable/splash_icon.xml). */
export const SPLASH_LOGO_PX = 96;
/** The 3D canvas is larger than the logo so tilting never clips (see splashScene.ts). */
const CANVAS_SCALE = 2.5;
const LAUNCH_KEY = 'launch_seen_v1';
/** Give the lazy chunks this long; after that the SVG / static version runs instead. */
const LOAD_DEADLINE_MS = 450;
/** Past this, the choreography would overrun the ~2 s cap: use the static version. */
const LATE_START_MS = 800;
/** Static version: a short beat so the brand registers, then fade. */
const STATIC_MIN_MS = 650;

// Page / brand tokens for each OS scheme (mirror index.css). Used only when the in-app theme
// differs from the OS one, so the first frame still matches the native splash exactly.
const SCHEME_TOKENS = {
  light: { '--bg-page': '45 14% 96.5%', '--brand': '158 74% 29%', '--brand-fg': '0 0% 100%', '--reward': '38 92% 50%' },
  dark: { '--bg-page': '200 14% 6.5%', '--brand': '156 56% 47%', '--brand-fg': '200 25% 7%', '--reward': '40 90% 58%' },
} as const;

export function shouldShowBootSplash(): boolean {
  try {
    return sessionStorage.getItem(LAUNCH_KEY) !== 'true';
  } catch {
    return true;
  }
}

type MotionModule = typeof import('./splashMotion');
type SceneModule = typeof import('../../lib/three/splashScene');
let motionChunk: Promise<MotionModule | null> | null = null;
let sceneChunk: Promise<SceneModule | null> | null = null;

/** Starts fetching the splash chunks; call as early as possible (main.tsx). */
export function preloadBootSplash() {
  if (!readRichMotion()) return;
  motionChunk ??= import('./splashMotion').catch(() => null);
  sceneChunk ??= import('../../lib/three/splashScene').catch(() => null);
}

function withDeadline<T>(promise: Promise<T | null>, ms: number): Promise<T | null> {
  return Promise.race([promise, new Promise<null>((resolve) => window.setTimeout(() => resolve(null), Math.max(0, ms)))]);
}

function schemeMismatch(): 'light' | 'dark' | null {
  if (!Capacitor.isNativePlatform()) return null;
  const osDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
  const attr = document.documentElement.getAttribute('data-theme');
  const appDark = attr === 'dark' || (attr !== 'light' && osDark);
  return osDark === appDark ? null : osDark ? 'dark' : 'light';
}

/**
 * Vertical centre of the logo. The native splash centres its icon on the physical screen, but on
 * Android the WebView starts out inset (system bars excluded) and only later goes edge-to-edge, so
 * '50%' of the viewport would sit ~40dp too high and then move. Anchoring to the screen keeps the
 * logo exactly where the native icon was, before and after the WebView resizes.
 */
function logoCentreY(): string {
  if (Capacitor.getPlatform() === 'android' && window.screen?.height > 0 && (window.screenY || 0) === 0) {
    return `${window.screen.height / 2}px`;
  }
  return '50%';
}

interface BootSplashProps {
  /** The app underneath is ready to be seen (auth restored, first screen mounted). */
  ready: boolean;
  onDone: () => void;
}

export function BootSplash({ ready, onDone }: BootSplashProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const logoRef = useRef<HTMLDivElement>(null);
  const svgWrapRef = useRef<HTMLDivElement>(null);
  const wordmarkRef = useRef<HTMLDivElement>(null);
  const taglineRef = useRef<HTMLParagraphElement>(null);
  const controllerRef = useRef<SplashController | null>(null);
  const readyRef = useRef(ready);
  const onDoneRef = useRef(onDone);
  readyRef.current = ready;
  onDoneRef.current = onDone;

  const [richAllowed] = useState(readRichMotion);
  const [mode, setMode] = useState<'pending' | 'rich' | 'static'>(richAllowed ? 'pending' : 'static');
  const [mismatch] = useState(schemeMismatch);
  const [schemeSynced, setSchemeSynced] = useState(() => mismatch === null);
  const [staticExit, setStaticExit] = useState(false);
  const [mountedAt] = useState(() => performance.now());
  const [centreY] = useState(logoCentreY);

  // Mount: mark the session, cover the app, and let the native splash go once we have painted.
  useEffect(() => {
    try {
      sessionStorage.setItem(LAUNCH_KEY, 'true');
    } catch {
      // Private mode: the splash simply shows again next time.
    }
    setBootSplashActive(true);
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => hideNativeSplash());
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      setBootSplashActive(false);
    };
  }, []);

  // In-app theme differs from the OS: start in the OS palette (what the native splash showed),
  // then ease into the app palette once the native splash has faded.
  useEffect(() => {
    if (schemeSynced) return;
    const timer = window.setTimeout(() => setSchemeSynced(true), 260);
    return () => window.clearTimeout(timer);
  }, [schemeSynced]);

  // Rich path: wait (briefly) for the chunks, then hand control to the choreography.
  useEffect(() => {
    if (!richAllowed || !schemeSynced) return;
    preloadBootSplash();
    let cancelled = false;
    let canvas: HTMLCanvasElement | null = null;

    (async () => {
      const budgetLeft = () => LOAD_DEADLINE_MS - (performance.now() - mountedAt);
      // Allow the palette cross-fade to finish before reading colours for the 3D mark.
      if (mismatch) await new Promise((resolve) => window.setTimeout(resolve, 380));
      const motion = await withDeadline(motionChunk ?? Promise.resolve(null), budgetLeft() + (mismatch ? 400 : 0));
      if (cancelled) return;
      if (!motion) {
        setMode('static');
        return;
      }
      const sceneModule = await withDeadline(sceneChunk ?? Promise.resolve(null), budgetLeft() + (mismatch ? 400 : 0));
      if (cancelled) return;
      // A busy main thread can fire the deadline late: never start the motion this far in.
      if (performance.now() - mountedAt > LATE_START_MS + (mismatch ? 400 : 0)) {
        setMode('static');
        return;
      }

      const root = rootRef.current;
      const logo = logoRef.current;
      const svgWrap = svgWrapRef.current;
      if (!root || !logo || !svgWrap || !backdropRef.current || !wordmarkRef.current || !taglineRef.current) return;

      let rig = null;
      if (sceneModule) {
        // Created imperatively: a canvas whose context was released can never be reused.
        canvas = document.createElement('canvas');
        const size = SPLASH_LOGO_PX * CANVAS_SCALE;
        const offset = (SPLASH_LOGO_PX - size) / 2;
        canvas.setAttribute('aria-hidden', 'true');
        canvas.style.cssText = `position:absolute;left:${offset}px;top:${offset}px;width:${size}px;height:${size}px;opacity:0;pointer-events:none;`;
        logo.appendChild(canvas);
        try {
          rig = sceneModule.createSplashScene(canvas, {
            logoPx: SPLASH_LOGO_PX,
            tokenScope: root,
            onContextLost: () => {
              // Show the SVG mark again; the timeline keeps running on its own values.
              svgWrap.style.opacity = '1';
              canvas?.remove();
            },
          });
        } catch {
          canvas.remove();
          canvas = null;
          rig = null;
        }
      }

      setMode('rich');
      controllerRef.current = motion.runSplashMotion(
        {
          root,
          backdrop: backdropRef.current,
          logo,
          svgWrap,
          canvas,
          lines: [wordmarkRef.current, taglineRef.current],
        },
        {
          logoPx: SPLASH_LOGO_PX,
          rig,
          elapsedMs: performance.now() - mountedAt,
          ready: readyRef.current,
          onDone: () => onDoneRef.current(),
        },
      );
    })();

    return () => {
      cancelled = true;
      controllerRef.current?.destroy();
      controllerRef.current = null;
      canvas?.remove();
    };
  }, [schemeSynced]);

  // Keep the choreography informed; it leaves as soon as it has played and the app is ready.
  useEffect(() => {
    controllerRef.current?.setReady(ready);
  }, [ready, mode]);

  // Static path (reduced motion, Data saver, or slow chunks): short beat, then a fade.
  useEffect(() => {
    if (mode !== 'static' || !ready || staticExit) return;
    const wait = Math.max(0, STATIC_MIN_MS - (performance.now() - mountedAt));
    const timer = window.setTimeout(() => setStaticExit(true), wait);
    return () => window.clearTimeout(timer);
  }, [mode, ready, staticExit]);

  useEffect(() => {
    if (!staticExit) return;
    const timer = window.setTimeout(() => onDoneRef.current(), 240);
    return () => window.clearTimeout(timer);
  }, [staticExit]);

  const schemeStyle = !schemeSynced && mismatch ? (SCHEME_TOKENS[mismatch] as CSSProperties) : undefined;
  const linesVisible = mode === 'static';

  return (
    <div
      ref={rootRef}
      className={[
        'boot-splash fixed inset-0 z-[300] select-none',
        mismatch ? 'boot-splash-sync' : '',
        staticExit ? 'pointer-events-none opacity-0 transition-opacity duration-normal ease-standard' : '',
      ].join(' ')}
      style={schemeStyle}
      role="status"
      aria-live="polite"
      aria-label="Step2Win is starting"
      onPointerDown={() => controllerRef.current?.hurry()}
    >
      <div ref={backdropRef} className="absolute inset-0 bg-bg-page" />
      <div
        ref={logoRef}
        className="absolute left-1/2"
        style={{
          top: centreY,
          width: SPLASH_LOGO_PX,
          height: SPLASH_LOGO_PX,
          marginLeft: -SPLASH_LOGO_PX / 2,
          marginTop: -SPLASH_LOGO_PX / 2,
        }}
      >
        <div ref={svgWrapRef} className="h-full w-full">
          <BrandMark size={SPLASH_LOGO_PX} className="block" />
        </div>
      </div>
      <div
        className="absolute inset-x-0 flex flex-col items-center px-6 text-center"
        style={{ top: `calc(${centreY} + ${SPLASH_LOGO_PX / 2 + 28}px)` }}
      >
        <div
          ref={wordmarkRef}
          className={linesVisible ? 'fade-in' : ''}
          style={linesVisible ? undefined : { opacity: 0 }}
        >
          <Wordmark className="text-title-lg" />
        </div>
        <p
          ref={taglineRef}
          className={['mt-1.5 text-callout text-text-secondary', linesVisible ? 'fade-in [animation-delay:80ms]' : ''].join(' ')}
          style={linesVisible ? undefined : { opacity: 0 }}
        >
          Walk daily. Take on challenges. Stay consistent.
        </p>
      </div>
    </div>
  );
}

export default BootSplash;
