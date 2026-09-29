import { lazy, Suspense, type ReactNode } from 'react';
import { Route } from 'react-router-dom';
import { PageLoader } from '../../components/ui/LoadingSpinner';

/**
 * Friends & teams routes (Phase 4 social). Mounted inside the protected MainLayout
 * route in App.tsx with a single `{socialRoutes}` line.
 */
const SocialScreen = lazy(() => import('./SocialScreen'));
const AddFriendScreen = lazy(() => import('./AddFriendScreen'));
const FriendInviteScreen = lazy(() => import('./AddFriendScreen').then((m) => ({ default: m.FriendInviteScreen })));
const TeamDetailScreen = lazy(() => import('./TeamDetailScreen'));
const SocialSettingsScreen = lazy(() => import('./SocialSettingsScreen'));
const SocialInboxScreen = lazy(() => import('./SocialInboxScreen'));

const page = (element: ReactNode) => <Suspense fallback={<PageLoader />}>{element}</Suspense>;

export const socialRoutes = (
  <>
    <Route path="/social" element={page(<SocialScreen />)} />
    <Route path="/social/add" element={page(<AddFriendScreen />)} />
    <Route path="/social/add/:code" element={page(<FriendInviteScreen />)} />
    <Route path="/social/teams/:id" element={page(<TeamDetailScreen />)} />
    <Route path="/social/settings" element={page(<SocialSettingsScreen />)} />
    <Route path="/social/inbox" element={page(<SocialInboxScreen />)} />
  </>
);
