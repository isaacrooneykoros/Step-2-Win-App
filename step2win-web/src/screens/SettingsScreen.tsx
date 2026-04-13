import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Capacitor } from '@capacitor/core';
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
import { PermissionStatusCard } from '../components/PermissionStatusIndicator';
import { useHealthSync } from '../hooks/useHealthSync';
import type { User } from '../types';
import { applyThemeMode, loadThemeMode, saveThemeMode, type ThemeMode } from '../config/theme';
import { checkNotificationPermission, requestNotificationPermission, syncReminderNotifications } from '../services/notifications';
import { DeviceStepCounter } from '../plugins/deviceStepCounter';

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
  const [showStrideWizard, setShowStrideWizard] = useState(false);
  const [passwordForm, setPasswordForm] = useState({
    current_password: '',
    new_password: '',
    confirm_password: '',
  });
  const [profileForm, setProfileForm] = useState({
    email: '',
    phone_number: '',
    daily_goal: 10000,
    stride_length_cm: 78,
    weight_kg: 70,
    calibration_quality: null as 'excellent' | 'good' | 'noisy' | null,
    calibration_variance_pct: null as number | null,
    last_calibrated_at: null as string | null,
  });
  const [wizardDistanceM, setWizardDistanceM] = useState(20);
  const [wizardCustomDistance, setWizardCustomDistance] = useState('20');
  const [wizardRunning, setWizardRunning] = useState(false);
  const [wizardPass, setWizardPass] = useState<1 | 2>(1);
  const [wizardBusy, setWizardBusy] = useState(false);
  const [wizardBaselineSteps, setWizardBaselineSteps] = useState<number | null>(null);
  const [wizardCurrentSteps, setWizardCurrentSteps] = useState(0);
  const [wizardDetectedSteps, setWizardDetectedSteps] = useState(0);
  const [wizardPassOneStride, setWizardPassOneStride] = useState<number | null>(null);
  const [wizardPassTwoStride, setWizardPassTwoStride] = useState<number | null>(null);
  const [wizardEstimatedStride, setWizardEstimatedStride] = useState<number | null>(null);
  const [wizardQualityScore, setWizardQualityScore] = useState<'excellent' | 'good' | 'noisy' | null>(null);
  const [wizardVariancePct, setWizardVariancePct] = useState<number | null>(null);
  const wizardPollRef = useRef<number | null>(null);

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
      stride_length_cm: profile.stride_length_cm || 78,
      weight_kg: profile.weight_kg || 70,
      calibration_quality: profile.calibration_quality ?? null,
      calibration_variance_pct: profile.calibration_variance_pct ?? null,
      last_calibrated_at: profile.last_calibrated_at ?? null,
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

  useEffect(() => {
    return () => {
      if (wizardPollRef.current !== null) {
        window.clearInterval(wizardPollRef.current);
      }
    };
  }, []);

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

  const saveCalibrationBadgeMutation = useMutation({
    mutationFn: (data: Partial<User>) => authService.updateProfile(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['profile'] });
    },
    onError: () => {
      showToast({ message: 'Could not persist calibration badge yet.', type: 'warning' });
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

    if (profileForm.stride_length_cm < 40 || profileForm.stride_length_cm > 130) {
      showToast({ message: 'Stride length must be between 40 and 130 cm.', type: 'error' });
      return;
    }

    if (profileForm.weight_kg < 30 || profileForm.weight_kg > 220) {
      showToast({ message: 'Weight must be between 30 and 220 kg.', type: 'error' });
      return;
    }

    updateProfileMutation.mutate(profileForm);
  };

  const onLogout = async () => {
    await logout();
    navigate('/login');
  };

  const stopWizardPolling = () => {
    if (wizardPollRef.current !== null) {
      window.clearInterval(wizardPollRef.current);
      wizardPollRef.current = null;
    }
  };

  const closeStrideWizard = () => {
    stopWizardPolling();
    setWizardRunning(false);
    setWizardPass(1);
    setWizardBusy(false);
    setWizardBaselineSteps(null);
    setWizardDetectedSteps(0);
    setWizardCurrentSteps(0);
    setWizardPassOneStride(null);
    setWizardPassTwoStride(null);
    setWizardEstimatedStride(null);
    setWizardQualityScore(null);
    setWizardVariancePct(null);
    setShowStrideWizard(false);
  };

  const onDistancePreset = (value: number) => {
    setWizardDistanceM(value);
    setWizardCustomDistance(String(value));
  };

  const refreshWizardReading = async (baseline?: number) => {
    const reading = await DeviceStepCounter.getTodaySteps();
    const nowSteps = Math.max(0, Math.round(Number(reading.steps) || 0));
    setWizardCurrentSteps(nowSteps);
    const base = baseline ?? wizardBaselineSteps ?? nowSteps;
    const delta = Math.max(0, nowSteps - base);
    setWizardDetectedSteps(delta);
    return nowSteps;
  };

  const startStrideCalibrationPass = async (pass: 1 | 2) => {
    if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'android') {
      showToast({ message: 'Stride wizard needs Android sensor support.', type: 'error' });
      return;
    }

    const custom = parseFloat(wizardCustomDistance);
    const effectiveDistance = Number.isFinite(custom) && custom > 0 ? custom : wizardDistanceM;
    if (effectiveDistance < 5 || effectiveDistance > 1000) {
      showToast({ message: 'Use a measured distance between 5m and 1000m.', type: 'error' });
      return;
    }

    setWizardBusy(true);
    try {
      const ok = await connectDevice({ silent: true });
      if (!ok) {
        return;
      }

      const reading = await DeviceStepCounter.getTodaySteps();
      const base = Math.max(0, Math.round(Number(reading.steps) || 0));
      setWizardDistanceM(effectiveDistance);
      setWizardPass(pass);
      setWizardBaselineSteps(base);
      setWizardCurrentSteps(base);
      setWizardDetectedSteps(0);

      if (pass === 1) {
        setWizardPassOneStride(null);
        setWizardPassTwoStride(null);
        setWizardEstimatedStride(null);
        setWizardQualityScore(null);
        setWizardVariancePct(null);
      } else {
        setWizardPassTwoStride(null);
      }

      setWizardRunning(true);

      stopWizardPolling();
      wizardPollRef.current = window.setInterval(() => {
        void refreshWizardReading(base);
      }, 1200);
    } catch (error: any) {
      showToast({ message: error?.message || 'Could not start calibration.', type: 'error' });
    } finally {
      setWizardBusy(false);
    }
  };

  const startStrideCalibration = async () => {
    await startStrideCalibrationPass(1);
  };

  const startReturnStrideCalibration = async () => {
    await startStrideCalibrationPass(2);
  };

  const finishStrideCalibration = async () => {
    if (!wizardRunning) return;

    setWizardBusy(true);
    try {
      const current = await refreshWizardReading();
      const baseline = wizardBaselineSteps ?? current;
      const walkedSteps = Math.max(0, current - baseline);

      if (walkedSteps < 12) {
        showToast({ message: 'Too few steps detected. Walk farther and try again.', type: 'error' });
        return;
      }

      const rawStride = (wizardDistanceM * 100) / walkedSteps;
      const strideCm = Math.min(130, Math.max(40, rawStride));
      const rounded = Number(strideCm.toFixed(1));

      if (wizardPass === 1) {
        setWizardPassOneStride(rounded);
        setWizardRunning(false);
        stopWizardPolling();
        showToast({ message: `Outbound pass captured: ${rounded} cm. Now walk back and start return pass.`, type: 'info' });
      } else {
        const passOne = wizardPassOneStride ?? rounded;
        const average = Number((((passOne + rounded) / 2)).toFixed(1));
        const variancePct = Number((Math.abs(passOne - rounded) / Math.max(average, 0.1) * 100).toFixed(1));
        const quality: 'excellent' | 'good' | 'noisy' = variancePct <= 2 ? 'excellent' : variancePct <= 5 ? 'good' : 'noisy';

        const calibratedAt = new Date().toISOString();

        setWizardPassTwoStride(rounded);
        setWizardEstimatedStride(average);
        setWizardVariancePct(variancePct);
        setWizardQualityScore(quality);
        setProfileForm((prev) => ({
          ...prev,
          stride_length_cm: average,
          calibration_quality: quality,
          calibration_variance_pct: variancePct,
          last_calibrated_at: calibratedAt,
        }));
        setWizardRunning(false);
        stopWizardPolling();

        saveCalibrationBadgeMutation.mutate({
          stride_length_cm: average,
          calibration_quality: quality,
          calibration_variance_pct: variancePct,
          last_calibrated_at: calibratedAt,
        });

        if (quality === 'noisy') {
          showToast({ message: `2-pass stride calibrated to ${average} cm, but quality is noisy (${variancePct}% variance). Consider rerunning.`, type: 'warning' });
        } else {
          showToast({ message: `2-pass stride calibrated to ${average} cm (${quality}).`, type: 'success' });
        }
      }
    } catch (error: any) {
      showToast({ message: error?.message || 'Could not finish calibration.', type: 'error' });
    } finally {
      setWizardBusy(false);
    }
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
          
          {/* Permission status card */}
          <div className="mb-4">
            <PermissionStatusCard />
          </div>

          <div className="flex items-center justify-between mb-3">
            <div>
              <p className="text-text-primary text-sm font-semibold">Step tracking</p>
              <p className="text-text-muted text-xs">Uses motion sensor + activity recognition permission to measure steps directly on your device.</p>
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
            {permissionStatus === 'granted' ? 'Step sensor connected' : isConnectingDevice ? 'Requesting...' : 'Enable step sensor'}
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
          <div className="flex items-center gap-2">
            <input
              type="number"
              min="40"
              max="130"
              step="0.5"
              value={profileForm.stride_length_cm}
              onChange={(e) => setProfileForm({ ...profileForm, stride_length_cm: parseFloat(e.target.value) || 78 })}
              className="input-field flex-1"
            />
            <span className="text-sm text-text-muted">cm stride</span>
          </div>
          <button
            type="button"
            onClick={() => setShowStrideWizard(true)}
            className="w-full btn-secondary py-2.5 rounded-2xl"
          >
            Run stride calibration wizard
          </button>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min="30"
              max="220"
              step="0.1"
              value={profileForm.weight_kg}
              onChange={(e) => setProfileForm({ ...profileForm, weight_kg: parseFloat(e.target.value) || 70 })}
              className="input-field flex-1"
            />
            <span className="text-sm text-text-muted">kg</span>
          </div>
        </div>
        <div className="flex gap-3">
          <button onClick={() => setShowProfileModal(false)} className="flex-1 btn-secondary py-3 rounded-2xl">Cancel</button>
          <button onClick={onSaveProfile} disabled={updateProfileMutation.isPending} className="flex-1 btn-primary py-3 rounded-2xl disabled:opacity-40">
            {updateProfileMutation.isPending ? 'Saving...' : 'Save'}
          </button>
        </div>
      </BaseModal>

      <BaseModal open={showStrideWizard} onClose={closeStrideWizard}>
        <h2 className="text-2xl font-black text-text-primary mb-2">Stride Calibration Wizard</h2>
        <p className="text-sm text-text-muted mb-4">
          Walk a known distance at your normal pace. We auto-detect steps and estimate stride length.
        </p>

        <div className="space-y-3 mb-4">
          <p className="text-xs uppercase tracking-widest text-text-muted">Measured Distance</p>
          <div className="grid grid-cols-4 gap-2">
            {[10, 20, 50, 100].map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => onDistancePreset(d)}
                disabled={wizardRunning || wizardPassOneStride !== null}
                className={`py-2 rounded-xl text-xs font-semibold ${wizardDistanceM === d ? 'bg-accent-blue text-white' : 'bg-bg-input text-text-secondary'}`}
              >
                {d}m
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min="5"
              max="1000"
              step="1"
              value={wizardCustomDistance}
              onChange={(e) => setWizardCustomDistance(e.target.value)}
              disabled={wizardRunning || wizardPassOneStride !== null}
              className="input-field flex-1"
              placeholder="Custom distance"
            />
            <span className="text-sm text-text-muted">meters</span>
          </div>
          <p className="text-xs text-text-muted">
            Pass mode: {wizardPassOneStride === null ? 'Ready for outbound walk' : wizardPassTwoStride === null ? 'Ready for return walk' : 'Completed'}
          </p>
        </div>

        <div className="rounded-2xl border border-border bg-bg-input p-3 mb-4">
          <p className="text-xs text-text-muted mb-1">Live sensor progress</p>
          <p className="text-xs text-text-secondary mb-1">Current pass: {wizardPass === 1 ? 'Outbound' : 'Return'}</p>
          <p className="text-sm text-text-primary font-semibold">Detected steps: {wizardDetectedSteps.toLocaleString()}</p>
          <p className="text-xs text-text-muted">Current sensor total: {wizardCurrentSteps.toLocaleString()}</p>
          {wizardPassOneStride !== null && (
            <p className="text-xs text-text-secondary mt-1">Pass 1 stride: {wizardPassOneStride.toFixed(1)} cm</p>
          )}
          {wizardPassTwoStride !== null && (
            <p className="text-xs text-text-secondary">Pass 2 stride: {wizardPassTwoStride.toFixed(1)} cm</p>
          )}
          {wizardEstimatedStride !== null && (
            <p className="text-xs text-accent-green mt-1">Averaged stride: {wizardEstimatedStride.toFixed(1)} cm (applied)</p>
          )}
          {wizardQualityScore !== null && wizardVariancePct !== null && (
            <p className={`text-xs mt-1 ${wizardQualityScore === 'excellent' ? 'text-accent-green' : wizardQualityScore === 'good' ? 'text-accent-blue' : 'text-accent-yellow'}`}>
              Quality: {wizardQualityScore.toUpperCase()} ({wizardVariancePct}% pass variance)
              {wizardQualityScore === 'noisy' ? ' — rerun recommended for tighter accuracy.' : ''}
            </p>
          )}
        </div>

        <div className="flex gap-3">
          {!wizardRunning && wizardPassOneStride === null ? (
            <button
              type="button"
              onClick={startStrideCalibration}
              disabled={wizardBusy}
              className="flex-1 btn-primary py-3 rounded-2xl"
            >
              {wizardBusy ? 'Preparing...' : 'Start Outbound Pass'}
            </button>
          ) : !wizardRunning && wizardPassOneStride !== null && wizardPassTwoStride === null ? (
            <button
              type="button"
              onClick={startReturnStrideCalibration}
              disabled={wizardBusy}
              className="flex-1 btn-primary py-3 rounded-2xl"
            >
              {wizardBusy ? 'Preparing...' : 'Start Return Pass'}
            </button>
          ) : !wizardRunning && wizardPassOneStride !== null && wizardPassTwoStride !== null ? (
            <button
              type="button"
              onClick={startStrideCalibration}
              disabled={wizardBusy}
              className="flex-1 btn-primary py-3 rounded-2xl"
            >
              {wizardBusy ? 'Preparing...' : 'Run Again'}
            </button>
          ) : (
            <button
              type="button"
              onClick={finishStrideCalibration}
              disabled={wizardBusy}
              className="flex-1 btn-primary py-3 rounded-2xl"
            >
              {wizardBusy ? 'Calculating...' : `Finish ${wizardPass === 1 ? 'Outbound' : 'Return'} Pass`}
            </button>
          )}
          <button type="button" onClick={closeStrideWizard} className="flex-1 btn-secondary py-3 rounded-2xl">
            Close
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
