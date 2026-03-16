import api from './client';
import type { AdminUser } from '../../store/authStore';

export interface LoginPayload {
  username: string;
  password: string;
}

export interface RegisterPayload {
  username: string;
  email: string;
  password: string;
  confirm_password: string;
  admin_code: string;
}

export interface AuthResponse {
  access: string;
  refresh: string;
  user: AdminUser;
}

export const authService = {
  login: async (payload: LoginPayload): Promise<AuthResponse> => {
    const response = await api.post<AuthResponse>('/api/admin/auth/login/', payload);
    return response.data;
  },

  register: async (payload: RegisterPayload): Promise<AuthResponse> => {
    const response = await api.post<AuthResponse>('/api/admin/auth/register/', payload);
    return response.data;
  },

  logout: async (refresh: string): Promise<void> => {
    try {
      await api.post('/api/auth/logout/', { refresh });
    } catch {
      // Logout remains successful client-side even if API call fails.
    }
  },
};
