import { CheckCircle2, Clock, XCircle, type LucideIcon } from 'lucide-react';
import type { Tone } from '../ui/Pill';
import { formatSteps } from '../../lib/format';

/** Parse an API calendar date ("2026-09-20") as a local date, avoiding UTC day shifts. */
export function parseCalendarDate(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match) return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return new Date(value);
}

/** "Sun, 20 Sep" */
export function formatCalendarDay(value: string): string {
  const date = parseCalendarDate(value);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

export interface StatusMeta {
  label: string;
  tone: Tone;
  live?: boolean;
  icon?: LucideIcon;
}

export function challengeStatusMeta(status: string): StatusMeta {
  switch (status) {
    case 'active':
      return { label: 'Live', tone: 'success', live: true };
    case 'pending':
      // Waiting in the admin approval queue (not listed, not joinable yet).
      return { label: 'Awaiting approval', tone: 'warning', icon: Clock };
    case 'completed':
      return { label: 'Completed', tone: 'neutral', icon: CheckCircle2 };
    case 'cancelled':
      return { label: 'Cancelled', tone: 'danger', icon: XCircle };
    default:
      return { label: status, tone: 'neutral' };
  }
}

/** "4 days left" / "Ends today" / "Starts Sun, 20 Sep" / "Ended Wed, 17 Sep" */
export function timeLeftLabel(status: string, daysRemaining: number | null | undefined, _startDate: string, endDate: string): string {
  if (status === 'completed' || status === 'cancelled') return `Ended ${formatCalendarDay(endDate)}`;
  if (status === 'pending') return 'Starts once approved';
  const days = Math.max(0, Number(daysRemaining ?? 0));
  if (days === 0) return 'Ends today';
  if (days === 1) return '1 day left';
  return `${days} days left`;
}

/** Plain-language explanation of how the net pool is shared. */
export function winConditionRule(winCondition: string | undefined, milestone: number): { title: string; body: string } {
  const goal = `${formatSteps(milestone)} steps`;
  switch (winCondition) {
    case 'winner_takes_all':
      return {
        title: 'Winner takes all',
        body: `The participant with the most steps who also reaches ${goal} receives the whole net pool.`,
      };
    case 'top_3':
      return {
        title: 'Top 3 split',
        body: `The three participants with the most steps who also reach ${goal} share the net pool 50% / 30% / 20%.`,
      };
    case 'qualification_only':
      return {
        title: 'Qualification only',
        body: `Everyone who reaches ${goal} before the end date qualifies to share the net pool.`,
      };
    case 'proportional':
    default:
      return {
        title: 'Proportional split',
        body: `Everyone who reaches ${goal} shares the net pool in proportion to their steps — walk more, earn a larger share.`,
      };
  }
}

export function toNumber(value: string | number | null | undefined): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export function apiErrorMessage(error: unknown, fallback: string): string {
  const data = (error as { response?: { data?: { error?: string; detail?: string } } })?.response?.data;
  return data?.error || data?.detail || fallback;
}
