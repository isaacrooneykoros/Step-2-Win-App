import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { Button } from '../ui/Button';
import { BrandMark, Wordmark } from '../brand/BrandMark';
import { usePrefersReducedMotion } from '../../lib/motion';
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

/** Horizontal distance (px) or fraction of width that commits a swipe. */
const SWIPE_MIN_PX = 48;

export const OnboardingScreen: React.FC<OnboardingScreenProps> = ({ onComplete }) => {
  const reduced = usePrefersReducedMotion();
  const [index, setIndex] = useState(0);
  const [dragX, setDragX] = useState(0);
  const [dragging, setDragging] = useState(false);
  const viewportRef = useRef<HTMLDivElement>(null);
  const pointer = useRef<{ id: number; x: number; y: number; axis: 'x' | 'y' | null } | null>(null);
  const headingId = useId();

  const last = PAGES.length - 1;
  const isLast = index === last;

  const goTo = useCallback((next: number) => {
    setIndex(Math.max(0, Math.min(PAGES.length - 1, next)));
  }, []);

  const handleNext = useCallback(() => {
    if (index >= PAGES.length - 1) onComplete();
    else goTo(index + 1);
  }, [goTo, index, onComplete]);

  // Keyboard: arrows move between pages; Escape skips.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA'].includes(target.tagName)) return;
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        goTo(index + 1);
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        goTo(index - 1);
      } else if (event.key === 'Escape') {
        onComplete();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goTo, index, onComplete]);

  // Lock the page behind the overlay.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // Pointer-based swipe (touch, pen and mouse drag).
  const onPointerDown = (event: React.PointerEvent) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    pointer.current = { id: event.pointerId, x: event.clientX, y: event.clientY, axis: null };
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
        setDragging(true);
        (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
      }
    }
    if (p.axis !== 'x') return;
    // Resist at the ends so the edges feel physical.
    const atEdge = (index === 0 && dx > 0) || (index === last && dx < 0);
    setDragX(atEdge ? dx * 0.3 : dx);
  };

  const endDrag = (event: React.PointerEvent) => {
    const p = pointer.current;
    if (!p || p.id !== event.pointerId) return;
    pointer.current = null;
    if (p.axis === 'x') {
      const width = viewportRef.current?.clientWidth ?? 360;
      const threshold = Math.min(SWIPE_MIN_PX, width * 0.2);
      if (dragX <= -threshold) goTo(index + 1);
      else if (dragX >= threshold) goTo(index - 1);
    }
    setDragging(false);
    setDragX(0);
  };

  const trackTransition = dragging || reduced ? 'none' : 'transform var(--dur-deliberate) var(--ease-standard)';
  const page = PAGES[index];

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-bg-page"
      role="dialog"
      aria-modal="true"
      aria-labelledby={headingId}
    >
      <div className="mx-auto flex h-full w-full max-w-md flex-col pt-safe pb-safe">
        {/* Top bar */}
        <div className="flex h-14 shrink-0 items-center justify-between pl-5 pr-2">
          <span className="inline-flex items-center gap-2">
            <BrandMark size={28} />
            <Wordmark className="text-headline" />
          </span>
          {!isLast && (
            <button
              type="button"
              onClick={onComplete}
              className="min-h-touch rounded-full px-4 text-callout font-semibold text-text-secondary hover:bg-bg-input hover:text-text-primary"
            >
              Skip
            </button>
          )}
        </div>

        {/* Pages */}
        <div
          ref={viewportRef}
          className="relative min-h-0 flex-1 touch-pan-y select-none overflow-hidden"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          aria-roledescription="carousel"
        >
          <div
            className="flex h-full"
            style={{
              transform: `translate3d(calc(${-index * 100}% + ${dragX}px), 0, 0)`,
              transition: trackTransition,
            }}
          >
            {PAGES.map((p, i) => {
              const active = i === index;
              const Illustration = p.Illustration;
              return (
                <section
                  key={p.eyebrow}
                  className="flex h-full w-full shrink-0 flex-col justify-center px-6"
                  aria-roledescription="slide"
                  aria-label={`${i + 1} of ${PAGES.length}`}
                  aria-hidden={!active}
                >
                  {/* Illustration + copy stay together as one centred composition on tall screens. */}
                  <div className="flex min-h-[150px] shrink items-center justify-center py-4" style={{ height: 'min(280px, 40dvh)' }}>
                    <div className="h-full w-full">
                      <Illustration active={active} />
                    </div>
                  </div>
                  {/* Min-height text block so headlines sit at the same place on every page. */}
                  <div className="min-h-[176px] shrink-0 pb-4">
                    <p className="eyebrow text-brand">{p.eyebrow}</p>
                    <h2
                      id={active ? headingId : undefined}
                      className="mt-2 text-title-lg text-text-primary"
                    >
                      {p.title}
                    </h2>
                    <p className="mt-2 text-body text-text-secondary">{p.body}</p>
                  </div>
                </section>
              );
            })}
          </div>
        </div>

        {/* Controls */}
        <div className="shrink-0 px-6 pb-4 pt-2">
          <div className="mb-5 flex items-center justify-center gap-1" role="group" aria-label="Choose page">
            {PAGES.map((p, i) => (
              <button
                key={p.eyebrow}
                type="button"
                onClick={() => goTo(i)}
                aria-label={`Page ${i + 1} of ${PAGES.length}: ${p.eyebrow}`}
                aria-current={i === index ? 'step' : undefined}
                className="flex h-6 items-center justify-center px-1"
              >
                <span
                  className={[
                    'block h-2 rounded-full transition-[width,background-color] duration-normal ease-standard',
                    i === index ? 'w-6 bg-brand' : 'w-2 bg-border hover:bg-text-muted',
                  ].join(' ')}
                />
              </button>
            ))}
          </div>
          <Button
            size="lg"
            fullWidth
            onClick={handleNext}
            rightIcon={isLast ? undefined : <ArrowRight size={18} aria-hidden />}
          >
            {isLast ? 'Get started' : 'Next'}
          </Button>
          <p className="sr-only" aria-live="polite">
            {`Page ${index + 1} of ${PAGES.length}: ${page.title}`}
          </p>
        </div>
      </div>
    </div>
  );
};

export default OnboardingScreen;
