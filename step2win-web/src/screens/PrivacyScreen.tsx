import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  Clock3,
  Download,
  FileText,
  Home,
  MapPin,
  PencilLine,
  Scale,
  ScanSearch,
  ShieldCheck,
  Trash2,
  type LucideIcon,
} from 'lucide-react';
import { Capacitor } from '@capacitor/core';
import { ScreenHeader } from '../components/ui/ScreenHeader';
import { ListGroup, ListRow } from '../components/ui/ListRow';
import { IconTile, Pill, type Tone } from '../components/ui/Pill';
import { Sheet } from '../components/ui/Sheet';
import Button from '../components/ui/Button';
import { Skeleton } from '../components/ui/Skeleton';
import { LoadError } from '../components/ui/ErrorState';
import { toast } from '../components/ui/Toast';
import { ToggleRow } from '../components/settings/Switch';
import { DeleteAccountSheet } from '../components/settings/DeleteAccountSheet';
import { apiErrorMessage } from '../components/settings/apiError';
import { clearLocalUserData } from '../lib/accountCleanup';
import { formatDateTime } from '../lib/format';
import { shareContent } from '../lib/share';
import { useAuthStore } from '../store/authStore';
import {
  consentsQueryKey,
  exportsQueryKey,
  privacyService,
  type ConsentPurpose,
  type ConsentPurposeState,
  type ConsentStatus,
  type DataExport,
} from '../services/api/privacy';

const PURPOSE_ICON: Record<ConsentPurpose, LucideIcon> = {
  terms: Scale,
  health_data: Activity,
  location_walks: MapPin,
};

const STATUS_PILL: Record<ConsentStatus, { label: string; tone: Tone }> = {
  granted: { label: 'Given', tone: 'success' },
  outdated: { label: 'Needs update', tone: 'warning' },
  withdrawn: { label: 'Off', tone: 'neutral' },
  not_given: { label: 'Not given', tone: 'neutral' },
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function saveArchive(blob: Blob, name: string) {
  if (Capacitor.isNativePlatform()) {
    const result = await shareContent({ title: 'Your Step2Win data', text: 'Your Step2Win data', file: { blob, name } });
    if (result === 'failed') throw new Error('share failed');
    return;
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/* ───────────── Consents ───────────── */

function ConsentsSection() {
  const userId = useAuthStore((s) => s.user?.id);
  const queryClient = useQueryClient();
  const [confirmWithdraw, setConfirmWithdraw] = useState<ConsentPurposeState | null>(null);
  const [requiredInfo, setRequiredInfo] = useState<ConsentPurposeState | null>(null);
  const { data, isLoading, isError, refetch, isFetching } = useQuery({
    queryKey: consentsQueryKey(userId),
    queryFn: privacyService.getConsents,
    enabled: userId != null,
  });

  const mutation = useMutation({
    mutationFn: ({ purpose, granted }: { purpose: ConsentPurpose; granted: boolean }) =>
      privacyService.updateConsents({ [purpose]: granted }, 'settings'),
    onSuccess: (next, vars) => {
      queryClient.setQueryData(consentsQueryKey(userId), next);
      setConfirmWithdraw(null);
      toast({ message: vars.granted ? 'Consent given.' : 'Consent withdrawn.', type: 'success' });
    },
    onError: (error) => toast({ message: apiErrorMessage(error, 'Couldn’t save your choice. Try again.'), type: 'error' }),
  });

  if (isLoading) {
    return (
      <div className="space-y-2" aria-busy="true">
        <Skeleton className="h-4 w-32 rounded" />
        <Skeleton className="h-40 w-full rounded-card" />
      </div>
    );
  }
  if (isError || !data) {
    return <LoadError resource="your privacy choices" onRetry={() => void refetch()} isRetrying={isFetching} />;
  }

  const required = data.purposes.filter((p) => p.required);
  const optional = data.purposes.filter((p) => !p.required);

  return (
    <>
      <ListGroup title="What you agreed to" footer="These are needed to have an account. To withdraw them, delete your account.">
        {required.map((p) => (
          <ListRow
            key={p.purpose}
            leading={<IconTile icon={PURPOSE_ICON[p.purpose]} tone="neutral" size="sm" />}
            title={p.title}
            subtitle={p.updated_at ? `Since ${formatDateTime(p.updated_at)}` : p.description}
            trailing={<Pill tone={STATUS_PILL[p.status].tone}>{STATUS_PILL[p.status].label}</Pill>}
            onClick={() => setRequiredInfo(p)}
            chevron
          />
        ))}
      </ListGroup>

      <ListGroup title="Optional" footer="You can turn these on or off at any time. Turning one off stops that use from now on.">
        {optional.map((p) => (
          <ToggleRow
            key={p.purpose}
            leading={<IconTile icon={PURPOSE_ICON[p.purpose]} tone={p.status === 'granted' ? 'brand' : 'neutral'} size="sm" />}
            title={p.title}
            subtitle={p.status === 'outdated' ? 'Our Privacy Policy changed: turn on again to confirm.' : p.description}
            checked={p.status === 'granted'}
            disabled={mutation.isPending}
            onChange={(next) => (next ? mutation.mutate({ purpose: p.purpose, granted: true }) : setConfirmWithdraw(p))}
          />
        ))}
      </ListGroup>

      <Sheet
        open={confirmWithdraw !== null}
        onClose={() => setConfirmWithdraw(null)}
        dismissible={!mutation.isPending}
        title={confirmWithdraw ? `Turn off “${confirmWithdraw.title}”?` : ''}
        footer={
          <div className="flex flex-col gap-2">
            <Button
              fullWidth
              size="lg"
              variant="danger-soft"
              isLoading={mutation.isPending}
              loadingText="Saving"
              onClick={() => confirmWithdraw && mutation.mutate({ purpose: confirmWithdraw.purpose, granted: false })}
            >
              Turn off
            </Button>
            <Button fullWidth size="lg" variant="ghost" disabled={mutation.isPending} onClick={() => setConfirmWithdraw(null)}>
              Keep it on
            </Button>
          </div>
        }
      >
        <p className="pb-2 text-callout text-text-secondary">{confirmWithdraw?.withdraw_effect}</p>
      </Sheet>

      <Sheet
        open={requiredInfo !== null}
        onClose={() => setRequiredInfo(null)}
        title={requiredInfo?.title ?? ''}
        footer={
          <Button fullWidth size="lg" variant="secondary" onClick={() => setRequiredInfo(null)}>
            Close
          </Button>
        }
      >
        <div className="space-y-3 pb-2">
          <p className="text-callout text-text-secondary">{requiredInfo?.description}</p>
          <p className="text-callout text-text-secondary">{requiredInfo?.withdraw_effect}</p>
          {requiredInfo?.version && (
            <p className="text-caption text-text-muted">
              Policy version you accepted: <span className="num">{requiredInfo.version.replace(/;/g, ', ')}</span>
            </p>
          )}
        </div>
      </Sheet>
    </>
  );
}

/* ───────────── Export ───────────── */

function exportSubtitle(latest: DataExport | undefined, linkHours: number): string {
  if (!latest) return `A ZIP file with your account, steps, walks, challenges and payments. Ready within about 10 minutes; downloadable for ${linkHours} hours.`;
  switch (latest.status) {
    case 'pending':
    case 'running':
      return `Being prepared since ${formatDateTime(latest.requested_at)}. This usually takes a few minutes.`;
    case 'ready':
      return `Ready (${formatSize(latest.size_bytes)}). Available until ${latest.expires_at ? formatDateTime(latest.expires_at) : 'soon'}.`;
    case 'failed':
      return 'We couldn’t prepare your copy. Please ask again.';
    default:
      return 'Your last copy has expired. Ask for a new one any time.';
  }
}

function ExportSection() {
  const userId = useAuthStore((s) => s.user?.id);
  const queryClient = useQueryClient();
  const [downloading, setDownloading] = useState(false);
  const { data, isLoading } = useQuery({
    queryKey: exportsQueryKey(userId),
    queryFn: privacyService.listExports,
    enabled: userId != null,
    // Poll while a copy is being prepared.
    refetchInterval: (query) =>
      query.state.data?.exports[0] && ['pending', 'running'].includes(query.state.data.exports[0].status) ? 20_000 : false,
  });
  const latest = data?.exports[0];

  const request = useMutation({
    mutationFn: privacyService.requestExport,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: exportsQueryKey(userId) });
      toast({ message: 'We’re preparing your data. We’ll email you when it’s ready.', type: 'success' });
    },
    onError: (error) => toast({ message: apiErrorMessage(error, 'Couldn’t start your request. Try again.'), type: 'error' }),
  });

  const download = async () => {
    if (!latest?.download_path) return;
    setDownloading(true);
    try {
      const blob = await privacyService.downloadExport(latest.download_path);
      const day = (latest.finished_at ?? latest.requested_at).slice(0, 10).replace(/-/g, '');
      await saveArchive(blob, `step2win-my-data-${day}.zip`);
    } catch (error) {
      toast({ message: apiErrorMessage(error, 'Download failed. Try again.'), type: 'error' });
      void queryClient.invalidateQueries({ queryKey: exportsQueryKey(userId) });
    } finally {
      setDownloading(false);
    }
  };

  const busy = latest?.status === 'pending' || latest?.status === 'running';
  const ready = latest?.status === 'ready' && !!latest.download_path;

  return (
    <ListGroup title="Your data" footer="Only you can download your copy, from this signed-in app.">
      <div className="flex items-start gap-3 px-4 py-3">
        <IconTile icon={Download} tone={ready ? 'brand' : 'neutral'} size="sm" />
        <div className="min-w-0 flex-1">
          <p className="text-body font-medium text-text-primary">Download a copy of your data</p>
          {isLoading ? (
            <Skeleton className="mt-1.5 h-3 w-48 rounded" />
          ) : (
            <p className="mt-0.5 text-caption text-text-muted">{exportSubtitle(latest, data?.link_hours ?? 72)}</p>
          )}
          <div className="mt-3">
            {ready ? (
              <Button size="sm" leftIcon={<Download size={16} aria-hidden />} isLoading={downloading} loadingText="Downloading" onClick={() => void download()}>
                Download ZIP
              </Button>
            ) : busy ? (
              <Pill tone="info" icon={Clock3}>
                Preparing
              </Pill>
            ) : (
              <Button size="sm" variant="secondary" isLoading={request.isPending} loadingText="Requesting" disabled={isLoading} onClick={() => request.mutate()}>
                Request my data
              </Button>
            )}
          </div>
        </div>
      </div>
    </ListGroup>
  );
}

/* ───────────── Retention ───────────── */

function RetentionSection() {
  const { data, isLoading } = useQuery({ queryKey: ['privacy', 'summary'], queryFn: privacyService.getSummary, staleTime: 60 * 60_000 });
  if (isLoading) return <Skeleton className="h-40 w-full rounded-card" />;
  if (!data) return null;
  return (
    <ListGroup title="How long we keep it">
      {data.retention.map((item) => (
        <div key={item.key} className="px-4 py-3">
          <p className="text-callout font-medium text-text-primary">{item.title}</p>
          <p className="mt-0.5 text-caption text-text-muted">{item.text}</p>
        </div>
      ))}
    </ListGroup>
  );
}

/* ───────────── Screen ───────────── */

export default function PrivacyScreen() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const logout = useAuthStore((s) => s.logout);
  const userId = useAuthStore((s) => s.user?.id);
  const [deleteOpen, setDeleteOpen] = useState(false);

  // Same clean-up as Settings › Delete account.
  const onAccountDeleted = useCallback(async () => {
    await clearLocalUserData(userId);
    await logout();
    queryClient.clear();
    toast({ message: 'Your account has been deleted.', type: 'success' });
    navigate('/login', { replace: true });
  }, [userId, logout, navigate, queryClient]);

  return (
    <div className="pb-nav">
      <ScreenHeader title="Privacy & your data" back />
      <div className="mx-auto w-full max-w-2xl space-y-6 px-5 pb-8 pt-2">
        <p className="text-callout text-text-secondary">
          See what you agreed to, change optional choices, get a copy of your data or delete it. Step2Win never sells your data
          or uses it for ads.
        </p>

        <ConsentsSection />
        <ExportSection />

        <ListGroup title="Manage">
          <ListRow
            leading={<IconTile icon={PencilLine} tone="neutral" size="sm" />}
            title="Correct your details"
            subtitle="Name, email and phone in Settings › Personal details"
            to="/settings"
          />
          <ListRow
            leading={<IconTile icon={Home} tone="neutral" size="sm" />}
            title="Home privacy zone"
            subtitle="Hide the ends of your walk routes near home (Settings › Privacy)"
            to="/settings"
          />
          <ListRow
            leading={<IconTile icon={Trash2} tone="danger" size="sm" />}
            title="Delete your account"
            subtitle="Removes your personal data; money records are kept without your contact details"
            destructive
            chevron
            onClick={() => setDeleteOpen(true)}
          />
        </ListGroup>

        <ListGroup
          title="Automated checks"
          footer="You can ask for a person to review any decision about your steps or a payout: open Help & support."
        >
          <div className="flex items-start gap-3 px-4 py-3">
            <IconTile icon={ScanSearch} tone="neutral" size="sm" />
            <p className="min-w-0 flex-1 text-caption text-text-secondary">
              To keep challenges fair, automated checks look at how your steps were recorded (for example walking rhythm, speed and
              device signals) and whether accounts share a phone or payout number. They can lower how many steps count toward
              challenge money or hold a payout for a staff review, usually within 48 hours. They never close an account on their
              own, and they never change your goals, streaks or XP.
            </p>
          </div>
        </ListGroup>

        <RetentionSection />

        <ListGroup title="Documents">
          <ListRow leading={<IconTile icon={ShieldCheck} tone="neutral" size="sm" />} title="Privacy Policy" to="/legal/privacy-policy" />
          <ListRow leading={<IconTile icon={FileText} tone="neutral" size="sm" />} title="Terms and Conditions" to="/legal/terms-and-conditions" />
          <ListRow leading={<IconTile icon={Scale} tone="neutral" size="sm" />} title="Fair play and payout reviews" to="/legal/fair-play-rules" />
        </ListGroup>
      </div>

      <DeleteAccountSheet open={deleteOpen} onClose={() => setDeleteOpen(false)} onDeleted={onAccountDeleted} />
    </div>
  );
}
