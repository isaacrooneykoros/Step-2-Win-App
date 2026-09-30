import { Capacitor } from '@capacitor/core';
import api from './client';

export type AnnouncementSeverity = 'info' | 'warning' | 'success';

export interface Announcement {
  id: number;
  title: string;
  body: string;
  severity: AnnouncementSeverity;
  link_url: string | null;
  link_label: string | null;
  dismissible: boolean;
  starts_at: string;
  ends_at: string | null;
}

export interface HelpArticle {
  id: number;
  title: string;
  body: string;
  updated_at: string;
}

export interface HelpCategory {
  id: number;
  title: string;
  description: string;
  articles: HelpArticle[];
}

function platform(): 'android' | 'ios' | 'web' {
  const p = Capacitor.getPlatform();
  return p === 'android' || p === 'ios' ? p : 'web';
}

/** Staff announcements and the help centre (backend apps/content). */
export const contentService = {
  announcements: async (): Promise<Announcement[]> => {
    const r = await api.get<{ results: Announcement[] }>(`/api/content/announcements/?platform=${platform()}`);
    return r.data.results ?? [];
  },
  dismiss: async (id: number): Promise<void> => {
    await api.post(`/api/content/announcements/${id}/dismiss/`, {});
  },
  help: async (q = ''): Promise<{ query: string; categories: HelpCategory[]; total: number }> => {
    const r = await api.get(`/api/content/help/${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''}`);
    return r.data;
  },
};
