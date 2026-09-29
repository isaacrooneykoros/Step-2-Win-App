import { Capacitor } from '@capacitor/core';

/** React Query keys. Everything social lives under ['social', ...] so one invalidate refreshes it all. */
export const socialKeys = {
  all: ['social'] as const,
  me: ['social', 'me'] as const,
  friends: ['social', 'friends'] as const,
  requests: ['social', 'requests'] as const,
  friendsRanking: (week: string) => ['social', 'ranking', 'friends', week] as const,
  teamsRanking: (week: string) => ['social', 'ranking', 'teams', week] as const,
  history: ['social', 'ranking', 'history'] as const,
  myTeams: ['social', 'teams', 'mine'] as const,
  discover: (q: string) => ['social', 'teams', 'discover', q] as const,
  team: (id: number) => ['social', 'team', id] as const,
  feed: ['social', 'feed'] as const,
  notifications: ['social', 'notifications'] as const,
  summary: ['social', 'summary'] as const,
  blocks: ['social', 'blocks'] as const,
};

/** Rankings refresh every few minutes while a social screen is open (never with Data Saver). */
export const RANKING_POLL_MS = 5 * 60_000;
export const SUMMARY_POLL_MS = 10 * 60_000;

// The hosted web app; native builds can't use their own origin (capacitor://localhost) in a shared link.
const PUBLIC_APP_URL =
  (import.meta.env.VITE_PUBLIC_APP_URL as string | undefined)?.replace(/\/$/, '') || 'https://step-2-win-app.vercel.app';

export function friendLink(code: string): string {
  const base = Capacitor.isNativePlatform() || typeof window === 'undefined' ? PUBLIC_APP_URL : window.location.origin;
  return `${base}/social/add/${code}`;
}

const CODE_RE = /^[A-HJ-NP-Z2-9]{6,12}$/;

/** Pull a friend code out of a scanned QR, a pasted link or a typed code. */
export function extractFriendCode(text: string): string | null {
  const raw = (text || '').trim();
  const fromLink = raw.match(/\/social\/add\/([A-Za-z0-9]{6,12})/);
  const candidate = (fromLink ? fromLink[1] : raw).toUpperCase().replace(/[\s-]/g, '');
  return CODE_RE.test(candidate) ? candidate : null;
}

const shortDate = new Intl.DateTimeFormat('en-KE', { day: 'numeric', month: 'short' });

export function weekRangeLabel(weekStart: string, weekEnd: string): string {
  const start = new Date(`${weekStart}T12:00:00`);
  const end = new Date(`${weekEnd}T12:00:00`);
  return `${shortDate.format(start)} – ${shortDate.format(end)}`;
}

export function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  return `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'}`;
}

export function errorCode(error: unknown): string | undefined {
  const data = (error as { response?: { data?: { code?: unknown } } })?.response?.data;
  return typeof data?.code === 'string' ? data.code : undefined;
}
