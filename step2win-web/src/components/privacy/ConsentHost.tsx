import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { create } from 'zustand';
import { FileText, LogOut, MapPin, ShieldCheck } from 'lucide-react';
import { Sheet } from '../ui/Sheet';
import { Button } from '../ui/Button';
import { IconTile } from '../ui/Pill';
import { toast } from '../ui/Toast';
import { LegalSheet, type LegalSlug } from '../auth/LegalSheet';
import { ConsentCheckbox, ConsentLink } from './ConsentCheckbox';
import { useAuthStore } from '../../store/authStore';
import {
  consentsQueryKey,
  privacyService,
  type ConsentOverview,
  type ConsentPurpose,
  type ConsentSource,
} from '../../services/api/privacy';

/* ───────────── Imperative prompt for optional consents ───────────── */

type OptionalPurpose = Extract<ConsentPurpose, 'location_walks'>;

interface PromptState {
  pending: { purpose: OptionalPurpose; source: ConsentSource; resolve: (granted: boolean) => void } | null;
  open: (p: NonNullable<PromptState['pending']>) => void;
  close: () => void;
}

const usePromptStore = create<PromptState>((set) => ({
  pending: null,
  open: (pending) => set({ pending }),
  close: () => set({ pending: null }),
}));

let queryClientRef: ReturnType<typeof useQueryClient> | null = null;

/**
 * Ask for an optional consent before a feature that needs it. Resolves `true` when the
 * user has (or now gives) the consent, `false` when they choose "Not now".
 * Needs <ConsentHost /> mounted once (App.tsx).
 *
 *   // Phase 1b walk start button:
 *   onClick={() => void requestConsent('location_walks').then((ok) => ok && startNewWalk())}
 */
export async function requestConsent(purpose: OptionalPurpose, source: ConsentSource = 'walk_start'): Promise<boolean> {
  try {
    const overview = await (queryClientRef?.fetchQuery({
      queryKey: consentsQueryKey(useAuthStore.getState().user?.id),
      queryFn: privacyService.getConsents,
      staleTime: 60_000,
    }) ?? privacyService.getConsents());
    if (overview.purposes.find((p) => p.purpose === purpose)?.status === 'granted') return true;
  } catch {
    // Offline or server asleep: ask anyway; saving the answer will retry the network.
  }
  // Only one prompt at a time: a second request answers "not now" to the first.
  usePromptStore.getState().pending?.resolve(false);
  return new Promise<boolean>((resolve) => usePromptStore.getState().open({ purpose, source, resolve }));
}

const PROMPT_COPY: Record<OptionalPurpose, { title: string; points: string[]; allow: string }> = {
  location_walks: {
    title: 'Use your location during walks?',
    points: [
      'Step2Win records your route only while a walk you started is running. It stops when you finish.',
      'Never in the background, never sold, never shown to other users. Your home privacy zone hides the ends of your routes.',
      'Raw GPS points are deleted after 30 days; the simplified route stays in your walk history.',
      'You can change this any time in Settings › Privacy & your data. Your phone will also ask for location permission.',
    ],
    allow: 'Allow during walks',
  },
};

function PurposePrompt() {
  const pending = usePromptStore((s) => s.pending);
  const close = usePromptStore((s) => s.close);
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);
  const [policy, setPolicy] = useState<LegalSlug | null>(null);

  if (!pending) return null;
  const copy = PROMPT_COPY[pending.purpose];

  const answer = async (granted: boolean) => {
    if (!granted) {
      pending.resolve(false);
      close();
      return;
    }
    setSaving(true);
    try {
      const overview = await privacyService.updateConsents({ [pending.purpose]: true }, pending.source);
      queryClient.setQueryData(consentsQueryKey(useAuthStore.getState().user?.id), overview);
      pending.resolve(true);
      close();
    } catch {
      toast({ message: 'Couldn’t save your choice. Check your connection and try again.', type: 'error' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Sheet
        open
        onClose={() => void answer(false)}
        dismissible={!saving}
        title={copy.title}
        footer={
          <div className="flex flex-col gap-2">
            <Button fullWidth size="lg" isLoading={saving} loadingText="Saving" onClick={() => void answer(true)}>
              {copy.allow}
            </Button>
            <Button fullWidth size="lg" variant="ghost" disabled={saving} onClick={() => void answer(false)}>
              Not now
            </Button>
          </div>
        }
      >
        <div className="flex items-start gap-3 pb-2">
          <IconTile icon={MapPin} tone="brand" />
          <ul className="min-w-0 flex-1 space-y-2">
            {copy.points.map((p) => (
              <li key={p} className="text-callout text-text-secondary">
                {p}
              </li>
            ))}
          </ul>
        </div>
        <p className="pt-1 text-caption text-text-muted">
          Details in our <ConsentLink onClick={() => setPolicy('privacy-policy')}>Privacy Policy</ConsentLink>.
        </p>
      </Sheet>
      <LegalSheet slug={policy} onClose={() => setPolicy(null)} />
    </>
  );
}

/* ───────────── Required consents: first sign-in and policy updates ───────────── */

function RequiredConsentGate({ overview }: { overview: ConsentOverview }) {
  const queryClient = useQueryClient();
  const logout = useAuthStore((s) => s.logout);
  const [terms, setTerms] = useState(false);
  const [health, setHealth] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [doc, setDoc] = useState<LegalSlug | null>(null);

  const missing = new Set(overview.missing);
  const needTerms = missing.has('terms');
  const needHealth = missing.has('health_data');
  // Someone who accepted before has seen an update; a new Google/Apple sign-up has not.
  const isUpdate = overview.purposes.some((p) => p.required && p.status === 'outdated');
  const summary = [overview.documents.privacy.change_summary, overview.documents.terms.change_summary]
    .filter(Boolean)
    .join(' ');

  const ready = (!needTerms || terms) && (!needHealth || health);

  const accept = async () => {
    setSubmitted(true);
    if (!ready) return;
    setSaving(true);
    try {
      const changes: Partial<Record<ConsentPurpose, boolean>> = {};
      if (needTerms) changes.terms = true;
      if (needHealth) changes.health_data = true;
      const next = await privacyService.updateConsents(changes, isUpdate ? 'reconsent' : 'social_signup');
      queryClient.setQueryData(consentsQueryKey(useAuthStore.getState().user?.id), next);
    } catch {
      toast({ message: 'Couldn’t save your choice. Check your connection and try again.', type: 'error' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Sheet
        open
        onClose={() => undefined}
        dismissible={false}
        hideCloseButton
        title={isUpdate ? 'We’ve updated our policies' : 'Before you start'}
        description={
          isUpdate
            ? 'Please review the changes and confirm to keep using Step2Win.'
            : 'Step2Win needs your agreement to run your account.'
        }
        footer={
          <div className="flex flex-col gap-2">
            <Button fullWidth size="lg" isLoading={saving} loadingText="Saving" onClick={() => void accept()}>
              Agree and continue
            </Button>
            <Button
              fullWidth
              size="lg"
              variant="ghost"
              leftIcon={<LogOut size={18} aria-hidden />}
              disabled={saving}
              onClick={() => void logout()}
            >
              Sign out
            </Button>
          </div>
        }
      >
        <div className="space-y-3 pb-2">
          {isUpdate && summary && (
            <div className="flex items-start gap-3 rounded-control bg-bg-input p-3">
              <FileText size={18} className="mt-0.5 shrink-0 text-text-secondary" aria-hidden />
              <p className="text-callout text-text-secondary">{summary}</p>
            </div>
          )}
          {needTerms && (
            <ConsentCheckbox
              checked={terms}
              onChange={setTerms}
              error={submitted && !terms ? 'Please tick this box to continue.' : undefined}
            >
              I am 18 or older and I agree to the{' '}
              <ConsentLink onClick={() => setDoc('terms-and-conditions')}>Terms</ConsentLink> and the{' '}
              <ConsentLink onClick={() => setDoc('privacy-policy')}>Privacy Policy</ConsentLink>.
            </ConsentCheckbox>
          )}
          {needHealth && (
            <ConsentCheckbox
              checked={health}
              onChange={setHealth}
              description="Your steps and your phone’s motion data are used to count your steps, run challenges and keep them fair. Kept while your account is open."
              error={submitted && !health ? 'Please tick this box to continue.' : undefined}
            >
              I allow Step2Win to process my activity and health data (steps and motion).
            </ConsentCheckbox>
          )}
          <p className="flex items-start gap-2 pt-1 text-caption text-text-muted">
            <ShieldCheck size={14} className="mt-0.5 shrink-0" aria-hidden />
            You can see, download or delete your data any time in Settings › Privacy &amp; your data.
          </p>
        </div>
      </Sheet>
      <LegalSheet slug={doc} onClose={() => setDoc(null)} />
    </>
  );
}

/**
 * Mount once inside the router and QueryClientProvider. Shows the required-consent gate
 * to signed-in users who haven't accepted the current Terms / Privacy Policy (new
 * Google/Apple sign-ups, older accounts, material policy updates) and hosts the
 * `requestConsent()` prompt.
 */
export function ConsentHost() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const userId = useAuthStore((s) => s.user?.id);
  const queryClient = useQueryClient();
  useEffect(() => {
    queryClientRef = queryClient;
    return () => {
      queryClientRef = null;
    };
  }, [queryClient]);

  const { data } = useQuery({
    queryKey: consentsQueryKey(userId),
    queryFn: privacyService.getConsents,
    enabled: isAuthenticated && userId != null,
    staleTime: 10 * 60_000,
    retry: 1,
  });

  if (!isAuthenticated) return null;
  return (
    <>
      {data?.needs_consent ? <RequiredConsentGate overview={data} /> : null}
      <PurposePrompt />
    </>
  );
}
