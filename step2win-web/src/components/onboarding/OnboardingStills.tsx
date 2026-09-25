import moveLight from '../../assets/onboarding/stills/move-light.webp';
import moveDark from '../../assets/onboarding/stills/move-dark.webp';
import togetherLight from '../../assets/onboarding/stills/together-light.webp';
import togetherDark from '../../assets/onboarding/stills/together-dark.webp';
import poolLight from '../../assets/onboarding/stills/pool-light.webp';
import poolDark from '../../assets/onboarding/stills/pool-dark.webp';
import habitLight from '../../assets/onboarding/stills/habit-light.webp';
import habitDark from '../../assets/onboarding/stills/habit-dark.webp';

/**
 * Pre-rendered stills of the four 3D scenes (rendered from the same world, one per page and
 * theme, WebP ~25–50 KB). Used for reduced motion, Data saver, no WebGL2, a lost context, a failed
 * download, or while the 3D scene is still loading on a slow connection. Only the one on screen
 * is requested.
 */
const STILLS: Array<{ light: string; dark: string }> = [
  { light: moveLight, dark: moveDark },
  { light: togetherLight, dark: togetherDark },
  { light: poolLight, dark: poolDark },
  { light: habitLight, dark: habitDark },
];

/** True when the page background token is dark (follows the in-app theme, not just the OS). */
export function readDark(el: Element): boolean {
  const raw = getComputedStyle(el).getPropertyValue('--bg-page').trim();
  const l = Number(raw.split(/\s+/)[2]?.replace('%', ''));
  return Number.isFinite(l) ? l < 40 : window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}

export function OnboardingStill({ index, dark }: { index: number; dark: boolean }) {
  const still = STILLS[index] ?? STILLS[0];
  return (
    <img
      src={dark ? still.dark : still.light}
      alt=""
      decoding="async"
      draggable={false}
      className="absolute inset-0 h-full w-full select-none object-cover object-top"
    />
  );
}
