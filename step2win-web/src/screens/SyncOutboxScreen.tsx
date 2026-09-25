import { useCallback, useEffect, useMemo, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, CloudOff, Footprints, RefreshCw, Route, UploadCloud, type LucideIcon } from 'lucide-react';
import api from '../services/api/client';
import { useAuthStore } from '../store/authStore';
import { useHealthSync } from '../hooks/useHealthSync';
import { listOutboxItems, type SyncOutboxItem } from '../services/offlineSyncOutbox';
import { DeviceStepCounter, type NativeSyncStatusReport } from '../plugins/deviceStepCounter';
import { useSyncState } from '../services/stepSyncCoordinator';
import { isAndroidApp } from '../utils/platform';
import { formatDateTime, formatRelativeTime, formatSteps } from '../lib/format';
import { ScreenHeader, IconButton } from '../components/ui/ScreenHeader';
import { ListGroup } from '../components/ui/ListRow';
import { IconTile, Pill } from '../components/ui/Pill';
import { StatTile } from '../components/ui/StatTile';
import Button from '../components/ui/Button';
import { useToast } from '../components/ui/Toast';
import { usePollInterval } from '../hooks/useDataSaver';

interface DeviceStatus {
  last_sync: string | null;
  last_sync_time: string | null;
}

function dayLabel(date: unknown) {
  if (typeof date !== 'string' || !date) return 'Queued update';
  const d = new Date(`${date}T00:00:00`);
  if (Number.isNaN(d.getTime())) return date;
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

/** Android: a day the phone counted but the server hasn't confirmed yet (native ledger). */
function nativePendingAsItems(status: NativeSyncStatusReport | undefined): SyncOutboxItem[] {
  if (!status?.pending?.length) return [];
  const at = status.lastAttemptAt || status.lastReadingAt || new Date().toISOString();
  return status.pending.map((day) => ({
    id: `native-${day.date}`,
    queueKey: `native:${day.date}`,
    userId: 0,
    kind: 'health' as const,
    payload: { date: day.date, steps: day.steps, acked_steps: day.ackedSteps, next_attempt_at: day.nextAttemptAt },
    idempotencyKey: `day-${day.date}`,
    retryCount: day.retries,
    createdAt: at,
    updatedAt: at,
  }));
}

/** What's in a queued item, in plain words. */
function describeItem(item: SyncOutboxItem): { icon: LucideIcon; title: string; detail: string } {
  if (item.kind === 'health') {
    const steps = Number(item.payload?.steps ?? 0);
    const distance = Number(item.payload?.distance_km ?? 0);
    const activeMinutes = Number(item.payload?.active_minutes ?? 0);
    const calories = Number(item.payload?.calories_active ?? 0);
    const parts = [`${formatSteps(steps)} steps`];
    if (distance > 0) parts.push(`${distance.toFixed(2)} km`);
    if (activeMinutes > 0) parts.push(`${activeMinutes} active min`);
    if (calories > 0) parts.push(`${calories} kcal`);
    const acked = Number(item.payload?.acked_steps ?? NaN);
    if (Number.isFinite(acked) && acked > 0) parts.push(`${formatSteps(acked)} already on your account`);
    return { icon: Footprints, title: `Daily steps · ${dayLabel(item.payload?.date)}`, detail: parts.join(' · ') };
  }
  const hourly = Array.isArray(item.payload?.hourly) ? item.payload.hourly : [];
  const waypoints = Array.isArray(item.payload?.waypoints) ? item.payload.waypoints.length : 0;
  const steps = hourly.reduce((sum: number, entry: any) => sum + (Number(entry?.steps) || 0), 0);
  return {
    icon: Route,
    title: `Hourly steps & route · ${dayLabel(item.payload?.date)}`,
    detail: `${formatSteps(steps)} steps over ${hourly.length} hour${hourly.length === 1 ? '' : 's'} · ${waypoints} route point${waypoints === 1 ? '' : 's'}`,
  };
}

function useOnline() {
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}

export default function SyncOutboxScreen() {
  const storeUserId = useAuthStore((state) => state.user?.id);
  const { syncHealthNow, isSyncing } = useHealthSync();
  const { showToast } = useToast();
  const isOnline = useOnline();
  const isNativeApp = Capacitor.isNativePlatform() && ['android', 'ios'].includes(Capacitor.getPlatform());
  const nativeSync = isAndroidApp();
  const { retryAt } = useSyncState();

  const statusPoll = usePollInterval(30_000);
  const statusQuery = useQuery<DeviceStatus>({
    queryKey: ['device-status'],
    queryFn: async () => (await api.get('/api/auth/device-status/')).data,
    refetchInterval: statusPoll,
  });

  const queryClient = useQueryClient();
  const profileId = queryClient.getQueryData<{ id: number }>(['profile'])?.id;
  const userId = storeUserId ?? profileId;

  // Android: step data waits in the native ledger until the server confirms it.
  const nativeStatusQuery = useQuery({
    queryKey: ['native-sync-status'],
    queryFn: () => DeviceStepCounter.getSyncStatus(),
    enabled: nativeSync,
    refetchInterval: 10_000,
  });

  const {
    data: webQueue = [],
    isLoading,
    isFetching,
    refetch: refetchWebQueue,
  } = useQuery({
    queryKey: ['sync-outbox', userId],
    queryFn: () => listOutboxItems(userId),
    enabled: !!userId,
    refetchInterval: 10_000,
  });

  const queue = useMemo(
    () => [...nativePendingAsItems(nativeStatusQuery.data), ...webQueue],
    [nativeStatusQuery.data, webQueue],
  );
  const refetchNativeStatus = nativeStatusQuery.refetch;
  const refetch = useCallback(async () => {
    if (nativeSync) await refetchNativeStatus();
    return refetchWebQueue();
  }, [nativeSync, refetchNativeStatus, refetchWebQueue]);

  useEffect(() => {
    const onOnline = () => void refetch();
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [refetch]);

  const summary = useMemo(() => {
    const retrying = queue.filter((item) => item.retryCount > 0).length;
    return {
      pending: queue.length,
      retrying,
      oldest: queue[0]?.createdAt ?? null,
      maxRetries: queue.reduce((max, item) => Math.max(max, item.retryCount), 0),
    };
  }, [queue]);

  const handleSyncNow = async () => {
    const before = summary.pending;
    await syncHealthNow();
    await refetch();
    void statusQuery.refetch();
    const nativeAfter = nativeSync ? (await DeviceStepCounter.getSyncStatus().catch(() => null))?.pending?.length ?? 0 : 0;
    const after = nativeAfter + (await listOutboxItems(userId)).length;
    if (before === 0 && after === 0) showToast({ message: 'Already up to date. Your steps are on your account.', type: 'success' });
    else if (before > 0 && after === 0) showToast({ message: 'Everything is synced.', type: 'success' });
    else if (before > 0 && after > 0) showToast({ message: `${after} update${after === 1 ? '' : 's'} still waiting. We’ll keep retrying.`, type: 'info' });
  };

  const lastSync = statusQuery.data?.last_sync_time ?? nativeStatusQuery.data?.lastSuccessAt ?? null;
  const nextRetryAt = Math.max(retryAt, Date.parse(nativeStatusQuery.data?.nextAllowedAt ?? '') || 0);
  const waitingForServer = nextRetryAt > Date.now();
  const synced = summary.pending === 0;

  const headline = synced
    ? 'Everything is synced'
    : !isOnline
      ? `You’re offline · ${summary.pending} update${summary.pending === 1 ? '' : 's'} waiting`
      : `${summary.pending} update${summary.pending === 1 ? '' : 's'} waiting to upload`;

  const explanation = synced
    ? 'Your steps are safely on your account. If you lose connection, new step data waits here until it can upload.'
    : !isOnline
      ? 'Your steps are stored on this phone and will upload automatically when you’re back online. Nothing is lost.'
      : waitingForServer
        ? `The server asked us to wait a moment. Your steps are stored on this phone and will upload after ${new Date(nextRetryAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`
        : summary.retrying > 0
          ? 'Some uploads didn’t go through yet. They’re kept on this phone and retried automatically — you can also retry now.'
          : 'These will upload in the next few moments. Your steps are stored on this phone until the server confirms them.';

  return (
    <div className="pb-nav">
      <ScreenHeader
        title="Step sync"
        back
        actions={
          <IconButton label="Refresh" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw size={20} className={isFetching ? 'animate-spin' : ''} aria-hidden />
          </IconButton>
        }
      />

      <div className="mx-auto w-full max-w-2xl space-y-6 px-5 pb-8 pt-2">
        <section aria-live="polite" className="rounded-card border border-border-light bg-bg-card p-5 shadow-card">
          <div className="flex items-start gap-3">
            <IconTile icon={synced ? CheckCircle2 : isOnline ? UploadCloud : CloudOff} tone={synced ? 'success' : isOnline ? 'warning' : 'neutral'} size="lg" />
            <div className="min-w-0 flex-1">
              <h2 className="text-headline text-text-primary">{isLoading ? 'Checking…' : headline}</h2>
              <p className="mt-1 text-callout text-text-secondary">{explanation}</p>
              <p className="mt-2 text-caption text-text-muted">
                {statusQuery.isLoading
                  ? 'Checking your last sync…'
                  : lastSync
                    ? `Last successful sync ${formatRelativeTime(lastSync)} · ${formatDateTime(lastSync)}`
                    : 'No steps have synced to your account yet.'}
              </p>
            </div>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-2">
            <StatTile className="rounded-control bg-bg-sunken p-3" label="Waiting" value={<span className="num">{summary.pending}</span>} />
            <StatTile className="rounded-control bg-bg-sunken p-3" label="Retrying" value={<span className="num">{summary.retrying}</span>} />
          </div>

          <Button className="mt-4" fullWidth onClick={handleSyncNow} isLoading={isSyncing} loadingText="Syncing" disabled={!isOnline} leftIcon={<RefreshCw size={18} aria-hidden />}>
            {synced ? 'Sync now' : 'Retry now'}
          </Button>
          {!isOnline && <p className="mt-2 text-center text-caption text-text-muted">Connect to the internet to sync.</p>}
        </section>

        {!synced && (
          <ListGroup title="Waiting to upload" footer={summary.oldest ? `Oldest item queued ${formatRelativeTime(summary.oldest)}.` : undefined}>
            {queue.map((item) => {
              const d = describeItem(item);
              return (
                <div key={item.queueKey} className="flex items-start gap-3 px-4 py-3">
                  <IconTile icon={d.icon} tone="neutral" size="sm" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-body font-medium text-text-primary">{d.title}</p>
                      {item.retryCount > 0 ? (
                        <Pill tone="warning">{`Retried ${item.retryCount}×`}</Pill>
                      ) : (
                        <Pill tone="neutral">Waiting</Pill>
                      )}
                    </div>
                    <p className="mt-0.5 text-caption text-text-secondary">{d.detail}</p>
                    <p className="mt-0.5 text-caption text-text-muted">
                      Saved {formatDateTime(item.createdAt)}
                      {item.updatedAt !== item.createdAt ? ` · last try ${formatRelativeTime(item.updatedAt)}` : ''} · ref {item.idempotencyKey.slice(0, 8)}
                    </p>
                  </div>
                </div>
              );
            })}
          </ListGroup>
        )}

        <section className="px-1">
          <h2 className="eyebrow mb-2">How step sync works</h2>
          <p className="text-callout text-text-secondary">
            Your phone counts steps, and Step2Win uploads them to your account. If an upload can’t get through, it’s kept on this phone and
            retried when you reconnect. Each item is removed only after the server confirms it, so the same steps are never counted twice.
          </p>
          {nativeSync && (
            <p className="mt-2 text-callout text-text-secondary">
              Counting keeps going when the app is closed. Step2Win uploads while you walk with the app open, and in the background about every{' '}
              {nativeStatusQuery.data?.backgroundIntervalMinutes || 30} minutes — more often in the last two hours of a challenge, less often
              with Data Saver or Battery Saver on. A short “Recording your challenge walk” notification appears only while you walk on a challenge day.
            </p>
          )}
          {!isNativeApp && (
            <p className="mt-2 text-caption text-text-muted">In the browser, queued items are kept in local storage; the phone app uses an on-device database.</p>
          )}
        </section>
      </div>
    </div>
  );
}
