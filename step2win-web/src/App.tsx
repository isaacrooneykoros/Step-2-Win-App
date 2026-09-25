import { lazy, Suspense, useCallback, useEffect, useState, useRef } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Capacitor } from '@capacitor/core';
import { App as CapacitorApp } from '@capacitor/app';
import { useAuthStore } from './store/authStore';
import { applyThemeMode, loadThemeMode, ThemeMode } from './config/theme';
import MainLayout from './components/layout/MainLayout';
import { PageLoader } from './components/ui/LoadingSpinner';
import { Toaster, toast } from './components/ui/Toast';
import { runBackHandlers } from './lib/backButton';
import { hideNativeSplash } from './lib/nativeShell';
import { BiometricLockGate } from './components/security/BiometricLockGate';
import { ErrorBoundary } from './components/ErrorBoundary';
import LoginScreen from './screens/LoginScreen';
import RegisterScreen from './screens/RegisterScreen';
import ForgotPasswordScreen from './screens/ForgotPasswordScreen';
import { BootSplash, shouldShowBootSplash } from './components/splash/BootSplash';
import { setOnboardingOpen, useOnboardingOpen } from './lib/launchState';
import type { ReactNode } from 'react';

const ONBOARDING_KEY = 'onboarding_completed_v1';
/** A cold start here may open with the onboarding. Deep links (e.g. /forgot-password) go straight through. */
const ONBOARDING_ENTRY_PATHS = ['/', '/login', '/launch'];

type OnboardingNext = 'register' | 'login';

function onboardingCompleted(): boolean {
  try {
    return localStorage.getItem(ONBOARDING_KEY) === 'true';
  } catch {
    return true;
  }
}

function markOnboardingCompleted() {
  try {
    localStorage.setItem(ONBOARDING_KEY, 'true');
  } catch {
    // Storage unavailable: the onboarding simply shows again on the next cold start.
  }
}

// The onboarding (and its 3D scene) is only needed once per install: keep it out of the entry chunk.
// It is fetched as soon as a device that has not seen it starts, so it is mounted when the splash leaves.
const loadOnboardingChunk = () => import('./components/screens/OnboardingScreen');
let onboardingChunk: ReturnType<typeof loadOnboardingChunk> | null = null;
function preloadOnboarding() {
  onboardingChunk ??= loadOnboardingChunk();
  return onboardingChunk;
}
/** The chunk failed to load (offline first launch, bad deploy): go straight to sign-in instead. */
function OnboardingUnavailable({ onComplete }: { onComplete: (next: OnboardingNext) => void }) {
  useEffect(() => {
    onComplete('login');
  }, [onComplete]);
  return null;
}
const OnboardingScreen = lazy(() => preloadOnboarding().catch(() => ({ default: OnboardingUnavailable })));

/** Tells the launch splash that the onboarding has committed underneath it (so the logo can fly into its header). */
function MountSignal({ onMount }: { onMount: () => void }) {
  useEffect(() => {
    onMount();
  }, [onMount]);
  return null;
}

/** First-run onboarding over the signed-out entry; it hands over to Register or Login. */
function OnboardingGate({ onMounted, onClose }: { onMounted: () => void; onClose: () => void }) {
  const navigate = useNavigate();
  const location = useLocation();

  const handleComplete = useCallback(
    (next: OnboardingNext) => {
      markOnboardingCompleted();
      const target = next === 'login' ? '/login' : '/register';
      // Route first, then close the overlay, so the screen under it is already the right one.
      if (location.pathname !== target) navigate(target, { replace: true });
      onClose();
    },
    [location.pathname, navigate, onClose],
  );

  return (
    <Suspense fallback={<div className="fixed inset-0 z-50 bg-bg-page" aria-busy="true" />}>
      <OnboardingScreen onComplete={handleComplete} />
      <MountSignal onMount={onMounted} />
    </Suspense>
  );
}

const HomeScreen = lazy(() => import('./screens/HomeScreen'));
const ChallengesScreen = lazy(() => import('./screens/ChallengesScreen'));
const ChallengeDetailScreen = lazy(() => import('./screens/ChallengeDetailScreen'));
const ChallengeResultsScreen = lazy(() => import('./screens/ChallengeResultsScreen'));
const ChallengesLobbyScreen = lazy(() => import('./screens/ChallengesLobbyScreen'));
const ChallengePreviewScreen = lazy(() => import('./screens/ChallengePreviewScreen'));
const SpectatorScreen = lazy(() => import('./screens/SpectatorScreen'));
const WalletScreen = lazy(() => import('./screens/WalletScreen'));
const ProfileScreen = lazy(() => import('./screens/ProfileScreen'));
const ProfileAnalyticsScreen = lazy(() => import('./screens/ProfileAnalyticsScreen'));
const SettingsScreen = lazy(() => import('./screens/SettingsScreen'));
const SyncOutboxScreen = lazy(() => import('./screens/SyncOutboxScreen'));
const StepsDetailScreen = lazy(() => import('./screens/StepsDetailScreen'));
const StepsHistoryScreen = lazy(() => import('./screens/StepsHistoryScreen'));
const StepsDayDetailScreen = lazy(() => import('./screens/StepsDayDetailScreen'));
const SupportScreen = lazy(() => import('./screens/SupportScreen'));
const ActiveSessionsScreen = lazy(() => import('./screens/ActiveSessionsScreen'));
const LegalDocumentScreen = lazy(() => import('./screens/LegalDocumentScreen'));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
      staleTime: 30000,
    },
  },
});

function ProtectedRoute({ children }: { children: ReactNode }) {
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  return isAuthenticated ? <>{children}</> : <Navigate to="/login" replace />;
}

function withSuspense(element: ReactNode) {
  return <Suspense fallback={<PageLoader />}>{element}</Suspense>;
}

function AuthLoadRedirect({
  loading,
  isAuthenticated,
}: {
  loading: boolean;
  isAuthenticated: boolean;
}) {
  const location = useLocation();

  // Still loading auth state - don't redirect yet
  if (loading) {
    return null;
  }

  // Not authenticated paths that are allowed. (The launch splash is an overlay now — BootSplash —
  // so there is no separate /launch step; the route only redirects for old links.)
  const publicPaths = ['/launch', '/login', '/register', '/forgot-password'];
  const isPublicPath = publicPaths.includes(location.pathname);

  // If not authenticated and trying to access protected route, redirect to login
  if (!isAuthenticated && !isPublicPath) {
    return <Navigate to="/login" replace />;
  }

  // If authenticated and trying to access auth screens, redirect to home
  if (isAuthenticated && ['/launch', '/login', '/register', '/forgot-password'].includes(location.pathname)) {
    return <Navigate to="/" replace />;
  }

  return null;
}

function NativeBackButtonGuard() {
  const navigate = useNavigate();
  const location = useLocation();
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const onboardingOpen = useOnboardingOpen();
  const lastBackPressRef = useRef(0);
  const backPressTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'android') {
      return;
    }

    const listener = CapacitorApp.addListener('backButton', ({ canGoBack }) => {
      // Open sheets / the lock screen get first refusal (they close or swallow the press).
      if (runBackHandlers()) {
        return;
      }

      const now = Date.now();
      const timeSinceLastPress = now - lastBackPressRef.current;
      const DOUBLE_TAP_THRESHOLD = 2000; // 2 seconds

      // The first-run onboarding (its own handler already stepped back through the pages) and
      // the signed-out entry screen are the app's root, like Home: back exits (double-tap).
      // Navigating to '/' from there would only bounce back to /login.
      const atRoot = onboardingOpen || location.pathname === '/' || (!isAuthenticated && location.pathname === '/login');

      // If we're not on home, go back or navigate to home
      if (canGoBack && !onboardingOpen) {
        window.history.back();
        lastBackPressRef.current = 0;
        if (backPressTimeoutRef.current) {
          clearTimeout(backPressTimeoutRef.current);
        }
        return;
      }

      // We're on home: check for double-tap to exit
      if (!atRoot) {
        navigate('/', { replace: true });
        lastBackPressRef.current = 0;
        if (backPressTimeoutRef.current) {
          clearTimeout(backPressTimeoutRef.current);
        }
        return;
      }

      // On home screen: double-tap to exit
      if (timeSinceLastPress < DOUBLE_TAP_THRESHOLD && lastBackPressRef.current !== 0) {
        // Double tap detected - exit app
        CapacitorApp.exitApp().catch(() => null);
        return;
      }

      // First tap - show message
      lastBackPressRef.current = now;

      // Clear the previous message timeout and set a new one
      if (backPressTimeoutRef.current) {
        clearTimeout(backPressTimeoutRef.current);
      }

      toast({ message: 'Press back again to exit', type: 'info', duration: 2000 });
      backPressTimeoutRef.current = setTimeout(() => {
        lastBackPressRef.current = 0;
      }, DOUBLE_TAP_THRESHOLD);
    });

    return () => {
      listener.then((handle) => handle.remove()).catch(() => null);
      if (backPressTimeoutRef.current) {
        clearTimeout(backPressTimeoutRef.current);
      }
    };
  }, [location.pathname, navigate, isAuthenticated, onboardingOpen]);

  return null;
}

export default function App() {
  const [loading, setLoading] = useState(true);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [onboardingMounted, setOnboardingMounted] = useState(false);
  const [bootSplash, setBootSplash] = useState(shouldShowBootSplash);
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => loadThemeMode());
  // Where this cold start landed, before any auth redirect rewrites it.
  const [entryPath] = useState(() => window.location.pathname);
  const init = useAuthStore((state) => state.init);
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);

  useEffect(() => {
    // A device that has not seen the onboarding may need it right after the splash: fetch it now.
    if (!onboardingCompleted() && ONBOARDING_ENTRY_PATHS.includes(entryPath)) {
      void preloadOnboarding().catch(() => null);
    }
    init().finally(() => {
      // Signed-out, first run, opened on the default entry: splash → onboarding → Register / Login.
      // Signed-in users never see it (existing installs updating the app just get the flag).
      const signedIn = useAuthStore.getState().isAuthenticated;
      setShowOnboarding(!signedIn && !onboardingCompleted() && ONBOARDING_ENTRY_PATHS.includes(entryPath));
      setLoading(false);
      // Tokens are restored: the first real frame (or the lock screen) replaces the splash.
      hideNativeSplash();
    });
  }, [init, entryPath]);

  // Any authenticated session (restored, or a sign-in from a deep-linked Register / Login)
  // counts as having been introduced to the app.
  useEffect(() => {
    if (isAuthenticated && !onboardingCompleted()) markOnboardingCompleted();
  }, [isAuthenticated]);

  useEffect(() => {
    applyThemeMode(themeMode);

    const handleThemeModeChange = (event: Event) => {
      const detail = (event as CustomEvent<ThemeMode>).detail;
      if (detail === 'light' || detail === 'dark' || detail === 'system') {
        setThemeMode(detail);
      }
    };

    const handleStorageChange = () => {
      setThemeMode(loadThemeMode());
    };

    window.addEventListener('theme-mode-change', handleThemeModeChange as EventListener);
    window.addEventListener('storage', handleStorageChange);

    return () => {
      window.removeEventListener('theme-mode-change', handleThemeModeChange as EventListener);
      window.removeEventListener('storage', handleStorageChange);
    };
  }, [themeMode]);

  const closeOnboarding = useCallback(() => setShowOnboarding(false), []);
  const handleOnboardingMounted = useCallback(() => setOnboardingMounted(true), []);

  const onboardingVisible = showOnboarding && !isAuthenticated;
  useEffect(() => {
    setOnboardingOpen(onboardingVisible);
  }, [onboardingVisible]);

  // The splash leaves once auth is restored and, on a first run, the onboarding is mounted
  // underneath (so its logo can land in the onboarding header).
  const appReady = !loading && (!showOnboarding || onboardingMounted);
  const splash = bootSplash ? <BootSplash key="boot-splash" ready={appReady} onDone={() => setBootSplash(false)} /> : null;

  if (loading) {
    return (
      <>
        <PageLoader />
        {splash}
      </>
    );
  }

  return (
    <>
    <ErrorBoundary>
    <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <NativeBackButtonGuard />
          <AuthLoadRedirect loading={loading} isAuthenticated={isAuthenticated} />
          <Routes>
            {/* Public routes */}
            <Route path="/launch" element={<Navigate to={isAuthenticated ? '/' : '/login'} replace />} />
            <Route path="/login" element={<LoginScreen />} />
            <Route path="/register" element={<RegisterScreen />} />
            <Route path="/forgot-password" element={<ForgotPasswordScreen />} />

            {/* Protected routes */}
            <Route
              element={
                <ProtectedRoute>
                  <MainLayout />
                </ProtectedRoute>
              }
            >
              <Route path="/" element={withSuspense(<HomeScreen />)} />
              <Route path="/steps" element={withSuspense(<StepsDetailScreen />)} />
              <Route path="/steps/history" element={withSuspense(<StepsHistoryScreen />)} />
              <Route path="/steps/history/:date" element={withSuspense(<StepsDayDetailScreen />)} />
              <Route path="/challenges" element={withSuspense(<ChallengesScreen />)} />
              <Route path="/challenges/lobby" element={withSuspense(<ChallengesLobbyScreen />)} />
              <Route path="/challenges/lobby/:id" element={withSuspense(<ChallengePreviewScreen />)} />
              <Route path="/challenges/:id/spectate" element={withSuspense(<SpectatorScreen />)} />
              <Route path="/challenges/:id/results" element={withSuspense(<ChallengeResultsScreen />)} />
              <Route path="/challenges/:id" element={withSuspense(<ChallengeDetailScreen />)} />
              <Route path="/wallet" element={withSuspense(<WalletScreen />)} />
              <Route path="/profile" element={withSuspense(<ProfileScreen />)} />
              <Route path="/profile/analytics" element={withSuspense(<ProfileAnalyticsScreen />)} />
              <Route path="/settings" element={withSuspense(<SettingsScreen />)} />
              <Route path="/settings/sync-outbox" element={withSuspense(<SyncOutboxScreen />)} />
              <Route path="/profile/sessions" element={withSuspense(<ActiveSessionsScreen />)} />
              <Route path="/support" element={withSuspense(<SupportScreen />)} />
              <Route path="/legal/:slug" element={withSuspense(<LegalDocumentScreen />)} />
            </Route>

            {/* Fallback */}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
          {onboardingVisible && (
            <OnboardingGate onMounted={handleOnboardingMounted} onClose={closeOnboarding} />
          )}
          <BiometricLockGate />
          <Toaster />
        </BrowserRouter>
    </QueryClientProvider>
    </ErrorBoundary>
    {splash}
    </>
  );
}
