/**
 * Axios instance for Step2Win Admin API.
 * - Attaches Bearer token
 * - Refreshes once on 401 (single-flight, shared with every other API helper)
 * - Redirects to /login when refresh fails
 */

import axios, { AxiosError } from 'axios';
import type { InternalAxiosRequestConfig } from 'axios';
import { refreshAccessToken, useAuthStore } from '../../store/authStore';
import { API_BASE } from '../../config/network';

const api = axios.create({
  baseURL: API_BASE,
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

api.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const original = error.config as (InternalAxiosRequestConfig & { _retry?: boolean }) | undefined;
    if (!original || error.response?.status !== 401 || original._retry) {
      return Promise.reject(error);
    }
    original._retry = true;

    const newAccess = await refreshAccessToken();
    if (!newAccess) {
      useAuthStore.getState().clearAuth();
      if (!window.location.pathname.startsWith('/login')) window.location.href = '/login';
      return Promise.reject(error);
    }
    if (original.headers) {
      original.headers.Authorization = `Bearer ${newAccess}`;
    }
    return api(original);
  }
);

export default api;
