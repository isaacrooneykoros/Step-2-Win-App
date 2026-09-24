import {
  Bell,
  BellRing,
  UploadCloud,
  FileText,
  Footprints,
  Gauge,
  KeyRound,
  LifeBuoy,
  Mail,
  Ruler,
  Scale,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Target,
  Trophy,
  Wallet,
} from 'lucide-react';
import type { User } from '../../types';
import type { ThemeMode } from '../../config/theme';
import { formatSteps } from '../../lib/format';
import { ListGroup, ListRow } from '../ui/ListRow';
import { IconTile, Pill } from '../ui/Pill';
import { Avatar } from '../ui/Avatar';
import Button from '../ui/Button';
import { Skeleton } from '../ui/Skeleton';
import { ToggleRow } from './Switch';
import { Segmented } from '../ui/Segmented';
import { Monitor, Moon, Sun } from 'lucide-react';
import { qualityMeta } from './calibration';
import type { PreferencesState } from './preferences';
import { permissionLabel } from './useDevicePermissions';
import { BiometricLockToggle } from '../security/BiometricLockToggle';

type SetPreference = (key: keyof PreferencesState, value: boolean) => void;

/* ───────────── Account ───────────── */

export function IdentityCard({ profile, onEditProfile, onEditPhoto }: { profile: User | undefined; onEditProfile: () => void; onEditPhoto: () => void }) {
  return (
    <section aria-label="Your profile" className="flex items-center gap-4 rounded-card border border-border-light bg-bg-card p-4 shadow-card">
      <button type="button" onClick={onEditPhoto} className="shrink-0 rounded-full" aria-label="Change profile photo">
        <Avatar name={profile?.username} src={profile?.profile_picture_url} size="lg" />
      </button>
      <div className="min-w-0 flex-1">
        {profile ? (
          <>
            <p className="truncate text-headline text-text-primary">{profile.username}</p>
            <p className="truncate text-caption text-text-muted">{profile.email || 'No email added'}</p>
          </>
        ) : (
          <>
            <Skeleton className="h-5 w-28 rounded" />
            <Skeleton className="mt-2 h-3 w-40 rounded" />
          </>
        )}
      </div>
      <Button variant="secondary" size="sm" className="!h-11 shrink-0" onClick={onEditProfile}>
        Edit profile
      </Button>
    </section>
  );
}

export function AccountSection({ profile, onEditContact, onEditGoal }: { profile: User | undefined; onEditContact: () => void; onEditGoal: () => void }) {
  const contact = [profile?.email, profile?.phone_number].filter(Boolean).join(' · ');
  return (
    <ListGroup title="Account">
      <ListRow
        leading={<IconTile icon={Mail} tone="info" size="sm" />}
        title="Personal details"
        subtitle={contact || 'Add your email and phone'}
        onClick={onEditContact}
        chevron
      />
      <ListRow
        leading={<IconTile icon={Target} tone="brand" size="sm" />}
        title="Daily step goal"
        subtitle="Fills your ring on Home"
        trailing={profile ? <span className="num text-callout text-text-secondary">{formatSteps(profile.daily_goal)}</span> : null}
        onClick={onEditGoal}
        chevron
      />
    </ListGroup>
  );
}

/* ───────────── Security ───────────── */

export function SecuritySection({ profile, onChangePassword }: { profile: User | undefined; onChangePassword: () => void }) {
  const bound = profile?.device_bound;
  return (
    <ListGroup title="Security">
      <ListRow leading={<IconTile icon={KeyRound} tone="neutral" size="sm" />} title="Change password" onClick={onChangePassword} chevron />
      <ListRow
        leading={<IconTile icon={Smartphone} tone="neutral" size="sm" />}
        title="Active sessions"
        subtitle="See where you’re signed in"
        to="/profile/sessions"
      />
      <ListRow
        leading={<IconTile icon={ShieldCheck} tone={bound ? 'success' : 'neutral'} size="sm" />}
        title="Device binding"
        subtitle={bound ? 'Steps sync from one phone' : 'No phone linked yet'}
        trailing={profile ? <Pill tone={bound ? 'success' : 'neutral'}>{bound ? 'Linked' : 'Not linked'}</Pill> : null}
      />
      <BiometricLockToggle />
    </ListGroup>
  );
}

/* ───────────── Notifications ───────────── */

export function NotificationsSection({
  permission,
  requesting,
  preferences,
  setPreference,
  onRequestPermission,
}: {
  permission: string;
  requesting: boolean;
  preferences: PreferencesState;
  setPreference: SetPreference;
  onRequestPermission: () => void;
}) {
  const status = permissionLabel(permission);
  const granted = permission === 'granted';
  return (
    <ListGroup
      title="Notifications"
      footer={!granted && permission !== 'unavailable' ? 'Reminders only arrive once notification access is allowed.' : undefined}
    >
      <ListRow
        leading={<IconTile icon={BellRing} tone={granted ? 'brand' : 'warning'} size="sm" />}
        title="Notification access"
        subtitle={granted ? 'Allowed on this device' : requesting ? 'Asking…' : 'Tap to allow notifications'}
        trailing={<Pill tone={status.tone}>{status.label}</Pill>}
        onClick={requesting ? undefined : onRequestPermission}
      />
      <ToggleRow
        leading={<IconTile icon={Bell} tone="neutral" size="sm" />}
        title="Push notifications"
        subtitle="General updates and challenge alerts"
        checked={preferences.pushNotifications}
        onChange={(v) => setPreference('pushNotifications', v)}
      />
      <ToggleRow
        leading={<IconTile icon={Trophy} tone="neutral" size="sm" />}
        title="Challenge reminders"
        subtitle="A nudge before a challenge deadline"
        checked={preferences.challengeReminders}
        onChange={(v) => setPreference('challengeReminders', v)}
      />
      <ToggleRow
        leading={<IconTile icon={Wallet} tone="neutral" size="sm" />}
        title="Payout alerts"
        subtitle="When winnings reach your wallet"
        checked={preferences.payoutAlerts}
        onChange={(v) => setPreference('payoutAlerts', v)}
      />
    </ListGroup>
  );
}

/* ───────────── Activity ───────────── */

const stepStatus: Record<string, { label: string; tone: 'success' | 'danger' | 'neutral' | 'warning' }> = {
  granted: { label: 'On', tone: 'success' },
  denied: { label: 'Off', tone: 'danger' },
  unavailable: { label: 'Phone app only', tone: 'neutral' },
  unknown: { label: 'Checking', tone: 'neutral' },
};

export function ActivitySection({
  profile,
  stepPermission,
  outboxCount,
  preferences,
  setPreference,
  onOpenStepTracking,
  onOpenCalibration,
  onCellular = false,
}: {
  onCellular?: boolean;
  profile: User | undefined;
  stepPermission: string;
  outboxCount: number;
  preferences: PreferencesState;
  setPreference: SetPreference;
  onOpenStepTracking: () => void;
  onOpenCalibration: () => void;
}) {
  const status = stepStatus[stepPermission] ?? stepStatus.unknown;
  const quality = profile?.calibration_quality ?? null;
  return (
    <ListGroup
      title="Activity & step data"
      footer={onCellular && !preferences.dataSaver ? 'You’re on mobile data. Data saver cuts Step2Win’s background data use.' : undefined}
    >
      <ListRow
        leading={<IconTile icon={Footprints} tone={stepPermission === 'granted' ? 'brand' : 'neutral'} size="sm" />}
        title="Step tracking"
        subtitle="Your phone’s step sensor"
        trailing={<Pill tone={status.tone}>{status.label}</Pill>}
        onClick={onOpenStepTracking}
        chevron
      />
      <ListRow
        leading={<IconTile icon={Ruler} tone="neutral" size="sm" />}
        title="Stride & weight"
        subtitle={
          profile ? (
            <span className="num">
              {profile.stride_length_cm} cm stride · {profile.weight_kg} kg
            </span>
          ) : (
            'For distance and calories'
          )
        }
        trailing={quality ? <Pill tone={qualityMeta[quality].tone}>{qualityMeta[quality].label}</Pill> : null}
        onClick={onOpenCalibration}
        chevron
      />
      <ListRow
        leading={<IconTile icon={UploadCloud} tone={outboxCount > 0 ? 'warning' : 'neutral'} size="sm" />}
        title="Step sync & outbox"
        subtitle={outboxCount > 0 ? 'Step data waiting to upload' : 'Everything is uploaded'}
        trailing={outboxCount > 0 ? <Pill tone="warning">{`${outboxCount} waiting`}</Pill> : null}
        to="/settings/sync-outbox"
      />
      <ToggleRow
        leading={<IconTile icon={Gauge} tone="neutral" size="sm" />}
        title="Data saver"
        subtitle={
          preferences.dataSaver
            ? 'On: steps upload every 5 min (and when you open the app), no auto-refresh or live updates, maps load on tap'
            : 'Upload steps every 5 min instead of 30 s, pause auto-refresh and live updates, load maps only on tap'
        }
        checked={preferences.dataSaver}
        onChange={(v) => setPreference('dataSaver', v)}
      />
    </ListGroup>
  );
}

/* ───────────── Privacy ───────────── */

export function PrivacySection({ onOpenPermissions, summary }: { onOpenPermissions: () => void; summary: string }) {
  return (
    <ListGroup title="Privacy">
      <ListRow leading={<IconTile icon={ShieldCheck} tone="neutral" size="sm" />} title="App permissions" subtitle={summary} onClick={onOpenPermissions} chevron />
      <ListRow leading={<IconTile icon={FileText} tone="neutral" size="sm" />} title="Privacy policy" subtitle="How we handle your data" to="/legal/privacy-policy" />
    </ListGroup>
  );
}

/* ───────────── App ───────────── */

export function AppearanceSection({
  themeMode,
  onThemeChange,
  preferences,
  setPreference,
}: {
  themeMode: ThemeMode;
  onThemeChange: (mode: ThemeMode) => void;
  preferences: PreferencesState;
  setPreference: SetPreference;
}) {
  return (
    <ListGroup title="Appearance" footer="System follows your phone’s light or dark setting.">
      <div className="px-4 py-3">
        <p className="mb-2 text-body font-medium text-text-primary">Theme</p>
        <Segmented<ThemeMode>
          label="Theme"
          value={themeMode}
          onChange={onThemeChange}
          options={[
            { value: 'light', label: <span className="inline-flex items-center gap-1.5"><Sun size={15} aria-hidden /> Light</span> },
            { value: 'dark', label: <span className="inline-flex items-center gap-1.5"><Moon size={15} aria-hidden /> Dark</span> },
            { value: 'system', label: <span className="inline-flex items-center gap-1.5"><Monitor size={15} aria-hidden /> System</span> },
          ]}
        />
      </div>
      <ToggleRow
        leading={<IconTile icon={Sparkles} tone="neutral" size="sm" />}
        title="Reduce motion"
        subtitle="Fewer animations across the app"
        checked={preferences.reduceMotion}
        onChange={(v) => setPreference('reduceMotion', v)}
      />
    </ListGroup>
  );
}

/* ───────────── Support & legal ───────────── */

export function SupportSection() {
  return (
    <ListGroup title="Support & legal">
      <ListRow leading={<IconTile icon={LifeBuoy} tone="brand" size="sm" />} title="Help & support" subtitle="Your tickets and replies from our team" to="/support" />
      <ListRow leading={<IconTile icon={Scale} tone="neutral" size="sm" />} title="Terms of service" to="/legal/terms-and-conditions" />
    </ListGroup>
  );
}
