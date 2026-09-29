import { DeviceStepCounter } from '../plugins/deviceStepCounter';
import { hasNativeStepCounter, isIOSApp } from '../utils/platform';

export type LocationPermissionState = 'prompt' | 'prompt-with-rationale' | 'granted' | 'denied' | 'unavailable';

export type AdvancedPermissionSnapshot = {
  location: LocationPermissionState;
  exactAlarm: 'granted' | 'denied' | 'unavailable';
};

/**
 * Location while using the app only. It is asked when the user starts their first walk;
 * background location is never requested.
 */
export async function checkAdvancedPermissionSnapshot(): Promise<AdvancedPermissionSnapshot> {
  if (!hasNativeStepCounter()) {
    return { location: 'unavailable', exactAlarm: 'unavailable' };
  }

  try {
    const status = await DeviceStepCounter.checkAdvancedPermissions();
    return {
      location: status.location,
      // Reminders are scheduled inexactly and the app no longer requests SCHEDULE_EXACT_ALARM
      // (Google Play restricts it), so there is nothing for the user to grant.
      exactAlarm: 'unavailable',
    };
  } catch {
    return { location: 'denied', exactAlarm: 'unavailable' };
  }
}

export async function requestForegroundLocationPermission(): Promise<boolean> {
  if (!hasNativeStepCounter()) {
    return false;
  }

  const result = await DeviceStepCounter.requestLocationPermissions();
  return result.location === 'granted';
}

/** Android 12+ only. */
export async function openExactAlarmPermissionSettings(): Promise<boolean> {
  if (!hasNativeStepCounter() || isIOSApp()) {
    return false;
  }

  const result = await DeviceStepCounter.openExactAlarmSettings();
  return !!result.opened;
}

/**
 * One fresh position (used once, e.g. to set the home privacy zone). The caller asks for the
 * permission first; the WebView's geolocation uses the app's location permission.
 */
export async function getCurrentCoordinates(): Promise<{ latitude: number; longitude: number; accuracy: number }> {
  if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
    throw new Error('unavailable');
  }
  const position = await new Promise<GeolocationPosition>((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: 20_000,
      maximumAge: 60_000,
    });
  });
  return {
    latitude: position.coords.latitude,
    longitude: position.coords.longitude,
    accuracy: Math.max(0, Math.round(position.coords.accuracy || 0)),
  };
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
