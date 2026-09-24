import { useEffect, useState, type ReactNode } from 'react';
import { AlertCircle, CheckCircle2, Clock, Phone, ShieldCheck, Smartphone, XCircle } from 'lucide-react';
import { Sheet } from '../ui/Sheet';
import Button from '../ui/Button';
import Input from '../ui/Input';
import { Pill } from '../ui/Pill';
import { formatKES } from '../../lib/format';
import type { useDeposit } from '../../hooks/useDeposit';
import { AmountField, Note, StatusPanel, StepIndicator, SummaryList } from './FlowParts';
import {
  DEPOSIT_MAX,
  DEPOSIT_MIN,
  amountError,
  formatPhoneDisplay,
  parseAmountInput,
  phoneError,
  sanitizeAmountInput,
} from './walletModel';

type Deposit = ReturnType<typeof useDeposit>;
type Step = 'amount' | 'phone' | 'confirm';

const STEP_LABEL: Record<Step, string> = { amount: 'Amount', phone: 'M-Pesa number', confirm: 'Confirm' };
const STEP_INDEX: Record<Step, number> = { amount: 1, phone: 2, confirm: 3 };
const QUICK = [100, 500, 1000, 2000];

interface DepositSheetProps {
  open: boolean;
  onClose: () => void;
  deposit: Deposit;
  defaultPhone: string;
  /** Latest available balance from the wallet query (for the success summary). */
  availableBalance: number | null;
  balanceRefreshing: boolean;
  onViewTransactions: () => void;
}

/** Friendlier wording for technical gateway errors, keeping the original as a detail line. */
function describeInitError(raw: string): { reason: string; detail?: string } {
  const lower = raw.toLowerCase();
  if (lower.includes('please wait a moment')) return { reason: raw };
  if (lower.includes('api key') || lower.includes('initiation failed') || lower.includes('gateway') || lower.includes('intasend')) {
    // Generic backend wording adds nothing; keep technical messages as a detail line for support.
    const generic = lower.includes('initiation failed');
    return { reason: 'The M-Pesa service is not available right now. Please try again in a few minutes.', detail: generic ? undefined : raw };
  }
  if (lower.includes('phone')) return { reason: 'That phone number was not accepted. Check it and try again.', detail: raw };
  if (lower.includes('duplicate')) return { reason: 'This request was already sent. Wait a moment before trying again.' };
  if (lower.includes('network error')) return { reason: 'We could not reach Step2Win. Check your connection and try again.' };
  return { reason: raw || 'We could not start the payment.' };
}

export function DepositSheet({
  open,
  onClose,
  deposit,
  defaultPhone,
  availableBalance,
  balanceRefreshing,
  onViewTransactions,
}: DepositSheetProps) {
  const { state, errorMsg, failureStage, mpesaRef, attempt, initiateDeposit, reset } = deposit;
  const [step, setStep] = useState<Step>('amount');
  const [amountRaw, setAmountRaw] = useState(attempt ? String(attempt.amount) : '');
  const [phone, setPhone] = useState(attempt?.phone ?? defaultPhone);
  const [touched, setTouched] = useState<{ amount?: boolean; phone?: boolean }>({});

  const amount = parseAmountInput(amountRaw);
  const amountErr = amountError(amount, DEPOSIT_MIN, DEPOSIT_MAX);
  const phoneErr = phoneError(phone);
  const sending = state === 'sending';

  const goNext = () => {
    if (step === 'amount') {
      setTouched((t) => ({ ...t, amount: true }));
      if (!amountErr) setStep('phone');
    } else if (step === 'phone') {
      setTouched((t) => ({ ...t, phone: true }));
      if (!phoneErr) setStep('confirm');
    }
  };

  const send = () => {
    if (amountErr || phoneErr || sending) return;
    initiateDeposit(amount, phone.trim());
  };

  const editDetails = () => {
    reset();
    setStep('amount');
  };

  const shownAmount = attempt?.amount ?? amount;
  const shownPhone = formatPhoneDisplay(attempt?.phone ?? phone);

  // ── Outcome views ──────────────────────────────────────────────────────────
  let body: ReactNode;
  let footer: ReactNode;

  if (state === 'waiting') {
    body = (
      <div className="space-y-5">
        <StatusPanel icon={Smartphone} tone="brand" title="Check your phone">
          We sent an M-Pesa prompt for <span className="num font-semibold text-text-primary">{formatKES(shownAmount)}</span> to{' '}
          <span className="num font-semibold text-text-primary">{shownPhone}</span>. Enter your M-Pesa PIN on your phone to approve it.
        </StatusPanel>
        <div className="flex items-center justify-center gap-2">
          <Pill tone="brand" dot="live" size="md">
            Waiting for M-Pesa
          </Pill>
          <ElapsedTime since={attempt?.startedAt ?? null} />
        </div>
        <Note icon={ShieldCheck}>
          You can close this screen. If you approve the prompt, the money is added to your wallet automatically — you don&apos;t need to
          pay again. To cancel, decline or ignore the prompt on your phone.
        </Note>
      </div>
    );
    footer = (
      <div className="pb-3">
        <Button variant="secondary" fullWidth size="lg" onClick={onClose}>
          Close — keep waiting in background
        </Button>
      </div>
    );
  } else if (state === 'success') {
    body = (
      <div className="space-y-5">
        <StatusPanel icon={CheckCircle2} tone="success" title="Deposit received">
          <span className="num font-semibold text-text-primary">{formatKES(shownAmount)}</span> has been added to your wallet.
        </StatusPanel>
        <SummaryList
          rows={[
            { label: 'Amount', value: formatKES(shownAmount) },
            { label: 'From', value: shownPhone },
            ...(mpesaRef ? [{ label: 'M-Pesa reference', value: mpesaRef }] : []),
            {
              label: 'Available balance',
              value: balanceRefreshing || availableBalance === null ? 'Updating…' : formatKES(availableBalance),
              strong: true,
            },
          ]}
        />
      </div>
    );
    footer = (
      <div className="pb-3">
        <Button fullWidth size="lg" onClick={onClose}>
          Done
        </Button>
      </div>
    );
  } else if (state === 'failed') {
    const initFailed = failureStage === 'initiate';
    const { reason, detail } = initFailed ? describeInitError(errorMsg) : { reason: errorMsg, detail: undefined };
    body = (
      <div className="space-y-5">
        <StatusPanel
          icon={initFailed ? AlertCircle : XCircle}
          tone="danger"
          title={initFailed ? 'We couldn’t send the M-Pesa prompt' : 'Payment not completed'}
          live="assertive"
        >
          {reason}
          {detail && <span className="mt-2 block text-caption text-text-muted">Details: {detail}</span>}
        </StatusPanel>
        <Note icon={ShieldCheck}>
          {initFailed
            ? 'No money has moved. Your M-Pesa and your Step2Win wallet are unchanged.'
            : 'Your M-Pesa was not charged and your Step2Win wallet is unchanged.'}
        </Note>
      </div>
    );
    footer = (
      <div className="grid grid-cols-2 gap-3 pb-3">
        <Button variant="secondary" size="lg" onClick={editDetails}>
          Edit details
        </Button>
        <Button
          size="lg"
          onClick={() => {
            if (!attempt) return;
            setStep('confirm');
            initiateDeposit(attempt.amount, attempt.phone);
          }}
        >
          Try again
        </Button>
      </div>
    );
  } else if (state === 'timeout') {
    body = (
      <div className="space-y-5">
        <StatusPanel icon={Clock} tone="warning" title="Still waiting for M-Pesa">
          We haven&apos;t received confirmation for <span className="num font-semibold text-text-primary">{formatKES(shownAmount)}</span> yet.
        </StatusPanel>
        <Note icon={ShieldCheck}>
          If you approved the prompt, your balance will update automatically as soon as M-Pesa confirms — please don&apos;t pay again. If
          you didn&apos;t approve it, no money has moved.
        </Note>
      </div>
    );
    footer = (
      <div className="grid grid-cols-2 gap-3 pb-3">
        <Button variant="secondary" size="lg" onClick={onViewTransactions}>
          View activity
        </Button>
        <Button size="lg" onClick={onClose}>
          Done
        </Button>
      </div>
    );
  } else {
    // ── Stepped form (idle / sending) ───────────────────────────────────────
    body = (
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (step === 'confirm') send();
          else goNext();
        }}
      >
        <StepIndicator step={STEP_INDEX[step]} total={3} label={STEP_LABEL[step]} />
        {step === 'amount' && (
          <AmountField
            value={amountRaw}
            onChange={(v) => setAmountRaw(sanitizeAmountInput(v))}
            quickAmounts={QUICK}
            error={touched.amount ? amountErr : undefined}
            helper={`From KSh ${DEPOSIT_MIN.toLocaleString('en-KE')} to KSh ${DEPOSIT_MAX.toLocaleString('en-KE')}`}
            label="How much do you want to add?"
          />
        )}
        {step === 'phone' && (
          <div>
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
                  ? 'This is the number on your profile. You can use a different Safaricom number.'
                  : 'The M-Pesa prompt will be sent to this number.'
              }
              className="num text-headline"
            />
          </div>
        )}
        {step === 'confirm' && (
          <div className="space-y-4">
            <SummaryList
              rows={[
                { label: 'Amount', value: formatKES(amount), strong: true },
                { label: 'M-Pesa number', value: formatPhoneDisplay(phone) },
                { label: 'Goes to', value: 'Your Step2Win wallet' },
              ]}
            />
            <Note icon={Smartphone} tone="brand">
              You&apos;ll get an M-Pesa prompt on <span className="num font-semibold text-text-primary">{formatPhoneDisplay(phone)}</span> —
              enter your PIN to approve. Step2Win will never ask for your PIN in the app.
            </Note>
          </div>
        )}
        {/* Hidden submit so Enter on the keyboard advances the step. */}
        <button type="submit" className="sr-only" tabIndex={-1} aria-hidden>
          Continue
        </button>
      </form>
    );
    footer = (
      <div className="flex gap-3 pb-3">
        {step !== 'amount' && (
          <Button
            variant="secondary"
            size="lg"
            disabled={sending}
            onClick={() => setStep(step === 'confirm' ? 'phone' : 'amount')}
            className="shrink-0"
          >
            Back
          </Button>
        )}
        {step === 'confirm' ? (
          <Button size="lg" fullWidth className="flex-1" onClick={send} isLoading={sending} loadingText="Sending prompt…">
            Send M-Pesa prompt
          </Button>
        ) : (
          <Button size="lg" fullWidth className="flex-1" onClick={goNext}>
            Continue
          </Button>
        )}
      </div>
    );
  }

  const title = state === 'idle' || state === 'sending' ? 'Add money' : 'M-Pesa deposit';
  const description = state === 'idle' || state === 'sending' ? 'Top up your wallet with M-Pesa' : undefined;

  return (
    <Sheet open={open} onClose={onClose} title={title} description={description} footer={footer} dismissible={!sending}>
      {body}
    </Sheet>
  );
}

/** "0:42" since the prompt was sent — a clear signal that we are still actively checking. */
function ElapsedTime({ since }: { since: number | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  if (!since) return null;
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  const m = Math.floor(seconds / 60);
  const s = String(seconds % 60).padStart(2, '0');
  return (
    <span className="num text-caption text-text-muted" aria-label={`${m} minutes ${s} seconds elapsed`}>
      {m}:{s}
    </span>
  );
}

export default DepositSheet;
