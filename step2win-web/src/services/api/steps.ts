import api from './client';
import type {
  HealthRecord,
  HealthSummary,
  StepSyncForm,
  DayDetail,
  HourlyStep,
  LocationWaypoint,
  StepSessionStartRequest,
  StepSessionStartResponse,
  StepSessionEndRequest,
  StepSessionEndResponse,
  TrustProfileResponse,
  ActivePolicyResponse,
  IntegrityStatus,
  StepResumeResponse,
  WalkStartRequest,
  WalkStartResponse,
  WalkPointsRequest,
  WalkPointsResponse,
  WalkFinishRequest,
  WalkSummary,
  PrivacyZoneStatus,
  DayBreakdown,
  VerificationResponse,
} from '../../types';

const walkPath = (id: number | string) => `/api/steps/walks/${encodeURIComponent(String(id))}/`;

export const stepsService = {
  /**
   * Sync health metrics with optional signed headers
   */
  syncHealth: async (data: StepSyncForm, headers?: Record<string, string>): Promise<HealthRecord> => {
    const response = await api.post<HealthRecord>('/api/steps/sync/', data, {
      headers,
    });
    return response.data;
  },

  startSession: async (data: StepSessionStartRequest): Promise<StepSessionStartResponse> => {
    const response = await api.post<StepSessionStartResponse>('/api/steps/session/start/', data);
    return response.data;
  },

  endSession: async (data: StepSessionEndRequest): Promise<StepSessionEndResponse> => {
    const response = await api.post<StepSessionEndResponse>('/api/steps/session/end/', data);
    return response.data;
  },

  getTrustProfile: async (): Promise<TrustProfileResponse> => {
    const response = await api.get<TrustProfileResponse>('/api/steps/trust/profile/');
    return response.data;
  },

  getActivePolicy: async (): Promise<ActivePolicyResponse> => {
    const response = await api.get<ActivePolicyResponse>('/api/steps/policy/active/');
    return response.data;
  },

  /**
   * Get today's health record
   */
  getTodayHealth: async (): Promise<HealthRecord> => {
    const response = await api.get<HealthRecord>('/api/steps/today/');
    return response.data;
  },

  /**
   * Get weekly steps
   */
  getWeekly: async (): Promise<Array<{ date: string; steps: number }>> => {
    const response = await api.get<Array<{ date: string; steps: number }>>('/api/steps/weekly/');
    return response.data;
  },

  /**
   * Get health summary for detail screen
   */
  getSummary: async (): Promise<HealthSummary> => {
    const response = await api.get<HealthSummary>('/api/steps/summary/');
    return response.data;
  },

  /**
   * Get health history with period filter
   */
  getHistory: async (period: string = '1w'): Promise<HealthRecord[]> => {
    const response = await api.get<HealthRecord[]>(`/api/steps/history/?period=${period}`);
    return response.data;
  },

  sync: async (data: StepSyncForm): Promise<HealthRecord> => {
    return stepsService.syncHealth(data);
  },

  getToday: async (): Promise<HealthRecord> => {
    return stepsService.getTodayHealth();
  },

  /**
   * Get detailed view for a single day
   */
  getDayDetail: async (date: string): Promise<DayDetail> => {
    const response = await api.get<DayDetail>(`/api/steps/day/${date}/`);
    return response.data;
  },

  /**
   * Sync hourly step data and location waypoints
   */
  syncHourly: async (data: {
    date: string;
    hourly: HourlyStep[];
    waypoints: LocationWaypoint[];
  }): Promise<{ status: string; hourly_count: number; waypoint_count: number }> => {
    const response = await api.post(`/api/steps/sync/hourly/`, data);
    return response.data;
  },

  /** Play Integrity token for the step session (Android; only when the server asked). */
  sendSessionIntegrity: async (data: {
    session_id: string;
    session_token: string;
    integrity_token: string;
  }): Promise<{ integrity_status: IntegrityStatus }> => {
    const response = await api.post<{ integrity_status: IntegrityStatus }>('/api/steps/session/integrity/', data);
    return response.data;
  },

  /** The server's last raw day total (after a reinstall). */
  getResume: async (date: string): Promise<StepResumeResponse> => {
    const response = await api.get<StepResumeResponse>(`/api/steps/resume/?date=${encodeURIComponent(date)}`);
    return response.data;
  },

  // ── Verification ("why") ──

  /** One day's breakdown, or null when the server has nothing for that day. */
  getVerificationDay: async (date: string): Promise<DayBreakdown | null> => {
    const response = await api.get<VerificationResponse>(`/api/steps/verification/?date=${encodeURIComponent(date)}`);
    return response.data?.days?.[0] ?? null;
  },

  /** The last `days` days (1..14), newest first. */
  getVerificationDays: async (days = 7): Promise<DayBreakdown[]> => {
    const n = Math.max(1, Math.min(14, Math.round(days)));
    const response = await api.get<VerificationResponse>(`/api/steps/verification/?days=${n}`);
    return response.data?.days ?? [];
  },

  // ── Walks ──

  startWalk: async (data: WalkStartRequest): Promise<WalkStartResponse> => {
    const response = await api.post<WalkStartResponse>('/api/steps/walks/start/', data);
    return response.data;
  },

  sendWalkPoints: async (id: number | string, data: WalkPointsRequest): Promise<WalkPointsResponse> => {
    const response = await api.post<WalkPointsResponse>(`${walkPath(id)}points/`, data);
    return response.data;
  },

  finishWalk: async (id: number | string, data: WalkFinishRequest): Promise<WalkSummary> => {
    const response = await api.post<WalkSummary>(`${walkPath(id)}finish/`, data);
    return response.data;
  },

  sendWalkIntegrity: async (id: number | string, integrityToken: string): Promise<{ integrity_status: IntegrityStatus }> => {
    const response = await api.post<{ integrity_status: IntegrityStatus }>(`${walkPath(id)}integrity/`, {
      integrity_token: integrityToken,
    });
    return response.data;
  },

  listWalks: async (limit = 20): Promise<WalkSummary[]> => {
    const response = await api.get<{ walks: WalkSummary[] }>(`/api/steps/walks/?limit=${Math.max(1, Math.round(limit))}`);
    return response.data?.walks ?? [];
  },

  getWalk: async (id: number | string): Promise<WalkSummary> => {
    const response = await api.get<WalkSummary>(walkPath(id));
    return response.data;
  },

  getPrivacyZone: async (): Promise<PrivacyZoneStatus> => {
    const response = await api.get<PrivacyZoneStatus>('/api/steps/walks/privacy-zone/');
    return response.data;
  },

  setPrivacyZone: async (data: { latitude: number; longitude: number; radius_m: number }): Promise<PrivacyZoneStatus> => {
    const response = await api.put<PrivacyZoneStatus>('/api/steps/walks/privacy-zone/', data);
    return response.data;
  },

  deletePrivacyZone: async (): Promise<void> => {
    await api.delete('/api/steps/walks/privacy-zone/');
  },
};
