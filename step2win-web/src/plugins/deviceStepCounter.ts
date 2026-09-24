import { registerPlugin } from '@capacitor/core';

export type PermissionState = 'prompt' | 'prompt-with-rationale' | 'granted' | 'denied' | 'unavailable';

export interface DeviceStepCounterPermissionStatus {
  activityRecognition: PermissionState;
}

export interface DeviceStepCounterAdvancedPermissionStatus extends DeviceStepCounterPermissionStatus {
  location: PermissionState;
  backgroundLocation: PermissionState;
  exactAlarm: 'granted' | 'denied';
  /** iOS only: false — exact alarms are an Android concept. */
  exactAlarmApplicable?: boolean;
  platform?: 'android' | 'ios';
}

export interface DeviceStepCounterReading {
  steps: number;
  date: string;
  timestamp: string;
  available: boolean;
  cadence_spm: number;
  burst_steps_5s: number;
  gait_state?: 'idle' | 'possible_walking' | 'confirmed_walking' | 'suspicious_motion' | null;
  gait_confidence?: number | null;
  gait_dominant_freq_hz?: number | null;
  gait_autocorr?: number | null;
  gait_interval_std_ms?: number | null;
  gait_valid_peaks_2s?: number | null;
  gait_gyro_variance?: number | null;
  gait_jerk_rms?: number | null;
  carry_mode?: 'unknown' | 'in_hand' | 'pocket' | 'bag' | null;
  ml_motion_label?: 'walk' | 'shake' | 'other' | null;
  ml_walk_probability?: number | null;
  ml_shake_probability?: number | null;
  ml_model_version?: string;
  // Enhanced ML features (smoothed predictions)
  smoothed_walk_probability?: number | null;
  smoothed_shake_probability?: number | null;
  ml_window_count?: number | null;
  ml_confidence_stability?: number | null;
  motion_entropy?: number | null;
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
  platform?: 'android' | 'ios';
  /**
   * iOS (CoreMotion) sets this to false: the Android GaitAnalyzer / ML fields above are then
   * null and must be sent to the backend as null, never as 0.
   */
  gait_available?: boolean | null;
  sensor_source?: 'cmpedometer';
}

export interface DeviceStepCounterBackgroundStatus {
  running: boolean;
  /** iOS: false — there is no foreground service; CoreMotion records steps by itself. */
  supported?: boolean;
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
    platform: 'android' | 'ios';
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
  /** Without options clears everything; with `date` + `upTo` only points recorded at or before `upTo`. */
  clearPendingWaypoints(options?: { date: string; upTo: string }): Promise<{ cleared: boolean; remaining?: number }>;
}

/** Android: DeviceStepCounterPlugin.java (sensor + foreground service). iOS: DeviceStepCounterPlugin.swift (CMPedometer). */
export const DeviceStepCounter = registerPlugin<DeviceStepCounterPlugin>('DeviceStepCounter');
