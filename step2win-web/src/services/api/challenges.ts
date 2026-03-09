import api from './client';
import type {
  Challenge,
  ChallengeDetail,
  ChallengeStats,
  Participant,
  CreateChallengeForm,
  JoinChallengeForm,
  ChatMessage,
  ChallengeSocialStats,
  LobbyChallenge,
  SpectatorLeaderboard,
  LobbyFilter,
  LobbySort,
  MyRecentResults,
} from '../../types';

export const challengesService = {
  /**
   * Get list of challenges
   */
  list: async (params?: {
    status?: string;
    milestone?: number;
    show_full?: boolean;
  }): Promise<Challenge[]> => {
    const response = await api.get<Challenge[]>('/api/challenges/', { params });
    return response.data;
  },

  /**
   * Get challenge detail
   */
  getDetail: async (id: number): Promise<ChallengeDetail> => {
    const response = await api.get<ChallengeDetail>(`/api/challenges/${id}/`);
    return response.data;
  },

  /**
   * Create new challenge
   */
  create: async (data: CreateChallengeForm): Promise<ChallengeDetail> => {
    console.log('Creating challenge with data:', data);
    const response = await api.post<ChallengeDetail>('/api/challenges/create/', data);
    return response.data;
  },

  /**
   * Join a challenge
   */
  join: async (data: JoinChallengeForm): Promise<{ status: string; challenge: ChallengeDetail }> => {
    const response = await api.post<{ status: string; challenge: ChallengeDetail }>(
      '/api/challenges/join/',
      data
    );
    return response.data;
  },

  /**
   * Get my challenges
   */
  getMyChallenges: async (): Promise<ChallengeDetail[]> => {
    try {
      const response = await api.get<any>('/api/challenges/my-challenges/');
      // Handle paginated response from DRF ListAPIView
      return Array.isArray(response.data) ? response.data : (response.data.results || []);
    } catch (error) {
      console.error('Error fetching my challenges:', error);
      return [];
    }
  },

  /**
   * Get challenge leaderboard
   */
  getLeaderboard: async (id: number): Promise<Participant[]> => {
    const response = await api.get<Participant[]>(`/api/challenges/${id}/leaderboard/`);
    return response.data;
  },

  /**
   * Get challenge stats
   */
  getStats: async (id: number): Promise<ChallengeStats> => {
    const response = await api.get<ChallengeStats>(`/api/challenges/${id}/stats/`);
    return response.data;
  },

  /**
   * Leave a challenge
   */
  leave: async (id: number): Promise<{ status: string }> => {
    const response = await api.post<{ status: string }>(`/api/challenges/${id}/leave/`);
    return response.data;
  },

  rematch: async (id: number): Promise<{ status: string; challenge: ChallengeDetail; rematch_of: number }> => {
    const response = await api.post<{ status: string; challenge: ChallengeDetail; rematch_of: number }>(
      `/api/challenges/${id}/rematch/`
    );
    return response.data;
  },

  /**
   * Get chat messages for a private challenge
   */
  getChatMessages: async (id: number): Promise<ChatMessage[]> => {
    const response = await api.get<{ messages: ChatMessage[]; count: number }>(`/api/challenges/${id}/chat/`);
    return response.data.messages;
  },

  /**
   * Send a message to challenge chat
   */
  sendChatMessage: async (id: number, content: string): Promise<ChatMessage> => {
    const response = await api.post<ChatMessage>(`/api/challenges/${id}/chat/`, { content });
    return response.data;
  },

  /**
   * Get social achievement badges for a private challenge
   */
  getSocialStats: async (id: number): Promise<ChallengeSocialStats> => {
    const response = await api.get<ChallengeSocialStats>(`/api/challenges/${id}/social-stats/`);
    return response.data;
  },

  getLobby: async (params?: {
    filter?: LobbyFilter;
    milestone?: string;
    min_fee?: number;
    max_fee?: number;
    sort?: LobbySort;
  }): Promise<{ challenges: LobbyChallenge[]; total_count: number; filters: Record<string, number> }> => {
    const query = new URLSearchParams();
    if (params?.filter) query.set('filter', params.filter);
    if (params?.milestone) query.set('milestone', params.milestone);
    if (params?.min_fee) query.set('min_fee', String(params.min_fee));
    if (params?.max_fee) query.set('max_fee', String(params.max_fee));
    if (params?.sort) query.set('sort', params.sort);
    const suffix = query.toString() ? `?${query.toString()}` : '';
    const response = await api.get(`/api/challenges/lobby/${suffix}`);
    return response.data;
  },

  getLobbyCard: async (id: number): Promise<LobbyChallenge> => {
    const response = await api.get<LobbyChallenge>(`/api/challenges/lobby/${id}/`);
    return response.data;
  },

  getSpectatorLeaderboard: async (id: number): Promise<SpectatorLeaderboard> => {
    const response = await api.get<SpectatorLeaderboard>(`/api/challenges/${id}/spectate/`);
    return response.data;
  },

  /**
   * Get challenge results (for completed challenges)
   */
  getChallengeResults: async (id: number): Promise<any> => {
    const response = await api.get(`/api/challenges/${id}/results/`);
    return response.data;
  },

  getMyRecentResults: async (): Promise<MyRecentResults> => {
    const response = await api.get('/api/challenges/my-results/');
    return response.data as MyRecentResults;
  },
};
