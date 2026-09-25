import { useEffect, useState } from 'react';
import { BrandMark, Wordmark } from '../brand/BrandMark';
import { OnboardingStill, readDark } from './OnboardingStills';

/**
 * Shown while the onboarding chunk loads. It matches the onboarding's opening frame (header in the
 * same place, page 1's pre-rendered scene), so the launch splash can hand over to it at once instead
 * of waiting on a slow phone, and the real screen then takes over without a visible change.
 */
export function OnboardingPlaceholder({ onMount }: { onMount: () => void }) {
  const [dark] = useState(() => readDark(document.documentElement));

  useEffect(() => {
    onMount();
  }, [onMount]);

  return (
    <div className="fixed inset-0 z-50 select-none overflow-hidden bg-bg-page" aria-busy="true">
      <div className="absolute inset-0" aria-hidden="true">
        <OnboardingStill index={0} dark={dark} />
      </div>
      <div className="relative mx-auto flex h-full w-full max-w-md flex-col">
        <div className="shrink-0 pt-safe">
          <div className="flex h-14 items-center justify-between pl-5 pr-2">
            <span className="inline-flex items-center gap-2">
              <BrandMark size={28} className="splash-anchor" />
              <Wordmark className="text-headline" />
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
