import { animate, createTimeline, cubicBezier, stagger, utils, type JSAnimation, type Timeline } from 'animejs';
import type { SplashRig } from '../../lib/three/splashScene';

/**
 * Boot splash choreography (lazy chunk). The story, ~3.6 s at normal speed:
 *
 *   0–220      the flat logo (identical to the native splash) draws a small breath in
 *   180–1000   it tilts into a three-quarter view while the three steps stand up, one by one
 *   1120–1780  the amber dot crouches, hops off its perch and drops onto the first step
 *   1900–2740  it climbs back up, one step at a time, crouching before each hop
 *   2640–3240  the mark turns flat again and the steps sink back into the logo
 *   2700–3610  the wordmark types in letter by letter, the tagline word by word,
 *              and a soft light sweeps across the settled mark
 *
 * then holds on the settled logo (HOLD_MS) and hands off to the app. Runs on a Three.js rig
 * when available, otherwise on the SVG itself with the same timings.
 */

export interface SplashElements {
  root: HTMLElement;
  /** Opaque background layer (faded separately so the logo can fly to its next position). */
  backdrop: HTMLElement;
  /** Fixed-size logo box, exactly where the native splash icon was. */
  logo: HTMLElement;
  /** Wrapper around the SVG mark inside `logo`. */
  svgWrap: HTMLElement;
  canvas: HTMLCanvasElement | null;
  /** Light sweep band inside `logo` (clipped to the tile), or null. */
  sheen: HTMLElement | null;
  /** Wordmark and tagline containers (faded out together at the hand-off). */
  lines: HTMLElement[];
  /** Wordmark letters, revealed one by one. */
  letters: HTMLElement[];
  /** Tagline words, revealed one by one. */
  words: HTMLElement[];
}

export interface SplashController {
  setReady: (ready: boolean) => void;
  /** User tapped: jump to the settled mark and leave quickly (once the app is ready). */
  hurry: () => void;
  destroy: () => void;
}

interface Options {
  logoPx: number;
  rig: SplashRig | null;
  ready: boolean;
  /** The hand-off has begun (the app underneath is being revealed). */
  onExitStart?: () => void;
  onDone: () => void;
}

const ease = {
  standard: cubicBezier(0.2, 0, 0, 1),
  enter: cubicBezier(0.05, 0.7, 0.1, 1),
  exit: cubicBezier(0.3, 0, 0.8, 0.15),
};

/** Hold on the settled logo and wordmark before the hand-off. */
const HOLD_MS = 450;
/** Hold after a tap-to-skip (the settled state still registers for a beat). */
const SKIP_HOLD_MS = 140;
const EXIT_MS = 360;
/** If the app never reports ready, leave anyway (measured from the start of the motion). */
const SAFETY_MS = 8000;

/** Timeline marks (ms), shared by the 3D and the SVG versions. */
export const T = {
  breathIn: 0,
  tilt: 180,
  steps: [420, 600, 780] as const,
  crouch: 1120,
  hop: 1260,
  land: 1780,
  climb: [1900, 2180, 2460] as const,
  /** Airborne time of each climbing hop. */
  hopMs: 280,
  settle: 2640,
  sink: [2700, 2760, 2820] as const,
  toSvg: 3240,
  letters: 2700,
  words: 2940,
  sheen: 3150,
} as const;

// Ball positions in the SVG's own 40x40 space (y down), mirrored by the 3D rig (y up, centred).
const SVG_TREADS: Array<[number, number]> = [
  [14.25, 24.7],
  [20.75, 18.2],
  [27.25, 11.7],
];
const SVG_HOME: [number, number] = [30.5, 9.5];

export function runSplashMotion(els: SplashElements, options: Options): SplashController {
  const { rig, onDone, onExitStart, logoPx } = options;
  let ready = options.ready;
  let timelineDone = false;
  let holdDone = false;
  let skipRequested = false;
  let exiting = false;
  let destroyed = false;
  let anchor: HTMLElement | null = null;
  let holdTimer = 0;
  let breathing: JSAnimation | null = null;
  const running: Array<{ pause: () => unknown }> = [];

  const tl: Timeline = createTimeline({
    autoplay: false,
    onUpdate: () => rig?.render(),
    onComplete: () => {
      if (timelineDone) return;
      timelineDone = true;
      holdTimer = window.setTimeout(
        () => {
          holdDone = true;
          maybeExit();
          // App still loading: keep the settled mark alive with a barely-there breath.
          if (!exiting && !destroyed) startBreathing();
        },
        skipRequested ? SKIP_HOLD_MS : HOLD_MS,
      );
    },
  });
  running.push(tl);

  // Hidden pieces start in their pre-reveal state (the first frame must equal the native splash).
  utils.set(els.lines, { opacity: 1 });
  utils.set(els.letters, { opacity: 0, translateY: 14 });
  utils.set(els.words, { opacity: 0, translateY: 8 });

  // A small breath in before the story starts (anticipation), released as the mark tilts.
  tl.add(els.logo, { scale: [{ to: 0.965, duration: 220, ease: 'inOutSine' }, { to: 1, duration: 520, ease: ease.standard }] }, T.breathIn);

  if (rig) buildRigTimeline(tl, rig);
  else buildSvgTimeline(tl, els);

  // Wordmark letter by letter, tagline word by word, as the mark settles.
  tl.add(els.letters, { opacity: [0, 1], translateY: [14, 0], duration: 460, ease: ease.enter, delay: stagger(45) }, T.letters);
  tl.add(els.words, { opacity: [0, 1], translateY: [8, 0], duration: 420, ease: ease.enter, delay: stagger(45) }, T.words);

  // A soft light sweeps across the settled (flat, SVG) mark.
  if (els.sheen) {
    utils.set(els.sheen, { translateX: -logoPx * 0.9, skewX: -18, opacity: 1 });
    tl.add(els.sheen, { translateX: logoPx * 1.35, duration: 460, ease: 'inOutSine' }, T.sheen);
  }

  if (rig) {
    // First frame is the flat pose, identical to the SVG: swap without a visible change.
    rig.render();
    els.canvas!.style.opacity = '1';
    els.svgWrap.style.opacity = '0';
    // Back to the crisp SVG once flat again, before the light sweep.
    tl.set(els.svgWrap, { opacity: 1 }, T.toSvg);
    tl.add(els.canvas!, { opacity: 0, duration: 120, ease: 'linear' }, T.toSvg);
  }

  tl.play();

  const safety = window.setTimeout(() => {
    ready = true;
    timelineDone = true;
    holdDone = true;
    maybeExit();
  }, SAFETY_MS);

  function startBreathing() {
    if (breathing || ready) return;
    breathing = animate(els.logo, { scale: [1, 1.025], duration: 1300, ease: 'inOutSine', loop: true, alternate: true });
    running.push(breathing);
  }

  function skipToSettled() {
    if (timelineDone) {
      // Already settled (holding or breathing): leave now.
      window.clearTimeout(holdTimer);
      holdDone = true;
      maybeExit();
      return;
    }
    tl.complete();
    rig?.render();
  }

  function maybeExit() {
    if (destroyed || exiting || !timelineDone || !holdDone || !ready) return;
    exiting = true;
    window.clearTimeout(safety);
    window.clearTimeout(holdTimer);
    breathing?.pause();
    rig?.dispose();
    els.root.style.pointerEvents = 'none';
    // Let the screen underneath start its entrance while the splash leaves.
    onExitStart?.();
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
    const bg = animate(els.backdrop, { opacity: 0, duration: 300, delay: 40, ease: ease.standard });
    const fly = animate(els.logo, {
      translateX: dx,
      translateY: dy,
      scale: to.width / logoPx,
      duration: EXIT_MS,
      ease: ease.standard,
      onComplete: () => {
        // If the screen is still fading its header in, cross-fade into it instead of a hard swap.
        target.style.visibility = '';
        if (effectiveOpacity(target) > 0.97) {
          finish();
          return;
        }
        running.push(animate(els.logo, { opacity: 0, duration: 220, ease: ease.standard, onComplete: finish }));
      },
    });
    running.push(lines, bg, fly);
  }

  /** No matching mark on top (e.g. Home): the mark eases forward as the app fades in. */
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
      if (ready && skipRequested) skipToSettled();
      maybeExit();
    },
    hurry() {
      if (exiting) return;
      skipRequested = true;
      // Only once the app is ready: otherwise the tap is remembered and applied when it is.
      if (ready) skipToSettled();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      window.clearTimeout(safety);
      window.clearTimeout(holdTimer);
      running.forEach((a) => a.pause());
      if (anchor) anchor.style.visibility = '';
      rig?.dispose();
    },
  };
}

/** Product of the element's and its ancestors' opacity. */
function effectiveOpacity(el: HTMLElement): number {
  let value = 1;
  for (let node: HTMLElement | null = el; node && value > 0; node = node.parentElement) {
    value *= Number.parseFloat(getComputedStyle(node).opacity || '1');
  }
  return value;
}

/**
 * Finds the brand mark on top of the screen underneath to hand the logo to. Hit-tested, so a
 * mark covered by an overlay (the Login screen under the onboarding, the lock screen) is skipped.
 * Call with the splash itself set to pointer-events: none.
 */
function findAnchor(): HTMLElement | null {
  const candidates = Array.from(document.querySelectorAll<HTMLElement>('.splash-anchor')).reverse();
  for (const el of candidates) {
    const rect = el.getBoundingClientRect();
    const visible =
      rect.width > 8 && rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
    if (!visible) continue;
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    if (hit && (hit === el || el.contains(hit))) return el;
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
  tl.add(s, { tiltX: -0.55, tiltY: 0.62, dolly: 0.9, duration: 820, ease: ease.standard }, T.tilt);
  const keys = ['step0', 'step1', 'step2'] as const;
  T.steps.forEach((at, i) => {
    tl.add(s, { [keys[i]]: UP, duration: 520, ease: 'outBack(1.6)' }, at);
  });

  // 2. The dot crouches, hops off its perch and drops onto the first step…
  tl.add(s, { ballSquash: [{ to: 0.72, duration: 140, ease: 'outQuad' }, { to: 1.12, duration: 120, ease: 'outQuad' }, { to: 1, duration: 200, ease: 'outSine' }] }, T.crouch);
  tl.add(s, { ballX: treads[0][0], ballDepth: 0.5, duration: T.land - T.hop, ease: 'inOutSine' }, T.hop);
  tl.add(s, { ballY: [{ to: home[1] + 6, duration: 200, ease: 'outQuad' }, { to: treads[0][1], duration: T.land - T.hop - 200, ease: 'inQuad' }] }, T.hop);
  tl.add(s, { ballSquash: [{ to: 0.66, duration: 80, ease: 'outQuad' }, { to: 1, duration: 240, ease: 'outBack(2.2)' }] }, T.land);

  // 3. …and climbs back up, one step at a time, crouching before each hop.
  const stops = [treads[1], treads[2], home];
  stops.forEach(([x, y], i) => {
    const from = i === 0 ? treads[0] : stops[i - 1];
    const start = T.climb[i];
    const peak = Math.max(from[1], y) + 4.5;
    const last = i === stops.length - 1;
    tl.add(s, { ballSquash: [{ to: 0.8, duration: 70, ease: 'outQuad' }, { to: 1.08, duration: 70, ease: 'outQuad' }] }, start - 70);
    tl.add(s, { ballX: x, duration: T.hopMs, ease: 'inOutSine' }, start);
    tl.add(s, { ballY: [{ to: peak, duration: T.hopMs / 2, ease: 'outQuad' }, { to: y, duration: T.hopMs / 2, ease: 'inQuad' }] }, start);
    tl.add(
      s,
      { ballSquash: [{ to: last ? 0.68 : 0.8, duration: 70, ease: 'outQuad' }, { to: 1, duration: last ? 300 : 180, ease: `outBack(${last ? 2.6 : 2})` }] },
      start + T.hopMs,
    );
  });
  tl.add(s, { ballDepth: 1, duration: T.hopMs, ease: 'inOutSine' }, T.climb[2]);

  // 4. Settle back into the flat mark; the steps sink back into it, top one first.
  tl.add(s, { tiltX: 0, tiltY: 0, dolly: 1, duration: 600, ease: ease.standard }, T.settle);
  [2, 1, 0].forEach((step, i) => {
    tl.add(s, { [keys[step]]: REST, duration: 400, ease: 'inOutCubic' }, T.sink[i]);
  });
}

/** Same story without WebGL: a CSS 3D tilt of the SVG mark, the steps lifting, the dot hopping along the stroke. */
function buildSvgTimeline(tl: Timeline, els: SplashElements) {
  const ball = els.svgWrap.querySelector<SVGCircleElement>('[data-ball]');
  const steps = Array.from(els.svgWrap.querySelectorAll<SVGElement>('[data-step]'));
  const shadows = Array.from(els.svgWrap.querySelectorAll<SVGElement>('[data-step-shadow]'));
  const stairs = els.svgWrap.querySelector<SVGElement>('[data-stairs]');
  els.logo.style.perspective = '420px';

  // Swap the single stair path for its three separate steps while the mark moves, and back once flat.
  if (stairs && steps.length === 3) {
    tl.set(steps, { opacity: 1 }, T.tilt);
    tl.set(stairs, { opacity: 0 }, T.tilt);
    tl.set(stairs, { opacity: 1 }, T.toSvg);
    tl.set(steps, { opacity: 0 }, T.toSvg);
  }
  tl.add(els.svgWrap, { rotateX: 26, rotateY: -30, scale: 1.04, duration: 820, ease: ease.standard }, T.tilt);
  // Each step lifts off the tile and casts a shadow: reads as standing up in the tilted view.
  T.steps.forEach((at, i) => {
    if (steps[i]) tl.add(steps[i], { translateX: -0.7, translateY: -1.1, duration: 520, ease: 'outBack(1.6)' }, at);
    if (shadows[i]) tl.add(shadows[i], { opacity: 0.26, duration: 520, ease: ease.standard }, at);
  });

  if (ball) {
    ball.style.transformBox = 'fill-box';
    ball.style.transformOrigin = '50% 100%';
    const squash = (to: number) => ({ scaleY: to, scaleX: 1 / Math.sqrt(to) });
    tl.add(ball, { scaleY: [{ to: 0.72, duration: 140, ease: 'outQuad' }, { to: 1.12, duration: 120 }, { to: 1, duration: 200 }] }, T.crouch);
    tl.add(ball, { cx: SVG_TREADS[0][0], duration: T.land - T.hop, ease: 'inOutSine' }, T.hop);
    tl.add(ball, { cy: [{ to: SVG_HOME[1] - 6, duration: 200, ease: 'outQuad' }, { to: SVG_TREADS[0][1] - 1.1, duration: T.land - T.hop - 200, ease: 'inQuad' }] }, T.hop);
    tl.add(ball, { ...squash(0.66), duration: 80, ease: 'outQuad' }, T.land);
    tl.add(ball, { scaleY: 1, scaleX: 1, duration: 240, ease: 'outBack(2.2)' }, T.land + 80);
    const stops = [SVG_TREADS[1], SVG_TREADS[2], SVG_HOME];
    stops.forEach(([x, y], i) => {
      const from = i === 0 ? SVG_TREADS[0] : stops[i - 1];
      const start = T.climb[i];
      const last = i === stops.length - 1;
      // Lifted treads sit 1.1 higher; home is not on a step.
      const lift = last ? 0 : 1.1;
      const peak = Math.min(from[1], y) - 4.5 - 1.1;
      tl.add(ball, { scaleY: [{ to: 0.8, duration: 70, ease: 'outQuad' }, { to: 1.08, duration: 70 }] }, start - 70);
      tl.add(ball, { cx: x, duration: T.hopMs, ease: 'inOutSine' }, start);
      tl.add(ball, { cy: [{ to: peak, duration: T.hopMs / 2, ease: 'outQuad' }, { to: y - lift, duration: T.hopMs / 2, ease: 'inQuad' }] }, start);
      tl.add(ball, { ...squash(last ? 0.68 : 0.8), duration: 70, ease: 'outQuad' }, start + T.hopMs);
      tl.add(ball, { scaleY: 1, scaleX: 1, duration: last ? 300 : 180, ease: `outBack(${last ? 2.6 : 2})` }, start + T.hopMs + 70);
    });
  }

  tl.add(els.svgWrap, { rotateX: 0, rotateY: 0, scale: 1, duration: 600, ease: ease.standard }, T.settle);
  [2, 1, 0].forEach((step, i) => {
    if (steps[step]) tl.add(steps[step], { translateX: 0, translateY: 0, duration: 400, ease: 'inOutCubic' }, T.sink[i]);
    if (shadows[step]) tl.add(shadows[step], { opacity: 0, duration: 400, ease: 'inOutCubic' }, T.sink[i]);
  });
}
