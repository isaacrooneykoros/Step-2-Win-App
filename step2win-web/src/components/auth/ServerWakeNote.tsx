import { useEffect } from 'react';
import { useServerStatus, warmServer } from '../../services/serverWarmup';

/**
 * Shown under a submit button while a request is pending and the server is still
 * waking from sleep, so a slow first sign-in reads as expected rather than broken.
 */
export function ServerWakeNote({ active }: { active: boolean }) {
  const status = useServerStatus();

  // A pending sign-in re-checks the server (a no-op if it answered recently).
  useEffect(() => {
    if (active) void warmServer();
  }, [active]);

  if (!active || status !== 'waking') return null;
  return (
    <p role="status" aria-live="polite" className="mt-2 text-center text-caption text-text-secondary">
      Starting up the server. The first sign-in after a quiet spell can take a few seconds.
    </p>
  );
}
