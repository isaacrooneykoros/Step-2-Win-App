import { Capacitor } from '@capacitor/core';

/**
 * Which shell the web app is running in, plus the permission wording that differs between
 * Android and iOS. Keep platform-specific copy here so screens don't hard-code Android terms.
 */
export type AppPlatform = 'android' | 'ios' | 'web';

export function appPlatform(): AppPlatform {
  if (!Capacitor.isNativePlatform()) return 'web';
  const platform = Capacitor.getPlatform();
  return platform === 'ios' ? 'ios' : platform === 'android' ? 'android' : 'web';
}

export const isNativeApp = () => appPlatform() !== 'web';
export const isAndroidApp = () => appPlatform() === 'android';
export const isIOSApp = () => appPlatform() === 'ios';

/** Phones where the native DeviceStepCounter plugin counts steps (Android sensor, iOS CoreMotion). */
export const hasNativeStepCounter = () => isNativeApp();

type PermissionCopy = {
  /** Name of the step permission as the OS shows it. */
  motionName: string;
  /** Where the user fixes a blocked permission. */
  settingsName: string;
  /** Toast after we opened the app's settings page for the motion permission. */
  motionOpenedSettingsHint: string;
  /** Toast when the motion permission is blocked and settings could not be opened. */
  motionBlockedHint: string;
  /** Toast after we opened settings for another permission ("Camera", "Location"…). */
  openedSettingsFor: (what: string) => string;
  /** Short description of how steps are counted on this platform. */
  stepSourceDescription: string;
};

const ANDROID_COPY: PermissionCopy = {
  motionName: 'Physical activity',
  settingsName: 'app settings',
  motionOpenedSettingsHint: 'Allow “Physical activity” under Permissions, then come back to Step2Win.',
  motionBlockedHint: 'Physical activity is blocked. Allow it in your phone settings to count steps.',
  openedSettingsFor: (what) => `Allow ${what} under Permissions, then come back to Step2Win.`,
  stepSourceDescription: 'Asks for Physical activity and starts counting in the background.',
};

const IOS_COPY: PermissionCopy = {
  motionName: 'Motion & Fitness',
  settingsName: 'the Settings app',
  motionOpenedSettingsHint: 'Turn on “Motion & Fitness” for Step2Win in Settings, then come back.',
  motionBlockedHint: 'Motion & Fitness is off for Step2Win. Turn it on in Settings › Step2Win to count steps.',
  openedSettingsFor: (what) => `Turn on ${what} for Step2Win in Settings, then come back.`,
  stepSourceDescription: 'Asks for Motion & Fitness. Your iPhone keeps counting steps even when Step2Win is closed.',
};

export function permissionCopy(): PermissionCopy {
  return isIOSApp() ? IOS_COPY : ANDROID_COPY;
}
