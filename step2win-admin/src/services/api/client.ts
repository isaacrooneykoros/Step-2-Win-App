/**
 * Axios instance for Step2Win Admin API.
 * - Attaches Bearer token
 * - Refreshes once on 401
 * - Redirects to /login when refresh fails
 */

import axios, { AxiosError } from 'axios';
import type { InternalAxiosRequestConfig } from 'axios';
import { useAuthStore } from '../../store/authStore';

const REFRESH_KEY = 's2w_admin_refresh';

const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL,
  timeout: 15_000,
  headers: { 'Content-Type': 'application/json' },
});

api.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  const token = useAuthStore.getState().accessToken;
  if (token && config.headers) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

let isRefreshing = false;
let failedQueue: Array<{
  resolve: (value: string | null) => void;
  reject: (error: AxiosError) => void;
}> = [];

function processQueue(error: AxiosError | null, token: string | null) {
  failedQueue.forEach((promise) => {
    if (error) {
      promise.reject(error);
      return;
    }
    promise.resolve(token);
  });
  failedQueue = [];
}

api.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const original = error.config as (InternalAxiosRequestConfig & { _retry?: boolean }) | undefined;
    if (!original || error.response?.status !== 401 || original._retry) {
      return Promise.reject(error);
    }

    if (isRefreshing) {
      return new Promise<string | null>((resolve, reject) => {
        failedQueue.push({ resolve, reject });
      }).then((token) => {
        if (!token) {
          return Promise.reject(error);
        }
        if (original.headers) {
          original.headers.Authorization = `Bearer ${token}`;
        }
        return api(original);
      });
    }

    original._retry = true;
    isRefreshing = true;

    const refresh = localStorage.getItem(REFRESH_KEY);
    if (!refresh) {
      useAuthStore.getState().clearAuth();
      window.location.href = '/login';
      return Promise.reject(error);
    }

    try {
      const response = await axios.post<{ access: string; refresh?: string }>(
        `${import.meta.env.VITE_API_BASE_URL}/api/auth/refresh/`,
        { refresh }
      );

      const newAccess = response.data.access;
      const newRefresh = response.data.refresh;

      useAuthStore.getState().setToken(newAccess);
      if (newRefresh) {
        localStorage.setItem(REFRESH_KEY, newRefresh);
      }

      if (original.headers) {
        original.headers.Authorization = `Bearer ${newAccess}`;
      }
      processQueue(null, newAccess);
      return api(original);
    } catch (refreshError) {
      processQueue(refreshError as AxiosError, null);
      useAuthStore.getState().clearAuth();
      window.location.href = '/login';
      return Promise.reject(refreshError);
    } finally {
      isRefreshing = false;
    }
  }
);

export default api;
