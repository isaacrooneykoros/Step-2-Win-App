import { useCallback, useEffect, useState } from 'react';
import { App as CapacitorApp } from '@capacitor/app';
import { AppSystem, isNativeAppShell, openAppSettings } from '../../plugins/appSystem';
import { permissionCopy } from '../../utils/platform';
import { useToast } from '../ui/Toast';
import {
  checkNotificationPermission,
  requestNotificationPermission,
  syncReminderNotifications,
  type NotificationPreferences,
} from '../../services/notifications';
import { checkCameraPermission, requestCameraPermission, type CameraPermissionState } from '../../services/cameraPermissions';
import {
  checkAdvancedPermissionSnapshot,
  openExactAlarmPermissionSettings,
  requestBackgroundLocationPermission,
  requestForegroundLocationPermission,
  type LocationPermissionState,
} from '../../services/locationPermissions';

export type NotificationPermissionState = 'prompt' | 'prompt-with-rationale' | 'granted' | 'denied' | 'unavailable';
export type ExactAlarmState = 'granted' | 'denied' | 'unavailable';

/** Loads and requests the OS-level permissions the Settings screen manages. */
export function useDevicePermissions() {
  const { showToast } = useToast();
  const [notification, setNotification] = useState<NotificationPermissionState>('prompt');
  const [camera, setCamera] = useState<CameraPermissionState>('prompt');
  const [location, setLocation] = useState<LocationPermissionState>('prompt');
  const [backgroundLocation, setBackgroundLocation] = useState<LocationPermissionState>('prompt');
  const [exactAlarm, setExactAlarm] = useState<ExactAlarmState>('unavailable');
  const [busy, setBusy] = useState<null | 'notification' | 'camera' | 'location' | 'background' | 'alarm'>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const [notificationStatus, cameraStatus, advanced] = await Promise.all([
        checkNotificationPermission(),
        checkCameraPermission(),
        checkAdvancedPermissionSnapshot(),
      ]);
      if (cancelled) return;
      setNotification(notificationStatus);
      setCamera(cameraStatus);
      setLocation(advanced.location);
      setBackgroundLocation(advanced.backgroundLocation);
      setExactAlarm(advanced.exactAlarm);
    };
    void load();
    // Coming back from the phone's settings: show what the user changed there.
    const handle = isNativeAppShell()
      ? CapacitorApp.addListener('appStateChange', ({ isActive }) => {
          if (isActive) void load();
        })
      : null;
    return () => {
      cancelled = true;
      handle?.then((h) => h.remove()).catch(() => null);
    };
  }, []);

  /** Blocked permissions can only be changed in the phone's settings (Android after repeated denials, iOS after one). */
  const openSettingsFor = async (what: string) => {
    const opened = await openAppSettings();
    showToast({
      message: opened
        ? permissionCopy().openedSettingsFor(what)
        : `${what} is blocked. Allow it in ${permissionCopy().settingsName}.`,
      type: 'info',
    });
  };

  const refreshAdvanced = useCallback(async () => {
    const updated = await checkAdvancedPermissionSnapshot();
    setLocation(updated.location);
    setBackgroundLocation(updated.backgroundLocation);
    setExactAlarm(updated.exactAlarm);
  }, []);

  const requestNotifications = async (preferences: NotificationPreferences) => {
    setBusy('notification');
    try {
      if (notification === 'denied' && isNativeAppShell()) {
        await AppSystem.openNotificationSettings().catch(() => null);
        showToast({ message: 'Turn on notifications for Step2Win, then come back.', type: 'info' });
        return;
      }
      const granted = await requestNotificationPermission();
      setNotification(granted ? 'granted' : 'denied');
      if (granted) {
        await syncReminderNotifications(preferences).catch(() => null);
        showToast({ message: 'Notifications are on.', type: 'success' });
      } else {
        showToast({ message: 'Notifications were not allowed. You can turn them on in your phone settings.', type: 'error' });
      }
    } finally {
      setBusy(null);
    }
  };

  const requestCamera = async () => {
    setBusy('camera');
    try {
      if (camera === 'denied' && isNativeAppShell()) {
        await openSettingsFor('Camera');
        return;
      }
      const granted = await requestCameraPermission();
      setCamera(granted ? 'granted' : 'denied');
      showToast(
        granted
          ? { message: 'Camera access is on for QR invites.', type: 'success' }
          : { message: 'Camera access was not allowed.', type: 'error' },
      );
    } finally {
      setBusy(null);
    }
  };

  const requestLocation = async () => {
    setBusy('location');
    try {
      if (location === 'denied') {
        await openSettingsFor('Location');
        return;
      }
      const granted = await requestForegroundLocationPermission();
      await refreshAdvanced();
      showToast(
        granted
          ? { message: 'Location access is on.', type: 'success' }
          : { message: 'Location access was not allowed.', type: 'error' },
      );
    } finally {
      setBusy(null);
    }
  };

  const requestBackground = async () => {
    setBusy('background');
    try {
      if (backgroundLocation === 'denied') {
        await openSettingsFor('Location “Allow all the time”');
        return;
      }
      const granted = await requestBackgroundLocationPermission();
      await refreshAdvanced();
      showToast(
        granted
          ? { message: 'Background location is on.', type: 'success' }
          : { message: 'Background location was not allowed.', type: 'error' },
      );
    } finally {
      setBusy(null);
    }
  };

  const openExactAlarm = async () => {
    setBusy('alarm');
    try {
      const opened = await openExactAlarmPermissionSettings();
      if (!opened) {
        showToast({ message: 'Exact alarm settings are not available on this device.', type: 'warning' });
        return;
      }
      showToast({ message: 'Turn on "Alarms & reminders", then come back to Step2Win.', type: 'info' });
      window.setTimeout(async () => {
        const updated = await checkAdvancedPermissionSnapshot();
        setExactAlarm(updated.exactAlarm);
      }, 1200);
    } finally {
      setBusy(null);
    }
  };

  return {
    notification,
    camera,
    location,
    backgroundLocation,
    exactAlarm,
    busy,
    requestNotifications,
    requestCamera,
    requestLocation,
    requestBackground,
    openExactAlarm,
  };
}

export type DevicePermissions = ReturnType<typeof useDevicePermissions>;

/** Plain-language status for any permission state. */
export function permissionLabel(state: string): { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' } {
  if (state === 'granted') return { label: 'Allowed', tone: 'success' };
  if (state === 'denied') return { label: 'Blocked', tone: 'danger' };
  if (state === 'unavailable') return { label: 'Not available', tone: 'neutral' };
  return { label: 'Not set', tone: 'warning' };
}
