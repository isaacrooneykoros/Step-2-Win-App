import { lazy, Suspense, useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GoogleOAuthProvider } from '@react-oauth/google';
import { useAuthStore } from './store/authStore';
import { GOOGLE_CLIENT_ID, isGoogleClientIdConfigured } from './config/googleAuth';
import MainLayout from './components/layout/MainLayout';
import { PageLoader } from './components/ui/LoadingSpinner';
import LoginScreen from './screens/LoginScreen';
import RegisterScreen from './screens/RegisterScreen';
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
const StepsDetailScreen = lazy(() => import('./screens/StepsDetailScreen'));
const StepsHistoryScreen = lazy(() => import('./screens/StepsHistoryScreen'));
const StepsDayDetailScreen = lazy(() => import('./screens/StepsDayDetailScreen'));
const SupportScreen = lazy(() => import('./screens/SupportScreen'));
const ActiveSessionsScreen = lazy(() => import('./screens/ActiveSessionsScreen'));

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

export default function App() {
  const [loading, setLoading] = useState(true);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const init = useAuthStore((state) => state.init);
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);

  useEffect(() => {
    init().finally(() => setLoading(false));
  }, [init]);

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
          <Routes>
            {/* Public routes */}
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
              <Route path="/profile/sessions" element={withSuspense(<ActiveSessionsScreen />)} />
              <Route path="/support" element={withSuspense(<SupportScreen />)} />
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
