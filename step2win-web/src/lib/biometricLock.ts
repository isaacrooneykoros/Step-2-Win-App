import { create } from 'zustand';
import { App as CapacitorApp } from '@capacitor/app';
import {
  AndroidBiometryStrength,
  BiometricAuth,
  BiometryError,
  BiometryErrorType,
  BiometryType,
} from '@aparajita/capacitor-biometric-auth';
import { AppSystem, isNativeAppShell } from '../plugins/appSystem';
import { loadPreferences, savePreference, subscribePreferences } from '../components/settings/preferences';
import { useAuthStore } from '../store/authStore';
import { toast } from '../components/ui/Toast';

/**
 * App lock ("Biometric lock" in Settings).
 * - Cold start: locked as soon as tokens are restored (the gate only renders for signed-in users).
 * - Resume: locked again after LOCK_GRACE_MS in the background.
 * - Unlock: fingerprint / face, with the phone's screen-lock PIN as fallback (device credential).
 * - Logging out (from anywhere) turns the lock off and clears lock state.
 */
export const LOCK_GRACE_MS = 60_000;

export type BiometricAvailability = {
  /** Something to authenticate with: enrolled biometrics or at least a screen lock. */
  available: boolean;
  biometricsEnrolled: boolean;
  deviceSecure: boolean;
  /** "fingerprint" | "face" | "iris" | null — for wording only. */
  kind: 'fingerprint' | 'face' | 'iris' | null;
  reason: string;
};

type LockState = {
  locked: boolean;
  authenticating: boolean;
  error: string | null;
  /** Bumps on every new lock so the gate auto-prompts exactly once per lock. */
  lockId: number;
};

export const useLockStore = create<LockState>(() => ({
  locked: false,
  authenticating: false,
  error: null,
  lockId: 0,
}));

let backgroundedAt: number | null = null;
let authInFlight = false;
let lastAuthEndedAt = 0;
let initialised = false;

/** Android (BiometricPrompt) and iOS (Face ID / Touch ID / passcode). */
export function isLockSupported() {
  return isNativeAppShell();
}

export function isLockEnabled() {
  return isLockSupported() && loadPreferences().biometricsLock;
}

function lock() {
  useLockStore.setState((s) => ({ locked: true, error: null, lockId: s.lockId + 1 }));
}

function clearLock() {
  useLockStore.setState({ locked: false, authenticating: false, error: null });
}

function kindOf(type: BiometryType): BiometricAvailability['kind'] {
  if (type === BiometryType.fingerprintAuthentication || type === BiometryType.touchId) return 'fingerprint';
  if (type === BiometryType.faceAuthentication || type === BiometryType.faceId) return 'face';
  if (type === BiometryType.irisAuthentication) return 'iris';
  return null;
}

export async function checkBiometricAvailability(): Promise<BiometricAvailability> {
  if (!isLockSupported()) {
    return { available: false, biometricsEnrolled: false, deviceSecure: false, kind: null, reason: 'Available in the Step2Win phone app' };
  }
  try {
    const result = await BiometricAuth.checkBiometry();
    return {
      available: result.isAvailable || result.deviceIsSecure,
      biometricsEnrolled: result.isAvailable,
      deviceSecure: result.deviceIsSecure,
      kind: result.isAvailable ? kindOf(result.biometryType) : null,
      reason: result.reason,
    };
  } catch (error) {
    return {
      available: false,
      biometricsEnrolled: false,
      deviceSecure: false,
      kind: null,
      reason: error instanceof Error ? error.message : 'Unable to check biometrics',
    };
  }
}

function describeFailure(error: unknown): string {
  if (error instanceof BiometryError) {
    switch (error.code) {
      case BiometryErrorType.userCancel:
      case BiometryErrorType.appCancel:
      case BiometryErrorType.systemCancel:
        return 'Unlock was cancelled.';
      case BiometryErrorType.biometryLockout:
        return 'Too many attempts. Try again in a moment, or use your screen lock PIN.';
      case BiometryErrorType.authenticationFailed:
        return 'That didn’t match. Try again.';
      case BiometryErrorType.passcodeNotSet:
      case BiometryErrorType.noDeviceCredential:
        return 'This phone has no screen lock set up.';
      default:
        return error.message || 'Couldn’t confirm it’s you.';
    }
  }
  return error instanceof Error && error.message ? error.message : 'Couldn’t confirm it’s you.';
}

/** Shows the system prompt (biometrics, with PIN / pattern / password fallback). */
export async function authenticateUser(title: string, subtitle?: string): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!isLockSupported()) return { ok: false, message: 'Available in the Step2Win phone app' };
  if (authInFlight) return { ok: false, message: 'Already waiting for you to confirm.' };
  authInFlight = true;
  try {
    await BiometricAuth.authenticate({
      reason: title,
      cancelTitle: 'Cancel',
      allowDeviceCredential: true,
      androidTitle: title,
      androidSubtitle: subtitle ?? 'Use your fingerprint, face or screen lock',
      androidConfirmationRequired: false,
      androidBiometryStrength: AndroidBiometryStrength.weak,
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, message: describeFailure(error) };
  } finally {
    authInFlight = false;
    lastAuthEndedAt = Date.now();
  }
}

/** Unlock the app (from the lock screen). */
export async function unlockApp() {
  const state = useLockStore.getState();
  if (!state.locked || state.authenticating) return;
  useLockStore.setState({ authenticating: true, error: null });

  // If the phone's screen lock was removed there's nothing left to check against; turn the
  // lock off rather than trapping the user (removing a screen lock itself requires the PIN).
  const availability = await checkBiometricAvailability();
  if (!availability.available) {
    savePreference('biometricsLock', false);
    clearLock();
    toast({ message: 'Biometric lock is off because this phone no longer has a screen lock.', type: 'warning' });
    return;
  }

  const result = await authenticateUser('Unlock Step2Win');
  if (result.ok) {
    clearLock();
  } else {
    useLockStore.setState({ authenticating: false, error: result.message });
  }
}

async function applyPrivacyScreen(enabled: boolean) {
  if (!isLockSupported()) return;
  try {
    await AppSystem.setPrivacyScreen({ enabled });
  } catch {
    // Older builds without the native bridge: nothing to do.
  }
}

/** Call once at startup, before the first render. */
export function initBiometricLock() {
  if (initialised) return;
  initialised = true;
  if (!isLockSupported()) return;

  // Cold start: arm immediately; the gate only shows once tokens are restored and valid.
  if (isLockEnabled()) {
    lock();
  }
  void applyPrivacyScreen(isLockEnabled());

  subscribePreferences(() => {
    const enabled = isLockEnabled();
    void applyPrivacyScreen(enabled);
    if (!enabled) clearLock();
  });

  CapacitorApp.addListener('appStateChange', ({ isActive }) => {
    // The system prompt is its own activity: pausing for it must not count as leaving.
    if (authInFlight || Date.now() - lastAuthEndedAt < 1500) {
      if (isActive) backgroundedAt = null;
      return;
    }
    if (!isActive) {
      backgroundedAt = Date.now();
      return;
    }
    const awayFor = backgroundedAt ? Date.now() - backgroundedAt : 0;
    backgroundedAt = null;
    if (isLockEnabled() && useAuthStore.getState().isAuthenticated && awayFor >= LOCK_GRACE_MS) {
      lock();
    }
  }).catch(() => null);

  // Logout (Settings, lock screen, or a forced session expiry) turns the lock off.
  useAuthStore.subscribe((state, previous) => {
    if (previous.isAuthenticated && !state.isAuthenticated) {
      clearLock();
      if (loadPreferences().biometricsLock) savePreference('biometricsLock', false);
    }
  });
}
