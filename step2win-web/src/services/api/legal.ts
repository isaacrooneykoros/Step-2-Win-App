import api from './client';
import type { LegalDocument } from '../../types';

export const legalService = {
  list: async (): Promise<LegalDocument[]> => {
    const response = await api.get('/api/legal/');
    return response.data;
  },

  get: async (slug: string): Promise<LegalDocument> => {
    const response = await api.get(`/api/legal/${slug}/`);
    return response.data;
  },

  acknowledge: async (slug: string): Promise<{ acknowledged: boolean; version: number }> => {
    const response = await api.post(`/api/legal/${slug}/acknowledge/`);
    return response.data;
  },
};
