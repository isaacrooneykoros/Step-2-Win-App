import type {
  AdminBadge,
  AdminChallenge,
  AdminAuthResponse,
  AdminAuthUser,
  AdminNotificationsResponse,
  AdminProfile,
  AdminTransaction,
  AdminUser,
  AdminWithdrawal,
  DashboardOverview,
  SupportAdminUser,
  SupportTicket,
  SupportTicketDetailResponse,
  WithdrawalQueueItem,
  WithdrawalStats,
  FraudOverview,
} from '../types/admin';
import { useAuthStore, type AdminUser as StoreAdminUser } from '../store/authStore';
import { API_BASE } from '../config/network';

function getAuthToken(): string | null {
  return useAuthStore.getState().accessToken;
}

function getRefreshToken(): string | null {
  return localStorage.getItem('s2w_admin_refresh') || localStorage.getItem('admin_refresh');
}

function setAuthSession(payload: AdminAuthResponse) {
  const normalizedUser: StoreAdminUser = {
    id: payload.user.id,
    username: payload.user.username,
    email: payload.user.email,
    is_staff: payload.user.is_staff,
    is_superuser: (payload.user as { is_superuser?: boolean }).is_superuser ?? false,
    profile_picture_url: (payload.user as { profile_picture_url?: string | null }).profile_picture_url ?? null,
  };
  useAuthStore.getState().setAuth(payload.access, payload.refresh, normalizedUser);
}

function clearAuthSession() {
  useAuthStore.getState().clearAuth();
}

function safeParseJson(value: string): unknown | null {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function extractErrorMessage(rawText: string): string {
  if (!rawText) {
    return 'Request failed';
  }

  const parsed = safeParseJson(rawText);
  if (!parsed || typeof parsed !== 'object') {
    return rawText;
  }
  const parsedRecord = parsed as Record<string, unknown>;
  const details =
    parsedRecord.details && typeof parsedRecord.details === 'object'
      ? (parsedRecord.details as Record<string, unknown>)
      : undefined;

  const detail = details?.detail ?? parsedRecord.detail;
  const msg = parsedRecord.message;

  if (typeof detail === 'string' && detail.trim()) {
    if (detail.toLowerCase().includes('token')) {
      return 'Session expired. Please log in again.';
    }
    return detail;
  }

  if (typeof msg === 'string' && msg.trim()) {
    const nested = safeParseJson(msg);
    if (nested && typeof nested === 'object' && 'detail' in nested) {
      const nestedDetail = String((nested as Record<string, unknown>).detail);
      if (nestedDetail.toLowerCase().includes('token')) {
        return 'Session expired. Please log in again.';
      }
      return nestedDetail;
    }
    return msg;
  }

  return typeof parsedRecord.error === 'string' ? parsedRecord.error : 'Request failed';
}

async function refreshAdminAccessToken(): Promise<string | null> {
  const refresh = getRefreshToken();
  if (!refresh) {
    return null;
  }

  try {
    const response = await fetch(`${API_BASE}/api/auth/refresh/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ refresh }),
    });

    if (!response.ok) {
      return null;
    }

    const payload = await response.json();
    if (!payload?.access) {
      return null;
    }

    useAuthStore.getState().setToken(payload.access);
    if (payload.refresh) {
      localStorage.setItem('s2w_admin_refresh', payload.refresh);
    }

    return payload.access as string;
  } catch {
    return null;
  }
}

async function request<T>(path: string, options?: RequestInit, hasRetried = false): Promise<T> {
  const token = getAuthToken();
  const bodyIsFormData = typeof FormData !== 'undefined' && options?.body instanceof FormData;
  const mergedHeaders: Record<string, string> = {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...((options?.headers as Record<string, string> | undefined) || {}),
  };

  if (!bodyIsFormData) {
    mergedHeaders['Content-Type'] = mergedHeaders['Content-Type'] || 'application/json';
  }

  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: mergedHeaders,
  });

  if (response.status === 401 && !hasRetried) {
    const refreshedToken = await refreshAdminAccessToken();
    if (refreshedToken) {
      return request<T>(path, options, true);
    }

    clearAuthSession();
    if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
      window.location.href = '/login';
    }
    throw new Error('Session expired. Please log in again.');
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(extractErrorMessage(text) || `Request failed: ${response.status}`);
  }

  if (response.status === 204) {
    return {} as T;
  }

  return response.json();
}

function unwrapList<T>(payload: T[] | { results?: T[] }): T[] {
  if (Array.isArray(payload)) {
    return payload;
  }
  return payload.results || [];
}

export const adminApi = {
  // Admin Auth
  adminLogin: async (username: string, password: string) => {
    const payload = await request<AdminAuthResponse>('/api/admin/auth/login/', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
    setAuthSession(payload);
    return payload;
  },
  adminRegister: async (data: {
    username: string;
    email: string;
    password: string;
    confirm_password: string;
    admin_code: string;
  }) => {
    const payload = await request<AdminAuthResponse>('/api/admin/auth/register/', {
      method: 'POST',
      body: JSON.stringify(data),
    });
    setAuthSession(payload);
    return payload;
  },
  adminLogout: () => {
    clearAuthSession();
  },
  getCurrentAdmin: (): AdminAuthUser | null => {
    const user = useAuthStore.getState().user;
    return (user as unknown as AdminAuthUser) ?? null;
  },
  clearAuthSession,

  getMyProfile: async () => request<AdminProfile>('/api/admin/profile/'),
  updateMyProfile: async (data: Record<string, unknown> | FormData) =>
    request<AdminProfile>('/api/admin/profile/', {
      method: 'PATCH',
      body: data instanceof FormData ? data : JSON.stringify(data),
      headers: data instanceof FormData ? {} : { 'Content-Type': 'application/json' },
    }),
  getNotifications: async () => request<AdminNotificationsResponse>('/api/admin/notifications/'),

  // Overview & Dashboard (enhanced for Vault UI)
  getOverview: (days: number = 7) => 
    request<DashboardOverview>(`/api/admin/dashboard/overview/?days=${days}`),

  // Users Management
  getUsers: async () => unwrapList(await request<AdminUser[] | { results?: AdminUser[] }>('/api/admin/users/')),
  getUserStats: async (userId: number) =>
    request(`/api/admin/users/${userId}/user_stats/`),
  banUser: (id: number) => request(`/api/admin/users/${id}/ban_user/`, { method: 'POST' }),
  unbanUser: (id: number) => request(`/api/admin/users/${id}/unban_user/`, { method: 'POST' }),
  makeStaff: (id: number) => request(`/api/admin/users/${id}/make_staff/`, { method: 'POST' }),
  removeStaff: (id: number) => request(`/api/admin/users/${id}/remove_staff/`, { method: 'POST' }),
  resetPassword: (id: number, newPassword: string) => 
    request(`/api/admin/users/${id}/reset_password/`, { 
      method: 'POST',
      body: JSON.stringify({ new_password: newPassword })
    }),
  updateUser: (id: number, data: Partial<{ username: string; email: string; phone_number: string }>) =>
    request(`/api/admin/users/${id}/update_user/`, {
      method: 'PATCH',
      body: JSON.stringify(data)
    }),
  deleteUser: (id: number) => request(`/api/admin/users/${id}/delete_user/`, { method: 'DELETE' }),

  // Challenges Management
  getChallenges: async () =>
    unwrapList(await request<AdminChallenge[] | { results?: AdminChallenge[] }>('/api/admin/challenges/')),
  approveChallenge: (id: number) => request(`/api/admin/challenges/${id}/approve_challenge/`, { method: 'POST' }),
  cancelChallenge: (id: number) => request(`/api/admin/challenges/${id}/cancel_challenge/`, { method: 'POST' }),
  rejectChallenge: (id: number, reason: string) =>
    request(`/api/admin/challenges/${id}/reject_challenge/`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),
  updateChallenge: (id: number, data: Partial<{ name: string; milestone: number; max_participants: number; end_date: string }>) =>
    request(`/api/admin/challenges/${id}/update_challenge/`, {
      method: 'PATCH',
      body: JSON.stringify(data)
    }),
  deleteChallenge: (id: number) => request(`/api/admin/challenges/${id}/delete_challenge/`, { method: 'DELETE' }),
  bulkCancelChallenges: (challengeIds: number[]) =>
    request('/api/admin/challenges/bulk_cancel/', {
      method: 'POST',
      body: JSON.stringify({ challenge_ids: challengeIds })
    }),
  bulkDeleteChallenges: (challengeIds: number[]) =>
    request('/api/admin/challenges/bulk_delete/', {
      method: 'POST',
      body: JSON.stringify({ challenge_ids: challengeIds })
    }),

  // Transactions
  getTransactions: async () =>
    unwrapList(await request<AdminTransaction[] | { results?: AdminTransaction[] }>('/api/admin/transactions/')),
  filterTransactions: async (filters: Record<string, string | number>) => {
    const params = new URLSearchParams(Object.entries(filters).map(([k, v]) => [k, String(v)]));
    return unwrapList(
      await request<AdminTransaction[] | { results?: AdminTransaction[] }>(
        `/api/admin/transactions/?${params.toString()}`
      )
    );
  },

  // Withdrawals
  getWithdrawals: async () =>
    unwrapList(await request<AdminWithdrawal[] | { results?: AdminWithdrawal[] }>('/api/admin/withdrawals/')),
  approveWithdrawal: (id: number) => request(`/api/admin/withdrawals/${id}/approve_withdrawal/`, { method: 'POST' }),
  rejectWithdrawal: (id: number, reason: string) =>
    request(`/api/admin/withdrawals/${id}/reject_withdrawal/`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),
  getWithdrawalQueue: (status = 'pending_review') =>
    request<WithdrawalQueueItem[]>(`/api/admin/withdrawals/?status=${encodeURIComponent(status)}`),
  getWithdrawalStats: () => request<WithdrawalStats>('/api/admin/withdrawals/stats/'),
  approveWithdrawalRequest: (id: string) =>
    request(`/api/admin/withdrawals/${id}/approve/`, { method: 'POST' }),
  rejectWithdrawalRequest: (id: string, reason: string) =>
    request(`/api/admin/withdrawals/${id}/reject/`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),
  retryFailedWithdrawal: (id: string) =>
    request(`/api/admin/withdrawals/${id}/retry/`, { method: 'POST' }),

  // Badges
  getBadges: async () => unwrapList(await request<AdminBadge[] | { results?: AdminBadge[] }>('/api/admin/badges/')),

  // Analytics
  getAnalytics: async (timeframe: 'week' | 'month' | 'all' = 'month') =>
    request(`/api/admin/dashboard/analytics/?timeframe=${timeframe}`),
  getUserActivity: async () => request('/api/admin/dashboard/user_activity/'),
  getChallengeStats: async () => request('/api/admin/dashboard/challenge_stats/'),
  getFinanceStats: async () => request('/api/admin/dashboard/finance_stats/'),
  
  // System Settings
  getSettings: async () => request('/api/admin/settings/'),
  updateSettings: async (data: Record<string, unknown>) =>
    request('/api/admin/settings/update/', {
      method: 'POST',
      body: JSON.stringify(data)
    }),
  
  // Audit Logs
  getAuditLogs: async (params?: {
    action?: string;
    resource_type?: string;
    admin_username?: string;
    from_date?: string;
    to_date?: string;
    limit?: number;
    offset?: number;
  }) => {
    const searchParams = new URLSearchParams();
    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined && value !== null) {
          searchParams.append(key, String(value));
        }
      });
    }
    const query = searchParams.toString();
    return request(`/api/admin/audit-logs/${query ? `?${query}` : ''}`);
  },
  
  // Advanced Reports
  getRevenueReport: async (days: number = 30) => 
    request(`/api/admin/reports/revenue/?days=${days}`),
  getUserRetention: async (days: number = 90) =>
    request(`/api/admin/reports/retention/?days=${days}`),
  getChallengeAnalytics: async (days: number = 30) =>
    request(`/api/admin/reports/challenge-analytics/?days=${days}`),
  getTransactionTrends: async (days: number = 30) =>
    request(`/api/admin/reports/transaction-trends/?days=${days}`),

  // Fraud Management
  getFraudOverview: async () => request<FraudOverview>('/api/admin/fraud/'),
  actionFraudFlag: async (
    flagId: number,
    action:
      | 'dismiss'
      | 'warn'
      | 'restrict'
      | 'suspend'
      | 'ban'
      | 'unrestrict'
      | 'unsuspend'
      | 'unban'
  ) =>
    request<{ status: string; flag_id: number; action: string }>(`/api/admin/fraud/${flagId}/action/`, {
      method: 'POST',
      body: JSON.stringify({ action }),
    }),

  // Support System
  getSupportTickets: async (params?: {
    status?: string;
    priority?: string;
    assigned_to?: string | number;
    q?: string;
    limit?: number;
    offset?: number;
  }) => {
    const searchParams = new URLSearchParams();
    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined && value !== null && value !== '') {
          searchParams.append(key, String(value));
        }
      });
    }
    const query = searchParams.toString();
    return request<{ total: number; results: SupportTicket[] }>(`/api/admin/support/tickets/${query ? `?${query}` : ''}`);
  },
  getSupportTicketDetail: async (ticketId: number) =>
    request<SupportTicketDetailResponse>(`/api/admin/support/tickets/${ticketId}/`),
  replySupportTicket: async (ticketId: number, message: string) =>
    request(`/api/admin/support/tickets/${ticketId}/reply/`, {
      method: 'POST',
      body: JSON.stringify({ message }),
    }),
  updateSupportTicket: async (
    ticketId: number,
    data: Partial<{ status: string; priority: string; assigned_to: number | null; admin_notes: string }>
  ) =>
    request(`/api/admin/support/tickets/${ticketId}/update/`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  getSupportAdmins: async () => request<{ results: SupportAdminUser[] }>('/api/admin/support/admins/'),
};
