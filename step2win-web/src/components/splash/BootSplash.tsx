import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Capacitor } from '@capacitor/core';
import { hideNativeSplash } from '../../lib/nativeShell';
import { readRichMotion } from '../../lib/motion';
import { setBootSplashActive } from '../../lib/launchState';
import type { SplashController } from './splashMotion';

/**
 * In-app launch splash. It takes over from the native splash (same background, same logo,
 * same position, so the hand-off is invisible) and plays its own short story (~3.6 s of motion,
 * a ~0.45 s hold, then the hand-off; see splashMotion.ts) while auth and the first screen load
 * underneath. It never waits on anything beyond that timeline: if the app is not ready by then
 * the settled mark breathes gently until it is (at most 8 s). A tap skips to the settled mark.
 *
 * Only this small shell is in the main bundle. The choreography (anime.js) and the 3D mark
 * (Three.js) are separate chunks that load in parallel; if WebGL is missing the SVG mark tells
 * the same story, and with reduced motion or Data saver (or chunks that do not arrive in time)
 * the splash is a short static beat and a fade (~0.9 s).
 */

/** Logo size in CSS px. Matches the native splash icon (res/drawable/splash_icon.xml). */
export const SPLASH_LOGO_PX = 96;
/** The 3D canvas is larger than the logo so tilting never clips (see splashScene.ts). */
const CANVAS_SCALE = 2.5;
const LAUNCH_KEY = 'launch_seen_v1';
/**
 * Loading budgets, measured from mount. The logo holds still meanwhile (identical to the native
 * splash), so waiting is invisible. The small motion chunk gets the longest budget; the heavier
 * 3D scene is optional: if it's late, the same story plays on the SVG mark instead of falling
 * back to the static version (phones on a cold start rarely parse three.js in under a second).
 */
const MOTION_DEADLINE_MS = 1400;
const SCENE_DEADLINE_MS = 900;
/** A busy main thread can resolve the deadlines late: past this, use the static version. */
const LATE_START_MS = 1600;
/** Static version: a short beat so the brand registers, then fade. */
const STATIC_MIN_MS = 650;
/** Static version: leave even if the app never reports ready. */
const STATIC_SAFETY_MS = 8000;
/** Corner radius of the brand tile (rx 11 of 40), for clipping the light sweep. */
const TILE_RADIUS_PX = (SPLASH_LOGO_PX * 11) / 40;
const TAGLINE = 'Walk daily. Take on challenges. Stay consistent.';
/** Wordmark "Step2Win" split for the letter reveal; the numeral is in brand colour. */
const WORDMARK_LETTERS = 'Step2Win'.split('');

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

/**
 * The Step2Win mark, drawn exactly like BrandMark (and the native splash_icon.xml). At rest it
 * is the very same single stair path; for the no-WebGL choreography it swaps to the stroke split
 * into its three steps (plus a shadow each), so each step can lift on its own.
 */
function SplashMark({ size }: { size: number }) {
  const steps = ['M11 29h6.5v-6.5', 'M17.5 22.5H24V16', 'M24 16h6.5V9.5'];
  const stroke = { fill: 'none', strokeWidth: 3.4, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" className="block" aria-hidden>
      <rect width="40" height="40" rx="11" fill="hsl(var(--brand))" />
      <path d="M11 29h6.5v-6.5H24V16h6.5V9.5" {...stroke} stroke="hsl(var(--brand-fg))" data-stairs="" />
      {steps.map((d) => (
        <path key={`s${d}`} d={d} {...stroke} stroke="#000" opacity={0} transform="translate(0.9 1.2)" data-step-shadow="" />
      ))}
      {steps.map((d) => (
        <path key={d} d={d} {...stroke} stroke="hsl(var(--brand-fg))" opacity={0} data-step="" />
      ))}
      <circle cx="30.5" cy="9.5" r="2.6" fill="hsl(var(--reward))" data-ball="" />
    </svg>
  );
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
  const sheenRef = useRef<HTMLDivElement>(null);
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
      const budgetLeft = (deadline: number) => deadline - (performance.now() - mountedAt);
      // Allow the palette cross-fade to finish before reading colours for the 3D mark.
      if (mismatch) await new Promise((resolve) => window.setTimeout(resolve, 380));
      const motion = await withDeadline(motionChunk ?? Promise.resolve(null), budgetLeft(MOTION_DEADLINE_MS) + (mismatch ? 400 : 0));
      if (cancelled) return;
      if (!motion) {
        setMode('static');
        return;
      }
      // Late or missing 3D scene: sceneModule is null and the SVG version of the story plays.
      const sceneModule = await withDeadline(sceneChunk ?? Promise.resolve(null), budgetLeft(SCENE_DEADLINE_MS) + (mismatch ? 400 : 0));
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
          sheen: sheenRef.current,
          lines: [wordmarkRef.current, taglineRef.current],
          letters: Array.from(wordmarkRef.current.querySelectorAll<HTMLElement>('[data-letter]')),
          words: Array.from(taglineRef.current.querySelectorAll<HTMLElement>('[data-word]')),
        },
        {
          logoPx: SPLASH_LOGO_PX,
          rig,
          ready: readyRef.current,
          onExitStart: () => setBootSplashActive(false),
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
    if (mode !== 'static' || staticExit) return;
    const elapsed = performance.now() - mountedAt;
    const wait = ready ? Math.max(0, STATIC_MIN_MS - elapsed) : Math.max(0, STATIC_SAFETY_MS - elapsed);
    const timer = window.setTimeout(() => setStaticExit(true), wait);
    return () => window.clearTimeout(timer);
  }, [mode, ready, staticExit]);

  useEffect(() => {
    if (!staticExit) return;
    // The app underneath is being revealed: let it start its entrance.
    setBootSplashActive(false);
    const timer = window.setTimeout(() => onDoneRef.current(), 240);
    return () => window.clearTimeout(timer);
  }, [staticExit]);

  const schemeStyle = !schemeSynced && mismatch ? (SCHEME_TOKENS[mismatch] as CSSProperties) : undefined;
  const linesVisible = mode === 'static';
  // Letters and words stay hidden until the static fade or the choreography reveals them.
  const pieceStyle = linesVisible ? undefined : { opacity: 0 };

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
          <SplashMark size={SPLASH_LOGO_PX} />
        </div>
        {/* Light sweep across the settled mark, clipped to the tile. Parked off the tile until used. */}
        <div className="pointer-events-none absolute inset-0 overflow-hidden" style={{ borderRadius: TILE_RADIUS_PX }} aria-hidden>
          <div
            ref={sheenRef}
            className="absolute -inset-y-4 left-0"
            style={{
              width: SPLASH_LOGO_PX * 0.42,
              opacity: 0,
              transform: `translateX(${-SPLASH_LOGO_PX}px) skewX(-18deg)`,
              background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.34) 50%, transparent)',
            }}
          />
        </div>
      </div>
      <div
        className="absolute inset-x-0 flex flex-col items-center px-6 text-center"
        style={{ top: `calc(${centreY} + ${SPLASH_LOGO_PX / 2 + 28}px)` }}
      >
        <div ref={wordmarkRef} className={linesVisible ? 'fade-in' : ''}>
          {/* Same styling as <Wordmark>, one span per letter for the reveal. */}
          <span className="text-title-lg font-bold tracking-[-0.03em] text-text-primary">
            {WORDMARK_LETTERS.map((letter, i) => (
              <span
                key={i}
                data-letter=""
                className={['inline-block', letter === '2' ? 'text-brand' : ''].join(' ')}
                style={pieceStyle}
              >
                {letter}
              </span>
            ))}
          </span>
        </div>
        <p
          ref={taglineRef}
          className={['mt-1.5 text-callout text-text-secondary', linesVisible ? 'fade-in [animation-delay:80ms]' : ''].join(' ')}
        >
          {TAGLINE.split(' ').map((word, i, all) => (
            <span key={i}>
              <span data-word="" className="inline-block" style={pieceStyle}>
                {word}
              </span>
              {i < all.length - 1 ? ' ' : ''}
            </span>
          ))}
        </p>
      </div>
    </div>
  );
}

export default BootSplash;
