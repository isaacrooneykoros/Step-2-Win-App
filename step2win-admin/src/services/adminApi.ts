import type {
  AdminAuthUser,
  AdminNotificationsResponse,
  AdminProfile,
  DashboardOverview,
  OpsMonitoringResponse,
  WithdrawalStats,
  FraudOverview,
} from '../types/admin';
import { refreshAccessToken, useAuthStore } from '../store/authStore';
import { API_BASE } from '../config/network';

function getAuthToken(): string | null {
  return useAuthStore.getState().accessToken;
}

function clearAuthSession() {
  useAuthStore.getState().clearAuth();
}

function safeParseJson(value: string): unknown | null {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeErrorText(value: string): string {
  return value
    .replace(/ErrorDetail\(string='([^']+)'(?:,\s*code='[^']*')?\)/g, '$1')
    .replace('{', ' ')
    .replace('}', ' ')
    .replace('[', ' ')
    .replace(']', ' ')
    .replace(/'/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstErrorMessage(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) {
    return normalizeErrorText(value);
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const msg = firstErrorMessage(item);
      if (msg) return msg;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const nested of Object.values(record)) {
      const msg = firstErrorMessage(nested);
      if (msg) return msg;
    }
  }
  return null;
}

function extractErrorMessage(rawText: string): string {
  if (!rawText) {
    return 'Request failed';
  }

  const normalizedRawText = normalizeErrorText(rawText);
  if (/uploaded file is not a valid image/i.test(normalizedRawText)) {
    return 'The selected file is not a valid image. Please choose a JPEG, PNG, WebP, HEIC, or HEIF photo.';
  }

  if (/only jpeg, png, webp|only jpeg, png, and webp images are allowed/i.test(normalizedRawText)) {
    return 'Please choose a JPEG, PNG, WebP, HEIC, or HEIF image.';
  }

  if (/profile picture must be less than/i.test(normalizedRawText)) {
    return 'Image is too large. Please choose a file smaller than 10MB.';
  }

  if (/profile_picture/i.test(normalizedRawText)) {
    return 'There was a problem with the photo you selected. Please choose a different image.';
  }

  const parsed = safeParseJson(rawText);
  if (!parsed || typeof parsed !== 'object') {
    return normalizedRawText || 'Request failed';
  }
  const parsedRecord = parsed as Record<string, unknown>;
  const details =
    parsedRecord.details && typeof parsedRecord.details === 'object'
      ? (parsedRecord.details as Record<string, unknown>)
      : undefined;

  const detail = details?.detail ?? parsedRecord.detail;
  const msg = parsedRecord.message;

  if (typeof detail === 'string' && detail.trim()) {
    if (detail.toLowerCase().includes('token')) {
      return 'Session expired. Please log in again.';
    }
    return detail;
  }

  if (typeof msg === 'string' && msg.trim()) {
    const nested = safeParseJson(msg);
    if (nested && typeof nested === 'object' && 'detail' in nested) {
      const nestedDetail = String((nested as Record<string, unknown>).detail);
      if (nestedDetail.toLowerCase().includes('token')) {
        return 'Session expired. Please log in again.';
      }
      return nestedDetail;
    }
    return msg;
  }

  const fieldError = Object.entries(parsedRecord).find(([, value]) => firstErrorMessage(value));

  if (fieldError) {
    const [field, value] = fieldError;
    const first = firstErrorMessage(value);
    if (first) {
      return `${field}: ${first}`;
    }
  }

  return typeof parsedRecord.error === 'string' ? parsedRecord.error : 'Request failed';
}

/** Single-flight refresh shared with every API helper (see store/authStore). */
function refreshAdminAccessToken(): Promise<string | null> {
  return refreshAccessToken();
}

async function request<T>(path: string, options?: RequestInit, hasRetried = false): Promise<T> {
  const token = getAuthToken();
  const bodyIsFormData = typeof FormData !== 'undefined' && options?.body instanceof FormData;
  const mergedHeaders: Record<string, string> = {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...((options?.headers as Record<string, string> | undefined) || {}),
  };

  if (!bodyIsFormData) {
    mergedHeaders['Content-Type'] = mergedHeaders['Content-Type'] || 'application/json';
  }

  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: mergedHeaders,
  });

  if (response.status === 401 && !hasRetried) {
    const refreshedToken = await refreshAdminAccessToken();
    if (refreshedToken) {
      return request<T>(path, options, true);
    }

    clearAuthSession();
    if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
      window.location.href = '/login';
    }
    throw new Error('Session expired. Please log in again.');
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(extractErrorMessage(text) || `Request failed: ${response.status}`);
  }

  if (response.status === 204) {
    return {} as T;
  }

  return response.json();
}

/**
 * Shared session helpers and the few dashboard/layout reads still served from here.
 * Page-specific clients live next to their pages (components/users/api, components/finance/api, ...).
 * Unused legacy wrappers (old withdrawal/transaction/report/fraud-action routes) were removed.
 */
export const adminApi = {
  adminLogout: () => {
    clearAuthSession();
  },
  getCurrentAdmin: (): AdminAuthUser | null => {
    const user = useAuthStore.getState().user;
    return (user as unknown as AdminAuthUser) ?? null;
  },
  clearAuthSession,

  getMyProfile: async () => request<AdminProfile>('/api/admin/profile/'),
  getNotifications: async () => request<AdminNotificationsResponse>('/api/admin/notifications/'),

  // Overview & Dashboard
  getOverview: (days: number = 7) =>
    request<DashboardOverview>(`/api/admin/dashboard/overview/?days=${days}`),

  getWithdrawalStats: () => request<WithdrawalStats>('/api/admin/withdrawals/stats/'),
  getFraudOverview: async () => request<FraudOverview>('/api/admin/fraud/'),
  getOpsMonitoring: async () => request<OpsMonitoringResponse>('/api/admin/monitoring/ops/'),
};
