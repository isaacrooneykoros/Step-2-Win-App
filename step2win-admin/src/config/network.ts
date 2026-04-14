const DEFAULT_LOCAL_API_BASE = 'http://127.0.0.1:8000';
const DEFAULT_HOSTED_API_BASE = 'https://step-2-win-app.onrender.com';

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

export function resolveApiBaseUrl(): string {
  const envBase = import.meta.env.VITE_API_BASE_URL as string | undefined;
  if (envBase && envBase.trim()) {
    return stripTrailingSlash(envBase.trim());
  }

  if (typeof window !== 'undefined') {
    const host = window.location.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1') {
      return DEFAULT_LOCAL_API_BASE;
    }
  }

  return DEFAULT_HOSTED_API_BASE;
}

export const API_BASE = resolveApiBaseUrl();
