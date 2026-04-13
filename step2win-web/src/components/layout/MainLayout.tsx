import { useEffect, useMemo, useState } from 'react';
import { Outlet, NavLink, useLocation } from 'react-router-dom';
import { Capacitor } from '@capacitor/core';
import { Home, Footprints, Trophy, Wallet, User, BellRing, Sparkles } from 'lucide-react';
import { useStepsWebSocket } from '../../hooks/useStepsWebSocket';
import { useHealthSync } from '../../hooks/useHealthSync';
import { BaseModal } from '../ui/BaseModal';
import {
  checkNotificationPermission,
  requestNotificationPermission,
  syncReminderNotifications,
} from '../../services/notifications';

type BrandToken = {
  accent: string;
  tint: string;
  label: string;
  icon: typeof Sparkles;
};

const navItems = [
  { to: '/', icon: Home, label: 'Home' },
  { to: '/steps', icon: Footprints, label: 'Steps' },
  { to: '/challenges', icon: Trophy, label: 'Challenges' },
  { to: '/wallet', icon: Wallet, label: 'Wallet' },
  { to: '/profile', icon: User, label: 'Profile' },
];

const BRAND_TOKENS: Record<string, BrandToken> = {
  '/': { accent: '#4F9CF9', tint: '#EFF6FF', label: 'Momentum', icon: Sparkles },
  '/steps': { accent: '#34D399', tint: '#ECFDF5', label: 'Stride', icon: Footprints },
  '/challenges': { accent: '#A78BFA', tint: '#F5F3FF', label: 'Compete', icon: Trophy },
  '/wallet': { accent: '#FBBF24', tint: '#FFFBEB', label: 'Wealth', icon: Wallet },
  '/profile': { accent: '#64748B', tint: '#F1F5F9', label: 'Identity', icon: User },
  '/settings': { accent: '#0F172A', tint: '#E2E8F0', label: 'Control', icon: BellRing },
};

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
  const { syncHealthSilent, connectDevice, isConnectingDevice, permissionStatus } = useHealthSync();
  const [showPermissionModal, setShowPermissionModal] = useState(false);
  const [notificationPermission, setNotificationPermission] = useState<'prompt' | 'prompt-with-rationale' | 'granted' | 'denied' | 'unavailable'>('prompt');

  const isNative = Capacitor.isNativePlatform();
  const brand = useMemo(() => {
    const token = BRAND_TOKENS[location.pathname] || BRAND_TOKENS['/'];
    return token;
  }, [location.pathname]);

  const canRequestDevicePermission = useMemo(() => {
    return isNative && permissionStatus !== 'unavailable' && permissionStatus !== 'granted';
  }, [isNative, permissionStatus]);

  const canRequestNotificationPermission = useMemo(() => {
    return isNative && notificationPermission !== 'granted';
  }, [isNative, notificationPermission]);

  useEffect(() => {
    syncHealthSilent();

    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        syncHealthSilent();
      }
    }, 1500);

    return () => window.clearInterval(interval);
  }, [syncHealthSilent]);

  useEffect(() => {
    let cancelled = false;

    const loadPermissions = async () => {
      if (!isNative) {
        setNotificationPermission('granted');
        return;
      }

      const status = await checkNotificationPermission();
      if (!cancelled) {
        setNotificationPermission(status);
      }
    };

    loadPermissions();

    return () => {
      cancelled = true;
    };
  }, [isNative]);

  useEffect(() => {
    if (!isNative) return;
    syncReminderNotifications(readNotificationPreferences()).catch(() => null);
  }, [isNative, notificationPermission]);

  useEffect(() => {
    if (!canRequestDevicePermission && !canRequestNotificationPermission) {
      setShowPermissionModal(false);
      return;
    }

    const dismissedAt = localStorage.getItem('permissions_permission_modal_dismissed_at');
    const cooldownMs = 12 * 60 * 60 * 1000;
    const recentlyDismissed = dismissedAt ? Date.now() - Number(dismissedAt) < cooldownMs : false;

    if (!recentlyDismissed) {
      const timer = window.setTimeout(() => setShowPermissionModal(true), 800);
      return () => window.clearTimeout(timer);
    }
  }, [canRequestDevicePermission, canRequestNotificationPermission]);

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
    localStorage.setItem('permissions_permission_modal_dismissed_at', String(Date.now()));
    setShowPermissionModal(false);
  };

  const handleEnableEverything = async () => {
    await handleEnablePermission();
    await handleEnableNotifications();
    setShowPermissionModal(false);
  };

  const activeAccent = brand.accent;

  return (
    <div
      className="app-shell min-h-screen flex flex-col"
      style={{
        background: `radial-gradient(circle at top, ${activeAccent}22, transparent 30%), hsl(var(--bg-page))`,
      }}
    >
      <div
        className="pointer-events-none fixed inset-x-0 top-0 h-24"
        style={{ background: `linear-gradient(180deg, ${activeAccent}18, transparent 72%)` }}
      />

      <div className="flex-1 overflow-y-auto pb-24">
        <Outlet />
      </div>

      <nav
        className="app-bottom-nav fixed bottom-0 left-0 right-0 px-3 pb-3 safe-bottom"
        style={{ boxShadow: '0 -14px 34px rgba(15, 23, 42, 0.14)' }}
      >
        <div
          className="mx-auto grid grid-cols-5 items-stretch gap-1 rounded-[28px] px-2 py-2 backdrop-blur-xl"
          style={{
            background: 'hsl(var(--bg-elevated) / 0.88)',
            border: '1px solid hsl(var(--border-default))',
          }}
        >
          {navItems.map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) => `
                flex min-w-0 flex-col items-center justify-center rounded-[20px] px-1 py-2 transition-all
                ${isActive ? 'text-text-primary' : 'text-text-muted'}
              `}
            >
              {({ isActive }) => (
                <div
                  className="flex w-full min-w-0 flex-col items-center gap-1"
                  style={{
                    background: isActive ? `${activeAccent}14` : 'transparent',
                    boxShadow: isActive ? `0 8px 20px ${activeAccent}22` : 'none',
                  }}
                >
                  <div
                    className="flex h-9 w-9 items-center justify-center rounded-2xl transition-all"
                    style={{
                      background: isActive ? `${activeAccent}18` : 'transparent',
                      color: isActive ? activeAccent : 'inherit',
                    }}
                  >
                    <Icon size={18} strokeWidth={isActive ? 2.4 : 1.9} />
                  </div>
                  <span className={`text-[10px] sm:text-xs font-semibold leading-none ${isActive ? 'text-text-primary' : 'text-text-muted'}`}>
                    {label}
                  </span>
                </div>
              )}
            </NavLink>
          ))}
        </div>
      </nav>

      <BaseModal open={showPermissionModal} onClose={handleDismissPermission} title="Enable Step2Win permissions">
        <p className="text-sm text-text-secondary mb-4">
          Turn on device access so the app can track steps and send reminders like challenge alerts and wallet updates.
        </p>

        <div className="space-y-3 mb-5">
          <PermissionCard
            title="Step sync"
            subtitle="Uses your phone's built-in motion sensor (activity recognition) to count and sync steps in real time."
            status={permissionStatus === 'granted' ? 'Granted' : 'Needs permission'}
            accent={activeAccent}
          />
          <PermissionCard
            title="Notifications"
            subtitle="Allows reminders, payout alerts, and app notifications."
            status={notificationPermission === 'granted' ? 'Granted' : 'Needs permission'}
            accent="#FBBF24"
          />
        </div>

        <div className="flex flex-col gap-3">
          <button
            onClick={handleEnableEverything}
            disabled={isConnectingDevice}
            className="w-full rounded-2xl px-4 py-3 font-semibold text-white transition-opacity disabled:opacity-60"
            style={{ background: `linear-gradient(135deg, ${activeAccent}, #0F172A)` }}
          >
            {isConnectingDevice ? 'Requesting...' : 'Enable all permissions'}
          </button>
          <div className="flex gap-3">
            <button
              onClick={handleEnablePermission}
              disabled={isConnectingDevice || permissionStatus === 'granted'}
              className="flex-1 py-3 rounded-2xl bg-bg-input text-text-secondary font-semibold disabled:opacity-50"
            >
              {permissionStatus === 'granted' ? 'Sensor access on' : 'Allow sensor access'}
            </button>
            <button
              onClick={handleEnableNotifications}
              disabled={notificationPermission === 'granted'}
              className="flex-1 py-3 rounded-2xl bg-bg-input text-text-secondary font-semibold disabled:opacity-50"
            >
              {notificationPermission === 'granted' ? 'Notifications on' : 'Allow notifications'}
            </button>
          </div>
          <button
            onClick={handleDismissPermission}
            className="w-full py-3 rounded-2xl text-text-muted font-semibold"
          >
            Maybe later
          </button>
        </div>
      </BaseModal>
    </div>
  );
}

function PermissionCard({
  title,
  subtitle,
  status,
  accent,
}: {
  title: string;
  subtitle: string;
  status: string;
  accent: string;
}) {
  return (
    <div className="rounded-2xl border border-border bg-bg-card p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-text-primary">{title}</p>
          <p className="text-xs text-text-muted mt-0.5">{subtitle}</p>
        </div>
        <span className="rounded-full px-2.5 py-1 text-[11px] font-semibold" style={{ background: `${accent}16`, color: accent }}>
          {status}
        </span>
      </div>
    </div>
  );
}
