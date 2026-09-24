import { formatSteps } from '../../lib/format';
import type { Challenge, ChallengeDetail, LobbyChallenge, Participant } from '../../types';

const DAY_MS = 86_400_000;

/** Parse an API date ("2026-09-25" or ISO) as a local calendar day. */
export function parseDay(input: string | null | undefined): Date | null {
  if (!input) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input);
  const date = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(input);
  if (Number.isNaN(date.getTime())) return null;
  date.setHours(0, 0, 0, 0);
  return date;
}

/** Whole calendar days from today until `input` (negative when in the past). */
export function daysUntil(input: string | null | undefined, now: Date = new Date()): number | null {
  const target = parseDay(input);
  if (!target) return null;
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  return Math.round((target.getTime() - today.getTime()) / DAY_MS);
}

/** Length of a challenge in days (end − start), as set by `duration_days` at creation. */
export function durationDays(start: string | null | undefined, end: string | null | undefined): number | null {
  const s = parseDay(start);
  const e = parseDay(end);
  if (!s || !e) return null;
  return Math.max(1, Math.round((e.getTime() - s.getTime()) / DAY_MS));
}

/** "Day 4 of 7" data for a running challenge. */
export function dayOfChallenge(start: string, end: string, now: Date = new Date()) {
  const total = durationDays(start, end) ?? 1;
  const sinceStart = -(daysUntil(start, now) ?? 0);
  const current = Math.min(total, Math.max(1, sinceStart + 1));
  return { current, total };
}

export function startsInLabel(start: string | null | undefined): string {
  const d = daysUntil(start);
  if (d === null) return 'Start date to be set';
  if (d <= 0) return 'Starts today';
  if (d === 1) return 'Starts tomorrow';
  return `Starts in ${d} days`;
}

export function daysLeftLabel(daysRemaining: number | null | undefined): string {
  const d = Math.max(0, Number(daysRemaining ?? 0));
  if (d === 0) return 'Ends today';
  if (d === 1) return '1 day left';
  return `${d} days left`;
}

/** "12 Mar" style date for a calendar-day string. */
export function formatDay(input: string | null | undefined, withWeekday = false): string {
  const date = parseDay(input);
  if (!date) return '';
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString('en-GB', {
    ...(withWeekday ? { weekday: 'short' } : {}),
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

export function milestoneText(milestone: number): string {
  return `${formatSteps(milestone)} steps`;
}

/** Backend milestone labels look like "Endurance - 50K steps"; return "Endurance" (or null). */
export function milestoneTier(label: string | null | undefined): string | null {
  if (!label) return null;
  const [tier, rest] = label.split(' - ');
  return rest ? tier.trim() : null;
}

export function toNumber(value: string | number | null | undefined): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export const WIN_CONDITION_COPY: Record<string, { label: string; description: string }> = {
  proportional: {
    label: 'Proportional split',
    description: 'Everyone who reaches the goal shares the pool in proportion to their steps.',
  },
  winner_takes_all: {
    label: 'Winner takes all',
    description: 'The qualifier with the most steps takes the pool.',
  },
  qualification_only: {
    label: 'Qualification only',
    description: 'Reaching the goal is what counts, not who walks the most.',
  },
};

// ─── Card model ──────────────────────────────────────────────────────────────

export type ChallengeCardVariant = 'active' | 'upcoming' | 'completed' | 'lobby';

/**
 * Presentation model for `ChallengeCard`. Every field maps to real API data; optional
 * fields are simply not rendered when unknown.
 */
export interface ChallengeCardModel {
  id: number;
  name: string;
  milestone: number;
  /** Tier from the backend label, e.g. "Endurance". */
  milestoneTier?: string | null;
  isPrivate?: boolean;
  entryFee: string | number;
  pool?: string | number | null;
  /** Platform top-up included in `pool` (lobby only). */
  poolBonus?: string | number | null;
  participants?: number | null;
  maxParticipants?: number | null;
  startDate?: string | null;
  endDate?: string | null;
  daysRemaining?: number | null;
  status?: 'pending' | 'active' | 'completed' | 'cancelled';

  // The signed-in user's participation (active / completed).
  steps?: number | null;
  rank?: number | null;
  qualified?: boolean | null;
  payout?: string | number | null;

  // Upcoming
  /** Creator's challenge that still needs a second participant. */
  waitingForPlayers?: boolean;
  inviteCode?: string | null;

  // Lobby
  spotsRemaining?: number | null;
  fillPercent?: number | null;
  featured?: boolean;
  almostFull?: boolean;
  official?: boolean;
  startingSoon?: boolean;
}

function myParticipation(c: Challenge | ChallengeDetail, userId?: number): Participant | null {
  const detail = c as Partial<ChallengeDetail>;
  if (detail.my_participation) return detail.my_participation;
  if (userId && Array.isArray(detail.participants)) {
    return detail.participants.find((p) => p.user === userId || p.user_id === userId) ?? null;
  }
  return null;
}

/** Map a `/my-challenges/` item to the card model. */
export function challengeToCardModel(c: Challenge | ChallengeDetail, userId?: number): ChallengeCardModel {
  const me = myParticipation(c, userId);
  return {
    id: c.id,
    name: c.name,
    milestone: c.milestone,
    milestoneTier: milestoneTier(c.milestone_display),
    isPrivate: c.is_private,
    entryFee: c.entry_fee,
    pool: c.total_pool,
    participants: c.current_participants,
    maxParticipants: c.max_participants,
    startDate: c.start_date,
    endDate: c.end_date,
    daysRemaining: c.days_remaining,
    status: c.status,
    steps: me?.steps ?? c.user_steps ?? null,
    rank: me?.rank ?? c.user_rank ?? null,
    qualified: me ? me.qualified : null,
    payout: me?.payout ?? c.user_payout ?? null,
    inviteCode: c.invite_code,
    waitingForPlayers: Boolean(userId && c.creator === userId && c.status === 'active' && c.current_participants < 2),
  };
}

/** Map a lobby card to the card model. */
export function lobbyToCardModel(l: LobbyChallenge): ChallengeCardModel {
  return {
    id: l.id,
    name: l.name,
    milestone: l.milestone,
    milestoneTier: milestoneTier(l.milestone_label),
    isPrivate: false,
    entryFee: l.entry_fee,
    pool: l.effective_pool_kes,
    poolBonus: l.platform_bonus_kes,
    participants: l.participant_count,
    maxParticipants: l.max_participants,
    startDate: l.start_date,
    endDate: l.end_date,
    daysRemaining: l.days_remaining,
    status: l.status,
    spotsRemaining: l.spots_remaining,
    fillPercent: l.fill_percentage,
    featured: l.is_featured,
    almostFull: l.is_almost_full,
    official: l.is_platform_challenge,
    startingSoon: l.is_starting_soon,
  };
}
