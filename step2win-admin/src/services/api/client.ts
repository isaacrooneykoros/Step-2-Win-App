/**
 * Axios-compatible API client wrapper
 * Maps the new component API calls to the existing adminApi
 */

const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:8000';

function getAuthToken(): string | null {
  return localStorage.getItem('admin_jwt');
}

async function request(method: string, url: string, data?: Record<string, unknown>, params?: Record<string, unknown>) {
  let fullUrl = url.startsWith('http') ? url : `${API_BASE}${url}`;
  
  // Add query params
  if (params) {
    const searchParams = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        searchParams.append(key, String(value));
      }
    });
    const queryString = searchParams.toString();
    fullUrl += (fullUrl.includes('?') ? '&' : '?') + queryString;
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  const token = getAuthToken();
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(fullUrl, {
    method,
    headers,
    body: data ? JSON.stringify(data) : undefined,
  });

  if (response.status === 401) {
    // Token expired
    localStorage.removeItem('admin_jwt');
    localStorage.removeItem('admin_refresh');
    localStorage.removeItem('admin_user');
    window.location.href = '/auth/login';
    throw new Error('Unauthorized');
  }

  if (!response.ok) {
    const text = await response.text();
    try {
      const error = JSON.parse(text);
      throw new Error(error.detail || error.message || `HTTP ${response.status}`);
    } catch {
      throw new Error(`HTTP ${response.status}: ${text}`);
    }
  }

  return response.json();
}

const api = {
  get: (url: string, config?: { params?: Record<string, unknown> }) => ({
    then: (callback: (data: unknown) => unknown) => request('GET', url, undefined, config?.params).then(callback),
    catch: (callback: (error: Error) => unknown) => request('GET', url, undefined, config?.params).catch(callback),
  }),

  post: (url: string, data?: Record<string, unknown>, config?: { params?: Record<string, unknown> }) => ({
    then: (callback: (data: unknown) => unknown) => request('POST', url, data, config?.params).then(callback),
    catch: (callback: (error: Error) => unknown) => request('POST', url, data, config?.params).catch(callback),
  }),

  patch: (url: string, data?: Record<string, unknown>, config?: { params?: Record<string, unknown> }) => ({
    then: (callback: (data: unknown) => unknown) => request('PATCH', url, data, config?.params).then(callback),
    catch: (callback: (error: Error) => unknown) => request('PATCH', url, data, config?.params).catch(callback),
  }),

  delete: (url: string, config?: { params?: Record<string, unknown> }) => ({
    then: (callback: (data: unknown) => unknown) => request('DELETE', url, undefined, config?.params).then(callback),
    catch: (callback: (error: Error) => unknown) => request('DELETE', url, undefined, config?.params).catch(callback),
  }),
};

export default api;
