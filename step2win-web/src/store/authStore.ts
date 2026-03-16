import { create } from 'zustand';
import { Preferences } from '@capacitor/preferences';
import type { User } from '../types';

interface AuthStore {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  sessionId: string | null;
  
  setAuth: (user: User, access: string, refresh: string, sessionId?: string) => Promise<void>;
  updateUser: (user: User) => void;
  logout: () => Promise<void>;
  init: () => Promise<boolean>;
  getAccessToken: () => Promise<string | null>;
  getRefreshToken: () => Promise<string | null>;
  getSessionId: () => Promise<string | null>;
}

export const useAuthStore = create<AuthStore>((set) => ({
  user: null,
  isAuthenticated: false,
  isLoading: true,
  sessionId: null,

  /**
   * Set authentication state and store tokens
   */
  setAuth: async (user, access, refresh, sessionId) => {
    try {
      await Preferences.set({ key: 'access_token', value: access });
      await Preferences.set({ key: 'refresh_token', value: refresh });
      if (sessionId) {
        await Preferences.set({ key: 'session_id', value: sessionId });
      }
    } catch (e) {
      // Capacitor Preferences unavailable (e.g. web dev without native runtime)
      // Use sessionStorage as fallback — scoped to tab, not persisted like localStorage
      sessionStorage.setItem('access_token', access);
      sessionStorage.setItem('refresh_token', refresh);
      if (sessionId) {
        sessionStorage.setItem('session_id', sessionId);
      }
    }
    set({ user, isAuthenticated: true, isLoading: false, sessionId: sessionId || null });
  },

  /**
   * Update user data
   */
  updateUser: (user) => {
    set({ user });
  },

  /**
   * Logout and clear tokens
   */
  logout: async () => {
    try {
      await Preferences.remove({ key: 'access_token' });
      await Preferences.remove({ key: 'refresh_token' });
      await Preferences.remove({ key: 'session_id' });
    } catch (e) {
      sessionStorage.removeItem('access_token');
      sessionStorage.removeItem('refresh_token');
      sessionStorage.removeItem('session_id');
    }
    set({ user: null, isAuthenticated: false, sessionId: null });
  },

  /**
   * Initialize auth state from stored tokens
   */
  init: async () => {
    try {
      try {
        const { value } = await Preferences.get({ key: 'access_token' });
        const { value: sessionId } = await Preferences.get({ key: 'session_id' });
        if (value) {
          set({ isAuthenticated: true, isLoading: false, sessionId: sessionId || null });
          return true;
        }
      } catch (e) {
        // Fall back to sessionStorage (never localStorage)
        const value = sessionStorage.getItem('access_token');
        const sessionId = sessionStorage.getItem('session_id');
        if (value) {
          set({ isAuthenticated: true, isLoading: false, sessionId: sessionId || null });
          return true;
        }
      }
      set({ isLoading: false });
      return false;
    } catch (error) {
      set({ isLoading: false });
      return false;
    }
  },

  /**
   * Get access token from storage
   */
  getAccessToken: async () => {
    try {
      const { value } = await Preferences.get({ key: 'access_token' });
      return value;
    } catch (e) {
      return sessionStorage.getItem('access_token');
    }
  },

  /**
   * Get refresh token from storage
   */
  getRefreshToken: async () => {
    try {
      const { value } = await Preferences.get({ key: 'refresh_token' });
      return value;
    } catch (e) {
      return sessionStorage.getItem('refresh_token');
    }
  },

  /**
   * Get session ID from storage
   */
  getSessionId: async () => {
    try {
      const { value } = await Preferences.get({ key: 'session_id' });
      return value;
    } catch (e) {
      return sessionStorage.getItem('session_id');
    }
  },
}));

