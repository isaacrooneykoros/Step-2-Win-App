import { useCallback, useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { LogOut, Trash2 } from 'lucide-react';
import { authService } from '../services/api';
import { useAuthStore } from '../store/authStore';
import { useHealthSync } from '../hooks/useHealthSync';
import type { User } from '../types';
import { applyThemeMode, loadThemeMode, saveThemeMode, type ThemeMode } from '../config/theme';
import { syncReminderNotifications } from '../services/notifications';
import { listOutboxItems } from '../services/offlineSyncOutbox';
import { ScreenHeader } from '../components/ui/ScreenHeader';
import Button from '../components/ui/Button';
import { ListGroup, ListRow } from '../components/ui/ListRow';
import { IconTile } from '../components/ui/Pill';
import { toast } from '../components/ui/Toast';
import { usePreferences } from '../components/settings/preferences';
import { useDevicePermissions } from '../components/settings/useDevicePermissions';
import {
  AccountSection,
  ActivitySection,
  AppearanceSection,
  IdentityCard,
  NotificationsSection,
  PrivacySection,
  SecuritySection,
  SupportSection,
} from '../components/settings/SettingsSections';
import { ProfilePhotoSheet } from '../components/settings/ProfilePhotoSheet';
import { ContactDetailsSheet } from '../components/settings/ContactDetailsSheet';
import { DailyGoalSheet } from '../components/settings/DailyGoalSheet';
import { PasswordSheet } from '../components/settings/PasswordSheet';
import { BodyCalibrationSheet } from '../components/settings/BodyCalibrationSheet';
import { StrideWizardSheet } from '../components/settings/StrideWizardSheet';
import { StepTrackingSheet } from '../components/settings/StepTrackingSheet';
import { PermissionsSheet } from '../components/settings/PermissionsSheet';
import { LogoutSheet } from '../components/settings/LogoutSheet';
import { DeleteAccountSheet } from '../components/settings/DeleteAccountSheet';
import { clearLocalUserData } from '../lib/accountCleanup';
import { useCellularConnection } from '../hooks/useCellularConnection';

const APP_VERSION = import.meta.env.VITE_APP_VERSION || '1.0.0';

type SheetId = 'photo' | 'contact' | 'goal' | 'password' | 'body' | 'wizard' | 'steps' | 'permissions' | 'logout' | 'delete';

export default function SettingsScreen() {
  const navigate = useNavigate();
  const logout = useAuthStore((state) => state.logout);
  const userId = useAuthStore((state) => state.user?.id);
  const { connectDevice, isConnectingDevice, permissionStatus } = useHealthSync();
  const { preferences, setPreference } = usePreferences();
  const permissions = useDevicePermissions();
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => loadThemeMode());
  const [sheet, setSheet] = useState<SheetId | null>(null);
  const close = () => setSheet(null);
  const onCellular = useCellularConnection();

  const { data: profile } = useQuery<User>({
    queryKey: ['profile'],
    queryFn: authService.getProfile,
  });

  // Shares the outbox screen's cache key; a lightweight count for the Activity row.
  const outboxUserId = userId ?? profile?.id;
  const { data: outbox = [] } = useQuery({
    queryKey: ['sync-outbox', outboxUserId],
    queryFn: () => listOutboxItems(outboxUserId),
    enabled: !!outboxUserId,
  });

  // Keep scheduled reminders in step with the notification toggles.
  useEffect(() => {
    if (permissions.notification !== 'granted') return;
    syncReminderNotifications(preferences).catch(() => null);
  }, [permissions.notification, preferences]);

  const onThemeChange = (mode: ThemeMode) => {
    setThemeMode(mode);
    saveThemeMode(mode);
    applyThemeMode(mode);
  };

  const onLogout = async () => {
    await logout();
    navigate('/login');
  };

  // Account deleted on the server: wipe this device's copy of the account, then sign out
  // (logout also turns the biometric lock off).
  const queryClient = useQueryClient();
  const deletedUserId = userId ?? profile?.id;
  const onAccountDeleted = useCallback(async () => {
    await clearLocalUserData(deletedUserId);
    await logout();
    queryClient.clear();
    toast({ message: 'Your account has been deleted.', type: 'success' });
    navigate('/login', { replace: true });
  }, [deletedUserId, logout, navigate, queryClient]);

  // Only count permissions this platform has (iOS: no background location / exact alarms).
  const permissionStates = [permissions.camera, permissions.location, permissions.backgroundLocation, permissions.exactAlarm].filter(
    (s) => s !== 'unavailable',
  );
  const allowedCount = permissionStates.filter((s) => s === 'granted').length;
  const permissionSummary = `${allowedCount} of ${permissionStates.length} allowed · camera, location${
    permissions.exactAlarm !== 'unavailable' ? ', alarms' : ''
  }`;

  return (
    <div className="pb-nav">
      <ScreenHeader title="Settings" back />

      <div className="mx-auto w-full max-w-2xl space-y-6 px-5 pb-8 pt-2">
        <IdentityCard profile={profile} onEditProfile={() => setSheet('contact')} onEditPhoto={() => setSheet('photo')} />
        <AccountSection
          profile={profile}
          onEditContact={() => setSheet('contact')}
          onEditGoal={() => setSheet('goal')}
        />
        <SecuritySection profile={profile} onChangePassword={() => setSheet('password')} />
        <NotificationsSection
          permission={permissions.notification}
          requesting={permissions.busy === 'notification'}
          preferences={preferences}
          setPreference={setPreference}
          onRequestPermission={() => permissions.requestNotifications(preferences)}
        />
        <ActivitySection
          profile={profile}
          stepPermission={permissionStatus}
          outboxCount={outbox.length}
          preferences={preferences}
          setPreference={setPreference}
          onOpenStepTracking={() => setSheet('steps')}
          onOpenCalibration={() => setSheet('body')}
          onCellular={onCellular}
        />
        <PrivacySection onOpenPermissions={() => setSheet('permissions')} summary={permissionSummary} />
        <AppearanceSection themeMode={themeMode} onThemeChange={onThemeChange} preferences={preferences} setPreference={setPreference} />
        <SupportSection />

        <div className="pt-2">
          <Button variant="danger-soft" size="lg" fullWidth leftIcon={<LogOut size={18} aria-hidden />} onClick={() => setSheet('logout')}>
            Log out
          </Button>
          <ListGroup title="Danger zone" className="mt-6">
            <ListRow
              leading={<IconTile icon={Trash2} tone="danger" size="sm" />}
              title="Delete account"
              subtitle="Remove your account and personal data"
              destructive
              chevron
              onClick={() => setSheet('delete')}
            />
          </ListGroup>
          <p className="mt-4 text-center text-caption text-text-muted">
            Step2Win <span className="num">{APP_VERSION}</span>
            {profile ? <> · Signed in as <span className="font-semibold text-text-secondary">{profile.username}</span></> : null}
          </p>
        </div>
      </div>

      <ProfilePhotoSheet open={sheet === 'photo'} onClose={close} profile={profile} />
      <ContactDetailsSheet open={sheet === 'contact'} onClose={close} profile={profile} onChangePhoto={() => setSheet('photo')} />
      <DailyGoalSheet open={sheet === 'goal'} onClose={close} profile={profile} />
      <PasswordSheet open={sheet === 'password'} onClose={close} />
      <BodyCalibrationSheet open={sheet === 'body'} onClose={close} profile={profile} onRunWizard={() => setSheet('wizard')} />
      <StrideWizardSheet open={sheet === 'wizard'} onClose={close} connectDevice={connectDevice} />
      <StepTrackingSheet
        open={sheet === 'steps'}
        onClose={close}
        permissionStatus={permissionStatus}
        isConnecting={isConnectingDevice}
        onConnect={() => void connectDevice()}
      />
      <PermissionsSheet open={sheet === 'permissions'} onClose={close} permissions={permissions} />
      <LogoutSheet open={sheet === 'logout'} onClose={close} onConfirm={onLogout} username={profile?.username} />
      <DeleteAccountSheet open={sheet === 'delete'} onClose={close} onDeleted={onAccountDeleted} />
    </div>
  );
}
