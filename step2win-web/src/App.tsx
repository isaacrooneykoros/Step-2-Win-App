import { lazy, Suspense, useEffect, useState, useRef } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GoogleOAuthProvider } from '@react-oauth/google';
import { Capacitor } from '@capacitor/core';
import { App as CapacitorApp } from '@capacitor/app';
import { useAuthStore } from './store/authStore';
import { GOOGLE_CLIENT_ID, isGoogleClientIdConfigured } from './config/googleAuth';
import { applyThemeMode, loadThemeMode, ThemeMode } from './config/theme';
import MainLayout from './components/layout/MainLayout';
import { PageLoader } from './components/ui/LoadingSpinner';
import LoginScreen from './screens/LoginScreen';
import RegisterScreen from './screens/RegisterScreen';
import LaunchSplashScreen from './screens/LaunchSplashScreen';
import type { ReactNode } from 'react';
import { OnboardingScreen } from './components/screens/OnboardingScreen';

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
  const launchSeen = sessionStorage.getItem('launch_seen_v1') === 'true';

  // Still loading auth state - don't redirect yet
  if (loading) {
    return null;
  }

  // Not authenticated paths that are allowed
  const publicPaths = ['/launch', '/login', '/register'];
  const isPublicPath = publicPaths.includes(location.pathname);

  // First visit - show launch screen
  if (!launchSeen && location.pathname !== '/launch' && !isPublicPath) {
    return <Navigate to="/launch" replace />;
  }

  // If not authenticated and trying to access protected route, redirect to login
  if (!isAuthenticated && !isPublicPath) {
    return <Navigate to="/login" replace />;
  }

  // If authenticated and trying to access auth screens, redirect to home
  if (isAuthenticated && ['/launch', '/login', '/register'].includes(location.pathname)) {
    return <Navigate to="/" replace />;
  }

  return null;
}

function NativeBackButtonGuard() {
  const navigate = useNavigate();
  const location = useLocation();
  const lastBackPressRef = useRef(0);
  const backPressTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'android') {
      return;
    }

    const listener = CapacitorApp.addListener('backButton', ({ canGoBack }) => {
      const now = Date.now();
      const timeSinceLastPress = now - lastBackPressRef.current;
      const DOUBLE_TAP_THRESHOLD = 2000; // 2 seconds

      // If we're not on home, go back or navigate to home
      if (canGoBack) {
        window.history.back();
        lastBackPressRef.current = 0;
        if (backPressTimeoutRef.current) {
          clearTimeout(backPressTimeoutRef.current);
        }
        return;
      }

      // We're on home: check for double-tap to exit
      if (location.pathname !== '/') {
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

      // Show toast notification about double-tap (optional - requires useToast context)
      // For now, we'll just set the timeout to reset the press counter
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
  }, [location.pathname, navigate]);

  return null;
}

export default function App() {
  const [loading, setLoading] = useState(true);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => loadThemeMode());
  const init = useAuthStore((state) => state.init);
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);

  useEffect(() => {
    init().finally(() => setLoading(false));
  }, [init]);

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

  useEffect(() => {
    if (!isAuthenticated) {
      setShowOnboarding(false);
      return;
    }

    const onboardingCompleted = localStorage.getItem('onboarding_completed_v1') === 'true';
    setShowOnboarding(!onboardingCompleted);
  }, [isAuthenticated]);

  const handleOnboardingComplete = () => {
    localStorage.setItem('onboarding_completed_v1', 'true');
    setShowOnboarding(false);
  };

  if (loading) return <PageLoader />;

  return (
    <QueryClientProvider client={queryClient}>
      <GoogleOAuthProvider clientId={isGoogleClientIdConfigured ? GOOGLE_CLIENT_ID : 'invalid-client-id'}>
        <BrowserRouter>
          <NativeBackButtonGuard />
          <AuthLoadRedirect loading={loading} isAuthenticated={isAuthenticated} />
          <Routes>
            {/* Public routes */}
            <Route path="/launch" element={<LaunchSplashScreen />} />
            <Route path="/login" element={<LoginScreen />} />
            <Route path="/register" element={<RegisterScreen />} />

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
          {showOnboarding && <OnboardingScreen onComplete={handleOnboardingComplete} />}
        </BrowserRouter>
      </GoogleOAuthProvider>
    </QueryClientProvider>
  );
}
