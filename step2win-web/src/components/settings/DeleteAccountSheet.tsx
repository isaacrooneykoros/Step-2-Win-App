import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Eye, EyeOff, Trash2, Wallet, Trophy, Clock3, ShieldAlert } from 'lucide-react';
import { authService } from '../../services/api';
import type { AccountDeletionBlocker } from '../../services/api/auth';
import { authenticateUser, isLockEnabled } from '../../lib/biometricLock';
import { Sheet } from '../ui/Sheet';
import Button from '../ui/Button';
import Input from '../ui/Input';
import { IconTile } from '../ui/Pill';
import { Skeleton } from '../ui/Skeleton';
import { ErrorInline } from '../ui/ErrorState';
import { apiErrorMessage } from './apiError';

interface DeleteAccountSheetProps {
  open: boolean;
  onClose: () => void;
  /** Runs after the server confirms deletion: clear local data, sign out, go to /login. */
  onDeleted: () => Promise<void> | void;
}

type Step = 'review' | 'confirm' | 'done';

const BLOCKER_LINKS: Record<string, { to: string; label: string; icon: typeof Wallet }> = {
  wallet_balance: { to: '/wallet', label: 'Go to Wallet to withdraw', icon: Wallet },
  withdrawal_pending: { to: '/wallet', label: 'Check your withdrawal', icon: Clock3 },
  payment_pending: { to: '/wallet', label: 'Check your wallet', icon: Clock3 },
  active_challenge: { to: '/challenges', label: 'View your challenges', icon: Trophy },
};

const DELETED = [
  'Your username, email, phone number and name',
  'Your profile photo',
  'Step, health and location (GPS) data',
  'Device registrations and every signed-in session',
  'Links to Google or Apple sign-in',
];

const KEPT = [
  'Wallet transactions, M-Pesa payments and withdrawals',
  'Challenge entries and results',
  'Fraud-prevention, audit and support records',
];

/** Settings → Delete account: eligibility → explanation → re-authentication → done. */
export function DeleteAccountSheet({ open, onClose, onDeleted }: DeleteAccountSheetProps) {
  const [step, setStep] = useState<Step>('review');
  const [password, setPassword] = useState('');
  const [confirmText, setConfirmText] = useState('');
  const [reveal, setReveal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);

  const eligibility = useQuery({
    queryKey: ['account-deletion-eligibility'],
    queryFn: authService.getAccountDeletionEligibility,
    enabled: open,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });

  const mutation = useMutation({
    mutationFn: authService.deleteAccount,
    onSuccess: () => setStep('done'),
    onError: (err: unknown) => {
      setError(apiErrorMessage(err, 'We couldn’t delete your account. Check your connection and try again.'));
      void eligibility.refetch();
    },
  });

  // Reset whenever the sheet opens.
  useEffect(() => {
    if (!open) return;
    setStep('review');
    setPassword('');
    setConfirmText('');
    setError(null);
    setReveal(false);
  }, [open]);

  // Final state: give the confirmation a moment to register, then sign out (once).
  const finished = useRef(false);
  const finish = useCallback(() => {
    if (finished.current) return;
    finished.current = true;
    void onDeleted();
  }, [onDeleted]);
  useEffect(() => {
    if (step !== 'done') return;
    const timer = window.setTimeout(finish, 2200);
    return () => window.clearTimeout(timer);
  }, [step, finish]);

  const data = eligibility.data;
  const confirmWord = data?.confirm_word ?? 'DELETE';
  const busy = mutation.isPending || verifying;

  const close = () => {
    if (busy || step === 'done') return;
    onClose();
  };

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!data || busy) return;
    setError(null);
    if (data.requires_password && !password) {
      setError('Enter your current password.');
      return;
    }
    if (!data.requires_password && confirmText.trim() !== confirmWord) {
      setError(`Type ${confirmWord} in capital letters to confirm.`);
      return;
    }
    if (isLockEnabled()) {
      setVerifying(true);
      const result = await authenticateUser('Confirm account deletion', 'Use your fingerprint, face or screen lock');
      setVerifying(false);
      if (!result.ok) {
        setError(result.message);
        return;
      }
    }
    mutation.mutate(data.requires_password ? { password } : { confirm: confirmText.trim() });
  };

  const blockers = data?.blockers ?? [];
  let body;
  let footer;

  if (step === 'done') {
    body = (
      <div className="flex flex-col items-center py-6 text-center" role="status" aria-live="polite">
        <IconTile icon={CheckCircle2} tone="success" size="lg" />
        <h3 className="mt-4 text-headline text-text-primary">Your account has been deleted</h3>
        <p className="mt-2 text-callout text-text-secondary">
          Your personal details have been removed and you’ve been signed out everywhere. Thanks for walking with us.
        </p>
      </div>
    );
    footer = (
      <div className="pb-3">
        <Button fullWidth onClick={finish}>
          Continue
        </Button>
      </div>
    );
  } else if (eligibility.isLoading) {
    body = (
      <div className="space-y-3" aria-busy="true" aria-label="Checking your account">
        <Skeleton className="h-5 w-3/4" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  } else if (eligibility.isError || !data) {
    body = (
      <ErrorInline
        message={apiErrorMessage(eligibility.error, 'We couldn’t check your account. Check your connection and try again.')}
        onRetry={() => void eligibility.refetch()}
      />
    );
    footer = (
      <div className="pb-3">
        <Button variant="secondary" fullWidth onClick={close}>
          Close
        </Button>
      </div>
    );
  } else if (!data.eligible) {
    body = <BlockerList blockers={blockers} onNavigate={onClose} />;
    footer = (
      <div className="pb-3">
        <Button variant="secondary" fullWidth onClick={close}>
          Close
        </Button>
      </div>
    );
  } else if (step === 'review') {
    body = (
      <div className="space-y-5">
        <div className="flex gap-3 rounded-control bg-danger-soft p-4 text-danger">
          <AlertTriangle size={20} className="mt-0.5 shrink-0" aria-hidden />
          <p className="text-callout">
            <span className="font-semibold">This can’t be undone.</span> You won’t be able to sign in again or recover your
            history. Signing up later creates a brand-new account.
          </p>
        </div>
        <section>
          <h3 className="eyebrow mb-2">What we delete</h3>
          <ul className="list-disc space-y-1 pl-5 text-callout text-text-secondary">
            {DELETED.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>
        <section>
          <h3 className="eyebrow mb-2">What we keep, anonymised</h3>
          <ul className="list-disc space-y-1 pl-5 text-callout text-text-secondary">
            {KEPT.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <p className="mt-2 text-caption text-text-muted">
            These no longer show your name or contact details. We keep them to meet financial record-keeping and tax rules.
          </p>
        </section>
      </div>
    );
    footer = (
      <div className="flex gap-3 pb-3">
        <Button variant="secondary" fullWidth onClick={close}>
          Cancel
        </Button>
        <Button variant="danger" fullWidth onClick={() => setStep('confirm')}>
          Continue
        </Button>
      </div>
    );
  } else {
    const toggle = (
      <button
        type="button"
        onClick={() => setReveal((v) => !v)}
        className="inline-flex h-10 w-10 items-center justify-center rounded-full text-text-muted hover:bg-bg-input"
        aria-label={reveal ? 'Hide password' : 'Show password'}
        aria-pressed={reveal}
      >
        {reveal ? <EyeOff size={18} /> : <Eye size={18} />}
      </button>
    );
    body = (
      <form onSubmit={submit} noValidate className="space-y-2">
        {data.requires_password ? (
          <Input
            label="Current password"
            type={reveal ? 'text' : 'password'}
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            trailing={toggle}
            error={error ?? undefined}
            autoFocus
          />
        ) : (
          <Input
            label={`Type ${confirmWord} to confirm`}
            helperText={`You signed in with ${providerLabel(data.social_providers)}, so there’s no password to check.`}
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            error={error ?? undefined}
            autoFocus
          />
        )}
        {isLockEnabled() ? (
          <p className="flex items-center gap-2 text-caption text-text-muted">
            <ShieldAlert size={14} aria-hidden /> You’ll also confirm with your fingerprint, face or screen lock.
          </p>
        ) : null}
        <p className="text-caption text-text-muted">Your account is deleted immediately. This can’t be undone.</p>
      </form>
    );
    footer = (
      <div className="flex gap-3 pb-3">
        <Button variant="secondary" fullWidth onClick={() => setStep('review')} disabled={busy}>
          Back
        </Button>
        <Button
          variant="danger"
          fullWidth
          onClick={() => void submit()}
          isLoading={busy}
          loadingText={verifying ? 'Confirming' : 'Deleting'}
          leftIcon={<Trash2 size={18} aria-hidden />}
        >
          Delete account
        </Button>
      </div>
    );
  }

  const title =
    step === 'done' ? undefined : data && !data.eligible ? 'You can’t delete your account yet' : step === 'confirm' ? 'Confirm it’s you' : 'Delete your account?';
  const description =
    step === 'done' || !data
      ? undefined
      : !data.eligible
        ? 'Sort out the items below first. Your account stays open until you do.'
        : step === 'confirm'
          ? data.requires_password
            ? 'Enter your password to permanently delete your Step2Win account.'
            : undefined
          : 'Your account and personal data will be permanently removed.';

  return (
    <Sheet
      open={open}
      onClose={close}
      dismissible={!busy && step !== 'done'}
      hideCloseButton={step === 'done'}
      size="md"
      title={title}
      description={description}
      footer={footer}
    >
      {body}
    </Sheet>
  );
}

function providerLabel(providers: string[]) {
  if (providers.includes('apple') && providers.includes('google')) return 'Google or Apple';
  if (providers.includes('apple')) return 'Apple';
  if (providers.includes('google')) return 'Google';
  return 'a sign-in provider';
}

function BlockerList({ blockers, onNavigate }: { blockers: AccountDeletionBlocker[]; onNavigate: () => void }) {
  return (
    <ul className="space-y-3">
      {blockers.map((blocker) => {
        const link = BLOCKER_LINKS[blocker.code];
        return (
          <li key={blocker.code} className="flex gap-3 rounded-control border border-border-light bg-bg-sunken p-4">
            <IconTile icon={link?.icon ?? AlertTriangle} tone="warning" size="sm" />
            <div className="min-w-0 flex-1">
              <p className="text-callout text-text-primary">{blocker.message}</p>
              {link ? (
                <Link to={link.to} onClick={onNavigate} className="mt-2 inline-flex min-h-[44px] items-center text-callout font-semibold text-brand">
                  {link.label}
                </Link>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export default DeleteAccountSheet;
