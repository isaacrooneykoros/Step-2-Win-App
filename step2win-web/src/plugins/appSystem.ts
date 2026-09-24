import { Capacitor, registerPlugin } from '@capacitor/core';

/**
 * Native bridge: android/app/src/main/java/com/step2win/app/AppSystemPlugin.java and
 * ios/App/App/AppSystemPlugin.swift (same methods; on iOS the settings links all open the app's
 * page in the Settings app and the privacy screen blurs the app-switcher snapshot).
 */
export interface AppSystemPlugin {
  /** Hide app content in the recents switcher (API 33+) — FLAG_SECURE on older Android. */
  setPrivacyScreen(options: { enabled: boolean }): Promise<{ enabled: boolean; mode: 'recents' | 'secure' }>;
  checkCameraPermission(): Promise<{ camera: string }>;
  requestCameraPermission(): Promise<{ camera: string }>;
  openSecuritySettings(): Promise<{ opened: boolean }>;
  openAppSettings(): Promise<{ opened: boolean }>;
  openNotificationSettings(): Promise<{ opened: boolean }>;
}

export const AppSystem = registerPlugin<AppSystemPlugin>('AppSystem');

export const isNativeAndroid = () => Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';

/** Android or iOS app (both ship the AppSystem plugin). */
export const isNativeAppShell = () => Capacitor.isNativePlatform() && ['android', 'ios'].includes(Capacitor.getPlatform());

/** Opens this app's system settings page (permissions). Resolves false on web or failure. */
export async function openAppSettings(): Promise<boolean> {
  if (!isNativeAppShell()) return false;
  try {
    return (await AppSystem.openAppSettings()).opened;
  } catch {
    return false;
  }
}
