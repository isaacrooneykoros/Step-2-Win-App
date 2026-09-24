import {
  ArrowDownLeft,
  ArrowUpRight,
  Gift,
  Receipt,
  RotateCcw,
  Trophy,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import type { Tone } from '../ui/Pill';
import type { Transaction } from '../../types';

/** Limits mirror backend settings (MIN/MAX_DEPOSIT_KES, MIN/MAX_WITHDRAWAL_KES). */
export const DEPOSIT_MIN = 10;
export const DEPOSIT_MAX = 100_000;
export const WITHDRAW_MIN = 10;
export const WITHDRAW_MAX = 70_000;

export const toAmount = (value: string | number | null | undefined): number => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/** Parse user-typed amount ("1,500" → 1500). Returns NaN when empty/invalid. */
export function parseAmountInput(raw: string): number {
  const cleaned = raw.replace(/[,\s]/g, '');
  if (!cleaned) return NaN;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : NaN;
}

/** Keep only digits and one decimal point with ≤2 decimals. */
export function sanitizeAmountInput(raw: string): string {
  const cleaned = raw.replace(/[^\d.]/g, '');
  const [whole, ...rest] = cleaned.split('.');
  if (rest.length === 0) return whole.slice(0, 7);
  return `${whole.slice(0, 7)}.${rest.join('').slice(0, 2)}`;
}

/**
 * Mirrors the backend's `format_phone`: accepts 07XX/01XX, 2547XX/2541XX and +254 forms.
 * Returns the normalised 254XXXXXXXXX string or null when it can't be an M-Pesa number.
 */
export function normalizeKenyanPhone(raw: string): string | null {
  let phone = raw.trim().replace(/[\s-]/g, '');
  if (phone.startsWith('+')) phone = phone.slice(1);
  if (phone.startsWith('07') || phone.startsWith('01')) phone = `254${phone.slice(1)}`;
  return /^254[17]\d{8}$/.test(phone) ? phone : null;
}

export function phoneError(raw: string): string | undefined {
  if (!raw.trim()) return 'Enter the M-Pesa number to use.';
  if (!normalizeKenyanPhone(raw)) return 'Enter a Safaricom number like 0712 345 678 or 254712345678.';
  return undefined;
}

/** 254712345678 → 0712 345 678 (display only). */
export function formatPhoneDisplay(raw: string | null | undefined): string {
  if (!raw) return '';
  const normalized = normalizeKenyanPhone(raw);
  if (!normalized) return raw;
  const local = `0${normalized.slice(3)}`;
  return `${local.slice(0, 4)} ${local.slice(4, 7)} ${local.slice(7)}`;
}

export function amountError(value: number, min: number, max: number, maxReason?: string): string | undefined {
  if (!Number.isFinite(value)) return 'Enter an amount.';
  if (value < min) return `The minimum is KSh ${min.toLocaleString('en-KE')}.`;
  if (value > max) return maxReason ?? `The maximum is KSh ${max.toLocaleString('en-KE')}.`;
  return undefined;
}

// ── Transactions ─────────────────────────────────────────────────────────────

export const txTypeConfig: Record<string, { icon: LucideIcon; tone: Tone; label: string }> = {
  deposit: { icon: ArrowDownLeft, tone: 'brand', label: 'Deposit' },
  withdrawal: { icon: ArrowUpRight, tone: 'neutral', label: 'Withdrawal' },
  challenge_entry: { icon: Trophy, tone: 'info', label: 'Challenge entry' },
  payout: { icon: Gift, tone: 'reward', label: 'Payout' },
  fee: { icon: Receipt, tone: 'neutral', label: 'Fee' },
  refund: { icon: RotateCcw, tone: 'success', label: 'Refund' },
};

export function txConfig(tx: Pick<Transaction, 'type' | 'type_display'>) {
  return txTypeConfig[tx.type] ?? { icon: Wallet, tone: 'neutral' as Tone, label: tx.type_display || 'Transaction' };
}

const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

/** "Today", "Yesterday", "Mon, 14 Sep" (adds year when not this year). */
export function dayLabel(input: string | Date, now: Date = new Date()): string {
  const date = new Date(input);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (dayKey(date) === dayKey(now)) return 'Today';
  if (dayKey(date) === dayKey(yesterday)) return 'Yesterday';
  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

export function groupByDay<T extends { created_at: string }>(items: T[]): Array<{ label: string; key: string; items: T[] }> {
  const groups: Array<{ label: string; key: string; items: T[] }> = [];
  const now = new Date();
  for (const item of items) {
    const date = new Date(item.created_at);
    const key = dayKey(date);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push(item);
    else groups.push({ key, label: dayLabel(date, now), items: [item] });
  }
  return groups;
}

export const timeOfDay = (input: string) =>
  new Date(input).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

// ── Withdrawals ──────────────────────────────────────────────────────────────

/** Shape returned by GET /api/payments/withdrawal/history/ */
export interface WithdrawalItem {
  id: string;
  status: string;
  amount_kes: string;
  method: string;
  destination: string;
  mpesa_ref: string | null;
  fail_reason: string | null;
  created_at: string;
  updated_at: string;
}

export const withdrawalStatus: Record<string, { label: string; tone: Tone; hint: string }> = {
  pending_review: { label: 'In review', tone: 'warning', hint: 'Waiting for approval — usually within 24 hours.' },
  approved: { label: 'Approved', tone: 'info', hint: 'Approved and queued for sending.' },
  processing: { label: 'Processing', tone: 'info', hint: 'Being sent to M-Pesa.' },
  completed: { label: 'Sent', tone: 'success', hint: 'Sent to your M-Pesa.' },
  rejected: { label: 'Rejected', tone: 'danger', hint: 'Not approved — amount returned to your balance.' },
  failed: { label: 'Failed', tone: 'danger', hint: 'Could not be sent — amount returned to your balance.' },
  cancelled: { label: 'Cancelled', tone: 'neutral', hint: 'Cancelled — amount returned to your balance.' },
};

export const IN_FLIGHT_WITHDRAWAL = new Set(['pending_review', 'approved', 'processing']);

export function withdrawalStatusInfo(status: string) {
  return withdrawalStatus[status] ?? { label: status.replace(/_/g, ' '), tone: 'neutral' as Tone, hint: '' };
}

/** Backend `destination_display` → "M-Pesa 0712 345 678" / "Bank: 123…" */
export function formatDestination(destination: string | null | undefined): string {
  if (!destination) return '';
  const match = destination.match(/^M-Pesa:\s*(.+)$/i);
  if (match) return `M-Pesa ${formatPhoneDisplay(match[1])}`;
  return destination;
}
