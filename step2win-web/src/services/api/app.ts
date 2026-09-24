import api from './client';

/** GET /api/app/config/ — runtime settings the admin controls. Always reachable, even during maintenance. */
export interface AppConfig {
  maintenance: { enabled: boolean; message: string };
  features: { registrations: boolean; challenges: boolean; withdrawals: boolean };
  withdrawals: { minimum_kes: string; maximum_kes: string; processing_hours: number };
  support_email: string;
  /** Which third-party sign-ins the server can verify (absent on older backends). */
  auth_providers?: { google: boolean; apple: boolean };
}

export const appService = {
  getConfig: async (): Promise<AppConfig> => {
    const response = await api.get<AppConfig>('/api/app/config/');
    return response.data;
  },
};
