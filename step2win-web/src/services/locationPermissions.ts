import { DeviceStepCounter } from '../plugins/deviceStepCounter';
import { hasNativeStepCounter, isIOSApp } from '../utils/platform';

export type LocationPermissionState = 'prompt' | 'prompt-with-rationale' | 'granted' | 'denied' | 'unavailable';

export type AdvancedPermissionSnapshot = {
  location: LocationPermissionState;
  backgroundLocation: LocationPermissionState;
  exactAlarm: 'granted' | 'denied' | 'unavailable';
};

/**
 * Android: foreground + background location and exact alarms. iOS: location while using the app
 * only — no background route tracking and no exact-alarm setting, so both report 'unavailable'.
 */
export async function checkAdvancedPermissionSnapshot(): Promise<AdvancedPermissionSnapshot> {
  if (!hasNativeStepCounter()) {
    return {
      location: 'unavailable',
      backgroundLocation: 'unavailable',
      exactAlarm: 'unavailable',
    };
  }

  try {
    const status = await DeviceStepCounter.checkAdvancedPermissions();
    const ios = isIOSApp();
    return {
      location: status.location,
      backgroundLocation: ios ? 'unavailable' : status.backgroundLocation,
      // Reminders are scheduled inexactly and the app no longer requests SCHEDULE_EXACT_ALARM
      // (Google Play restricts it), so there is nothing for the user to grant.
      exactAlarm: 'unavailable',
    };
  } catch {
    const ios = isIOSApp();
    return {
      location: 'denied',
      backgroundLocation: ios ? 'unavailable' : 'denied',
      exactAlarm: 'unavailable',
    };
  }
}

export async function requestForegroundLocationPermission(): Promise<boolean> {
  if (!hasNativeStepCounter()) {
    return false;
  }

  const result = await DeviceStepCounter.requestLocationPermissions();
  return result.location === 'granted';
}

/** Android only (iOS records routes only while the app is open). */
export async function requestBackgroundLocationPermission(): Promise<boolean> {
  if (!hasNativeStepCounter() || isIOSApp()) {
    return false;
  }

  const result = await DeviceStepCounter.requestBackgroundLocationPermission();
  return result.backgroundLocation === 'granted';
}

/** Android 12+ only. */
export async function openExactAlarmPermissionSettings(): Promise<boolean> {
  if (!hasNativeStepCounter() || isIOSApp()) {
    return false;
  }

  const result = await DeviceStepCounter.openExactAlarmSettings();
  return !!result.opened;
}

export async function captureCurrentWaypoint() {
  if (!('geolocation' in navigator)) {
    return null;
  }

  if ('permissions' in navigator && navigator.permissions?.query) {
    try {
      const permission = await navigator.permissions.query({ name: 'geolocation' as PermissionName });
      if (permission.state !== 'granted') {
        return null;
      }
    } catch {
      // Fall through when browser does not fully support geolocation permission queries.
    }
  }

  const position = await new Promise<GeolocationPosition>((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: 8000,
      maximumAge: 30000,
    });
  });

  const now = new Date();
  return {
    hour: now.getHours(),
    recorded_at: now.toISOString(),
    latitude: position.coords.latitude,
    longitude: position.coords.longitude,
    accuracy_m: Math.max(0, Math.round(position.coords.accuracy || 0)),
  };
}
