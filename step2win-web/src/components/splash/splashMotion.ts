import { animate, createTimeline, cubicBezier, stagger, type Timeline } from 'animejs';
import type { SplashRig } from '../../lib/three/splashScene';

/**
 * Boot splash choreography (lazy chunk). The story in ~1.5 s: the flat logo tilts into 3D,
 * the stair stroke stands up as three real steps, the reward dot hops down to the first step
 * and climbs back up, step by step, to its place at the top; the mark settles flat again and
 * hands off to the app. Runs on a Three.js rig when available, otherwise on the SVG itself.
 */

export interface SplashElements {
  root: HTMLElement;
  /** Opaque background layer (faded separately so the logo can fly to its next position). */
  backdrop: HTMLElement;
  /** Fixed-size logo box, exactly centred in the viewport. */
  logo: HTMLElement;
  /** Wrapper around the SVG BrandMark inside `logo`. */
  svgWrap: HTMLElement;
  canvas: HTMLCanvasElement | null;
  /** Wordmark and tagline, revealed in order. */
  lines: HTMLElement[];
}

export interface SplashController {
  setReady: (ready: boolean) => void;
  /** User tapped: play the rest quickly (only once the app is ready). */
  hurry: () => void;
  destroy: () => void;
}

interface Options {
  logoPx: number;
  rig: SplashRig | null;
  /** Time already spent since the splash mounted (chunk loading); the timeline compresses to fit. */
  elapsedMs: number;
  ready: boolean;
  onDone: () => void;
}

const ease = {
  standard: cubicBezier(0.2, 0, 0, 1),
  enter: cubicBezier(0.05, 0.7, 0.1, 1),
  exit: cubicBezier(0.3, 0, 0.8, 0.15),
};

/** Whole splash, including the exit, should stay within this. */
const CAP_MS = 1900;
const EXIT_MS = 340;
const HOLD_MS = 0;
/** Authored length of the main timeline at speed 1. */
const TIMELINE_MS = 1700;
/** Played a little faster than authored (~1.5 s); compressed further, up to MAX_SPEED, to fit CAP_MS. */
const BASE_SPEED = 1.15;
/** Never exceed this when compressing (anything faster reads as a glitch). */
const MAX_SPEED = 1.6;
/** If the app never reports ready, leave anyway. */
const SAFETY_MS = 8000;

// Ball positions in the SVG's own 40x40 space (y down), mirrored by the 3D rig (y up, centred).
const SVG_TREADS: Array<[number, number]> = [
  [14.25, 24.7],
  [20.75, 18.2],
  [27.25, 11.7],
];
const SVG_HOME: [number, number] = [30.5, 9.5];

export function runSplashMotion(els: SplashElements, options: Options): SplashController {
  const { rig, onDone } = options;
  let ready = options.ready;
  let timelineDone = false;
  let exiting = false;
  let destroyed = false;
  let anchor: HTMLElement | null = null;
  const running: Array<{ revert?: () => unknown; pause: () => unknown }> = [];

  const budget = CAP_MS - EXIT_MS - HOLD_MS - options.elapsedMs;
  const speed = Math.min(MAX_SPEED, Math.max(BASE_SPEED, TIMELINE_MS / Math.max(budget, 1)));

  const tl: Timeline = createTimeline({
    autoplay: false,
    playbackRate: speed,
    onUpdate: () => rig?.render(),
    onComplete: () => {
      timelineDone = true;
      if (HOLD_MS > 0) window.setTimeout(maybeExit, HOLD_MS);
      else maybeExit();
    },
  });
  running.push(tl);

  if (rig) buildRigTimeline(tl, rig);
  else buildSvgTimeline(tl, els);

  // Wordmark + tagline rise in as the mark settles.
  tl.add(
    els.lines,
    { opacity: [0, 1], translateY: [10, 0], duration: 420, ease: ease.enter, delay: stagger(80) },
    1100,
  );

  if (rig) {
    // First frame is the flat pose, identical to the SVG: swap without a visible change.
    rig.render();
    els.canvas!.style.opacity = '1';
    els.svgWrap.style.opacity = '0';
    // Back to the crisp SVG for the hand-off.
    tl.set(els.svgWrap, { opacity: 1 }, 1560);
    tl.add(els.canvas!, { opacity: 0, duration: 140, ease: 'linear' }, 1560);
  }

  tl.play();

  const safety = window.setTimeout(() => {
    ready = true;
    timelineDone = true;
    maybeExit();
  }, SAFETY_MS);

  function maybeExit() {
    if (destroyed || exiting || !timelineDone || !ready) return;
    exiting = true;
    window.clearTimeout(safety);
    rig?.dispose();
    els.root.style.pointerEvents = 'none';
    anchor = findAnchor();
    if (anchor) flyToAnchor(anchor);
    else zoomOut();
  }

  /** Shared-element hand-off: the logo lands exactly on the screen's own brand mark. */
  function flyToAnchor(target: HTMLElement) {
    const from = els.logo.getBoundingClientRect();
    const to = target.getBoundingClientRect();
    const dx = to.left + to.width / 2 - (from.left + from.width / 2);
    const dy = to.top + to.height / 2 - (from.top + from.height / 2);
    target.style.visibility = 'hidden';
    const lines = animate(els.lines, { opacity: 0, duration: 160, ease: ease.exit });
    const bg = animate(els.backdrop, { opacity: 0, duration: 280, delay: 40, ease: ease.standard });
    const fly = animate(els.logo, {
      translateX: dx,
      translateY: dy,
      scale: to.width / options.logoPx,
      duration: EXIT_MS,
      ease: ease.standard,
      onComplete: finish,
    });
    running.push(lines, bg, fly);
  }

  /** No matching mark underneath (e.g. Home): the mark eases forward as the app fades in. */
  function zoomOut() {
    const lines = animate(els.lines, { opacity: 0, duration: 160, ease: ease.exit });
    const logo = animate(els.logo, { scale: 1.08, opacity: 0, duration: 300, ease: ease.standard });
    const bg = animate(els.backdrop, { opacity: 0, duration: 300, delay: 20, ease: ease.standard, onComplete: finish });
    running.push(lines, logo, bg);
  }

  function finish() {
    if (destroyed) return;
    if (anchor) anchor.style.visibility = '';
    onDone();
  }

  return {
    setReady(next) {
      ready = next;
      maybeExit();
    },
    hurry() {
      if (!ready || exiting) return;
      tl.speed = Math.max(tl.speed, 3);
      if (timelineDone) maybeExit();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      window.clearTimeout(safety);
      running.forEach((a) => a.pause());
      if (anchor) anchor.style.visibility = '';
      rig?.dispose();
    },
  };
}

/** Finds a visible brand mark on the screen underneath to hand the logo to. */
function findAnchor(): HTMLElement | null {
  const candidates = Array.from(document.querySelectorAll<HTMLElement>('.splash-anchor'));
  for (const el of candidates) {
    const rect = el.getBoundingClientRect();
    const visible =
      rect.width > 8 && rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
    if (visible) return el;
  }
  return null;
}

function buildRigTimeline(tl: Timeline, rig: SplashRig) {
  // Imported lazily with the rig; values mirrored here to keep this module free of three.js.
  const REST = 1.2;
  const UP = 8.5;
  const s = rig.state;
  const treads: Array<[number, number]> = SVG_TREADS.map(([x, y]) => [x - 20, 20 - y]);
  const home: [number, number] = [SVG_HOME[0] - 20, 20 - SVG_HOME[1]];

  // 1. Tilt into three-quarter view with a slight push-in; the steps stand up one by one.
  tl.add(s, { tiltX: -0.55, tiltY: 0.62, dolly: 0.9, duration: 560, ease: ease.standard }, 0);
  tl.add(s, { step0: UP, duration: 420, ease: 'outBack(1.3)' }, 60);
  tl.add(s, { step1: UP, duration: 420, ease: 'outBack(1.3)' }, 130);
  tl.add(s, { step2: UP, duration: 420, ease: 'outBack(1.3)' }, 200);

  // 2. The dot hops down to the first step…
  tl.add(s, { ballX: treads[0][0], ballDepth: 0.5, duration: 420, ease: 'inOutSine' }, 120);
  tl.add(s, { ballY: [{ to: home[1] + 5, duration: 160, ease: 'outQuad' }, { to: treads[0][1], duration: 260, ease: 'inQuad' }] }, 120);
  tl.add(s, { ballSquash: [{ to: 0.7, duration: 70, ease: 'outQuad' }, { to: 1, duration: 200, ease: 'outBack(2)' }] }, 540);

  // 3. …and climbs back up, one step at a time.
  const stops = [treads[1], treads[2], home];
  stops.forEach(([x, y], i) => {
    const from = i === 0 ? treads[0] : stops[i - 1];
    const start = 660 + i * 220;
    const peak = Math.max(from[1], y) + 4;
    tl.add(s, { ballX: x, duration: 220, ease: 'inOutSine' }, start);
    tl.add(s, { ballY: [{ to: peak, duration: 110, ease: 'outQuad' }, { to: y, duration: 110, ease: 'inQuad' }] }, start);
    tl.add(s, { ballSquash: [{ to: 0.8, duration: 60, ease: 'outQuad' }, { to: 1, duration: 160, ease: 'outBack(2)' }] }, start + 220);
  });
  tl.add(s, { ballDepth: 1, duration: 220, ease: 'inOutSine' }, 1100);

  // 4. Settle back into the flat mark.
  tl.add(s, { tiltX: 0, tiltY: 0, dolly: 1, duration: 480, ease: ease.standard }, 1100);
  tl.add(s, { step2: REST, duration: 380, ease: 'inOutCubic' }, 1120);
  tl.add(s, { step1: REST, duration: 380, ease: 'inOutCubic' }, 1160);
  tl.add(s, { step0: REST, duration: 380, ease: 'inOutCubic' }, 1200);
}

/** Same story without WebGL: a CSS 3D tilt of the SVG mark and the dot hopping along the stroke. */
function buildSvgTimeline(tl: Timeline, els: SplashElements) {
  const ball = els.svgWrap.querySelector('circle');
  els.logo.style.perspective = '420px';

  tl.add(els.svgWrap, { rotateX: 26, rotateY: -30, scale: 1.04, duration: 560, ease: ease.standard }, 0);
  if (ball) {
    tl.add(ball, { cx: SVG_TREADS[0][0], duration: 420, ease: 'inOutSine' }, 120);
    tl.add(ball, { cy: [{ to: SVG_HOME[1] - 5, duration: 160, ease: 'outQuad' }, { to: SVG_TREADS[0][1], duration: 260, ease: 'inQuad' }] }, 120);
    const stops = [SVG_TREADS[1], SVG_TREADS[2], SVG_HOME];
    stops.forEach(([x, y], i) => {
      const from = i === 0 ? SVG_TREADS[0] : stops[i - 1];
      const start = 660 + i * 220;
      const peak = Math.min(from[1], y) - 4;
      tl.add(ball, { cx: x, duration: 220, ease: 'inOutSine' }, start);
      tl.add(ball, { cy: [{ to: peak, duration: 110, ease: 'outQuad' }, { to: y, duration: 110, ease: 'inQuad' }] }, start);
    });
  }
  tl.add(els.svgWrap, { rotateX: 0, rotateY: 0, scale: 1, duration: 480, ease: ease.standard }, 1100);
  // Pad to the same length as the 3D version so the hand-off timing is identical.
  tl.add(els.svgWrap, { opacity: 1, duration: 140 }, 1560);
}
