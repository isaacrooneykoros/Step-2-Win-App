/**
 * Auth Store - Step2Win Admin
 * Access token: in-memory only
 * Refresh token: localStorage for session restoration
 */

import { create } from 'zustand';
import { API_BASE } from '../config/network';

export interface AdminUser {
  id: number;
  username: string;
  email: string;
  is_staff: boolean;
  is_superuser?: boolean;
}

interface AuthState {
  accessToken: string | null;
  user: AdminUser | null;
  isLoading: boolean;
  isHydrated: boolean;
  setAuth: (access: string, refresh: string, user: AdminUser) => void;
  clearAuth: () => void;
  setToken: (access: string) => void;
  loadSession: () => Promise<void>;
}

const REFRESH_KEY = 's2w_admin_refresh';
const USER_KEY = 's2w_admin_user';

export const useAuthStore = create<AuthState>((set) => ({
  accessToken: null,
  user: null,
  isLoading: false,
  isHydrated: false,

  setAuth: (access, refresh, user) => {
    localStorage.setItem(REFRESH_KEY, refresh);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
    set({ accessToken: access, user, isHydrated: true });
  },

  clearAuth: () => {
    localStorage.removeItem(REFRESH_KEY);
    localStorage.removeItem(USER_KEY);
    set({ accessToken: null, user: null, isHydrated: true, isLoading: false });
  },

  setToken: (access) => {
    set({ accessToken: access });
  },

  loadSession: async () => {
    set({ isLoading: true });
    const refresh = localStorage.getItem(REFRESH_KEY);
    const rawUser = localStorage.getItem(USER_KEY);

    if (!refresh) {
      set({ isLoading: false, isHydrated: true });
      return;
    }

    try {
      const res = await fetch(`${API_BASE}/api/auth/refresh/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh }),
      });

      if (res.ok) {
        const data = (await res.json()) as { access: string; refresh?: string };

        if (rawUser) {
          const user = JSON.parse(rawUser) as AdminUser;
          if (!user.is_staff) {
            localStorage.removeItem(REFRESH_KEY);
            localStorage.removeItem(USER_KEY);
            set({ accessToken: null, user: null, isLoading: false, isHydrated: true });
            return;
          }

          localStorage.setItem(REFRESH_KEY, data.refresh ?? refresh);
          set({ accessToken: data.access, user, isLoading: false, isHydrated: true });
          return;
        }
      }
    } catch {
      // Ignore network and parse errors and force login.
    }

    localStorage.removeItem(REFRESH_KEY);
    localStorage.removeItem(USER_KEY);
    set({ accessToken: null, user: null, isLoading: false, isHydrated: true });
  },
}));
