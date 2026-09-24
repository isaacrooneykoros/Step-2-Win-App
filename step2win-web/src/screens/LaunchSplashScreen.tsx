import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';
import { BrandMark, Wordmark } from '../components/brand/BrandMark';
import { usePrefersReducedMotion } from '../lib/motion';

/** Long enough to register the brand, short enough never to feel like a wait. */
const SPLASH_DELAY_MS = 1100;
const SPLASH_DELAY_REDUCED_MS = 700;

export default function LaunchSplashScreen() {
  const navigate = useNavigate();
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    sessionStorage.setItem('launch_seen_v1', 'true');
    const timer = window.setTimeout(() => {
      navigate(isAuthenticated ? '/' : '/login', { replace: true });
    }, reduced ? SPLASH_DELAY_REDUCED_MS : SPLASH_DELAY_MS);

    return () => window.clearTimeout(timer);
  }, [isAuthenticated, navigate, reduced]);

  return (
    <main
      className="flex min-h-[100dvh] flex-col items-center justify-center bg-bg-page px-6 pt-safe pb-safe"
      aria-label="Step2Win is starting"
    >
      <div className="flex flex-col items-center text-center">
        <div className="scale-in">
          <BrandMark size={72} className="shadow-raised rounded-[20px]" title="Step2Win" />
        </div>
        <Wordmark className="fade-in mt-5 text-title-lg [animation-delay:120ms]" />
        <p className="fade-in mt-1.5 text-callout text-text-secondary [animation-delay:220ms]">
          Walk daily. Take on challenges. Stay consistent.
        </p>
      </div>
      <span className="sr-only" role="status">
        Loading
      </span>
    </main>
  );
}
