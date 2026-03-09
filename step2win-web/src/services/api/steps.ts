import api from './client';
import type {
  HealthRecord,
  HealthSummary,
  StepSyncForm,
  DayDetail,
  HourlyStep,
  LocationWaypoint,
} from '../../types';

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
};
