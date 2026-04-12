import axios, { AxiosError } from 'axios';
import { Preferences } from '@capacitor/preferences';
import { resolveApiBaseUrl } from '../../config/network';

const api = axios.create({
  baseURL: resolveApiBaseUrl(),
  timeout: 15000,  // 15 seconds — prevents hanging requests
  headers: {
    'Content-Type': 'application/json',
  },
});

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
