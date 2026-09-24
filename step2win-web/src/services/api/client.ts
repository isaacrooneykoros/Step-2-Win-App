import axios, { AxiosError } from 'axios';
import { Preferences } from '@capacitor/preferences';
import { resolveApiBaseUrl } from '../../config/network';
import { notifyFeatureDisabled, showMaintenance } from './platformNotices';

const api = axios.create({
  baseURL: resolveApiBaseUrl(),
  // The hosted server sleeps when idle and can take ~30s to wake up, so allow
  // for that instead of failing the first request after a quiet period.
  timeout: 45000,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Cold-start retries. Reads are always safe to repeat; the only writes repeated
// are ones where a duplicate can't cause harm (login returns fresh tokens).
// Anything that moves money or creates records is never resent automatically.
const MAX_WAKE_RETRIES = 2;
const WAKE_RETRY_DELAYS_MS = [2000, 5000];
const RETRY_SAFE_POSTS = ['/api/auth/login/', '/api/auth/refresh/'];
const WAKING_STATUSES = new Set([502, 503, 504]);

function isRetryableWakeFailure(error: AxiosError): boolean {
  const config = error.config as (typeof error.config & { _wakeRetries?: number }) | undefined;
  // A timeout already waited out the wake-up window; repeating it only doubles the wait.
  if (!config || error.code === 'ERR_CANCELED' || error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
    return false;
  }
  if ((config._wakeRetries ?? 0) >= MAX_WAKE_RETRIES) return false;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;

  const status = error.response?.status;
  const serverWaking = !error.response || (status !== undefined && WAKING_STATUSES.has(status));
  if (!serverWaking) return false;

  const method = (config.method ?? 'get').toLowerCase();
  if (method === 'get' || method === 'head' || method === 'options') return true;
  return method === 'post' && RETRY_SAFE_POSTS.some((path) => (config.url ?? '').endsWith(path));
}

// Request interceptor - add auth token
api.interceptors.request.use(
  async (config) => {
    try {
      const { value } = await Preferences.get({ key: 'access_token' });
      if (value) {
        config.headers.Authorization = `Bearer ${value}`;
      }
    } catch (e) {
      const value = localStorage.getItem('access_token');
      if (value) {
        config.headers.Authorization = `Bearer ${value}`;
      }
    }
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

// Response interceptor - handle token refresh
let isRefreshing = false;
let failedQueue: Array<{ resolve: (value: any) => void; reject: (reason?: any) => void }> = [];

const processQueue = (error: any, token: string | null = null) => {
  failedQueue.forEach(({ resolve, reject }) => {
    if (error) {
      reject(error);
    } else {
      resolve(token);
    }
  });
  failedQueue = [];
};

api.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const originalRequest = error.config;

    // Admin-controlled platform states (Settings > Customer access).
    const payload = error.response?.data as { code?: string; error?: string } | undefined;
    if (error.response?.status === 503 && payload?.code === 'maintenance') {
      showMaintenance(payload.error);
      return Promise.reject(error);
    }
    if (error.response?.status === 403 && payload?.code === 'feature_disabled') {
      notifyFeatureDisabled(payload.error);
      return Promise.reject(error);
    }

    if (isRetryableWakeFailure(error)) {
      const config = originalRequest as typeof originalRequest & { _wakeRetries?: number };
      const attempt = config._wakeRetries ?? 0;
      config._wakeRetries = attempt + 1;
      await new Promise((resolve) => setTimeout(resolve, WAKE_RETRY_DELAYS_MS[attempt] ?? 5000));
      return api(config);
    }

    // If error is 401 and we haven't tried to refresh yet
    if (error.response?.status === 401 && originalRequest && !(originalRequest as any)._retry) {
      if (isRefreshing) {
        // Queue this request until refresh completes
        return new Promise((resolve, reject) => {
          failedQueue.push({ resolve, reject });
        })
          .then((token) => {
            if (originalRequest.headers && token) {
              originalRequest.headers.Authorization = `Bearer ${token}`;
            }
            return api(originalRequest);
          })
          .catch((err) => Promise.reject(err));
      }

      (originalRequest as any)._retry = true;
      isRefreshing = true;

      try {
        // Get refresh token
        let refreshToken: string | null = null;
        try {
          const { value } = await Preferences.get({ key: 'refresh_token' });
          refreshToken = value;
        } catch (e) {
          refreshToken = localStorage.getItem('refresh_token');
        }

        if (!refreshToken) {
          throw new Error('No refresh token available');
        }

        // Request new access token
        const { data } = await axios.post(
          `${api.defaults.baseURL}/api/auth/refresh/`,
          { refresh: refreshToken }
        );

        const newAccess = data.access;
        const newRefresh = data.refresh; // Token rotation - new refresh token

        // Save new tokens
        try {
          await Preferences.set({ key: 'access_token', value: newAccess });
          if (newRefresh) {
            await Preferences.set({ key: 'refresh_token', value: newRefresh });
          }
        } catch (e) {
          localStorage.setItem('access_token', newAccess);
          if (newRefresh) {
            localStorage.setItem('refresh_token', newRefresh);
          }
        }

        // Update authorization header
        api.defaults.headers.common.Authorization = `Bearer ${newAccess}`;
        if (originalRequest.headers) {
          originalRequest.headers.Authorization = `Bearer ${newAccess}`;
        }

        processQueue(null, newAccess);
        isRefreshing = false;

        // Retry original request
        return api(originalRequest);
      } catch (refreshError: any) {
        processQueue(refreshError, null);
        isRefreshing = false;

        // Refresh failed - clear tokens
        try {
          await Preferences.remove({ key: 'access_token' });
          await Preferences.remove({ key: 'refresh_token' });
          await Preferences.remove({ key: 'session_id' });
        } catch (e) {
          localStorage.removeItem('access_token');
          localStorage.removeItem('refresh_token');
          localStorage.removeItem('session_id');
        }

        // Check if session was revoked
        const errorMsg = refreshError?.response?.data?.error || '';
        if (errorMsg.includes('revoked')) {
          // Show user-friendly message
          console.error('Session was revoked from another device');
        }

        // Redirect to login
        window.location.href = '/login';
        return Promise.reject(refreshError);
      }
    }

    return Promise.reject(error);
  }
);

export default api;
