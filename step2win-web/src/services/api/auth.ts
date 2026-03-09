import api from './client';
import type {
  AuthResponse,
  LoginCredentials,
  RegisterData,
  User,
  ChangePasswordData,
  DeviceBinding,
  DeviceStatus,
} from '../../types';

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
    const response = await api.post<{ status: string }>('/api/auth/bind-device/', data);
    return response.data;
  },

  /**
   * Get device status
   */
  getDeviceStatus: async (): Promise<DeviceStatus> => {
    const response = await api.get<DeviceStatus>('/api/auth/device-status/');
    return response.data;
  },

  /**
   * Login/Register with Google OAuth token
   */
  googleSignIn: async (credential: string): Promise<AuthResponse> => {
    const response = await api.post<AuthResponse>('/api/auth/google/', { token: credential });
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
};
