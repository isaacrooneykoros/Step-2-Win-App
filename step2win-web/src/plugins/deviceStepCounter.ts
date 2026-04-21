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
  gait_state?: 'idle' | 'possible_walking' | 'confirmed_walking' | 'suspicious_motion';
  gait_confidence?: number;
  gait_dominant_freq_hz?: number;
  gait_autocorr?: number;
  gait_interval_std_ms?: number;
  gait_valid_peaks_2s?: number;
  gait_gyro_variance?: number;
  gait_jerk_rms?: number;
  carry_mode?: 'unknown' | 'in_hand' | 'pocket' | 'bag';
  ml_motion_label?: 'walk' | 'shake' | 'other';
  ml_walk_probability?: number;
  ml_shake_probability?: number;
  ml_model_version?: string;
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
