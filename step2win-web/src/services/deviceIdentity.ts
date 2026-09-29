import { Preferences } from '@capacitor/preferences';
import { v4 as uuidv4 } from 'uuid';

/**
 * Install id and time zone fields sent with step syncs, step sessions and walks.
 *
 * install_id: a random UUID created on the first launch of this install. A reinstall (or
 * cleared app data) gets a new one. Android's native layer keeps its own id and reports it on
 * every reading; that one wins so web- and native-built uploads agree.
 */

const INSTALL_ID_KEY = 'step2win_install_id_v1';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let cached: string | null = null;

function isValid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value.trim());
}

function readLocal(): string | null {
  try {
    const value = localStorage.getItem(INSTALL_ID_KEY);
    return isValid(value) ? value : null;
  } catch {
    return null;
  }
}

function writeLocal(value: string) {
  try {
    localStorage.setItem(INSTALL_ID_KEY, value);
  } catch {
    // Storage unavailable: Preferences still keeps it.
  }
}

/** Synchronous (for payload builders). Creates and persists the id on first use. */
export function getInstallIdSync(): string {
  if (cached) return cached;
  const local = readLocal();
  if (local) {
    cached = local;
    return local;
  }
  const created = uuidv4();
  cached = created;
  writeLocal(created);
  void Preferences.set({ key: INSTALL_ID_KEY, value: created }).catch(() => undefined);
  return created;
}

/** Prefers Capacitor Preferences (native storage), then localStorage, then a new id. */
export async function getInstallId(): Promise<string> {
  if (cached) return cached;
  try {
    const { value } = await Preferences.get({ key: INSTALL_ID_KEY });
    if (isValid(value)) {
      cached = value;
      writeLocal(value);
      return value;
    }
  } catch {
    // Fall back to localStorage.
  }
  return getInstallIdSync();
}

/** The native layer's id (Android) when a reading carries one; it replaces the web id. */
export function adoptNativeInstallId(value: unknown): string | null {
  if (!isValid(value)) return null;
  if (cached !== value) {
    cached = value;
    writeLocal(value);
    void Preferences.set({ key: INSTALL_ID_KEY, value }).catch(() => undefined);
  }
  return value;
}

/** Minutes EAST of UTC (EAT = 180). */
export function tzOffsetMinutes(date = new Date()): number {
  return -date.getTimezoneOffset();
}

/** IANA zone name ("Africa/Nairobi"), or "" when the runtime doesn't know it. */
export function tzName(): string {
  try {
    return (Intl.DateTimeFormat().resolvedOptions().timeZone || '').slice(0, 64);
  } catch {
    return '';
  }
}

export function timeZoneFields(date = new Date()): { tz_offset_minutes: number; tz_name: string } {
  return { tz_offset_minutes: tzOffsetMinutes(date), tz_name: tzName() };
}
