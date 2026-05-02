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
  // Enhanced ML features (smoothed predictions)
  smoothed_walk_probability?: number;
  smoothed_shake_probability?: number;
  ml_window_count?: number;
  ml_confidence_stability?: number;
  motion_entropy?: number;
  // Session and replay protection fields
  device_id?: string;
  session_id?: string;
  client_event_id?: string;
  sequence_number?: number;
  timestamp_client?: string;
  payload_hash?: string;
  steps_delta?: number;
  steps_total?: number;
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
  startStepSession(): Promise<{
    device_id: string;
    platform: 'android';
    app_version: string;
    ml_model_version: string;
    session_id?: string | null;
    session_token?: string | null;
    expires_at?: string | null;
    next_sequence_number?: number | null;
  }>;
  setActiveStepSession(data: {
    session_id: string;
    session_token: string;
    expires_at: string;
    next_sequence_number: number;
  }): Promise<{ saved: boolean }>;
  clearActiveStepSession(): Promise<{ cleared: boolean }>;
  getTodaySteps(): Promise<DeviceStepCounterReading>;
  startBackgroundCapture(): Promise<DeviceStepCounterBackgroundStatus>;
  stopBackgroundCapture(): Promise<DeviceStepCounterBackgroundStatus>;
  getBackgroundStatus(): Promise<DeviceStepCounterBackgroundStatus>;
  getPendingWaypoints(): Promise<DeviceStepCounterPendingWaypoints>;
  clearPendingWaypoints(): Promise<{ cleared: boolean }>;
}

export const DeviceStepCounter = registerPlugin<DeviceStepCounterPlugin>('DeviceStepCounter');
