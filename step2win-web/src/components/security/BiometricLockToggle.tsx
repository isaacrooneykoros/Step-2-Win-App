import { useCallback, useEffect, useState } from 'react';
import { App as CapacitorApp } from '@capacitor/app';
import { Fingerprint, Settings2 } from 'lucide-react';
import { ToggleRow } from '../settings/Switch';
import { ListRow } from '../ui/ListRow';
import { IconTile } from '../ui/Pill';
import { useToast } from '../ui/Toast';
import { usePreference, savePreference } from '../settings/preferences';
import {
  authenticateUser,
  checkBiometricAvailability,
  isLockSupported,
  LOCK_GRACE_MS,
  type BiometricAvailability,
} from '../../lib/biometricLock';
import { AppSystem } from '../../plugins/appSystem';
import { isIOSApp } from '../../utils/platform';

const graceLabel = `${Math.round(LOCK_GRACE_MS / 60_000)} min`;

/** Settings row for the app lock. Turning it on or off always requires a successful check. */
export function BiometricLockToggle() {
  const enabled = usePreference('biometricsLock');
  const supported = isLockSupported();
  const { showToast } = useToast();
  const [availability, setAvailability] = useState<BiometricAvailability | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    if (!supported) return;
    void checkBiometricAvailability().then(setAvailability);
  }, [supported]);

  // Re-check when coming back from the phone's security settings.
  useEffect(() => {
    refresh();
    if (!supported) return;
    const handle = CapacitorApp.addListener('appStateChange', ({ isActive }) => {
      if (isActive) refresh();
    });
    return () => {
      handle.then((h) => h.remove()).catch(() => null);
    };
  }, [refresh, supported]);

  const onChange = async (next: boolean) => {
    if (busy) return;
    setBusy(true);
    const result = await authenticateUser(next ? 'Turn on biometric lock' : 'Turn off biometric lock');
    setBusy(false);
    if (!result.ok) {
      showToast({ message: `${result.message} Biometric lock is still ${enabled ? 'on' : 'off'}.`, type: 'error' });
      return;
    }
    savePreference('biometricsLock', next);
    showToast({
      message: next ? `Biometric lock is on. Step2Win locks after ${graceLabel} away.` : 'Biometric lock is off.',
      type: 'success',
    });
  };

  let subtitle: string;
  let disabled = busy;
  if (!supported) {
    subtitle = 'Available in the Step2Win phone app';
    disabled = true;
  } else if (!availability) {
    subtitle = 'Checking this phone…';
    disabled = true;
  } else if (!availability.available) {
    subtitle = isIOSApp()
      ? 'Set up Face ID, Touch ID or a passcode on this iPhone to use this.'
      : 'Set up a screen lock or fingerprint on this phone to use this.';
    disabled = !enabled; // still allow turning it off
  } else if (busy) {
    subtitle = 'Confirm it’s you…';
  } else {
    const ios = isIOSApp();
    const method = availability.biometricsEnrolled
      ? availability.kind === 'face'
        ? ios ? 'Face ID' : 'face unlock'
        : ios ? 'Touch ID' : 'fingerprint'
      : ios ? 'passcode' : 'screen lock PIN';
    subtitle = enabled
      ? `Asks for your ${method} when you open the app or return after ${graceLabel}`
      : `Ask for your ${method} when you open the app`;
  }

  const showSetup = supported && availability && !availability.available;

  return (
    <>
      <ToggleRow
        leading={<IconTile icon={Fingerprint} tone={enabled && supported ? 'brand' : 'neutral'} size="sm" />}
        title="Biometric lock"
        subtitle={subtitle}
        checked={enabled && supported}
        onChange={(v) => void onChange(v)}
        disabled={disabled}
      />
      {showSetup && (
        <ListRow
          leading={<IconTile icon={Settings2} tone="neutral" size="sm" />}
          title={isIOSApp() ? 'Set up Face ID or a passcode' : 'Set up screen lock'}
          subtitle={isIOSApp() ? 'Opens the Settings app' : 'Opens your phone’s security settings'}
          onClick={() => void AppSystem.openSecuritySettings().catch(() => null)}
          chevron
        />
      )}
    </>
  );
}

export default BiometricLockToggle;
