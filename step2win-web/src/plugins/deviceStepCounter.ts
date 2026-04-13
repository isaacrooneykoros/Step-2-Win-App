import { registerPlugin } from '@capacitor/core';

export type PermissionState = 'prompt' | 'prompt-with-rationale' | 'granted' | 'denied' | 'unavailable';

export interface DeviceStepCounterPermissionStatus {
  activityRecognition: PermissionState;
}

export interface DeviceStepCounterAdvancedPermissionStatus extends DeviceStepCounterPermissionStatus {
  location: PermissionState;
  backgroundLocation: PermissionState;
  exactAlarm: 'granted' | 'denied';
}

export interface DeviceStepCounterReading {
  steps: number;
  date: string;
  timestamp: string;
  available: boolean;
  cadence_spm: number;
  burst_steps_5s: number;
  background_running: boolean;
}

export interface DeviceStepCounterBackgroundStatus {
  running: boolean;
}

export interface DeviceStepCounterWaypoint {
  hour: number;
  recorded_at: string;
  latitude: number;
  longitude: number;
  accuracy_m: number;
}

export interface DeviceStepCounterPendingWaypoints {
  date: string;
  waypoints: DeviceStepCounterWaypoint[];
}

export interface DeviceStepCounterPlugin {
  checkPermissions(): Promise<DeviceStepCounterPermissionStatus>;
  requestPermissions(): Promise<DeviceStepCounterPermissionStatus>;
  checkAdvancedPermissions(): Promise<DeviceStepCounterAdvancedPermissionStatus>;
  requestLocationPermissions(): Promise<{ location: PermissionState }>;
  requestBackgroundLocationPermission(): Promise<{ backgroundLocation: PermissionState }>;
  openExactAlarmSettings(): Promise<{ opened: boolean; supported: boolean }>;
  getTodaySteps(): Promise<DeviceStepCounterReading>;
  startBackgroundCapture(): Promise<DeviceStepCounterBackgroundStatus>;
  stopBackgroundCapture(): Promise<DeviceStepCounterBackgroundStatus>;
  getBackgroundStatus(): Promise<DeviceStepCounterBackgroundStatus>;
  getPendingWaypoints(): Promise<DeviceStepCounterPendingWaypoints>;
  clearPendingWaypoints(): Promise<{ cleared: boolean }>;
}

export const DeviceStepCounter = registerPlugin<DeviceStepCounterPlugin>('DeviceStepCounter');
