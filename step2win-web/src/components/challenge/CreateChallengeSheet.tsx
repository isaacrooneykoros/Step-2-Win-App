import { useMemo, useState } from 'react';
import { AlertCircle, ChevronDown, Globe, Lock } from 'lucide-react';
import { Sheet } from '../ui/Sheet';
import Button from '../ui/Button';
import Input from '../ui/Input';
import { Segmented } from '../ui/Segmented';
import { formatKES, formatKESShort, formatSteps } from '../../lib/format';
import type { ChallengeConfig, ChallengeWinCondition, CreateChallengeForm } from '../../types';
import { NextSteps, SummaryList } from './SummaryList';
import { WIN_CONDITION_COPY, formatDay, milestoneTier } from './challengeUtils';

/** Used only until /challenges/config/ loads. Mirrors the backend defaults. */
const FALLBACK_MILESTONES = [10000, 15000, 20000, 25000, 30000, 40000, 50000, 65000, 80000, 100000, 125000, 150000, 200000, 250000, 300000];
/** Entry is typed (whole KSh). Used only until /challenges/config/ loads; mirrors the backend. */
const FALLBACK_FEE_MIN = 50;
const FALLBACK_FEE_MAX = 10000;
const FALLBACK_FEE_SUGGESTIONS = [100, 250, 500, 1000, 2000];
const DURATIONS = ['7', '14', '21', '30'] as const;
type Duration = (typeof DURATIONS)[number];

export interface CreateChallengeSheetProps {
  open: boolean;
  onClose: () => void;
  config?: ChallengeConfig;
  /** User's available (unlocked) wallet balance, if known. */
  availableBalance: number | null;
  isSubmitting: boolean;
  /** Error message from the last attempt, shown on the review step. */
  error?: string | null;
  onSubmit: (payload: CreateChallengeForm) => void;
  onDeposit: () => void;
}

interface FormState {
  name: string;
  milestone: string;
  entryFee: string;
  maxParticipants: string;
  isPublic: boolean;
  duration: Duration;
  winCondition: ChallengeWinCondition;
}

const INITIAL: FormState = {
  name: '',
  milestone: '50000',
  entryFee: '100',
  maxParticipants: '20',
  isPublic: true,
  duration: '7',
  winCondition: 'proportional',
};

type Errors = Partial<Record<'name' | 'entryFee' | 'maxParticipants', string>>;

/**
 * Two-step create flow: set up → review & pay. Nothing is charged until the user
 * confirms on the review step. Remount (via `key`) to reset between openings.
 */
export function CreateChallengeSheet({
  open,
  onClose,
  config,
  availableBalance,
  isSubmitting,
  error,
  onSubmit,
  onDeposit,
}: CreateChallengeSheetProps) {
  const [step, setStep] = useState<'form' | 'review'>('form');
  const [form, setForm] = useState<FormState>(INITIAL);
  const [errors, setErrors] = useState<Errors>({});

  const milestones = useMemo(
    () =>
      config?.challenge_milestones?.length
        ? config.challenge_milestones.map((m) => ({ value: m.value, tier: milestoneTier(m.label) }))
        : FALLBACK_MILESTONES.map((value) => ({ value, tier: null as string | null })),
    [config],
  );

  const feeMin = config?.entry_fee_min ?? FALLBACK_FEE_MIN;
  const feeMax = config?.entry_fee_max ?? FALLBACK_FEE_MAX;
  const feeSuggestions = (config?.entry_fee_suggestions ?? FALLBACK_FEE_SUGGESTIONS).filter((s) => s >= feeMin && s <= feeMax);
  const maxPlayers = config?.max_challenge_participants ?? 1000;
  const feePct = config ? Number(config.platform_fee_percentage) : null;
  const entry = Number(form.entryFee) || 0;
  const milestone = Number(form.milestone);
  const duration = Number(form.duration);
  const endDate = new Date();
  endDate.setDate(endDate.getDate() + duration);
  const endLabel = formatDay(endDate.toISOString());
  const insufficient = availableBalance !== null && entry > availableBalance;
  const payoutRule = form.isPublic ? 'proportional' : form.winCondition;

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    if (key in errors) setErrors((e) => ({ ...e, [key]: undefined }));
  };

  const setVisibility = (isPublic: boolean) => {
    setForm((f) => ({ ...f, isPublic }));
  };

  const validate = (): boolean => {
    const next: Errors = {};
    if (!form.name.trim()) next.name = 'Give your challenge a name.';
    if (!entry || entry < feeMin || entry > feeMax) {
      next.entryFee = `Enter an amount between ${formatKESShort(feeMin)} and ${formatKESShort(feeMax)}.`;
    }
    const players = Number(form.maxParticipants);
    if (!Number.isInteger(players) || players < 2 || players > maxPlayers) {
      next.maxParticipants = `Choose between 2 and ${maxPlayers} players.`;
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const submit = () => {
    onSubmit({
      name: form.name.trim(),
      milestone,
      entry_fee: entry,
      max_participants: Number(form.maxParticipants),
      is_public: form.isPublic,
      duration_days: duration,
      win_condition: payoutRule,
      // theme_emoji intentionally omitted: the backend applies its default.
    });
  };

  const selectedTier = milestones.find((m) => m.value === milestone)?.tier;

  const footer =
    step === 'form' ? (
      <div className="pb-3">
        <div className="mb-3 flex items-baseline justify-between gap-3 text-callout">
          <span className="text-text-secondary">Your entry contribution</span>
          <span className="num font-semibold text-text-primary">{entry ? formatKES(entry) : '—'}</span>
        </div>
        <Button
          fullWidth
          size="lg"
          onClick={() => {
            if (validate()) setStep('review');
          }}
        >
          Review
        </Button>
      </div>
    ) : (
      <div className="flex gap-3 pb-3">
        <Button variant="outline" size="lg" onClick={() => setStep('form')} disabled={isSubmitting}>
          Back
        </Button>
        <Button fullWidth size="lg" onClick={submit} isLoading={isSubmitting} loadingText="Creating…" disabled={insufficient}>
          Pay {formatKES(entry)} and create
        </Button>
      </div>
    );

  return (
    <Sheet
      open={open}
      onClose={onClose}
      dismissible={!isSubmitting}
      title={step === 'form' ? 'New challenge' : 'Review and pay'}
      description={
        step === 'form'
          ? 'Set the goal and entry. You join as the first participant.'
          : 'Check the details. Nothing is charged until you confirm.'
      }
      footer={footer}
    >
      {step === 'form' ? (
        <div className="space-y-5">
          <Input
            label="Challenge name"
            value={form.name}
            onChange={(e) => set('name', e.target.value)}
            placeholder="e.g. Office step-off"
            maxLength={200}
            autoComplete="off"
            error={errors.name}
            containerClassName="!mb-0"
          />

          <fieldset>
            <legend className="label">Who can join</legend>
            <div role="radiogroup" aria-label="Who can join" className="grid grid-cols-2 gap-2">
              {[
                { value: true, icon: Globe, title: 'Public', body: 'Listed in Discover' },
                { value: false, icon: Lock, title: 'Private', body: 'Invite code only' },
              ].map((opt) => {
                const active = form.isPublic === opt.value;
                const Icon = opt.icon;
                return (
                  <button
                    key={opt.title}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => setVisibility(opt.value)}
                    className={[
                      'flex min-h-[64px] items-start gap-2.5 rounded-control border p-3 text-left transition-colors duration-fast active:!scale-100',
                      active ? 'border-brand bg-brand-soft' : 'border-border bg-bg-card hover:bg-bg-input',
                    ].join(' ')}
                  >
                    <Icon size={18} className={`mt-0.5 shrink-0 ${active ? 'text-brand' : 'text-text-muted'}`} aria-hidden />
                    <span className="min-w-0">
                      <span className="block text-callout font-semibold text-text-primary">{opt.title}</span>
                      <span className="block text-caption text-text-secondary">{opt.body}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </fieldset>

          <div>
            <p className="label" id="entry-label">
              Entry contribution
            </p>
            <Input
              aria-labelledby="entry-label"
              type="text"
              inputMode="numeric"
              autoComplete="off"
              enterKeyHint="done"
              placeholder={String(feeSuggestions[0] ?? feeMin)}
              value={form.entryFee}
              // Whole shillings only: keep digits, drop leading zeros.
              onChange={(e) => set('entryFee', e.target.value.replace(/\D/g, '').replace(/^0+/, '').slice(0, 6))}
              leading={<span className="text-callout font-semibold">KSh</span>}
              className="num pl-14"
              error={errors.entryFee}
              helperText={`Type any amount from ${formatKESShort(feeMin)} to ${formatKESShort(feeMax)}.`}
              containerClassName="!mb-0"
            />
            {feeSuggestions.length > 0 && (
              <div className="mt-3">
                <p className="mb-2 text-caption text-text-muted" id="entry-suggestions-label">
                  Suggestions
                </p>
                <div className="grid grid-cols-5 gap-2" role="group" aria-labelledby="entry-suggestions-label">
                  {feeSuggestions.map((amount) => {
                    const selected = entry === amount;
                    return (
                      <button
                        key={amount}
                        type="button"
                        aria-pressed={selected}
                        onClick={() => set('entryFee', String(amount))}
                        className={`num inline-flex h-11 min-w-0 items-center justify-center rounded-full border px-1 text-callout font-semibold ${
                          selected
                            ? 'border-brand bg-brand-soft text-brand'
                            : 'border-border bg-bg-card text-text-primary hover:bg-bg-input'
                        }`}
                      >
                        {amount.toLocaleString('en-KE')}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            {availableBalance !== null && entry > 0 && entry > availableBalance && (
              <p className="mt-2 flex items-center gap-1.5 text-caption font-medium text-warning" role="status">
                <AlertCircle size={14} aria-hidden />
                More than your available balance ({formatKESShort(availableBalance)}). You can top up on the next step.
              </p>
            )}
          </div>

          <div>
            <label htmlFor="create-milestone" className="label">
              Step goal
            </label>
            <div className="relative">
              <select
              id="create-milestone"
              value={form.milestone}
              onChange={(e) => set('milestone', e.target.value)}
              className="input-field num min-h-[48px] appearance-none pr-10"
            >
              {milestones.map((m) => (
                <option key={m.value} value={String(m.value)}>
                  {formatSteps(m.value)} steps{m.tier ? ` · ${m.tier}` : ''}
                </option>
              ))}
            </select>
              <ChevronDown size={18} className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-text-muted" aria-hidden />
            </div>
            <p className="mt-1.5 text-caption text-text-muted">Total steps each person needs over the whole challenge to qualify.</p>
          </div>

          <div>
            <p className="label" id="duration-label">
              Duration
            </p>
            <Segmented
              label="Duration"
              value={form.duration}
              onChange={(v) => set('duration', v)}
              options={DURATIONS.map((d) => ({ value: d, label: `${d} days` }))}
            />
            <p className="mt-1.5 text-caption text-text-muted">Starts today and ends {endLabel}.</p>
          </div>

          <Input
            label="Maximum players"
            type="number"
            inputMode="numeric"
            min={2}
            max={maxPlayers}
            value={form.maxParticipants}
            onChange={(e) => set('maxParticipants', e.target.value)}
            className="num"
            error={errors.maxParticipants}
            helperText={`Including you. Up to ${maxPlayers}.`}
            containerClassName="!mb-0"
          />

          {!form.isPublic && (
            <fieldset>
              <legend className="label">How the pool is paid out</legend>
              <div role="radiogroup" aria-label="How the pool is paid out" className="space-y-2">
                {(Object.keys(WIN_CONDITION_COPY) as ChallengeWinCondition[]).map((key) => {
                  const active = form.winCondition === key;
                  return (
                    <button
                      key={key}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      onClick={() => set('winCondition', key)}
                      className={[
                        'flex w-full items-start gap-3 rounded-control border p-3 text-left transition-colors duration-fast active:!scale-100',
                        active ? 'border-brand bg-brand-soft' : 'border-border bg-bg-card hover:bg-bg-input',
                      ].join(' ')}
                    >
                      <span
                        className={`mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 ${active ? 'border-brand' : 'border-border'}`}
                        aria-hidden
                      >
                        {active && <span className="h-2.5 w-2.5 rounded-full bg-brand" />}
                      </span>
                      <span className="min-w-0">
                        <span className="block text-callout font-semibold text-text-primary">{WIN_CONDITION_COPY[key].label}</span>
                        <span className="block text-caption text-text-secondary">{WIN_CONDITION_COPY[key].description}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </fieldset>
          )}
        </div>
      ) : (
        <div className="space-y-5">
          <div className="rounded-card bg-bg-sunken p-4">
            <p className="eyebrow">You pay now</p>
            <p className="num mt-1 text-title-lg text-text-primary">{formatKES(entry)}</p>
            <p className="mt-1 text-callout text-text-secondary">Moved from your Step2Win wallet into this challenge's pool.</p>
          </div>

          <SummaryList
            items={[
              { label: 'Challenge', value: <span className="line-clamp-2 break-words">{form.name.trim()}</span> },
              { label: 'Step goal', value: `${formatSteps(milestone)} steps${selectedTier ? ` · ${selectedTier}` : ''}` },
              { label: 'Dates', value: `Today – ${endLabel} (${duration} days)` },
              { label: 'Visibility', value: form.isPublic ? 'Public' : 'Private' },
              { label: 'Players', value: `Up to ${form.maxParticipants}` },
              { label: 'Payout', value: WIN_CONDITION_COPY[payoutRule].label },
              {
                label: 'Platform fee',
                value: feePct !== null && Number.isFinite(feePct) ? `${feePct}% of final pool` : 'Taken from final pool',
                tone: 'muted',
              },
            ]}
          />

          {availableBalance !== null && (
            <SummaryList
              items={[
                { label: 'Available balance', value: formatKES(availableBalance) },
                { label: 'Entry contribution', value: `− ${formatKES(entry)}` },
                {
                  label: 'Balance after',
                  value: formatKES(Math.max(0, availableBalance - entry)),
                  strong: true,
                  tone: insufficient ? 'danger' : 'default',
                },
              ]}
            />
          )}

          {insufficient && (
            <div className="flex items-start gap-3 rounded-card bg-warning-soft p-4" role="status">
              <AlertCircle size={18} className="mt-0.5 shrink-0 text-warning" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="text-callout font-semibold text-text-primary">Not enough balance</p>
                <p className="mt-0.5 text-caption text-text-secondary">Deposit with M-Pesa, then come back to create this challenge.</p>
                <Button variant="outline" size="sm" className="mt-3" onClick={onDeposit}>
                  Deposit
                </Button>
              </div>
            </div>
          )}

          {error && (
            <div className="flex items-start gap-3 rounded-card bg-danger-soft p-4" role="alert">
              <AlertCircle size={18} className="mt-0.5 shrink-0 text-danger" aria-hidden />
              <div className="min-w-0">
                <p className="text-callout font-semibold text-danger">Challenge not created</p>
                <p className="mt-0.5 text-caption text-text-secondary">{error}</p>
              </div>
            </div>
          )}

          <NextSteps
            steps={[
              `${formatKES(entry)} is held in the challenge pool and you join as the first participant.`,
              "Share the invite code we'll show you so others can join.",
              `It ends on ${endLabel}. Everyone who walks ${formatSteps(milestone)} steps qualifies, and the pool is paid out by the ${WIN_CONDITION_COPY[payoutRule].label.toLowerCase()} rule after the platform fee. If nobody qualifies, entries are refunded.`,
            ]}
          />
        </div>
      )}
    </Sheet>
  );
}

export default CreateChallengeSheet;
