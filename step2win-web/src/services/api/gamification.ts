import api from './client';

export interface UserXP {
  id: number;
  user: number;
  total_xp: number;
  level: number;
  xp_this_week: number;
  updated_at: string;
}

export interface Badge {
  id: number;
  slug: string;
  name: string;
  icon: string;
  badge_type: 'streak' | 'step' | 'challenge' | 'achievement';
  description: string;
  criteria_type: string;
  criteria_value: number;
}

export interface UserBadge {
  id: number;
  badge: Badge;
  user: number;
  earned_at: string;
}

export interface XPEvent {
  id: number;
  user: number;
  event_type: string;
  amount: number;
  metadata: Record<string, any>;
  created_at: string;
}

export const gamificationService = {
  /**
   * Get current user's XP profile
   */
  getMyXP: async (): Promise<UserXP> => {
    const response = await api.get<UserXP>('/api/gamification/xp/my_xp/');
    return response.data;
  },

  /**
   * Get top users by XP (leaderboard)
   */
  getLeaderboard: async (limit: number = 10): Promise<UserXP[]> => {
    const response = await api.get<UserXP[]>('/api/gamification/xp/leaderboard/', {
      params: { limit },
    });
    return response.data;
  },

  /**
   * Get all badges definitions
   */
  getAllBadges: async (): Promise<Badge[]> => {
    const response = await api.get<{ results: Badge[] }>('/api/gamification/badges/');
    return response.data.results || [];
  },

  /**
   * Get user's earned badges
   */
  getMyBadges: async (): Promise<UserBadge[]> => {
    const response = await api.get<{ results: UserBadge[] }>('/api/gamification/badges/my_badges/');
    return response.data.results || [];
  },

  /**
   * Get available badges (not yet earned)
   */
  getUpcomingBadges: async (): Promise<Badge[]> => {
    const response = await api.get<{ results: Badge[] }>('/api/gamification/badges/upcoming/');
    return response.data.results || [];
  },

  /**
   * Get recent XP events
   */
  getRecentEvents: async (limit: number = 10): Promise<XPEvent[]> => {
    const response = await api.get<XPEvent[]>('/api/gamification/events/', {
      params: { limit },
    });
    return Array.isArray(response.data) ? response.data : [];
  },
};
