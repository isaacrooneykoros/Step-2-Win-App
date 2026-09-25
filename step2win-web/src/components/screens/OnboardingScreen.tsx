import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { animate, cubicBezier, stagger, utils, type JSAnimation } from 'animejs';
import { Button } from '../ui/Button';
import { BrandMark, Wordmark } from '../brand/BrandMark';
import { readRichMotion } from '../../lib/motion';
import { useBootSplashActive } from '../../lib/launchState';
import { pushBackHandler } from '../../lib/backButton';
import type { OnboardingWorld } from '../../lib/three/onboardingWorld';
import { OnboardingStill } from '../onboarding/OnboardingStills';
import { preloadOnboarding } from '../onboarding/preload';

// This chunk is fetched during the launch splash: start the 3D chunk and character files too.
preloadOnboarding();

export type OnboardingNext = 'register' | 'login';

interface OnboardingScreenProps {
  onComplete: (next: OnboardingNext) => void;
}

interface Page {
  eyebrow: string;
  title: string;
  body: string;
}

const PAGES: Page[] = [
  {
    eyebrow: 'Move',
    title: 'Every step counts',
    body: 'Your phone counts your steps, and we verify them so every leaderboard stays fair.',
  },
  {
    eyebrow: 'Challenge',
    title: 'Walk together',
    body: 'Join step challenges with friends or the wider community and see where you stand.',
  },
  {
    eyebrow: 'Earn',
    title: 'Qualify to share the pool',
    body: 'Your entry is a contribution to the challenge pool. Hit the step target to qualify for a share; if you miss it, there is no payout.',
  },
  {
    eyebrow: 'Build consistency',
    title: 'Make it a habit',
    body: 'Set a daily goal and keep your streak going, one day at a time.',
  },
];

const LAST = PAGES.length - 1;
/** Horizontal distance (px) or fraction of width that commits a swipe. */
const SWIPE_MIN_PX = 48;
/** If the 3D scene has not drawn its first frame by then, show the still (and upgrade later). */
const SCENE_DEADLINE_MS = 3000;

const ease = {
  standard: cubicBezier(0.2, 0, 0, 1),
  enter: cubicBezier(0.05, 0.7, 0.1, 1),
  exit: cubicBezier(0.3, 0, 0.8, 0.15),
  flight: cubicBezier(0.45, 0, 0.2, 1),
};

const clampIndex = (i: number) => Math.max(0, Math.min(LAST, i));

function readDark(el: Element): boolean {
  const raw = getComputedStyle(el).getPropertyValue('--bg-page').trim();
  const l = Number(raw.split(/\s+/)[2]?.replace('%', ''));
  return Number.isFinite(l) ? l < 40 : window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}

type HeroMode = 'loading' | '3d' | 'still';

/**
 * First-run introduction, shown before sign-in. One persistent Three.js world (lazy chunk) with
 * rigged, animated people; the camera flies between four stations along one climb while the
 * copy — real DOM text in a sheet below — is choreographed with anime.js. Swipes scrub the
 * camera with the finger. Reduced motion, Data saver, no WebGL2, a lost context or a failed
 * download show pre-rendered stills of the same scenes instead.
 */
export const OnboardingScreen: React.FC<OnboardingScreenProps> = ({ onComplete }) => {
  const [rich] = useState(readRichMotion);
  const splashActive = useBootSplashActive();
  const [index, setIndex] = useState(0);
  const [heroMode, setHeroMode] = useState<HeroMode>(rich ? 'loading' : 'still');
  const [dark, setDark] = useState(() => readDark(document.documentElement));
  const headingId = useId();

  const rootRef = useRef<HTMLDivElement>(null);
  const heroRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const fillRefs = useRef<Array<HTMLSpanElement | null>>([]);
  const worldRef = useRef<OnboardingWorld | null>(null);
  const heroModeRef = useRef(heroMode);
  heroModeRef.current = heroMode;

  /** Continuous position (0…3) driving the camera and the progress bar. */
  const progress = useRef({ f: 0 });
  const progressAnim = useRef<JSAnimation | null>(null);
  /** Latest requested page (state `index` follows once the old copy has left). */
  const target = useRef(0);
  const direction = useRef(1);
  const textLeaving = useRef<JSAnimation | null>(null);
  const introStarted = useRef(false);
  const firstStationPlayed = useRef(false);
  const pointer = useRef<{ id: number; x: number; y: number; axis: 'x' | 'y' | null; dx: number } | null>(null);

  const applyProgress = useCallback(() => {
    const f = progress.current.f;
    worldRef.current?.setProgress(f);
    if (!rich) return;
    fillRefs.current.forEach((el, i) => {
      if (el) el.style.transform = `scaleX(${Math.max(0, Math.min(1, f - i + 1))})`;
    });
  }, [rich]);

  const playFirstStation = useCallback(() => {
    if (firstStationPlayed.current || !introStarted.current || !worldRef.current) return;
    firstStationPlayed.current = true;
    worldRef.current.enterStation(target.current, 0);
  }, []);

  const goTo = useCallback(
    (next: number) => {
      const to = clampIndex(next);
      if (to === target.current && !pointer.current) {
        // Snap back after an uncommitted drag.
        if (rich) {
          progressAnim.current?.pause();
          progressAnim.current = animate(progress.current, { f: to, duration: 420, ease: ease.standard, onUpdate: applyProgress });
          if (textRef.current && !textLeaving.current) {
            animate(textRef.current, { translateX: 0, opacity: 1, duration: 320, ease: ease.standard });
          }
        }
        return;
      }
      direction.current = to > target.current ? 1 : -1;
      const distance = Math.abs(to - progress.current.f);
      target.current = to;

      if (!rich) {
        progress.current.f = to;
        applyProgress();
        if (textRef.current) textRef.current.style.transform = '';
        setIndex(to);
        return;
      }

      // Camera and progress bar glide from wherever they are (mid-drag or mid-flight).
      progressAnim.current?.pause();
      progressAnim.current = animate(progress.current, {
        f: to,
        duration: Math.min(2200, 900 + 520 * Math.max(0, distance - 1) + 260 * Math.min(1, distance)),
        ease: ease.flight,
        onUpdate: applyProgress,
      });
      // The station's story restarts as the camera settles in.
      worldRef.current?.enterStation(to, 420);
      firstStationPlayed.current = true;

      // The current copy leaves in the travel direction; the next arrives from the other side.
      if (!textLeaving.current && textRef.current) {
        textLeaving.current = animate(textRef.current, {
          translateX: -direction.current * 28,
          opacity: 0,
          duration: 150,
          ease: ease.exit,
          onComplete: () => {
            textLeaving.current = null;
            setIndex(target.current);
          },
        });
      }
    },
    [applyProgress, rich],
  );

  // New page copy: eyebrow, title and body arrive in sequence.
  const mountedIndex = useRef(index);
  useLayoutEffect(() => {
    if (mountedIndex.current === index) return;
    mountedIndex.current = index;
    const container = textRef.current;
    if (!rich || !container) return;
    utils.set(container, { translateX: 0, opacity: 1 });
    animate(Array.from(container.children), {
      opacity: [0, 1],
      translateX: [direction.current * 24, 0],
      duration: 460,
      ease: ease.enter,
      delay: stagger(55),
    });
  }, [index, rich]);

  const finish = useCallback((next: OnboardingNext) => onComplete(next), [onComplete]);

  const handleNext = useCallback(() => {
    if (target.current < LAST) goTo(target.current + 1);
    else if (index === LAST) finish('register');
  }, [goTo, index, finish]);

  // Intro choreography once the screen is actually visible (the splash hands over).
  useEffect(() => {
    if (splashActive || introStarted.current) return;
    introStarted.current = true;
    const root = rootRef.current;
    if (!root) return;
    applyProgress();
    if (rich) {
      animate(root.querySelectorAll('[data-intro]'), {
        opacity: [0, 1],
        translateY: [14, 0],
        duration: 560,
        ease: ease.enter,
        delay: stagger(70, { start: 120 }),
      });
    }
    playFirstStation();
  }, [splashActive, rich, applyProgress, playFirstStation]);

  // Follow light/dark switches for the stills (the 3D world listens itself).
  useEffect(() => {
    const observer = new MutationObserver(() => setDark(readDark(document.documentElement)));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] });
    return () => observer.disconnect();
  }, []);

  /** Frames the scene in the band between the header and the sheet. */
  const updateInsets = useCallback(() => {
    const world = worldRef.current;
    const root = rootRef.current;
    if (!world || !root) return;
    const r = root.getBoundingClientRect();
    const top = (headerRef.current?.getBoundingClientRect().bottom ?? r.top) - r.top;
    const bottom = r.bottom - (sheetRef.current?.getBoundingClientRect().top ?? r.bottom);
    world.setViewInsets(top, bottom);
  }, []);

  // The 3D world: one canvas for the whole flow. The chunk and the character files download
  // during the splash, but the world (shader compilation is the heavy part) is only built once
  // the splash hands over, so it never makes the splash stutter on slower phones. Until its
  // first frame, the pre-rendered still of the same scene shows; the live scene fades in over it.
  useEffect(() => {
    if (!rich || splashActive) return;
    let cancelled = false;
    let world: OnboardingWorld | null = null;
    let canvas: HTMLCanvasElement | null = null;
    let observer: ResizeObserver | null = null;
    let fade: JSAnimation | null = null;

    const teardown = () => {
      observer?.disconnect();
      observer = null;
      fade?.pause();
      world?.dispose();
      world = null;
      worldRef.current = null;
      canvas?.remove();
      canvas = null;
    };
    const fail = () => {
      teardown();
      if (!cancelled) setHeroMode('still');
    };

    const deadline = window.setTimeout(() => {
      if (heroModeRef.current === 'loading') setHeroMode('still');
    }, SCENE_DEADLINE_MS);

    import('../../lib/three/onboardingWorld')
      .then((mod) => {
        const hero = heroRef.current;
        if (cancelled || !hero) return;
        // Created imperatively: a canvas whose WebGL context was released cannot be reused.
        canvas = document.createElement('canvas');
        canvas.setAttribute('aria-hidden', 'true');
        canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;opacity:0;display:block;';
        hero.appendChild(canvas);
        try {
          world = mod.createOnboardingWorld(canvas, {
            tokenScope: rootRef.current ?? document.documentElement,
            onContextLost: fail,
            onError: fail,
            onFirstFrame: () => {
              if (!canvas || cancelled) return;
              window.clearTimeout(deadline);
              fade = animate(canvas, {
                opacity: [0, 1],
                duration: heroModeRef.current === 'still' ? 700 : 520,
                ease: ease.standard,
                onComplete: () => !cancelled && setHeroMode('3d'),
              });
            },
          });
        } catch {
          fail();
          return;
        }
        worldRef.current = world;
        const rect = hero.getBoundingClientRect();
        world.resize(rect.width, rect.height);
        updateInsets();
        world.setProgress(progress.current.f);
        observer = new ResizeObserver(() => {
          const box = hero.getBoundingClientRect();
          world?.resize(box.width, box.height);
          updateInsets();
        });
        observer.observe(hero);
        if (sheetRef.current) observer.observe(sheetRef.current);
        if (headerRef.current) observer.observe(headerRef.current);
        // A fresh world starts with every station reset: play the current one.
        firstStationPlayed.current = false;
        playFirstStation();
        if (import.meta.env.DEV) {
          (window as unknown as { __onboardingGoTo?: (i: number) => void }).__onboardingGoTo = goTo;
        }
      })
      .catch(() => {
        if (!cancelled) setHeroMode('still');
      });

    return () => {
      cancelled = true;
      window.clearTimeout(deadline);
      teardown();
    };
  }, [rich, splashActive, playFirstStation, updateInsets]);

  // Stop every running tween when the overlay closes.
  useEffect(
    () => () => {
      progressAnim.current?.pause();
      textLeaving.current?.pause();
    },
    [],
  );

  // Android hardware back: previous page; on the first page the app's normal handling applies.
  useEffect(
    () =>
      pushBackHandler(() => {
        if (target.current > 0) {
          goTo(target.current - 1);
          return true;
        }
        return false;
      }),
    [goTo],
  );

  // Keyboard: arrows move between pages; Escape leaves for sign-in.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const el = event.target as HTMLElement | null;
      if (el && ['INPUT', 'TEXTAREA'].includes(el.tagName)) return;
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        goTo(target.current + 1);
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        goTo(target.current - 1);
      } else if (event.key === 'Escape') {
        finish('login');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goTo, finish]);

  // Lock the page behind the overlay.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // Swipe (touch, pen, mouse): the camera, progress bar and copy follow the finger.
  const onPointerDown = (event: React.PointerEvent) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    pointer.current = { id: event.pointerId, x: event.clientX, y: event.clientY, axis: null, dx: 0 };
  };

  const onPointerMove = (event: React.PointerEvent) => {
    const p = pointer.current;
    if (!p || p.id !== event.pointerId) return;
    const dx = event.clientX - p.x;
    const dy = event.clientY - p.y;
    if (!p.axis) {
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
      p.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      if (p.axis === 'x') {
        (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
        progressAnim.current?.pause();
      }
    }
    if (p.axis !== 'x') return;
    const width = rootRef.current?.clientWidth || 360;
    // Resist at the ends so the edges feel physical.
    const atEdge = (target.current === 0 && dx > 0) || (target.current === LAST && dx < 0);
    p.dx = atEdge ? dx * 0.3 : dx;
    if (textLeaving.current || !textRef.current) return;
    if (rich) {
      progress.current.f = target.current - p.dx / width;
      applyProgress();
      utils.set(textRef.current, { translateX: p.dx * 0.35, opacity: 1 - Math.min(0.75, (Math.abs(p.dx) / width) * 1.6) });
    } else {
      textRef.current.style.transform = `translateX(${p.dx * 0.35}px)`;
    }
  };

  const endDrag = (event: React.PointerEvent) => {
    const p = pointer.current;
    if (!p || p.id !== event.pointerId) return;
    pointer.current = null;
    if (p.axis !== 'x') return;
    const width = rootRef.current?.clientWidth || 360;
    const threshold = Math.min(SWIPE_MIN_PX, width * 0.2);
    if (p.dx <= -threshold) goTo(target.current + 1);
    else if (p.dx >= threshold) goTo(target.current - 1);
    else goTo(target.current);
    if (!rich && textRef.current) textRef.current.style.transform = '';
  };

  const page = PAGES[index];
  const isLast = index === LAST;
  const introHidden = rich ? { opacity: 0 } : undefined;

  return (
    <div
      ref={rootRef}
      className="fixed inset-0 z-50 touch-pan-y select-none overflow-hidden bg-bg-page"
      role="dialog"
      aria-modal="true"
      aria-labelledby={headingId}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      {/* Scene: full-bleed behind everything; the canvas is appended here. */}
      <div ref={heroRef} className="absolute inset-0 touch-pan-y select-none" aria-hidden="true">
        {/* The still also covers the 3D world's build time, so the scene is never blank. */}
        {heroMode !== '3d' && (
          <div key={`${index}-${dark}`} className="fade-in absolute inset-0">
            <OnboardingStill index={index} dark={dark} />
          </div>
        )}
      </div>

      <div className="relative mx-auto flex h-full w-full max-w-md flex-col">
        {/* Top bar: stays visible so the splash logo can land in it. */}
        <div ref={headerRef} className="shrink-0 pt-safe">
          <div className="flex h-14 items-center justify-between pl-5 pr-2">
            <span className="inline-flex items-center gap-2">
              <BrandMark size={28} className="splash-anchor" />
              <Wordmark className="text-headline" />
            </span>
            <button
              type="button"
              onClick={() => goTo(LAST)}
              aria-label="Skip to the last page"
              aria-hidden={isLast || undefined}
              tabIndex={isLast ? -1 : 0}
              data-intro
              style={introHidden}
              className={[
                'group inline-flex min-h-touch items-center px-1 text-callout font-semibold text-text-primary',
                'transition-opacity duration-normal ease-standard',
                isLast ? 'pointer-events-none !opacity-0' : '',
              ].join(' ')}
            >
              {/* Pill backdrop keeps the label legible over any part of the scene behind it. */}
              <span className="rounded-full bg-bg-card/75 px-3.5 py-1.5 backdrop-blur-sm group-hover:bg-bg-card/90">Skip</span>
            </button>
          </div>

          {/* Progress: one segment per page; fills follow the camera, including mid-swipe. */}
          <div className="flex gap-1.5 px-5" role="group" aria-label="Choose page" data-intro style={introHidden}>
            {PAGES.map((p, i) => (
              <button
                key={p.eyebrow}
                type="button"
                onClick={() => goTo(i)}
                aria-label={`Page ${i + 1} of ${PAGES.length}: ${p.eyebrow}`}
                aria-current={i === index ? 'step' : undefined}
                className="flex h-6 flex-1 items-center"
              >
                <span className="relative block h-1 w-full overflow-hidden rounded-full bg-bg-card/60">
                  <span
                    ref={(el) => {
                      fillRefs.current[i] = el;
                    }}
                    className="absolute inset-0 origin-left rounded-full bg-brand"
                    style={
                      rich
                        ? undefined
                        : {
                            transform: `scaleX(${i <= index ? 1 : 0})`,
                            transition: 'transform var(--dur-normal) var(--ease-standard)',
                          }
                    }
                  />
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="min-h-0 flex-1" />

        {/* Copy and controls: a sheet over the lower part of the scene. */}
        <div ref={sheetRef} className="shrink-0 rounded-t-[28px] bg-bg-page pb-safe" data-intro style={introHidden}>
          <div
            ref={textRef}
            className="min-h-[178px] px-6 pt-6"
            aria-roledescription="slide"
            aria-label={`${index + 1} of ${PAGES.length}`}
          >
            <p className="eyebrow text-brand">{page.eyebrow}</p>
            <h2 id={headingId} className="mt-2 text-title-lg text-text-primary">
              {page.title}
            </h2>
            <p className="mt-2 text-body text-text-secondary">{page.body}</p>
          </div>

          <div className="px-6 pb-2 pt-2">
            <div className="flex items-center">
              <div
                className="shrink-0 overflow-hidden transition-[width,margin] duration-normal ease-standard"
                style={{ width: index > 0 ? 52 : 0, marginRight: index > 0 ? 12 : 0 }}
              >
                <button
                  type="button"
                  onClick={() => goTo(target.current - 1)}
                  aria-label="Previous page"
                  aria-hidden={index === 0 || undefined}
                  tabIndex={index === 0 ? -1 : 0}
                  className="flex h-[52px] w-[52px] items-center justify-center rounded-2xl border border-border bg-bg-card text-text-primary hover:bg-bg-input"
                >
                  <ArrowLeft size={20} aria-hidden />
                </button>
              </div>
              <Button
                size="lg"
                className="min-w-0 flex-1"
                onClick={handleNext}
                aria-label={isLast ? 'Get started' : 'Next page'}
                rightIcon={isLast ? undefined : <ArrowRight size={18} aria-hidden />}
              >
                <span key={isLast ? 'start' : 'next'} className="fade-in">
                  {isLast ? 'Get started' : 'Next'}
                </span>
              </Button>
            </div>
            {/* Space is always reserved so the sheet (and the camera framing) never jumps. */}
            <button
              type="button"
              onClick={() => finish('login')}
              aria-label="I already have an account, sign in"
              aria-hidden={!isLast || undefined}
              tabIndex={isLast ? 0 : -1}
              className={[
                'mt-1 flex min-h-touch w-full items-center justify-center rounded-control text-callout font-semibold text-brand hover:bg-bg-input',
                'transition-opacity duration-normal ease-standard',
                isLast ? 'opacity-100' : 'pointer-events-none opacity-0',
              ].join(' ')}
            >
              I already have an account
            </button>
            <p className="sr-only" aria-live="polite">
              {`Page ${index + 1} of ${PAGES.length}: ${page.title}`}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default OnboardingScreen;
