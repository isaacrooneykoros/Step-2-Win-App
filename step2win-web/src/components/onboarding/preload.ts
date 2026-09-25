import { readRichMotion } from '../../lib/motion';

let started = false;

/**
 * Starts fetching the onboarding 3D chunk and its character files (call during the launch
 * splash). No-op when rich motion is off (reduced motion or Data saver): those users get the
 * static stills and never download the models. Idempotent.
 */
export function preloadOnboarding(): void {
  if (started || typeof window === 'undefined') return;
  started = true;
  if (!readRichMotion()) return;
  import('../../lib/three/onboardingWorld')
    .then((mod) => mod.preloadOnboardingAssets())
    .catch(() => {
      started = false;
    });
}
