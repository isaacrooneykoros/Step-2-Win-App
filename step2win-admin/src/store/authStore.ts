/**
 * Auth Store - Step2Win Admin
 * Access token: in-memory only
 * Refresh token: localStorage for session restoration
 *
 * Refresh tokens rotate and the old one is blacklisted on use, so two
 * refreshes started with the same token would race: the second is rejected
 * and would log the operator out. Every refresh path in the app therefore goes
 * through `refreshAccessToken()`, which shares one in-flight request.
 */

import { create } from 'zustand';
import { API_BASE } from '../config/network';

export interface AdminUser {
  id: number;
  username: string;
  email: string;
  is_staff: boolean;
  is_superuser?: boolean;
  profile_picture_url?: string | null;
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
const LEGACY_REFRESH_KEY = 'admin_refresh';
const USER_KEY = 's2w_admin_user';

function storedRefreshToken(): string | null {
  return localStorage.getItem(REFRESH_KEY) || localStorage.getItem(LEGACY_REFRESH_KEY);
}

async function postRefresh(refresh: string): Promise<{ access: string; refresh?: string } | null> {
  const res = await fetch(`${API_BASE}/api/auth/refresh/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh }),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { access?: string; refresh?: string };
  return data?.access ? { access: data.access, refresh: data.refresh } : null;
}

async function performRefresh(): Promise<string | null> {
  const refresh = storedRefreshToken();
  if (!refresh) return null;
  try {
    let data = await postRefresh(refresh);
    // Another tab may have rotated the token while this request was in flight;
    // if the stored token changed, try once more with the new one.
    const latest = storedRefreshToken();
    if (!data && latest && latest !== refresh) {
      data = await postRefresh(latest);
    }
    if (!data) return null;
    if (data.refresh) localStorage.setItem(REFRESH_KEY, data.refresh);
    useAuthStore.getState().setToken(data.access);
    return data.access;
  } catch {
    return null;
  }
}

let inflightRefresh: Promise<string | null> | null = null;

/**
 * Exchange the stored refresh token for a new access token. Concurrent callers
 * (React StrictMode double effects, parallel 401s) share one request.
 * Resolves to the new access token, or null when the session cannot be renewed.
 */
export function refreshAccessToken(): Promise<string | null> {
  if (!inflightRefresh) {
    inflightRefresh = performRefresh().finally(() => {
      inflightRefresh = null;
    });
  }
  return inflightRefresh;
}

let inflightSession: Promise<void> | null = null;

export const useAuthStore = create<AuthState>((set, get) => ({
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

  loadSession: () => {
    // Already restored (e.g. the StrictMode re-run of the mount effect).
    if (get().isHydrated && get().accessToken) return Promise.resolve();
    if (inflightSession) return inflightSession;

    inflightSession = (async () => {
      set({ isLoading: true });
      const rawUser = localStorage.getItem(USER_KEY);

      if (!storedRefreshToken()) {
        set({ isLoading: false, isHydrated: true });
        return;
      }

      const access = await refreshAccessToken();
      if (access && rawUser) {
        try {
          const user = JSON.parse(rawUser) as AdminUser;
          if (user.is_staff) {
            set({ accessToken: access, user, isLoading: false, isHydrated: true });
            return;
          }
        } catch {
          // Corrupt stored user: fall through and force login.
        }
      }

      localStorage.removeItem(REFRESH_KEY);
      localStorage.removeItem(USER_KEY);
      set({ accessToken: null, user: null, isLoading: false, isHydrated: true });
    })().finally(() => {
      inflightSession = null;
    });
    return inflightSession;
  },
}));
