/**
 * Auth Store - Step2Win Admin
 * Access token: in-memory only (never persisted)
 * Refresh token: sessionStorage — tab-scoped, cleared automatically on tab/browser close.
 *
 * Security note: sessionStorage is still accessible to JavaScript on the same origin,
 * so it is not immune to XSS. For the highest-security deployments, migrate to httpOnly
 * cookies set by the backend. sessionStorage is used here as a meaningful improvement
 * over localStorage, which persists indefinitely across sessions.
 */

import { create } from 'zustand';

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
    sessionStorage.setItem(REFRESH_KEY, refresh);
    sessionStorage.setItem(USER_KEY, JSON.stringify(user));
    set({ accessToken: access, user, isHydrated: true });
  },

  clearAuth: () => {
    sessionStorage.removeItem(REFRESH_KEY);
    sessionStorage.removeItem(USER_KEY);
    set({ accessToken: null, user: null, isHydrated: true, isLoading: false });
  },

  setToken: (access) => {
    set({ accessToken: access });
  },

  loadSession: async () => {
    set({ isLoading: true });
    const refresh = sessionStorage.getItem(REFRESH_KEY);
    const rawUser = sessionStorage.getItem(USER_KEY);
    const apiBase = import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:8000';

    if (!refresh) {
      set({ isLoading: false, isHydrated: true });
      return;
    }

    try {
      const res = await fetch(`${apiBase}/api/auth/refresh/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh }),
      });

      if (res.ok) {
        const data = (await res.json()) as { access: string; refresh?: string };

        if (rawUser) {
          const user = JSON.parse(rawUser) as AdminUser;
          if (!user.is_staff) {
            sessionStorage.removeItem(REFRESH_KEY);
            sessionStorage.removeItem(USER_KEY);
            set({ accessToken: null, user: null, isLoading: false, isHydrated: true });
            return;
          }

          sessionStorage.setItem(REFRESH_KEY, data.refresh ?? refresh);
          set({ accessToken: data.access, user, isLoading: false, isHydrated: true });
          return;
        }
      }
    } catch {
      // Ignore network and parse errors and force login.
    }

    sessionStorage.removeItem(REFRESH_KEY);
    sessionStorage.removeItem(USER_KEY);
    set({ accessToken: null, user: null, isLoading: false, isHydrated: true });
  },
}));
