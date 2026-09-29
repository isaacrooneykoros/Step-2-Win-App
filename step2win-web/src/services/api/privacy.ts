import api from './client';

/** Consent purposes known to the backend (apps/privacy/consent.py). */
export type ConsentPurpose = 'terms' | 'health_data' | 'location_walks';
export type ConsentStatus = 'granted' | 'outdated' | 'withdrawn' | 'not_given';
export type ConsentSource = 'registration' | 'social_signup' | 'reconsent' | 'settings' | 'walk_start';

export interface ConsentPurposeState {
  purpose: ConsentPurpose;
  required: boolean;
  title: string;
  description: string;
  withdraw_effect: string;
  status: ConsentStatus;
  granted: boolean;
  version: string | null;
  updated_at: string | null;
  source: string | null;
}

export interface PolicyDocumentInfo {
  slug: string;
  title: string | null;
  version: number;
  version_label: string | null;
  change_summary: string;
}

export interface ConsentOverview {
  purposes: ConsentPurposeState[];
  needs_consent: boolean;
  missing: ConsentPurpose[];
  documents: { terms: PolicyDocumentInfo; privacy: PolicyDocumentInfo };
  text_version: string;
}

export type ExportStatus = 'pending' | 'running' | 'ready' | 'failed' | 'expired';

export interface DataExport {
  id: string;
  status: ExportStatus;
  requested_at: string;
  finished_at: string | null;
  expires_at: string | null;
  size_bytes: number;
  download_path: string | null;
}

export interface ExportList {
  exports: DataExport[];
  cooldown_hours: number;
  link_hours: number;
}

export interface RetentionItem {
  key: string;
  title: string;
  text: string;
}

/** Per account, so a different sign-in on the same phone never sees cached answers. */
export const consentsQueryKey = (userId: number | string | null | undefined) => ['privacy', 'consents', userId ?? 'anon'] as const;
export const exportsQueryKey = (userId: number | string | null | undefined) => ['privacy', 'exports', userId ?? 'anon'] as const;

const APP_VERSION = import.meta.env.VITE_APP_VERSION || '1.0.0';

export const privacyService = {
  getConsents: async (): Promise<ConsentOverview> => {
    const response = await api.get<ConsentOverview>('/api/privacy/consents/');
    return response.data;
  },

  updateConsents: async (
    consents: Partial<Record<ConsentPurpose, boolean>>,
    source: ConsentSource,
  ): Promise<ConsentOverview> => {
    const response = await api.post<ConsentOverview>('/api/privacy/consents/', {
      consents,
      source,
      app_version: APP_VERSION,
    });
    return response.data;
  },

  listExports: async (): Promise<ExportList> => {
    const response = await api.get<ExportList>('/api/privacy/exports/');
    return response.data;
  },

  requestExport: async (): Promise<DataExport> => {
    const response = await api.post<DataExport>('/api/privacy/exports/');
    return response.data;
  },

  downloadExport: async (path: string): Promise<Blob> => {
    const response = await api.get(path, { responseType: 'blob', timeout: 120000 });
    return response.data as Blob;
  },

  getSummary: async (): Promise<{ retention: RetentionItem[] }> => {
    const response = await api.get<{ retention: RetentionItem[] }>('/api/privacy/summary/');
    return response.data;
  },
};
