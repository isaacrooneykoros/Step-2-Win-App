/**
 * Phase 1c: Health Connect (Android) / Apple Health (iOS) as extra, opt-in step sources.
 *
 * Android reads and uploads natively (DeviceStepCounter.syncNow reads Health Connect on
 * open / resume and the native uploader posts the summaries after the steps). iOS reads
 * HealthKit natively and this module uploads the day summaries it returns. Nothing here
 * may break step syncing: every failure is swallowed (the phone's own count carries on).
 */
import { Capacitor } from '@capacitor/core';
import { DeviceStepCounter, type HealthSourcesPayload, type HealthSourcesStatus } from '../plugins/deviceStepCounter';
import { stepsService } from './api/steps';
import { isAndroidApp, isIOSApp } from '../utils/platform';

const UPLOADED_KEY = 's2w_health_sources_uploaded_v1';

export function healthSourcesSupported(): boolean {
  return Capacitor.isNativePlatform() && (isAndroidApp() || isIOSApp());
}

export async function getHealthSourcesStatus(): Promise<HealthSourcesStatus | null> {
  if (!healthSourcesSupported()) return null;
  try {
    return await DeviceStepCounter.healthSourcesStatus();
  } catch {
    return null; // older native build without Phase 1c
  }
}

function contentKey(payload: HealthSourcesPayload): string {
  return JSON.stringify([payload.hours, payload.workouts]);
}

function readUploaded(userId: string | number): Record<string, string> {
  try {
    const all = JSON.parse(localStorage.getItem(UPLOADED_KEY) || '{}') as Record<string, Record<string, string>>;
    return all[String(userId)] || {};
  } catch {
    return {};
  }
}

function writeUploaded(userId: string | number, map: Record<string, string>): void {
  try {
    const all = JSON.parse(localStorage.getItem(UPLOADED_KEY) || '{}') as Record<string, Record<string, string>>;
    const days = Object.keys(map).sort().slice(-10);
    all[String(userId)] = Object.fromEntries(days.map((d) => [d, map[d]]));
    localStorage.setItem(UPLOADED_KEY, JSON.stringify(all));
  } catch {
    // storage full / private mode: re-uploading is harmless (the server replaces the day)
  }
}

/**
 * iOS: read Apple Health (rate-limited natively) and upload the days that changed.
 * `session` is the active step session (it proves the platform to the server).
 */
export async function uploadIosHealthSources(
  userId: string | number,
  session: { sessionId: string; sessionToken: string },
  options?: { force?: boolean },
): Promise<number> {
  if (!isIOSApp() || !Capacitor.isNativePlatform()) return 0;
  let result: Awaited<ReturnType<typeof DeviceStepCounter.healthSourcesRead>>;
  try {
    result = await DeviceStepCounter.healthSourcesRead({ force: !!options?.force });
  } catch {
    return 0;
  }
  if (!result?.optedIn || !result.days) return 0;
  const uploaded = readUploaded(userId);
  let sent = 0;
  for (const [date, payload] of Object.entries(result.days).sort(([a], [b]) => a.localeCompare(b))) {
    const key = contentKey(payload);
    if (uploaded[date] === key) continue;
    try {
      await stepsService.uploadHealthSources({
        session_id: session.sessionId,
        session_token: session.sessionToken,
        date,
        tz_offset_minutes: payload.tz_offset_minutes,
        health_sources: payload,
      });
      uploaded[date] = key;
      sent += 1;
    } catch (error) {
      const status = (error as { response?: { status?: number } })?.response?.status;
      // 400: the server can't use this summary; don't retry the same data forever.
      if (status === 400) uploaded[date] = key;
      else break; // offline / server busy / session: the next sync retries
    }
  }
  writeUploaded(userId, uploaded);
  return sent;
}

/** Human label for a package / bundle id the phone read (the server's label wins when present). */
export function originLabel(origin: string): string {
  const known: Array<[RegExp, string]> = [
    [/^android$|^com\.android\.healthconnect\.phone\./, 'This phone'],
    [/^com\.sec\.android\.app\.shealth$/, 'Samsung Health'],
    [/^com\.google\.android\.apps\.fitness$/, 'Google Fit'],
    [/^com\.fitbit\.FitbitMobile$/, 'Fitbit'],
    [/^com\.garmin\./, 'Garmin Connect'],
    [/^com\.xiaomi\.wearable$|^com\.xiaomi\.miwatch/, 'Mi Fitness'],
    [/^com\.huami\.watch/, 'Zepp'],
    [/^com\.xiaomi\.hm\.health$|^HM\.wristband$/, 'Zepp Life'],
    [/^com\.huawei\./, 'Huawei Health'],
    [/^com\.strava/, 'Strava'],
    [/^com\.apple\.health\./, 'Apple Health'],
  ];
  for (const [re, label] of known) if (re.test(origin)) return label;
  return 'Other app';
}
