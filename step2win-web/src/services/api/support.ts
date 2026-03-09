import api from './client';
import type {
  CreateSupportTicketData,
  SupportTicketListResponse,
  SupportTicketDetailResponse,
  SupportStatus,
} from '../../types';

export const supportService = {
  createTicket: async (data: CreateSupportTicketData): Promise<any> => {
    const response = await api.post('/api/auth/support/tickets/create/', data);
    return response.data;
  },

  getMyTickets: async (params?: {
    status?: SupportStatus;
    limit?: number;
    offset?: number;
  }): Promise<SupportTicketListResponse> => {
    const search = new URLSearchParams();
    if (params?.status) search.append('status', params.status);
    if (typeof params?.limit === 'number') search.append('limit', String(params.limit));
    if (typeof params?.offset === 'number') search.append('offset', String(params.offset));

    const query = search.toString();
    const response = await api.get<SupportTicketListResponse>(`/api/auth/support/tickets/${query ? `?${query}` : ''}`);
    return response.data;
  },

  getTicketDetail: async (ticketId: number): Promise<SupportTicketDetailResponse> => {
    const response = await api.get<SupportTicketDetailResponse>(`/api/auth/support/tickets/${ticketId}/`);
    return response.data;
  },

  replyToTicket: async (ticketId: number, message: string): Promise<{ status: string }> => {
    const response = await api.post<{ status: string }>(`/api/auth/support/tickets/${ticketId}/reply/`, { message });
    return response.data;
  },

  updateTicketStatus: async (ticketId: number, status: SupportStatus): Promise<any> => {
    const response = await api.patch(`/api/auth/support/tickets/${ticketId}/status/`, { status });
    return response.data;
  },
};
