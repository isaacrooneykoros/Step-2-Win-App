import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Globe, LogOut, Monitor, ShieldAlert, Smartphone, type LucideIcon } from 'lucide-react';
import { authService } from '../services/api';
import { useAuthStore } from '../store/authStore';
import { formatRelativeTime, formatShortDate } from '../lib/format';
import { ScreenHeader } from '../components/ui/ScreenHeader';
import { ListGroup } from '../components/ui/ListRow';
import { IconTile, Pill } from '../components/ui/Pill';
import Button from '../components/ui/Button';
import { Sheet } from '../components/ui/Sheet';
import { Skeleton } from '../components/ui/Skeleton';
import { EmptyState } from '../components/ui/EmptyState';
import { LoadError } from '../components/ui/ErrorState';
import { useToast } from '../components/ui/Toast';
import { apiErrorMessage } from '../components/settings/apiError';

interface DeviceSession {
  id: string;
  device_name: string;
  device_type: 'android' | 'ios' | 'web' | 'unknown';
  ip_address: string | null;
  last_active_at: string;
  created_at: string;
  is_current: boolean;
}

const deviceIcon: Record<string, LucideIcon> = {
  android: Smartphone,
  ios: Smartphone,
  web: Monitor,
  unknown: Globe,
};

function deviceLabel(session: DeviceSession) {
  if (session.device_name && session.device_name !== 'Unknown') return session.device_name;
  if (session.device_type === 'android') return 'Android phone';
  if (session.device_type === 'ios') return 'iPhone';
  if (session.device_type === 'web') return 'Web browser';
  return 'Unknown device';
}

const PREVIEW_COUNT = 8;

type Confirm = { kind: 'one'; session: DeviceSession } | { kind: 'all'; count: number } | null;

export default function ActiveSessionsScreen() {
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const sessionId = useAuthStore((state) => state.sessionId);
  const getRefreshToken = useAuthStore((state) => state.getRefreshToken);
  const [confirm, setConfirmState] = useState<Confirm>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  // Keep the last target while the sheet animates out so its copy doesn't flicker.
  const setConfirm = (next: Confirm) => {
    if (next) setConfirmState(next);
    setConfirmOpen(next !== null);
  };

  const sessionsQuery = useQuery<DeviceSession[]>({
    queryKey: ['sessions'],
    queryFn: authService.getActiveSessions,
  });

  const revokeMutation = useMutation({
    mutationFn: (id: string) => authService.revokeSession(id),
    onSuccess: (_data, id) => {
      const session = sessionsQuery.data?.find((s) => s.id === id);
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
      setConfirm(null);
      showToast({ message: `${session ? deviceLabel(session) : 'Device'} has been signed out.`, type: 'success' });
    },
    onError: (error: unknown) => {
      showToast({ message: apiErrorMessage(error, 'We couldn’t sign out that device. Please try again.'), type: 'error' });
    },
  });

  const revokeAllMutation = useMutation({
    mutationFn: async () => authService.revokeAllSessions((await getRefreshToken()) ?? undefined),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
      setConfirm(null);
      showToast({ message: 'All other devices have been signed out.', type: 'success' });
    },
    onError: (error: unknown) => {
      showToast({ message: apiErrorMessage(error, 'We couldn’t sign out your other devices. Please try again.'), type: 'error' });
    },
  });

  const sessions = sessionsQuery.data ?? [];
  const isCurrent = (s: DeviceSession) => s.is_current || (!!sessionId && s.id === sessionId);
  const current = sessions.find(isCurrent);
  const others = sessions.filter((s) => !isCurrent(s));
  const visibleOthers = showAll ? others : others.slice(0, PREVIEW_COUNT);
  const hiddenCount = others.length - visibleOthers.length;
  const pending = revokeMutation.isPending || revokeAllMutation.isPending;

  return (
    <div className="pb-nav">
      <ScreenHeader title="Active sessions" back />

      <div className="mx-auto w-full max-w-2xl space-y-6 px-5 pb-8 pt-2">
        <div className="flex gap-3 rounded-card bg-bg-sunken p-4">
          <IconTile icon={ShieldAlert} tone="info" size="sm" />
          <p className="text-callout text-text-secondary">
            These are the devices signed in to your account. If you don’t recognise one, sign it out and change your password.
          </p>
        </div>

        {sessionsQuery.isLoading ? (
          <div className="overflow-hidden rounded-card border border-border-light bg-bg-card" aria-busy="true" aria-label="Loading sessions">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex items-center gap-3 border-b border-border-light px-4 py-4 last:border-b-0">
                <Skeleton className="h-10 w-10 rounded-xl" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-32 rounded" />
                  <Skeleton className="h-3 w-44 rounded" />
                </div>
              </div>
            ))}
          </div>
        ) : sessionsQuery.isError ? (
          <LoadError resource="your sessions" onRetry={() => sessionsQuery.refetch()} isRetrying={sessionsQuery.isFetching} />
        ) : sessions.length === 0 ? (
          <EmptyState icon={Smartphone} title="No active sessions" description="Devices you sign in on will appear here." />
        ) : (
          <>
            {current && (
              <section aria-labelledby="this-device" className="rounded-card border border-border-light bg-bg-card p-4 shadow-card">
                <div className="flex items-center gap-3">
                  <IconTile icon={deviceIcon[current.device_type] ?? Globe} tone="brand" size="lg" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <h2 id="this-device" className="truncate text-headline text-text-primary">
                        {deviceLabel(current)}
                      </h2>
                      <Pill tone="brand" dot="live">
                        This device
                      </Pill>
                    </div>
                    <p className="mt-0.5 text-caption text-text-muted">
                      Active now{current.ip_address ? ` · ${current.ip_address}` : ''} · signed in {formatShortDate(current.created_at)}
                    </p>
                  </div>
                </div>
              </section>
            )}

            {others.length > 0 ? (
              <ListGroup
                title={`Other devices · ${others.length}`}
                footer={
                  hiddenCount > 0 ? (
                    <button type="button" onClick={() => setShowAll(true)} className="inline-flex min-h-[44px] items-center font-semibold text-brand">
                      Show {hiddenCount} more
                    </button>
                  ) : (
                    'Last active is when each device last reached Step2Win.'
                  )
                }
              >
                {visibleOthers.map((session) => (
                  <div key={session.id} className="flex min-h-[64px] items-center gap-3 px-4 py-3">
                    <IconTile icon={deviceIcon[session.device_type] ?? Globe} tone="neutral" size="sm" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-body font-medium text-text-primary">{deviceLabel(session)}</p>
                      <p className="mt-0.5 truncate text-caption text-text-muted">
                        Active {formatRelativeTime(session.last_active_at)}
                        {session.ip_address ? ` · ${session.ip_address}` : ''}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="!h-11 shrink-0 !text-danger"
                      onClick={() => setConfirm({ kind: 'one', session })}
                      aria-label={`Sign out ${deviceLabel(session)}, active ${formatRelativeTime(session.last_active_at)}`}
                    >
                      Sign out
                    </Button>
                  </div>
                ))}
              </ListGroup>
            ) : (
              <p className="px-1 text-callout text-text-secondary">You’re not signed in anywhere else.</p>
            )}

            {others.length > 0 && (
              <Button variant="danger-soft" size="lg" fullWidth leftIcon={<LogOut size={18} aria-hidden />} onClick={() => setConfirm({ kind: 'all', count: others.length })}>
                Sign out all other devices
              </Button>
            )}
          </>
        )}
      </div>

      <Sheet
        open={confirmOpen}
        onClose={() => setConfirm(null)}
        dismissible={!pending}
        size="sm"
        title={confirm?.kind === 'all' ? `Sign out ${confirm.count} other ${confirm.count === 1 ? 'device' : 'devices'}?` : 'Sign out this device?'}
        description={
          confirm?.kind === 'one'
            ? `${deviceLabel(confirm.session)} will need to sign in again to use your account.`
            : 'Every device except this one will need to sign in again. This can’t be undone.'
        }
        footer={
          <div className="flex gap-3 pb-3">
            <Button variant="secondary" fullWidth onClick={() => setConfirm(null)} disabled={pending}>
              Cancel
            </Button>
            <Button
              variant="danger"
              fullWidth
              isLoading={pending}
              loadingText="Signing out"
              onClick={() => {
                if (confirm?.kind === 'one') revokeMutation.mutate(confirm.session.id);
                else if (confirm?.kind === 'all') revokeAllMutation.mutate();
              }}
            >
              Sign out
            </Button>
          </div>
        }
      >
        {confirm?.kind === 'one' ? (
          <p className="text-caption text-text-muted">
            Last active {formatRelativeTime(confirm.session.last_active_at)}
            {confirm.session.ip_address ? ` from ${confirm.session.ip_address}` : ''}.
          </p>
        ) : null}
      </Sheet>
    </div>
  );
}
