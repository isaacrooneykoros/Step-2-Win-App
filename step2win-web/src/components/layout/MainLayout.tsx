import { useEffect, useMemo, useRef, useState } from 'react';
import { Outlet, NavLink, useLocation } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Capacitor } from '@capacitor/core';
import { App as CapacitorApp } from '@capacitor/app';
import { Home, Trophy, Wallet, User, Footprints, Bell, Camera, MapPin, Navigation, Activity } from 'lucide-react';
import { useStepsWebSocket } from '../../hooks/useStepsWebSocket';
import { useHealthSync } from '../../hooks/useHealthSync';
import { usePermissionStatus } from '../../hooks/usePermissionStatus';
import { useDataSaver } from '../../hooks/useDataSaver';
import { authService } from '../../services/api';
import { useAuthStore } from '../../store/authStore';
import { Sheet } from '../ui/Sheet';
import Button from '../ui/Button';
import { IconTile, Pill } from '../ui/Pill';
import { ConnectionBanner } from '../ui/ConnectionBanner';
import { useBootSplashActive, useOnboardingOpen } from '../../lib/launchState';
import { isIOSApp, permissionCopy } from '../../utils/platform';
import {
  checkNotificationPermission,
  requestNotificationPermission,
  syncReminderNotifications,
} from '../../services/notifications';
import { checkCameraPermission, requestCameraPermission, type CameraPermissionState } from '../../services/cameraPermissions';
import {
  checkAdvancedPermissionSnapshot,
  requestBackgroundLocationPermission,
  requestForegroundLocationPermission,
  type LocationPermissionState,
} from '../../services/locationPermissions';

const PERMISSIONS_BOOTSTRAP_DONE_KEY = 'permissions_bootstrap_done_v1';

// Four destinations keep the bar calm. Step activity lives under Home (its hero ring links to /steps).
const navItems = [
  { to: '/', icon: Home, label: 'Home', match: (p: string) => p === '/' || p.startsWith('/steps') },
  { to: '/challenges', icon: Trophy, label: 'Challenges', match: (p: string) => p.startsWith('/challenges') },
  { to: '/wallet', icon: Wallet, label: 'Wallet', match: (p: string) => p.startsWith('/wallet') },
  {
    to: '/profile',
    icon: User,
    label: 'Profile',
    match: (p: string) => ['/profile', '/settings', '/support', '/legal'].some((prefix) => p.startsWith(prefix)),
  },
];

function readNotificationPreferences() {
  try {
    const raw = localStorage.getItem('app_preferences_v1');
    if (!raw) return { pushNotifications: true, challengeReminders: true, payoutAlerts: true };
    const parsed = JSON.parse(raw);
    return {
      pushNotifications: parsed.pushNotifications !== false,
      challengeReminders: parsed.challengeReminders !== false,
      payoutAlerts: parsed.payoutAlerts !== false,
    };
  } catch {
    return { pushNotifications: true, challengeReminders: true, payoutAlerts: true };
  }
}

export default function MainLayout() {
  const location = useLocation();
  useStepsWebSocket();
  const { syncHealthSilent, syncHealthNow, connectDevice, isConnectingDevice, permissionStatus } = useHealthSync();
  const { stepSyncIntervalMs } = useDataSaver();
  const queryClient = useQueryClient();
  const [permissionsVersion, setPermissionsVersion] = useState(0);
  const { permissionStatus: globalPermissionStatus } = usePermissionStatus();
  const [showPermissionModal, setShowPermissionModal] = useState(false);
  // Ask for permissions only once the launch splash and the first-run onboarding are out of the way.
  const onboardingOpen = useOnboardingOpen();
  const bootSplashActive = useBootSplashActive();
  const [notificationPermission, setNotificationPermission] = useState<'prompt' | 'prompt-with-rationale' | 'granted' | 'denied' | 'unavailable'>('prompt');
  const [cameraPermission, setCameraPermission] = useState<CameraPermissionState>('prompt');
  const [locationPermission, setLocationPermission] = useState<LocationPermissionState>('prompt');
  const [backgroundLocationPermission, setBackgroundLocationPermission] = useState<LocationPermissionState>('prompt');

  const isNative = Capacitor.isNativePlatform();
  const updateUser = useAuthStore((state) => state.updateUser);

  // The auth store restores tokens on launch but not the user object; hydrate it from the
  // profile endpoint so greetings, balances and goals are correct after a reload.
  const { data: profile } = useQuery({ queryKey: ['profile'], queryFn: authService.getProfile });
  useEffect(() => {
    if (profile) updateUser(profile);
  }, [profile, updateUser]);

  // Scroll to top on navigation (the document scrolls, not an inner container).
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [location.pathname]);

  const canRequestDevicePermission = useMemo(() => {
    return isNative && permissionStatus !== 'unavailable' && permissionStatus !== 'granted';
  }, [isNative, permissionStatus]);

  const canRequestNotificationPermission = useMemo(() => {
    return isNative && notificationPermission !== 'granted';
  }, [isNative, notificationPermission]);

  const canRequestCameraPermission = useMemo(() => {
    return isNative && cameraPermission !== 'granted';
  }, [isNative, cameraPermission]);

  const canRequestLocationPermission = useMemo(() => {
    return isNative && locationPermission !== 'granted';
  }, [isNative, locationPermission]);

  // Background step sync: every 30 s, or every 5 min with data saver on (switches instantly).
  useEffect(() => {
    syncHealthSilent();

    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        syncHealthSilent();
      }
    }, stepSyncIntervalMs);

    return () => window.clearInterval(interval);
  }, [stepSyncIntervalMs, syncHealthSilent]);

  // App resume: sync steps immediately (even with data saver), refresh what's on screen if the
  // app was away for a while, and re-read permissions the user may have changed in Settings.
  const syncNowRef = useRef(syncHealthNow);
  syncNowRef.current = syncHealthNow;
  useEffect(() => {
    if (!isNative) return;
    let pausedAt = 0;
    const handle = CapacitorApp.addListener('appStateChange', ({ isActive }) => {
      if (!isActive) {
        pausedAt = Date.now();
        return;
      }
      void syncNowRef.current();
      setPermissionsVersion((v) => v + 1);
      if (pausedAt && Date.now() - pausedAt > 30_000) {
        void queryClient.invalidateQueries({ refetchType: 'active' });
      }
      pausedAt = 0;
    });
    return () => {
      handle.then((h) => h.remove()).catch(() => null);
    };
  }, [isNative, queryClient]);

  useEffect(() => {
    let cancelled = false;

    const loadPermissions = async () => {
      if (!isNative) {
        setNotificationPermission('granted');
        return;
      }

      const status = await checkNotificationPermission();
      const camera = await checkCameraPermission();
      const advanced = await checkAdvancedPermissionSnapshot();
      if (!cancelled) {
        setNotificationPermission(status);
        setCameraPermission(camera);
        setLocationPermission(advanced.location);
        setBackgroundLocationPermission(advanced.backgroundLocation);
      }
    };

    loadPermissions();

    return () => {
      cancelled = true;
    };
  }, [isNative, permissionsVersion]);

  useEffect(() => {
    if (!isNative) return;
    syncReminderNotifications(readNotificationPreferences()).catch(() => null);
  }, [isNative, notificationPermission]);

  useEffect(() => {
    const alreadyDone = localStorage.getItem(PERMISSIONS_BOOTSTRAP_DONE_KEY) === 'true';
    if (alreadyDone) {
      setShowPermissionModal(false);
      return;
    }

    if (!canRequestDevicePermission && !canRequestNotificationPermission && !canRequestCameraPermission && !canRequestLocationPermission) {
      localStorage.setItem(PERMISSIONS_BOOTSTRAP_DONE_KEY, 'true');
      setShowPermissionModal(false);
      return;
    }

    if (onboardingOpen || bootSplashActive) return;
    const timer = window.setTimeout(() => setShowPermissionModal(true), 700);
    return () => window.clearTimeout(timer);
  }, [canRequestCameraPermission, canRequestDevicePermission, canRequestLocationPermission, canRequestNotificationPermission, onboardingOpen, bootSplashActive]);

  const handleEnablePermission = async () => {
    const ok = await connectDevice();
    if (ok) {
      syncHealthSilent();
    }
  };

  const handleEnableNotifications = async () => {
    const granted = await requestNotificationPermission();
    setNotificationPermission(granted ? 'granted' : 'denied');
    if (granted) {
      await syncReminderNotifications(readNotificationPreferences()).catch(() => null);
    }
  };

  const handleDismissPermission = () => {
    localStorage.setItem(PERMISSIONS_BOOTSTRAP_DONE_KEY, 'true');
    setShowPermissionModal(false);
  };

  const handleEnableEverything = async () => {
    await handleEnablePermission();
    await handleEnableNotifications();
    const cameraGranted = await requestCameraPermission();
    setCameraPermission(cameraGranted ? 'granted' : 'denied');

    const locationGranted = await requestForegroundLocationPermission();
    setLocationPermission(locationGranted ? 'granted' : 'denied');

    if (locationGranted && !isIOSApp()) {
      const backgroundGranted = await requestBackgroundLocationPermission();
      setBackgroundLocationPermission(backgroundGranted ? 'granted' : 'denied');
    }

    localStorage.setItem(PERMISSIONS_BOOTSTRAP_DONE_KEY, 'true');
    setShowPermissionModal(false);
  };

  const activityDenied = globalPermissionStatus.activityRecognition === 'denied';
  const showActivityBanner = isNative && globalPermissionStatus.activityRecognition !== 'granted';

  return (
    <div className="app-shell flex min-h-[100dvh] flex-col">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[130] focus:rounded-xl focus:bg-bg-card focus:px-4 focus:py-2 focus:shadow-raised"
      >
        Skip to content
      </a>

      <div className="sticky top-0 z-40">
        <ConnectionBanner />
        {showActivityBanner && (
          <div className="flex items-center gap-3 bg-warning-soft px-4 py-2.5 pt-safe" role="status">
            <Activity size={16} className="shrink-0 text-warning" aria-hidden />
            <p className="min-w-0 flex-1 text-caption font-medium text-text-primary">
              {activityDenied
                ? `Step counting is off. Allow ${permissionCopy().motionName} access to record steps.`
                : `Allow ${permissionCopy().motionName} access to start counting steps.`}
            </p>
            {activityDenied ? (
              <button
                type="button"
                onClick={handleEnablePermission}
                disabled={isConnectingDevice}
                className="shrink-0 text-caption font-semibold text-warning underline-offset-2 hover:underline"
              >
                Open settings
              </button>
            ) : (
              <button
                type="button"
                onClick={handleEnablePermission}
                disabled={isConnectingDevice}
                className="shrink-0 text-caption font-semibold text-warning underline-offset-2 hover:underline"
              >
                {isConnectingDevice ? 'Requesting…' : 'Allow'}
              </button>
            )}
          </div>
        )}
      </div>

      <main id="main" className="flex-1">
        <div key={location.pathname} className="screen-enter">
          <Outlet />
        </div>
      </main>

      <nav
        aria-label="Primary"
        className="app-bottom-nav fixed inset-x-0 bottom-0 z-50 border-t border-border-light bg-bg-elevated/95 backdrop-blur-md safe-bottom"
      >
        <ul className="mx-auto grid h-[var(--nav-height)] max-w-md grid-cols-4">
          {navItems.map(({ to, icon: Icon, label, match }) => {
            const active = match(location.pathname);
            return (
              <li key={to} className="flex">
                <NavLink
                  to={to}
                  end={to === '/'}
                  aria-current={active ? 'page' : undefined}
                  className={`relative flex flex-1 flex-col items-center justify-center gap-1 active:!scale-95 ${
                    active ? 'text-brand' : 'text-text-muted hover:text-text-secondary'
                  }`}
                >
                  <span
                    aria-hidden
                    className={`absolute top-0 h-[3px] w-8 rounded-b-full bg-brand transition-opacity duration-normal ${active ? 'opacity-100' : 'opacity-0'}`}
                  />
                  <Icon size={22} strokeWidth={active ? 2.3 : 1.8} aria-hidden />
                  <span className={`text-micro ${active ? 'font-semibold' : 'font-medium'}`}>{label}</span>
                </NavLink>
              </li>
            );
          })}
        </ul>
      </nav>

      <Sheet
        open={showPermissionModal}
        onClose={handleDismissPermission}
        title="Set up step tracking"
        description="Step2Win counts steps with your phone's motion sensor. Choose what to allow — you can change this any time in Settings."
        footer={
          <div className="flex flex-col gap-2">
            <Button fullWidth size="lg" onClick={handleEnableEverything} isLoading={isConnectingDevice} loadingText="Requesting access…">
              Allow access
            </Button>
            <Button fullWidth variant="ghost" onClick={handleDismissPermission}>
              Not now
            </Button>
          </div>
        }
      >
        <div className="divide-y divide-border-light overflow-hidden rounded-card border border-border-light">
          <PermissionRow
            icon={Footprints}
            title={permissionCopy().motionName}
            subtitle="Counts and verifies your steps in real time."
            granted={permissionStatus === 'granted'}
            required
          />
          <PermissionRow
            icon={Bell}
            title="Notifications"
            subtitle="Challenge reminders, results and payout updates."
            granted={notificationPermission === 'granted'}
          />
          <PermissionRow
            icon={Camera}
            title="Camera"
            subtitle="Scan challenge invite QR codes."
            granted={cameraPermission === 'granted'}
          />
          <PermissionRow
            icon={MapPin}
            title="Location"
            subtitle="Draws your walking route on the activity map."
            granted={locationPermission === 'granted'}
          />
          {!isIOSApp() && (
            <PermissionRow
              icon={Navigation}
              title="Background location"
              subtitle="Keeps routes continuous while the app is closed."
              granted={backgroundLocationPermission === 'granted'}
              optional
            />
          )}
        </div>
      </Sheet>
    </div>
  );
}

function PermissionRow({
  icon,
  title,
  subtitle,
  granted,
  required = false,
  optional = false,
}: {
  icon: typeof Footprints;
  title: string;
  subtitle: string;
  granted: boolean;
  required?: boolean;
  optional?: boolean;
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <IconTile icon={icon} tone={granted ? 'success' : 'neutral'} size="sm" />
      <div className="min-w-0 flex-1">
        <p className="text-callout font-semibold text-text-primary">
          {title}
          {required && <span className="ml-1.5 text-micro font-medium text-text-muted">Required</span>}
        </p>
        <p className="text-caption text-text-muted">{subtitle}</p>
      </div>
      {granted ? (
        <Pill tone="success">Allowed</Pill>
      ) : (
        <Pill tone="neutral">{optional ? 'Optional' : 'Off'}</Pill>
      )}
    </div>
  );
}
