import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';

const DEFAULT_WEB_API_BASE = 'http://localhost:8000';
const DEFAULT_NATIVE_API_BASE = 'https://step-2-win-app.onrender.com';

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function resolveBaseCandidate(): string {
  const envBase = import.meta.env.VITE_API_BASE_URL as string | undefined;
  if (envBase?.trim()) {
    return trimTrailingSlash(envBase.trim());
  }

  return Capacitor.isNativePlatform() ? DEFAULT_NATIVE_API_BASE : DEFAULT_WEB_API_BASE;
}

export function resolveApiBaseUrl(): string {
  const base = resolveBaseCandidate();
  const platform = Capacitor.getPlatform();

  // Android emulator maps host machine localhost to 10.0.2.2.
  if (platform === 'android' && (base.includes('127.0.0.1') || base.includes('localhost'))) {
    return base.replace('127.0.0.1', '10.0.2.2').replace('localhost', '10.0.2.2');
  }

  return base;
}

export function resolveWsBaseUrl(): string {
  const explicit = import.meta.env.VITE_WS_URL as string | undefined;
  const raw = trimTrailingSlash(explicit?.trim() || resolveApiBaseUrl());

  try {
    const parsed = new URL(raw);
    const protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${parsed.host}`;
  } catch {
    return raw.replace('https://', 'wss://').replace('http://', 'ws://');
  }
}

export async function getStoredAccessToken(): Promise<string | null> {
  try {
    const { value } = await Preferences.get({ key: 'access_token' });
    if (value) {
      return value;
    }
  } catch {
    // Fall through to localStorage in web contexts.
  }

  return localStorage.getItem('access_token');
}