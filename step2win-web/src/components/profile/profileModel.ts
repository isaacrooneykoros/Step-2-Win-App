import { AlertTriangle, Ban, ShieldAlert, ShieldCheck, type LucideIcon } from 'lucide-react';
import type { Tone } from '../ui/Pill';
import type { HealthRecord, User } from '../../types';
import { addDays, dateKey, parseDateKey } from '../steps/stepUtils';

export interface DayPoint {
  date: string;
  /** null = no synced record for that day. */
  steps: number | null;
  distanceKm: number | null;
  activeMinutes: number | null;
}

/** Continuous run of `days` calendar days ending at `end` (inclusive), filled from history records. */
export function dailySeries(records: HealthRecord[] | undefined, days: number, end: Date = new Date()): DayPoint[] {
  const byDate = new Map<string, HealthRecord>();
  for (const r of records ?? []) {
    // Several sources could report the same day; keep the largest count.
    const prev = byDate.get(r.date);
    if (!prev || (r.steps ?? 0) > (prev.steps ?? 0)) byDate.set(r.date, r);
  }
  const endDay = parseDateKey(dateKey(end));
  const out: DayPoint[] = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const key = dateKey(addDays(endDay, -i));
    const r = byDate.get(key);
    out.push({
      date: key,
      steps: r ? r.steps ?? 0 : null,
      distanceKm: r?.distance_km ?? null,
      activeMinutes: r?.active_minutes ?? null,
    });
  }
  return out;
}

export interface PeriodStats {
  recordedDays: number;
  totalSteps: number;
  avgSteps: number;
  goalDays: number;
  best: DayPoint | null;
  distanceKm: number;
  activeMinutes: number;
  /** Longest run of consecutive goal-met days inside the period. */
  longestRun: number;
}

export function periodStats(points: DayPoint[], goal: number): PeriodStats {
  const recorded = points.filter((p) => p.steps !== null);
  const totalSteps = recorded.reduce((s, p) => s + (p.steps ?? 0), 0);
  let best: DayPoint | null = null;
  let run = 0;
  let longestRun = 0;
  for (const p of points) {
    if (p.steps !== null && (!best || p.steps > (best.steps ?? 0))) best = p;
    if (p.steps !== null && p.steps >= goal) {
      run += 1;
      longestRun = Math.max(longestRun, run);
    } else run = 0;
  }
  return {
    recordedDays: recorded.length,
    totalSteps,
    avgSteps: recorded.length ? Math.round(totalSteps / recorded.length) : 0,
    goalDays: recorded.filter((p) => (p.steps ?? 0) >= goal).length,
    best,
    distanceKm: recorded.reduce((s, p) => s + (p.distanceKm ?? 0), 0),
    activeMinutes: recorded.reduce((s, p) => s + (p.activeMinutes ?? 0), 0),
    longestRun,
  };
}

/** "Member since Sep 2026" — the API sends "September 2026"; also accepts ISO dates. */
export function memberSinceLabel(user: Pick<User, 'member_since' | 'created_at'> | null | undefined): string | null {
  const raw = user?.member_since || user?.created_at;
  if (!raw) return null;
  const monthYear = raw.match(/^([A-Za-z]+)\s+(\d{4})$/);
  if (monthYear) return `${monthYear[1].slice(0, 3)} ${monthYear[2]}`;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;
  return date.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
}

export interface StandingInfo {
  label: string;
  tone: Tone;
  icon: LucideIcon;
  description: string;
  ok: boolean;
}

/** Plain-language account standing from `trust_status` (falls back to `trust_score`). */
export function standingInfo(user: Pick<User, 'trust_status' | 'trust_score'> | null | undefined): StandingInfo {
  const status =
    user?.trust_status ??
    (user?.trust_score == null ? 'GOOD' : user.trust_score >= 85 ? 'GOOD' : user.trust_score >= 65 ? 'REVIEW' : 'RESTRICT');
  switch (status) {
    case 'WARN':
      return {
        label: 'Warning',
        tone: 'warning',
        icon: AlertTriangle,
        ok: false,
        description: 'Some recent step data looked unusual. Keep syncing normally from your own device to stay in good standing.',
      };
    case 'REVIEW':
      return {
        label: 'Under review',
        tone: 'warning',
        icon: ShieldAlert,
        ok: false,
        description: 'Our team is reviewing recent step activity on your account. We will let you know the outcome.',
      };
    case 'RESTRICT':
      return {
        label: 'Restricted',
        tone: 'danger',
        icon: ShieldAlert,
        ok: false,
        description: 'Some features are limited on your account. Contact support if you think this is a mistake.',
      };
    case 'SUSPEND':
      return {
        label: 'Suspended',
        tone: 'danger',
        icon: Ban,
        ok: false,
        description: 'Your account is suspended. Contact support for details.',
      };
    case 'BAN':
      return {
        label: 'Closed',
        tone: 'danger',
        icon: Ban,
        ok: false,
        description: 'This account has been closed. Contact support for details.',
      };
    default:
      return {
        label: 'Good standing',
        tone: 'success',
        icon: ShieldCheck,
        ok: true,
        description: 'Your step data is verified and your account has full access.',
      };
  }
}

export function calibrationSummary(user: Pick<User, 'calibration_quality' | 'calibration_variance_pct' | 'last_calibrated_at'> | null | undefined): {
  label: string;
  tone: Tone;
  hint: string;
} {
  const quality = user?.calibration_quality;
  if (!quality || !user?.last_calibrated_at) {
    return { label: 'Not calibrated', tone: 'neutral', hint: 'Improves distance accuracy' };
  }
  const ageDays = Math.floor((Date.now() - new Date(user.last_calibrated_at).getTime()) / 86_400_000);
  const stale = ageDays >= 30;
  const label = quality.charAt(0).toUpperCase() + quality.slice(1);
  if (quality === 'noisy' || stale) {
    return { label, tone: 'warning', hint: stale ? `${ageDays} days old · recalibrate` : 'Noisy · recalibrate' };
  }
  const variance = user.calibration_variance_pct;
  return {
    label,
    tone: 'success',
    hint: variance != null ? `${variance.toFixed(1)}% variance · ${ageDays === 0 ? 'today' : `${ageDays} d ago`}` : `Calibrated ${ageDays === 0 ? 'today' : `${ageDays} days ago`}`,
  };
}
