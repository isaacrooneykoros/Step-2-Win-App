import { Capacitor } from '@capacitor/core';
import { DeviceStepCounter } from '../plugins/deviceStepCounter';

export type LocationPermissionState = 'prompt' | 'prompt-with-rationale' | 'granted' | 'denied' | 'unavailable';

export type AdvancedPermissionSnapshot = {
  location: LocationPermissionState;
  backgroundLocation: LocationPermissionState;
  exactAlarm: 'granted' | 'denied' | 'unavailable';
};

export async function checkAdvancedPermissionSnapshot(): Promise<AdvancedPermissionSnapshot> {
  if (Capacitor.getPlatform() !== 'android') {
    return {
      location: 'unavailable',
      backgroundLocation: 'unavailable',
      exactAlarm: 'unavailable',
    };
  }

  try {
    const status = await DeviceStepCounter.checkAdvancedPermissions();
    return {
      location: status.location,
      backgroundLocation: status.backgroundLocation,
      exactAlarm: status.exactAlarm,
    };
  } catch {
    return {
      location: 'denied',
      backgroundLocation: 'denied',
      exactAlarm: 'denied',
    };
  }
}

export async function requestForegroundLocationPermission(): Promise<boolean> {
  if (Capacitor.getPlatform() !== 'android') {
    return false;
  }

  const result = await DeviceStepCounter.requestLocationPermissions();
  return result.location === 'granted';
}

export async function requestBackgroundLocationPermission(): Promise<boolean> {
  if (Capacitor.getPlatform() !== 'android') {
    return false;
  }

  const result = await DeviceStepCounter.requestBackgroundLocationPermission();
  return result.backgroundLocation === 'granted';
}

export async function openExactAlarmPermissionSettings(): Promise<boolean> {
  if (Capacitor.getPlatform() !== 'android') {
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
