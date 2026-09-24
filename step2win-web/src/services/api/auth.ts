import api from './client';
import CryptoJS from 'crypto-js';
import { useAuthStore } from '../../store/authStore';
import type {
  AuthResponse,
  LoginCredentials,
  RegisterData,
  User,
  ChangePasswordData,
  DeviceBinding,
} from '../../types';

const APP_SIGNING_SECRET = import.meta.env.VITE_APP_SIGNING_SECRET || '';

function buildDeviceSignature(userId: string, deviceId: string, platform: 'android' | 'ios'): string {
  const payload = `${userId}:${deviceId}:${platform}`;
  return CryptoJS.HmacSHA256(payload, APP_SIGNING_SECRET).toString();
}

export const authService = {
  /**
   * Register a new user
   */
  register: async (data: RegisterData): Promise<AuthResponse> => {
    const response = await api.post<AuthResponse>('/api/auth/register/', data);
    return response.data;
  },

  /**
   * Login user with device info
   */
  login: async (credentials: LoginCredentials & {
    device_name?: string;
    device_type?: string;
    app_version?: string;
  }): Promise<AuthResponse & { session_id?: string }> => {
    const response = await api.post<AuthResponse & { session_id?: string }>(
      '/api/auth/login/',
      credentials
    );
    return response.data;
  },

  /**
   * Logout user
   */
  logout: async (refreshToken: string): Promise<void> => {
    await api.post('/api/auth/logout/', { refresh: refreshToken });
  },

  /**
   * Get user profile
   */
  getProfile: async (): Promise<User> => {
    const response = await api.get<User>('/api/auth/profile/');
    return response.data;
  },

  /**
   * Update user profile
   */
  updateProfile: async (data: Partial<User>): Promise<User> => {
    const response = await api.put<User>('/api/auth/profile/', data);
    return response.data;
  },

  /**
   * Change password
   */
  changePassword: async (data: ChangePasswordData): Promise<{ status: string }> => {
    const response = await api.post<{ status: string }>('/api/auth/change-password/', data);
    return response.data;
  },

  /**
   * Bind device for step tracking
   */
  bindDevice: async (data: DeviceBinding): Promise<{ status: string }> => {
    const userId = useAuthStore.getState().user?.id;
    if (!userId) {
      throw new Error('Unable to bind device: user context missing');
    }
    if (!APP_SIGNING_SECRET) {
      throw new Error('Unable to bind device: VITE_APP_SIGNING_SECRET is not configured');
    }

    const payload: DeviceBinding = {
      ...data,
      device_signature: buildDeviceSignature(String(userId), data.device_id, data.platform),
    };

    const response = await api.post<{ status: string }>('/api/auth/bind-device/', payload);
    return response.data;
  },

  /**
   * Sign in / sign up with a Google ID token or an Apple identity token.
   * The raw nonce lets the server check the token was minted for this attempt.
   */
  socialSignIn: async (
    provider: 'google' | 'apple',
    payload: {
      id_token: string;
      nonce: string;
      given_name?: string;
      family_name?: string;
      device_type?: string;
      device_name?: string;
      app_version?: string;
    },
  ): Promise<AuthResponse & { session_id?: string; created?: boolean }> => {
    const response = await api.post<AuthResponse & { session_id?: string; created?: boolean }>(
      `/api/auth/${provider}/`,
      payload,
    );
    return response.data;
  },

  /**
   * Get user stats
   */
  getUserStats: async (): Promise<any> => {
    const response = await api.get('/api/auth/stats/');
    return response.data;
  },

  /**
   * Get active sessions
   */
  getActiveSessions: async (): Promise<any> => {
    const response = await api.get('/api/auth/sessions/');
    return response.data;
  },

  /**
   * Revoke a specific session
   */
  revokeSession: async (sessionId: string): Promise<any> => {
    const response = await api.post(`/api/auth/sessions/${sessionId}/revoke/`);
    return response.data;
  },

  /**
   * Revoke all other sessions
   */
  revokeAllSessions: async (currentRefresh?: string): Promise<any> => {
    const response = await api.post('/api/auth/sessions/revoke-all/', {
      current_refresh: currentRefresh,
    });
    return response.data;
  },

  /**
   * Can this account be deleted right now? Lists blockers (balance, live challenge, pending withdrawal).
   */
  getAccountDeletionEligibility: async (): Promise<AccountDeletionEligibility> => {
    const response = await api.get<AccountDeletionEligibility>('/api/auth/account/delete/eligibility/');
    return response.data;
  },

  /**
   * Permanently delete (anonymise) the account. Password accounts send `password`;
   * Google / Apple sign-ups send `confirm: "DELETE"`.
   */
  deleteAccount: async (body: { password?: string; confirm?: string }): Promise<{ deleted: boolean; message: string }> => {
    const response = await api.post<{ deleted: boolean; message: string }>('/api/auth/account/delete/', body);
    return response.data;
  },
};

export type AccountDeletionBlocker = {
  code: 'wallet_balance' | 'active_challenge' | 'withdrawal_pending' | 'payment_pending' | 'staff_account' | 'already_deleted' | string;
  message: string;
};

export type AccountDeletionEligibility = {
  eligible: boolean;
  blockers: AccountDeletionBlocker[];
  requires_password: boolean;
  confirm_word: string;
  social_providers: string[];
};
