import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { animate, cubicBezier, stagger, utils, type JSAnimation } from 'animejs';
import { Button } from '../ui/Button';
import { BrandMark, Wordmark } from '../brand/BrandMark';
import { readRichMotion } from '../../lib/motion';
import { useBootSplashActive } from '../../lib/launchState';
import { pushBackHandler } from '../../lib/backButton';
import type { OnboardingWorld } from '../../lib/three/onboardingWorld';
import {
  ChallengeIllustration,
  ConsistencyIllustration,
  EarnIllustration,
  MoveIllustration,
} from '../onboarding/OnboardingIllustrations';

interface OnboardingScreenProps {
  onComplete: () => void;
}

interface Page {
  eyebrow: string;
  title: string;
  body: string;
  /** Static illustration: reduced motion, Data saver, or no WebGL. */
  Illustration: React.ComponentType<{ active: boolean }>;
}

const PAGES: Page[] = [
  {
    eyebrow: 'Move',
    title: 'Every step counts',
    body: 'Your phone counts your steps, and we verify them so every leaderboard stays fair.',
    Illustration: MoveIllustration,
  },
  {
    eyebrow: 'Challenge',
    title: 'Walk together',
    body: 'Join step challenges with friends or the wider community and see where you stand.',
    Illustration: ChallengeIllustration,
  },
  {
    eyebrow: 'Earn',
    title: 'Qualify to share the pool',
    body: 'Your entry is a contribution to the challenge pool. Hit the step target to qualify for a share; if you miss it, there is no payout.',
    Illustration: EarnIllustration,
  },
  {
    eyebrow: 'Build consistency',
    title: 'Make it a habit',
    body: 'Set a daily goal and keep your streak going, one day at a time.',
    Illustration: ConsistencyIllustration,
  },
];

const LAST = PAGES.length - 1;
/** Horizontal distance (px) or fraction of width that commits a swipe. */
const SWIPE_MIN_PX = 48;
/** If the 3D chunk has not produced a scene by then, show the static illustrations. */
const SCENE_DEADLINE_MS = 2500;

const ease = {
  standard: cubicBezier(0.2, 0, 0, 1),
  enter: cubicBezier(0.05, 0.7, 0.1, 1),
  exit: cubicBezier(0.3, 0, 0.8, 0.15),
};

const clampIndex = (i: number) => Math.max(0, Math.min(LAST, i));

/**
 * First-run introduction. One persistent Three.js canvas (lazy chunk) flies between four
 * landings joined by steps while the copy — real DOM text — is choreographed with anime.js.
 * Swipes scrub the camera and the progress bar with the finger. Reduced motion, Data saver or
 * missing WebGL fall back to the static illustrations with plain fades.
 */
export const OnboardingScreen: React.FC<OnboardingScreenProps> = ({ onComplete }) => {
  const [rich] = useState(readRichMotion);
  const splashActive = useBootSplashActive();
  const [index, setIndex] = useState(0);
  const [heroMode, setHeroMode] = useState<'loading' | '3d' | 'fallback'>(rich ? 'loading' : 'fallback');
  const headingId = useId();

  const rootRef = useRef<HTMLDivElement>(null);
  const heroRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
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
    worldRef.current.enterStation(target.current, 220);
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
        duration: 820,
        ease: ease.standard,
        onUpdate: applyProgress,
      });
      worldRef.current?.enterStation(to, 360);
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

  const handleNext = useCallback(() => {
    if (target.current < LAST) goTo(target.current + 1);
    else if (index === LAST) onComplete();
  }, [goTo, index, onComplete]);

  // Intro choreography once the screen is actually visible (not under the launch splash).
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
        delay: stagger(70),
      });
    }
    playFirstStation();
  }, [splashActive, rich, applyProgress, playFirstStation]);

  // The 3D world: one canvas for the whole flow, created after the splash has gone.
  useEffect(() => {
    if (!rich || splashActive) return;
    let cancelled = false;
    let world: OnboardingWorld | null = null;
    let canvas: HTMLCanvasElement | null = null;
    let observer: ResizeObserver | null = null;

    const teardown = () => {
      observer?.disconnect();
      observer = null;
      world?.dispose();
      world = null;
      worldRef.current = null;
      canvas?.remove();
      canvas = null;
    };

    const deadline = window.setTimeout(() => {
      if (!worldRef.current) setHeroMode('fallback');
    }, SCENE_DEADLINE_MS);

    import('../../lib/three/onboardingWorld')
      .then((mod) => {
        const hero = heroRef.current;
        if (cancelled || !hero || heroModeRef.current === 'fallback') return;
        // Created imperatively: a canvas whose WebGL context was released cannot be reused.
        canvas = document.createElement('canvas');
        canvas.setAttribute('aria-hidden', 'true');
        // Soft bottom edge: mid-flight the landing can dip below the hero; it fades instead of being cut.
        const mask = 'linear-gradient(to bottom, #000 86%, transparent 100%)';
        canvas.style.cssText = `position:absolute;inset:0;width:100%;height:100%;opacity:0;display:block;-webkit-mask-image:${mask};mask-image:${mask};`;
        hero.appendChild(canvas);
        try {
          world = mod.createOnboardingWorld(canvas, {
            tokenScope: rootRef.current ?? document.documentElement,
            onContextLost: () => {
              teardown();
              setHeroMode('fallback');
            },
            onFirstFrame: () => {
              if (canvas) animate(canvas, { opacity: [0, 1], duration: 420, ease: ease.standard });
            },
          });
        } catch {
          teardown();
          setHeroMode('fallback');
          return;
        }
        worldRef.current = world;
        const rect = hero.getBoundingClientRect();
        world.resize(rect.width, rect.height);
        world.setProgress(progress.current.f);
        observer = new ResizeObserver((entries) => {
          const box = entries[0]?.contentRect;
          if (box) world?.resize(box.width, box.height);
        });
        observer.observe(hero);
        setHeroMode('3d');
        // A fresh world starts with every landing reset: play the current one (again, if remounted).
        firstStationPlayed.current = false;
        playFirstStation();
      })
      .catch(() => {
        if (!cancelled) setHeroMode('fallback');
      });

    return () => {
      cancelled = true;
      window.clearTimeout(deadline);
      teardown();
    };
  }, [rich, splashActive, playFirstStation]);

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

  // Keyboard: arrows move between pages; Escape skips.
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
        onComplete();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goTo, onComplete]);

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
    const width = viewportRef.current?.clientWidth || 360;
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
    const width = viewportRef.current?.clientWidth || 360;
    const threshold = Math.min(SWIPE_MIN_PX, width * 0.2);
    if (p.dx <= -threshold) goTo(target.current + 1);
    else if (p.dx >= threshold) goTo(target.current - 1);
    else goTo(target.current);
    if (!rich && textRef.current) textRef.current.style.transform = '';
  };

  const page = PAGES[index];
  const isLast = index === LAST;
  const introHidden = rich ? { opacity: 0 } : undefined;
  const Illustration = page.Illustration;

  return (
    <div
      ref={rootRef}
      className="fixed inset-0 z-50 flex flex-col bg-bg-page"
      role="dialog"
      aria-modal="true"
      aria-labelledby={headingId}
    >
      <div className="mx-auto flex h-full w-full max-w-md flex-col pt-safe pb-safe">
        {/* Top bar */}
        <div className="flex h-14 shrink-0 items-center justify-between pl-5 pr-2" data-intro style={introHidden}>
          <span className="inline-flex items-center gap-2">
            <BrandMark size={28} />
            <Wordmark className="text-headline" />
          </span>
          <button
            type="button"
            onClick={onComplete}
            aria-label="Skip introduction"
            aria-hidden={isLast || undefined}
            tabIndex={isLast ? -1 : 0}
            className={[
              'min-h-touch rounded-full px-4 text-callout font-semibold text-text-secondary hover:bg-bg-input hover:text-text-primary',
              'transition-opacity duration-normal ease-standard',
              isLast ? 'pointer-events-none opacity-0' : 'opacity-100',
            ].join(' ')}
          >
            Skip
          </button>
        </div>

        {/* Progress: one segment per page; fills follow the camera, including mid-swipe. */}
        <div className="flex shrink-0 gap-1.5 px-5" role="group" aria-label="Choose page" data-intro style={introHidden}>
          {PAGES.map((p, i) => (
            <button
              key={p.eyebrow}
              type="button"
              onClick={() => goTo(i)}
              aria-label={`Page ${i + 1} of ${PAGES.length}: ${p.eyebrow}`}
              aria-current={i === index ? 'step' : undefined}
              className="flex h-6 flex-1 items-center"
            >
              <span className="relative block h-1 w-full overflow-hidden rounded-full bg-bg-input">
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

        {/* Scene + copy: one swipeable surface. */}
        <div
          ref={viewportRef}
          className="relative flex min-h-0 flex-1 touch-pan-y select-none flex-col"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          aria-roledescription="carousel"
        >
          <div ref={heroRef} className="relative min-h-[160px] flex-1" aria-hidden="true">
            {heroMode === 'fallback' && (
              <div key={index} className="fade-in absolute inset-0 flex items-center justify-center px-6 py-4">
                <div className="h-full max-h-[260px] w-full">
                  <Illustration active />
                </div>
              </div>
            )}
          </div>

          <div
            ref={textRef}
            className="min-h-[196px] shrink-0 px-6 pb-2 pt-3"
            aria-roledescription="slide"
            aria-label={`${index + 1} of ${PAGES.length}`}
            data-intro
            style={introHidden}
          >
            <p className="eyebrow text-brand">{page.eyebrow}</p>
            <h2 id={headingId} className="mt-2 text-title-lg text-text-primary">
              {page.title}
            </h2>
            <p className="mt-2 text-body text-text-secondary">{page.body}</p>
          </div>
        </div>

        {/* Controls */}
        <div className="shrink-0 px-6 pb-4 pt-3" data-intro style={introHidden}>
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
          <p className="sr-only" aria-live="polite">
            {`Page ${index + 1} of ${PAGES.length}: ${page.title}`}
          </p>
        </div>
      </div>
    </div>
  );
};

export default OnboardingScreen;
