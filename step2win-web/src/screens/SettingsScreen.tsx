import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  ChevronLeft,
  Bell,
  Shield,
  Smartphone,
  Lock,
  Mail,
  Target,
  LifeBuoy,
  FileText,
  Moon,
  Sun,
  LogOut,
  Activity,
  Monitor,
} from 'lucide-react';
import { authService } from '../services/api';
import { useAuthStore } from '../store/authStore';
import { useToast } from '../components/ui/Toast';
import { BaseModal } from '../components/ui/BaseModal';
import { useHealthSync } from '../hooks/useHealthSync';
import type { User } from '../types';
import { applyThemeMode, loadThemeMode, saveThemeMode, type ThemeMode } from '../config/theme';
import { checkNotificationPermission, requestNotificationPermission, syncReminderNotifications } from '../services/notifications';

type PreferencesState = {
  pushNotifications: boolean;
  challengeReminders: boolean;
  payoutAlerts: boolean;
  biometricsLock: boolean;
  reduceMotion: boolean;
  dataSaver: boolean;
};

const PREFS_KEY = 'app_preferences_v1';

function loadPreferences(): PreferencesState {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) {
      return {
        pushNotifications: true,
        challengeReminders: true,
        payoutAlerts: true,
        biometricsLock: false,
        reduceMotion: false,
        dataSaver: false,
      };
    }
    return JSON.parse(raw) as PreferencesState;
  } catch {
    return {
      pushNotifications: true,
      challengeReminders: true,
      payoutAlerts: true,
      biometricsLock: false,
      reduceMotion: false,
      dataSaver: false,
    };
  }
}

export default function SettingsScreen() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { logout } = useAuthStore();
  const { connectDevice, isConnectingDevice, permissionStatus } = useHealthSync();

  const [preferences, setPreferences] = useState<PreferencesState>(() => loadPreferences());
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => loadThemeMode());
  const [notificationPermission, setNotificationPermission] = useState<'prompt' | 'prompt-with-rationale' | 'granted' | 'denied' | 'unavailable'>('prompt');
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [passwordForm, setPasswordForm] = useState({
    current_password: '',
    new_password: '',
    confirm_password: '',
  });
  const [profileForm, setProfileForm] = useState({
    email: '',
    phone_number: '',
    daily_goal: 10000,
  });

  const { data: profile } = useQuery<User>({
    queryKey: ['profile'],
    queryFn: authService.getProfile,
  });

  useEffect(() => {
    if (!profile) return;
    setProfileForm({
      email: profile.email || '',
      phone_number: profile.phone_number || '',
      daily_goal: profile.daily_goal || 10000,
    });
  }, [profile]);

  useEffect(() => {
    localStorage.setItem(PREFS_KEY, JSON.stringify(preferences));
  }, [preferences]);

  useEffect(() => {
    document.documentElement.classList.toggle('reduce-motion', preferences.reduceMotion);
  }, [preferences.reduceMotion]);

  useEffect(() => {
    saveThemeMode(themeMode);
    applyThemeMode(themeMode);
  }, [themeMode]);

  useEffect(() => {
    let cancelled = false;

    const loadPermission = async () => {
      const status = await checkNotificationPermission();
      if (!cancelled) {
        setNotificationPermission(status);
      }
    };

    loadPermission();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (notificationPermission !== 'granted') return;
    syncReminderNotifications(preferences).catch(() => null);
  }, [notificationPermission, preferences]);

  const changePasswordMutation = useMutation({
    mutationFn: (data: { old_password: string; new_password: string; confirm_password: string }) => authService.changePassword(data),
    onSuccess: () => {
      setShowPasswordModal(false);
      setPasswordForm({ current_password: '', new_password: '', confirm_password: '' });
      showToast({ message: 'Password updated successfully.', type: 'success' });
    },
    onError: (error: any) => {
      showToast({ message: error?.response?.data?.error || 'Failed to change password.', type: 'error' });
    },
  });

  const updateProfileMutation = useMutation({
    mutationFn: (data: Partial<User>) => authService.updateProfile(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['profile'] });
      setShowProfileModal(false);
      showToast({ message: 'Profile updated successfully.', type: 'success' });
    },
    onError: (error: any) => {
      showToast({ message: error?.response?.data?.error || 'Failed to update profile.', type: 'error' });
    },
  });

  const deviceStatus = useMemo(() => {
    if (permissionStatus === 'granted') return { label: 'Connected', dot: 'bg-accent-green' };
    if (permissionStatus === 'denied') return { label: 'Permission Required', dot: 'bg-accent-red' };
    if (permissionStatus === 'unavailable') return { label: 'Mobile app required', dot: 'bg-text-muted' };
    return { label: 'Initializing', dot: 'bg-accent-yellow' };
  }, [permissionStatus]);

  const notificationStatus = useMemo(() => {
    if (notificationPermission === 'granted') return { label: 'Enabled', dot: 'bg-accent-green' };
    if (notificationPermission === 'denied') return { label: 'Permission required', dot: 'bg-accent-red' };
    return { label: 'Available', dot: 'bg-accent-yellow' };
  }, [notificationPermission]);

  const onTogglePreference = (key: keyof PreferencesState) => {
    setPreferences((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const onSelectTheme = (mode: ThemeMode) => {
    setThemeMode(mode);
    showToast({ message: `${mode.charAt(0).toUpperCase() + mode.slice(1)} theme selected.`, type: 'success' });
  };

  const onRequestNotifications = async () => {
    const granted = await requestNotificationPermission();
    setNotificationPermission(granted ? 'granted' : 'denied');
    if (granted) {
      await syncReminderNotifications(preferences).catch(() => null);
      showToast({ message: 'Notifications enabled.', type: 'success' });
      return;
    }

    showToast({ message: 'Notification permission was not granted.', type: 'error' });
  };

  const onSavePassword = () => {
    if (passwordForm.new_password !== passwordForm.confirm_password) {
      showToast({ message: 'New passwords do not match.', type: 'error' });
      return;
    }
    if (passwordForm.new_password.length < 6) {
      showToast({ message: 'Password must be at least 6 characters.', type: 'error' });
      return;
    }

    changePasswordMutation.mutate({
      old_password: passwordForm.current_password,
      new_password: passwordForm.new_password,
      confirm_password: passwordForm.confirm_password,
    });
  };

  const onSaveProfile = () => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!profileForm.email || !emailRegex.test(profileForm.email)) {
      showToast({ message: 'Please enter a valid email.', type: 'error' });
      return;
    }

    if (profileForm.daily_goal < 1000 || profileForm.daily_goal > 100000) {
      showToast({ message: 'Daily goal must be between 1,000 and 100,000.', type: 'error' });
      return;
    }

    updateProfileMutation.mutate(profileForm);
  };

  const onLogout = async () => {
    await logout();
    navigate('/login');
  };

  return (
    <div className="screen-enter pb-nav bg-bg-page min-h-screen">
      <div className="pt-safe px-4 pt-5 pb-4 flex items-center gap-3">
        <button
          onClick={() => navigate('/profile')}
          className="w-10 h-10 rounded-xl bg-bg-input flex items-center justify-center"
          aria-label="Back"
        >
          <ChevronLeft size={20} className="text-text-primary" />
        </button>
        <div>
          <h1 className="text-text-primary text-2xl font-bold">Settings</h1>
          <p className="text-text-muted text-sm">Manage your account, app, and privacy</p>
        </div>
      </div>

      <div className="px-4 pb-4">
        <div className="card rounded-3xl p-4">
          <p className="text-xs uppercase tracking-widest text-text-muted mb-3">Account</p>
          <div className="space-y-2">
            <button onClick={() => setShowProfileModal(true)} className="settings-row">
              <Mail size={18} className="text-accent-blue" />
              <span>Edit profile details</span>
            </button>
            <button onClick={() => setShowPasswordModal(true)} className="settings-row">
              <Lock size={18} className="text-accent-purple" />
              <span>Change password</span>
            </button>
            <button onClick={() => navigate('/profile/sessions')} className="settings-row">
              <Smartphone size={18} className="text-accent-green" />
              <span>Active sessions</span>
            </button>
          </div>
        </div>
      </div>

      <div className="px-4 pb-4">
        <div className="card rounded-3xl p-4">
          <p className="text-xs uppercase tracking-widest text-text-muted mb-3">Permissions</p>
          <div className="flex items-center justify-between mb-3">
            <div>
              <p className="text-text-primary text-sm font-semibold">Step tracking</p>
              <p className="text-text-muted text-xs">Reads your step count from the phone's own health store for the most accurate data available.</p>
            </div>
            <div className="flex items-center gap-2">
              <span className={`w-2.5 h-2.5 rounded-full ${deviceStatus.dot}`} />
              <span className="text-xs text-text-secondary">{deviceStatus.label}</span>
            </div>
          </div>
          <button
            onClick={() => connectDevice()}
            disabled={isConnectingDevice || permissionStatus === 'granted'}
            className="w-full btn-primary py-3 rounded-2xl disabled:opacity-50"
          >
            {permissionStatus === 'granted' ? 'Phone health already connected' : isConnectingDevice ? 'Requesting...' : 'Connect phone health data'}
          </button>
        </div>
      </div>

      <div className="px-4 pb-4">
        <div className="card rounded-3xl p-4">
          <p className="text-xs uppercase tracking-widest text-text-muted mb-3">Theme</p>
          <div className="grid grid-cols-3 gap-2 mb-5">
            <ThemeButton
              icon={<Monitor size={16} />}
              label="System"
              active={themeMode === 'system'}
              onClick={() => onSelectTheme('system')}
            />
            <ThemeButton
              icon={<Sun size={16} />}
              label="Light"
              active={themeMode === 'light'}
              onClick={() => onSelectTheme('light')}
            />
            <ThemeButton
              icon={<Moon size={16} />}
              label="Dark"
              active={themeMode === 'dark'}
              onClick={() => onSelectTheme('dark')}
            />
          </div>

          <p className="text-xs uppercase tracking-widest text-text-muted mb-3">Notifications</p>
          <div className="space-y-3">
            <PreferenceToggle
              icon={<Bell size={16} className="text-accent-blue" />}
              title="Push notifications"
              subtitle="General updates and challenge alerts"
              checked={preferences.pushNotifications}
              onChange={() => onTogglePreference('pushNotifications')}
            />
            <PreferenceToggle
              icon={<Target size={16} className="text-accent-green" />}
              title="Challenge reminders"
              subtitle="Reminder before challenge deadlines"
              checked={preferences.challengeReminders}
              onChange={() => onTogglePreference('challengeReminders')}
            />
            <PreferenceToggle
              icon={<Activity size={16} className="text-accent-yellow" />}
              title="Payout alerts"
              subtitle="Notify when winnings hit your wallet"
              checked={preferences.payoutAlerts}
              onChange={() => onTogglePreference('payoutAlerts')}
            />
            <div className="flex items-center justify-between rounded-2xl border border-border bg-bg-input px-3 py-3">
              <div>
                <p className="text-sm font-semibold text-text-primary">Notification permission</p>
                <p className="text-xs text-text-muted">Needed for reminders and payment alerts.</p>
              </div>
              <div className="flex items-center gap-2">
                <span className={`w-2.5 h-2.5 rounded-full ${notificationStatus.dot}`} />
                <span className="text-xs text-text-secondary">{notificationStatus.label}</span>
              </div>
            </div>
            <button onClick={onRequestNotifications} className="w-full btn-secondary py-3 rounded-2xl">
              {notificationPermission === 'granted' ? 'Refresh notification access' : 'Request notification access'}
            </button>

          </div>

          <p className="text-xs uppercase tracking-widest text-text-muted mt-5 mb-3">App Preferences</p>
          <div className="space-y-3">
            <PreferenceToggle
              icon={<Shield size={16} className="text-accent-purple" />}
              title="Biometric lock"
              subtitle="Require biometric unlock when app opens"
              checked={preferences.biometricsLock}
              onChange={() => onTogglePreference('biometricsLock')}
            />
            <PreferenceToggle
              icon={<Sun size={16} className="text-accent-pink" />}
              title="Reduce motion"
              subtitle="Use simpler animations to save battery"
              checked={preferences.reduceMotion}
              onChange={() => onTogglePreference('reduceMotion')}
            />
          </div>
        </div>
      </div>

      <div className="px-4 pb-4">
        <div className="card rounded-3xl p-4">
          <p className="text-xs uppercase tracking-widest text-text-muted mb-3">Help & Legal</p>
          <div className="space-y-2">
            <button onClick={() => navigate('/support')} className="settings-row">
              <LifeBuoy size={18} className="text-accent-green" />
              <span>Support center</span>
            </button>
            <button onClick={() => navigate('/legal/privacy-policy')} className="settings-row">
              <Shield size={18} className="text-accent-purple" />
              <span>Privacy policy</span>
            </button>
            <button onClick={() => navigate('/legal/terms-and-conditions')} className="settings-row">
              <FileText size={18} className="text-accent-purple" />
              <span>Terms of service</span>
            </button>
          </div>
        </div>
      </div>

      <div className="px-4 pb-8">
        <button onClick={onLogout} className="w-full py-3 rounded-2xl bg-tint-red text-accent-red font-semibold flex items-center justify-center gap-2">
          <LogOut size={18} />
          Logout
        </button>
      </div>

      <BaseModal open={showPasswordModal} onClose={() => setShowPasswordModal(false)}>
        <h2 className="text-2xl font-black text-text-primary mb-2">Change Password</h2>
        <p className="text-sm text-text-muted mb-6">Secure your account with a new password.</p>
        <div className="space-y-4 mb-6">
          <input
            type="password"
            value={passwordForm.current_password}
            onChange={(e) => setPasswordForm({ ...passwordForm, current_password: e.target.value })}
            placeholder="Current password"
            className="input-field w-full"
          />
          <input
            type="password"
            value={passwordForm.new_password}
            onChange={(e) => setPasswordForm({ ...passwordForm, new_password: e.target.value })}
            placeholder="New password"
            className="input-field w-full"
          />
          <input
            type="password"
            value={passwordForm.confirm_password}
            onChange={(e) => setPasswordForm({ ...passwordForm, confirm_password: e.target.value })}
            placeholder="Confirm new password"
            className="input-field w-full"
          />
        </div>
        <div className="flex gap-3">
          <button onClick={() => setShowPasswordModal(false)} className="flex-1 btn-secondary py-3 rounded-2xl">Cancel</button>
          <button onClick={onSavePassword} disabled={changePasswordMutation.isPending} className="flex-1 btn-primary py-3 rounded-2xl disabled:opacity-40">
            {changePasswordMutation.isPending ? 'Updating...' : 'Update'}
          </button>
        </div>
      </BaseModal>

      <BaseModal open={showProfileModal} onClose={() => setShowProfileModal(false)}>
        <h2 className="text-2xl font-black text-text-primary mb-2">Edit Profile</h2>
        <p className="text-sm text-text-muted mb-6">Keep your account details up to date.</p>
        <div className="space-y-4 mb-6">
          <input
            type="email"
            value={profileForm.email}
            onChange={(e) => setProfileForm({ ...profileForm, email: e.target.value })}
            placeholder="Email address"
            className="input-field w-full"
          />
          <input
            type="tel"
            value={profileForm.phone_number}
            onChange={(e) => setProfileForm({ ...profileForm, phone_number: e.target.value })}
            placeholder="Phone number"
            className="input-field w-full"
          />
          <div className="flex items-center gap-2">
            <input
              type="number"
              min="1000"
              max="100000"
              value={profileForm.daily_goal}
              onChange={(e) => setProfileForm({ ...profileForm, daily_goal: parseInt(e.target.value, 10) || 10000 })}
              className="input-field flex-1"
            />
            <span className="text-sm text-text-muted">steps</span>
          </div>
        </div>
        <div className="flex gap-3">
          <button onClick={() => setShowProfileModal(false)} className="flex-1 btn-secondary py-3 rounded-2xl">Cancel</button>
          <button onClick={onSaveProfile} disabled={updateProfileMutation.isPending} className="flex-1 btn-primary py-3 rounded-2xl disabled:opacity-40">
            {updateProfileMutation.isPending ? 'Saving...' : 'Save'}
          </button>
        </div>
      </BaseModal>
    </div>
  );
}

function ThemeButton({
  icon,
  label,
  active,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-2xl border px-3 py-3 text-left transition-all ${active ? 'border-transparent bg-text-primary text-white' : 'border-border bg-bg-input text-text-secondary'}`}
    >
      <div className="flex items-center gap-2">
        <span className={active ? 'text-white' : 'text-text-muted'}>{icon}</span>
        <span className="text-sm font-semibold">{label}</span>
      </div>
    </button>
  );
}

function PreferenceToggle({
  icon,
  title,
  subtitle,
  checked,
  onChange,
  locked,
}: {
  icon: ReactNode;
  title: string;
  subtitle: string;
  checked: boolean;
  onChange: () => void;
  locked?: boolean;
}) {
  return (
    <div className="flex items-center gap-3">
      <div className="w-8 h-8 rounded-lg bg-bg-input flex items-center justify-center flex-shrink-0">{icon}</div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-text-primary">{title}</p>
        <p className="text-xs text-text-muted">{subtitle}</p>
      </div>
      <button
        onClick={onChange}
        className={`relative w-12 h-7 rounded-full transition-colors ${checked ? 'bg-accent-blue' : 'bg-border'} ${locked ? 'opacity-70' : ''}`}
        aria-label={title}
      >
        <span
          className={`absolute top-1 w-5 h-5 rounded-full bg-white transition-all ${checked ? 'left-6' : 'left-1'}`}
        />
      </button>
    </div>
  );
}
