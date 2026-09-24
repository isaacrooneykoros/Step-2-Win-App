import { useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, CheckCircle2, Clock, PauseCircle, Phone, ShieldCheck, Wallet } from 'lucide-react';
import { Sheet } from '../ui/Sheet';
import Button from '../ui/Button';
import Input from '../ui/Input';
import { Pill } from '../ui/Pill';
import { formatKES } from '../../lib/format';
import { appService, paymentsService } from '../../services/api';
import { AmountField, Note, StatusPanel, StepIndicator, SummaryList } from './FlowParts';
import {
  WITHDRAW_MAX,
  WITHDRAW_MIN,
  amountError,
  formatDestination,
  formatPhoneDisplay,
  parseAmountInput,
  phoneError,
  sanitizeAmountInput,
  toAmount,
  withdrawalStatusInfo,
} from './walletModel';

type Step = 'amount' | 'destination' | 'confirm';
type SubmitState = 'idle' | 'submitting' | 'success' | 'error';

const STEP_LABEL: Record<Step, string> = { amount: 'Amount', destination: 'Send to', confirm: 'Confirm' };
const STEP_INDEX: Record<Step, number> = { amount: 1, destination: 2, confirm: 3 };
const QUICK = [500, 1000, 2000, 5000];

interface WithdrawResult {
  message?: string;
  withdrawal_id?: string;
  amount_kes?: string;
  status?: string;
  destination?: string;
}

interface WithdrawSheetProps {
  open: boolean;
  onClose: () => void;
  available: number;
  defaultPhone: string;
  onViewWithdrawals: () => void;
}

export function WithdrawSheet({ open, onClose, available, defaultPhone, onViewWithdrawals }: WithdrawSheetProps) {
  const queryClient = useQueryClient();
  const [step, setStep] = useState<Step>('amount');
  const [amountRaw, setAmountRaw] = useState('');
  const [phone, setPhone] = useState(defaultPhone);
  const [touched, setTouched] = useState<{ amount?: boolean; phone?: boolean }>({});
  const [submitState, setSubmitState] = useState<SubmitState>('idle');
  const [error, setError] = useState('');
  const [result, setResult] = useState<WithdrawResult | null>(null);

  // Admin-configured minimum / switch / review time (Settings > Withdrawals).
  const configQ = useQuery({ queryKey: ['app-config'], queryFn: appService.getConfig, staleTime: 60_000, enabled: open });
  const config = configQ.data;
  const minimum = Math.max(WITHDRAW_MIN, toAmount(config?.withdrawals.minimum_kes));
  const reviewTime = hoursLabel(config?.withdrawals.processing_hours ?? 24);
  const paused = config?.features.withdrawals === false;

  const cap = Math.min(WITHDRAW_MAX, available);
  const tooLittle = available < minimum;
  const amount = parseAmountInput(amountRaw);
  const amountErr = amountError(
    amount,
    minimum,
    cap,
    amount > available ? `You have ${formatKES(available)} available to withdraw.` : undefined,
  );
  const phoneErr = phoneError(phone);
  const submitting = submitState === 'submitting';

  const goNext = () => {
    if (step === 'amount') {
      setTouched((t) => ({ ...t, amount: true }));
      if (!amountErr) setStep('destination');
    } else if (step === 'destination') {
      setTouched((t) => ({ ...t, phone: true }));
      if (!phoneErr) setStep('confirm');
    }
  };

  const submit = async () => {
    if (amountErr || phoneErr || submitting) return;
    setSubmitState('submitting');
    setError('');
    try {
      const data = await paymentsService.requestWithdrawal({
        method: 'mpesa',
        amount,
        phone_number: phone.trim(),
      });
      setResult(data ?? null);
      setSubmitState('success');
      queryClient.invalidateQueries({ queryKey: ['wallet'] });
      queryClient.invalidateQueries({ queryKey: ['withdrawals'] });
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
      queryClient.invalidateQueries({ queryKey: ['profile'] });
    } catch (err: any) {
      const status = err?.response?.status;
      setError(
        err?.response?.data?.error ||
          (status === 429 ? 'Too many withdrawal requests. Please wait a while and try again.' : '') ||
          err?.message ||
          'Withdrawal request failed. Please try again.',
      );
      setSubmitState('error');
    }
  };

  let body: ReactNode;
  let footer: ReactNode;

  if (submitState === 'success') {
    const status = withdrawalStatusInfo(result?.status || 'pending_review');
    const shownAmount = result?.amount_kes ? Number(result.amount_kes) : amount;
    body = (
      <div className="space-y-5">
        <StatusPanel icon={CheckCircle2} tone="success" title="Withdrawal requested">
          {result?.message || `Your request is being reviewed and is usually processed within ${reviewTime}.`}
        </StatusPanel>
        <SummaryList
          rows={[
            { label: 'Amount', value: formatKES(shownAmount), strong: true },
            { label: 'To', value: result?.destination ? formatDestination(result.destination) : `M-Pesa ${formatPhoneDisplay(phone)}` },
            {
              label: 'Status',
              value: (
                <Pill tone={status.tone} size="md">
                  {status.label}
                </Pill>
              ),
            },
          ]}
        />
        <Timeline reviewTime={reviewTime} />
        <Note icon={ShieldCheck}>
          {formatKES(shownAmount)} has been taken from your available balance and is held while we review it. If the request is rejected or
          sending fails, the full amount goes back to your balance.
        </Note>
      </div>
    );
    footer = (
      <div className="grid grid-cols-2 gap-3 pb-3">
        <Button variant="secondary" size="lg" onClick={onViewWithdrawals}>
          Track status
        </Button>
        <Button size="lg" onClick={onClose}>
          Done
        </Button>
      </div>
    );
  } else if (submitState === 'error') {
    body = (
      <div className="space-y-5">
        <StatusPanel icon={AlertCircle} tone="danger" title="Withdrawal not requested" live="assertive">
          {error}
        </StatusPanel>
        <Note icon={ShieldCheck}>Nothing was taken from your balance.</Note>
      </div>
    );
    footer = (
      <div className="grid grid-cols-2 gap-3 pb-3">
        <Button
          variant="secondary"
          size="lg"
          onClick={() => {
            setSubmitState('idle');
            setStep('amount');
          }}
        >
          Edit details
        </Button>
        <Button
          size="lg"
          onClick={() => {
            setSubmitState('idle');
            setStep('confirm');
          }}
        >
          Try again
        </Button>
      </div>
    );
  } else {
    body = (
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (step === 'confirm') submit();
          else goNext();
        }}
      >
        <StepIndicator step={STEP_INDEX[step]} total={3} label={STEP_LABEL[step]} />
        {step === 'amount' &&
          (paused ? (
            <Note icon={PauseCircle}>
              Withdrawals are paused for a short while. Your balance is safe; please try again later.
            </Note>
          ) : tooLittle ? (
            <Note icon={Wallet}>
              You have <span className="num font-semibold text-text-primary">{formatKES(available)}</span> available. You need at least{' '}
              {formatKES(minimum)} available to withdraw. Money locked in active challenges can&apos;t be withdrawn until they end.
            </Note>
          ) : (
            <>
              <AmountField
                value={amountRaw}
                onChange={(v) => setAmountRaw(sanitizeAmountInput(v))}
                quickAmounts={QUICK}
                quickMax={cap}
                error={touched.amount ? amountErr : undefined}
                helper={
                  <>
                    Available: <span className="num font-semibold text-text-secondary">{formatKES(available)}</span>
                    {` · minimum ${formatKES(minimum)}`}
                    {available > WITHDRAW_MAX && ` · up to ${formatKES(WITHDRAW_MAX)} per request`}
                  </>
                }
                label="How much do you want to withdraw?"
              />
              <button
                type="button"
                onClick={() => setAmountRaw(String(Math.floor(cap * 100) / 100))}
                className="mt-2 inline-flex min-h-touch items-center text-callout font-semibold text-brand"
              >
                Withdraw {available > WITHDRAW_MAX ? 'maximum' : 'all'} ({formatKES(Math.floor(cap * 100) / 100)})
              </button>
            </>
          ))}
        {step === 'destination' && (
          <div className="space-y-3">
            <Input
              label="M-Pesa phone number"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              enterKeyHint="next"
              data-autofocus
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              onBlur={() => setTouched((t) => ({ ...t, phone: true }))}
              placeholder="0712 345 678"
              leading={<Phone size={18} />}
              error={touched.phone ? phoneErr : undefined}
              helperText={
                defaultPhone && phone === defaultPhone
                  ? 'This is the number on your profile.'
                  : 'Money will be sent to this M-Pesa number.'
              }
              className="num text-headline"
            />
            <Note icon={ShieldCheck}>Check the number carefully — M-Pesa transfers can&apos;t be reversed once sent.</Note>
          </div>
        )}
        {step === 'confirm' && (
          <div className="space-y-4">
            <SummaryList
              rows={[
                { label: 'You withdraw', value: formatKES(amount), strong: true },
                { label: 'Send to', value: `M-Pesa ${formatPhoneDisplay(phone)}` },
                { label: 'Available after', value: formatKES(Math.max(0, available - amount)) },
              ]}
            />
            <Note icon={Clock}>
              Withdrawals are reviewed by our team, usually within {reviewTime}, then sent to your M-Pesa. The amount is held from your balance
              while it&apos;s reviewed.
            </Note>
          </div>
        )}
        <button type="submit" className="sr-only" tabIndex={-1} aria-hidden>
          Continue
        </button>
      </form>
    );
    footer = tooLittle || paused ? (
      <div className="pb-3">
        <Button variant="secondary" fullWidth size="lg" onClick={onClose}>
          Close
        </Button>
      </div>
    ) : (
      <div className="flex gap-3 pb-3">
        {step !== 'amount' && (
          <Button
            variant="secondary"
            size="lg"
            disabled={submitting}
            onClick={() => setStep(step === 'confirm' ? 'destination' : 'amount')}
            className="shrink-0"
          >
            Back
          </Button>
        )}
        {step === 'confirm' ? (
          <Button size="lg" fullWidth className="flex-1" onClick={submit} isLoading={submitting} loadingText="Requesting…">
            Request withdrawal
          </Button>
        ) : (
          <Button size="lg" fullWidth className="flex-1" onClick={goNext}>
            Continue
          </Button>
        )}
      </div>
    );
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={submitState === 'idle' || submitting ? 'Withdraw' : 'Withdrawal'}
      description={submitState === 'idle' || submitting ? 'Send money from your wallet to M-Pesa' : undefined}
      footer={footer}
      dismissible={!submitting}
    >
      {body}
    </Sheet>
  );
}

/** 24 → "24 hours", 72 → "3 days". */
function hoursLabel(hours: number): string {
  if (hours >= 48 && hours % 24 === 0) return `${hours / 24} days`;
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}

/** What happens next, in order. */
function Timeline({ reviewTime }: { reviewTime: string }) {
  const items = [
    { title: 'Requested', hint: 'Just now', done: true },
    { title: 'Review', hint: `Usually within ${reviewTime}`, done: false },
    { title: 'Sent to M-Pesa', hint: 'You’ll get an M-Pesa SMS', done: false },
  ];
  return (
    <ol className="space-y-0 rounded-card border border-border-light bg-bg-card px-4 py-3" aria-label="What happens next">
      {items.map((item, i) => (
        <li key={item.title} className="relative flex gap-3 pb-3 last:pb-0">
          {i < items.length - 1 && <span className="absolute left-[7px] top-5 h-[calc(100%-12px)] w-px bg-border" aria-hidden />}
          <span
            className={`mt-1 h-[15px] w-[15px] shrink-0 rounded-full border-2 ${item.done ? 'border-brand bg-brand' : 'border-border bg-bg-card'}`}
            aria-hidden
          />
          <div className="min-w-0">
            <p className="text-callout font-semibold text-text-primary">
              {item.title}
              <span className="sr-only">{item.done ? ' (done)' : ' (next)'}</span>
            </p>
            <p className="text-caption text-text-muted">{item.hint}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}

export default WithdrawSheet;
