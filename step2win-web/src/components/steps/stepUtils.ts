import { useQuery } from '@tanstack/react-query';
import { authService } from '../../services/api';
import { useAuthStore } from '../../store/authStore';
import type { StepsPeriod } from '../../types';

/** Local calendar key (YYYY-MM-DD). Avoids the UTC shift of toISOString(). */
export function dateKey(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Parses an API date (YYYY-MM-DD) as a local date at noon so weekday labels never shift. */
export function parseDateKey(key: string): Date {
  return new Date(`${key}T12:00:00`);
}

export function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

/** Whole days between an API date and today (0 = today). */
export function daysAgo(key: string): number {
  const today = parseDateKey(dateKey());
  return Math.round((today.getTime() - parseDateKey(key).getTime()) / 86_400_000);
}

export function weekdayShort(key: string): string {
  return parseDateKey(key).toLocaleDateString('en-GB', { weekday: 'short' });
}

/** "Tue, 22 Sep" */
export function dayLabel(key: string): string {
  return parseDateKey(key).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

/** "Tuesday, 22 September" */
export function dayLabelLong(key: string): string {
  return parseDateKey(key).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
}

/** "Today", "Yesterday", or "Tue, 22 Sep" */
export function relativeDayLabel(key: string): string {
  const ago = daysAgo(key);
  if (ago === 0) return 'Today';
  if (ago === 1) return 'Yesterday';
  return dayLabel(key);
}

/** "6 AM", "12 PM" */
export function formatHour(hour: number): string {
  if (hour === 0) return '12 AM';
  if (hour === 12) return '12 PM';
  return hour < 12 ? `${hour} AM` : `${hour - 12} PM`;
}

/** Smallest history period that still contains the given date. */
export function periodCovering(key: string): StepsPeriod {
  const ago = daysAgo(key);
  if (ago <= 6) return '1w';
  if (ago <= 29) return '1m';
  if (ago <= 89) return '3m';
  if (ago <= 364) return '1y';
  return 'all';
}

/**
 * The user's personal daily step goal (profile `daily_goal`).
 * Never a challenge milestone — those are multi-day totals.
 */
export function useDailyGoal(): { goal: number; isKnown: boolean } {
  const storeGoal = useAuthStore((s) => s.user?.daily_goal);
  const { data: profile } = useQuery({ queryKey: ['profile'], queryFn: authService.getProfile, staleTime: 60_000 });
  const goal = profile?.daily_goal ?? storeGoal;
  return { goal: goal && goal > 0 ? goal : 10_000, isKnown: Boolean(goal && goal > 0) };
}
