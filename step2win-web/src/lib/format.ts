export { formatKES } from '../utils/currency';

const toNumber = (value: number | string | null | undefined): number => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/** 12,480 */
export function formatSteps(value: number | string | null | undefined): string {
  return Math.round(toNumber(value)).toLocaleString('en-KE');
}

/** 12.5K / 1.2M — for tight spaces like chart labels. */
export function formatCompact(value: number | string | null | undefined): string {
  const n = toNumber(value);
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (Math.abs(n) >= 10_000) return `${Math.round(n / 1000)}K`;
  if (Math.abs(n) >= 1_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}K`;
  return String(Math.round(n));
}

/** KSh amount without decimals when whole: KSh 1,250 */
export function formatKESShort(value: number | string | null | undefined): string {
  const n = toNumber(value);
  const whole = Math.abs(n % 1) < 0.005;
  return `KSh ${n.toLocaleString('en-KE', {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

/** "just now", "5 min ago", "3 h ago", "Yesterday", "12 Mar" */
export function formatRelativeTime(input: string | number | Date | null | undefined): string {
  if (!input) return '';
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return '';
  const diffSec = Math.round((Date.now() - date.getTime()) / 1000);
  if (diffSec < 45) return 'just now';
  const mins = Math.round(diffSec / 60);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  return formatShortDate(date);
}

/** "12 Mar" (adds year when not the current year) */
export function formatShortDate(input: string | number | Date): string {
  const date = new Date(input);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) });
}

/** "Wed, 12 Mar · 14:05" */
export function formatDateTime(input: string | number | Date): string {
  const date = new Date(input);
  return `${date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })} · ${date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
}

/** Whole days between two calendar dates (inclusive of start). */
export function challengeDayProgress(startDate: string, endDate: string, now: Date = new Date()) {
  const start = new Date(startDate);
  const end = new Date(endDate);
  const dayMs = 86_400_000;
  const totalDays = Math.max(1, Math.round((end.getTime() - start.getTime()) / dayMs) + 1);
  const elapsed = Math.floor((now.getTime() - start.getTime()) / dayMs) + 1;
  const currentDay = Math.min(totalDays, Math.max(0, elapsed));
  return { currentDay, totalDays, fraction: currentDay / totalDays };
}

export function initials(name: string | null | undefined): string {
  if (!name) return '?';
  const parts = name.trim().split(/[\s._-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}
