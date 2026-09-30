import { registerPlugin } from '@capacitor/core';

export type PermissionState = 'prompt' | 'prompt-with-rationale' | 'granted' | 'denied' | 'unavailable';

export interface DeviceStepCounterPermissionStatus {
  activityRecognition: PermissionState;
}

export interface DeviceStepCounterAdvancedPermissionStatus extends DeviceStepCounterPermissionStatus {
  /** Foreground location only (asked at the first "Start a walk"). Background location is never requested. */
  location: PermissionState;
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
  /**
   * How burst_steps_5s was measured: "live_timed" only when every step carries its own
   * sensor timestamp (Android STEP_DETECTOR SensorEvent.timestamp); otherwise "arrival_batched".
   */
  burst_source?: 'live_timed' | 'arrival_batched' | null;
  /** Phase 1b walking evidence (see WalkingEvidenceHour). iOS: 'ios_coremotion'. */
  evidence_source?: 'android_gait_v1' | 'ios_coremotion' | null;
  evidence_hours?: WalkingEvidenceHour[] | null;
  /** Random id of this app install (new after a reinstall). */
  install_id?: string;
}

/**
 * Per local hour of the day: every counted phone-counter step of the hour falls in exactly one
 * bucket. Cumulative for the day and this install (each upload repeats the whole day).
 * - verified: steps while on-device gait analysis saw walking or running
 * - shake:    steps while the motion clearly did not look like walking (shaking, swinging, vibration)
 * - unknown:  steps nothing measured (app closed, no walking service) or inconclusive / missing sensor
 * - vehicle:  steps while Activity Recognition said IN_VEHICLE / ON_BICYCLE (or GPS vehicle speed in a walk)
 * - walk:     steps inside a user-started walk session (the server verifies those via the walk)
 */
export interface WalkingEvidenceHour {
  hour: number;
  verified: number;
  shake: number;
  unknown: number;
  vehicle: number;
  walk: number;
  /** Minutes of the hour with at least one step. */
  active_minutes: number;
  /** Minutes of the hour in which gait was actually analysed. */
  gait_minutes: number;
}

/** Supplementary device signals (shadow only on the server). */
export interface DeviceSignals {
  emulator: boolean;
  rooted: boolean;
  debuggable: boolean;
  adb_enabled: boolean;
  has_step_counter: boolean;
  has_step_detector: boolean;
  has_accelerometer: boolean;
  has_gyroscope: boolean;
  has_gravity: boolean;
}

export type WalkGpsStatus = 'ok' | 'searching' | 'off' | 'denied' | 'unavailable';

/** One GPS fix of a walk. Fast fixes are kept (spd flags vehicle speed); mock = from a mock provider. */
export interface WalkPoint {
  /** ISO time of the fix. */
  t: string;
  lat: number;
  lng: number;
  /** Horizontal accuracy (m). */
  acc: number;
  /** Speed (m/s) from the fix or derived; null when unknown. */
  spd: number | null;
  mock: boolean;
}

export interface WalkState {
  active: boolean;
  walkId: string | null;
  startedAt: string | null;
  endedAt: string | null;
  elapsedS: number;
  steps: number;
  distanceM: number;
  /** Walk steps by on-device gait verdict. verified + shake + unknown == steps. */
  gaitVerifiedSteps: number;
  gaitShakeSteps: number;
  gaitUnknownSteps: number;
  /** Seconds moving at vehicle speed (GPS) or in a vehicle / on a bike (Activity Recognition). */
  vehicleSeconds: number;
  mockLocation: boolean;
  /** True when the walk ended by itself after long inactivity. */
  autoEnded: boolean;
  gpsStatus: WalkGpsStatus;
  /** 'step_counter' (hardware counter) | 'accelerometer' (phones without TYPE_STEP_COUNTER) | 'cmpedometer' (iOS). */
  stepSource: 'step_counter' | 'accelerometer' | 'cmpedometer';
  /** Points recorded but not yet taken with takeWalkPoints / stopWalk. */
  pointsPending: number;
}

export interface WalkStartResult {
  started: boolean;
  /** Why it didn't start. */
  reason?: 'location_permission' | 'activity_permission' | 'gps_off' | 'already_active' | 'unsupported';
  stepSource?: WalkState['stepSource'];
}

export interface StepSensorCapabilities {
  hasStepCounter: boolean;
  hasStepDetector: boolean;
  hasAccelerometer: boolean;
  hasGyroscope: boolean;
  hasGravity: boolean;
  /** Can a walk count steps at all (step counter or accelerometer fallback). */
  walkSupported: boolean;
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

/** Android native uploader outcome (DeviceStepCounter.syncNow). */
export type NativeSyncStatus =
  | 'ok'
  | 'nothing'
  | 'pending'
  | 'busy'
  | 'offline'
  | 'backoff'
  | 'throttled'
  | 'auth'
  | 'signed_out'
  | 'not_configured'
  | 'rejected'
  | 'error';

export interface NativeSyncResult {
  status: NativeSyncStatus;
  uploaded: number;
  pendingDays: number;
  /** ISO time before which the server asked not to retry (Retry-After / backoff). */
  retryAt: string | null;
  message?: string;
}

export interface NativeSyncPendingDay {
  date: string;
  steps: number;
  ackedSteps: number;
  retries: number;
  nextAttemptAt: string | null;
}

export interface NativeSyncStatusReport {
  pending: NativeSyncPendingDay[];
  signedIn: boolean;
  todaySteps: number;
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  nextAllowedAt: string | null;
  failureCount: number;
  lastStatus: string;
  lastReadingAt: string | null;
  saverMode: boolean;
  nearDeadline: boolean;
  challengeActiveToday: boolean;
  backgroundIntervalMinutes: number;
}

export interface SyncConfiguration {
  apiBaseUrl: string;
  strideCm?: number;
  weightKg?: number;
  dataSaver?: boolean;
  /** Active challenges the user is in: local-date ranges (YYYY-MM-DD, inclusive). */
  challengeWindows?: Array<{ start: string; end: string }>;
}

export interface StepHistoryDay {
  date: string;
  steps: number;
  /** 24 hourly buckets (local time). */
  hours: number[];
}

export interface DeviceStepCounterPlugin {
  checkPermissions(): Promise<DeviceStepCounterPermissionStatus>;
  requestPermissions(): Promise<DeviceStepCounterPermissionStatus>;
  checkAdvancedPermissions(): Promise<DeviceStepCounterAdvancedPermissionStatus>;
  requestLocationPermissions(): Promise<{ location: PermissionState }>;
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
  /** Next sequence number of the active step session (strictly increasing, shared with native uploads). */
  claimSequence(): Promise<{ sequence_number: number }>;

  // ── Android: native smart sync (WorkManager + walking service + one uploader) ──
  configureSync(config: SyncConfiguration): Promise<{
    backgroundIntervalMinutes: number;
    challengeActiveToday: boolean;
    nearDeadline: boolean;
    motionTriggers: boolean;
  }>;
  syncNow(options?: { force?: boolean; reason?: string }): Promise<NativeSyncResult>;
  getSyncStatus(): Promise<NativeSyncStatusReport>;
  /** Android: fires (at most every 3 s) when today's step total changes while the app is open. */
  addListener(
    eventName: 'stepsChanged',
    listener: (data: { steps: number; date: string; cadence_spm: number }) => void,
  ): Promise<{ remove: () => Promise<void> }>;

  // ── Phase 1b: walks, device integrity, capabilities ──
  /** Starts the user's walk: foreground service (location|health), high-accuracy GPS, gait evidence. */
  startWalk(options: { walkId: string; autoEndMinutes?: number }): Promise<WalkStartResult>;
  getWalkState(): Promise<WalkState>;
  /** Drains up to `max` buffered points (oldest first) for upload / live drawing. */
  takeWalkPoints(options?: { max?: number }): Promise<{ points: WalkPoint[] }>;
  /** Ends the walk (GPS off, service stopped). Returns the final state and every point not yet taken. */
  stopWalk(): Promise<WalkState & { points: WalkPoint[] }>;
  /** Play Integrity (Android) token for a server nonce. token null when unavailable (not configured, no Play services). */
  requestIntegrityToken(options: { nonce: string }): Promise<{ token: string | null; error?: string }>;
  getDeviceSignals(): Promise<DeviceSignals>;
  getSensorCapabilities(): Promise<StepSensorCapabilities>;
  /** Fires while a walk is active (about every 2 s). */
  addListener(eventName: 'walkUpdate', listener: (state: WalkState) => void): Promise<{ remove: () => Promise<void> }>;

  // ── iOS: CoreMotion history for offline catch-up (the phone keeps ~7 days) ──
  getStepHistory(options: { days: number }): Promise<{ days: StepHistoryDay[] }>;

  // ── Phase 1c: Health Connect (Android) / Apple Health (iOS), opt-in and read-only ──
  healthSourcesStatus(): Promise<HealthSourcesStatus>;
  /** Opts in and shows Health Connect's / Apple's own access screen (read only). */
  healthSourcesConnect(): Promise<HealthSourcesStatus>;
  /** Reads the last few days now. iOS also returns the payloads for the JS layer to upload. */
  healthSourcesRead(options?: { force?: boolean }): Promise<HealthSourcesStatus & { days?: Record<string, HealthSourcesPayload> }>;
  healthSourcesDisconnect(): Promise<HealthSourcesStatus>;
  /** Android 9-13: opens the Play Store page of the Health Connect app. */
  healthSourcesInstall(): Promise<{ opened: boolean }>;
  /** Health Connect's own settings (Android) or the Health app (iOS). */
  healthSourcesOpenSettings(): Promise<{ opened: boolean }>;
}

/** Where the phone's health store stands and what we last read from it (per device). */
export interface HealthSourcesStatus {
  platform: 'android' | 'ios';
  provider: 'health_connect' | 'healthkit';
  /** available | update_required | not_installed (Android 9-13) | unsupported */
  availability: 'available' | 'update_required' | 'not_installed' | 'unsupported';
  optedIn: boolean;
  state: 'off' | 'unavailable' | 'needs_install' | 'needs_update' | 'permission_denied' | 'connected';
  permissions: { steps: boolean; exercise: boolean; routes: boolean; background: boolean };
  backgroundSupported: boolean;
  lastReadAt: string | null;
  lastUploadAt: string | null;
  lastStatus: string;
  /** Apps / devices that wrote steps today (as read on this phone; the server decides what counts). */
  todayOrigins: Array<{ origin: string; steps: number; manual_steps: number; device: string }>;
  /** Today's steps from those apps: per hour the max over apps, never the sum. */
  todaySourceSteps: number;
  note?: string;
}

/** One day's summary for POST /api/steps/health-sources/ (see backend/ANTICHEAT.md "Phase 1c"). */
export interface HealthSourcesPayload {
  provider: 'health_connect' | 'healthkit';
  platform: 'android' | 'ios';
  read_at: string;
  tz_offset_minutes: number;
  hours: Array<{ hour: number; origin: string; steps: number; device: string; method: string }>;
  workouts: Array<Record<string, unknown>>;
}

/** Android: DeviceStepCounterPlugin.java (sensor + foreground service). iOS: DeviceStepCounterPlugin.swift (CMPedometer). */
export const DeviceStepCounter = registerPlugin<DeviceStepCounterPlugin>('DeviceStepCounter');
