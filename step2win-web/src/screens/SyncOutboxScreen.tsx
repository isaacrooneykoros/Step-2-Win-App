import { useEffect, useMemo } from 'react';
import { Capacitor } from '@capacitor/core';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  Clock3,
  CloudOff,
  Database,
  Hourglass,
  RefreshCw,
  Route,
  AlertTriangle,
  CheckCircle2,
} from 'lucide-react';
import { useAuthStore } from '../store/authStore';
import { useHealthSync } from '../hooks/useHealthSync';
import { listOutboxItems, type SyncOutboxItem } from '../services/offlineSyncOutbox';

function formatRelativeTime(timestamp: string) {
  const diffMs = Date.now() - new Date(timestamp).getTime();
  if (!Number.isFinite(diffMs) || diffMs < 0) return 'just now';

  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;

  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;

  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

function formatTimestamp(timestamp: string) {
  return new Date(timestamp).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function getPayloadSummary(item: SyncOutboxItem) {
  if (item.kind === 'health') {
    const steps = Number(item.payload?.steps ?? 0);
    const distance = Number(item.payload?.distance_km ?? 0);
    const activeMinutes = Number(item.payload?.active_minutes ?? 0);
    const calories = Number(item.payload?.calories_active ?? 0);

    return [
      `${steps.toLocaleString()} steps`,
      distance > 0 ? `${distance.toFixed(2)} km` : 'no distance',
      activeMinutes > 0 ? `${activeMinutes} active min` : 'no active minutes',
      calories > 0 ? `${calories} kcal` : 'no calories',
    ].join(' • ');
  }

  const hourly = Array.isArray(item.payload?.hourly) ? item.payload.hourly : [];
  const waypoints = Array.isArray(item.payload?.waypoints) ? item.payload.waypoints.length : 0;
  const steps = hourly.reduce((sum: number, entry: any) => sum + (Number(entry?.steps) || 0), 0);

  return [
    `${steps.toLocaleString()} hourly steps`,
    `${hourly.length} hour bucket${hourly.length === 1 ? '' : 's'}`,
    `${waypoints} waypoint${waypoints === 1 ? '' : 's'}`,
  ].join(' • ');
}

function getKindLabel(kind: SyncOutboxItem['kind']) {
  return kind === 'health' ? 'Live health sync' : 'Hourly route sync';
}

export default function SyncOutboxScreen() {
  const navigate = useNavigate();
  const userId = useAuthStore((state) => state.user?.id);
  const { syncHealthSilent, isSyncing } = useHealthSync();

  const { data: queue = [], isFetching, refetch } = useQuery({
    queryKey: ['sync-outbox', userId],
    queryFn: () => listOutboxItems(userId),
    enabled: !!userId,
    refetchInterval: 5000,
    refetchIntervalInBackground: true,
  });

  useEffect(() => {
    const onOnline = () => {
      void refetch();
    };

    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [refetch]);

  const isOnline = typeof navigator === 'undefined' ? true : navigator.onLine;
  const isNativeAndroid = Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';

  const summary = useMemo(() => {
    const pending = queue.length;
    const health = queue.filter((item) => item.kind === 'health').length;
    const hourly = queue.filter((item) => item.kind === 'hourly').length;
    const oldest = queue[0]?.createdAt || null;
    const maxRetries = queue.reduce((max, item) => Math.max(max, item.retryCount), 0);

    return {
      pending,
      health,
      hourly,
      oldest,
      maxRetries,
    };
  }, [queue]);

  const oldestLabel = summary.oldest ? formatRelativeTime(summary.oldest) : 'none waiting';

  const handleSyncNow = async () => {
    await syncHealthSilent();
    await refetch();
  };

  return (
    <div className="screen-enter pb-nav bg-bg-page min-h-screen">
      <div className="pt-safe px-4 pt-5 pb-4">
        <div className="flex items-center gap-3 mb-4">
          <button
            onClick={() => navigate('/settings')}
            className="w-10 h-10 rounded-xl bg-bg-input flex items-center justify-center shrink-0"
            aria-label="Back to settings"
          >
            <ArrowLeft size={20} className="text-text-primary" />
          </button>
          <div>
            <h1 className="text-text-primary text-2xl font-bold">Sync Outbox</h1>
            <p className="text-text-muted text-sm">Queued items stay on this device until they are safely accepted by the server.</p>
          </div>
        </div>

        <div className="card rounded-[2rem] p-5 overflow-hidden relative mb-4">
          <div className="absolute inset-x-0 top-0 h-28 bg-gradient-to-r from-accent-blue/12 via-accent-green/10 to-accent-yellow/10 pointer-events-none" />
          <div className="relative flex items-start justify-between gap-4">
            <div>
              <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-bg-input border border-border mb-3">
                <span className={`w-2.5 h-2.5 rounded-full ${isOnline ? 'bg-accent-green' : 'bg-accent-red'}`} />
                <span className="text-[11px] font-semibold text-text-secondary">{isOnline ? 'Online' : 'Offline'}</span>
              </div>
              <h2 className="text-text-primary text-xl font-black">{summary.pending === 0 ? 'All caught up' : 'Sync pending'}</h2>
              <p className="text-sm text-text-muted mt-1 max-w-md">
                Android uses SQLite for durable retries. Web preview uses a local fallback so you can still test the flow.
              </p>
            </div>
            <div className="w-12 h-12 rounded-2xl bg-bg-input border border-border flex items-center justify-center shrink-0">
              <Database size={22} className="text-accent-blue" />
            </div>
          </div>

          <div className="relative grid grid-cols-2 gap-3 mt-5">
            <StatCard label="Pending" value={summary.pending.toString()} icon={<Hourglass size={16} className="text-accent-blue" />} />
            <StatCard label="Health / Hourly" value={`${summary.health}/${summary.hourly}`} icon={<Route size={16} className="text-accent-green" />} />
            <StatCard label="Oldest" value={oldestLabel} icon={<Clock3 size={16} className="text-accent-yellow" />} />
            <StatCard label="Max retries" value={summary.maxRetries.toString()} icon={<AlertTriangle size={16} className="text-accent-pink" />} />
          </div>

          <div className="relative flex gap-3 mt-5">
            <button
              onClick={handleSyncNow}
              disabled={isSyncing || isFetching}
              className="flex-1 btn-primary py-3 rounded-2xl disabled:opacity-50"
            >
              {isSyncing ? 'Syncing...' : 'Sync now'}
            </button>
            <button
              onClick={() => refetch()}
              className="flex-1 btn-secondary py-3 rounded-2xl inline-flex items-center justify-center gap-2"
            >
              <RefreshCw size={16} className={isFetching ? 'animate-spin' : ''} />
              Refresh
            </button>
          </div>
          {summary.pending > 0 && (
            <p className="relative text-xs text-text-muted mt-3">
              Queue items remain until the network returns and the server accepts them. Retries preserve idempotency keys.
            </p>
          )}
        </div>
      </div>

      <div className="px-4 pb-8 space-y-3">
        {summary.pending === 0 ? (
          <div className="card rounded-3xl p-5 text-center">
            <CheckCircle2 size={28} className="mx-auto text-accent-green mb-3" />
            <h3 className="text-text-primary text-lg font-bold">Nothing waiting to sync</h3>
            <p className="text-sm text-text-muted mt-1">
              New step or route snapshots will appear here automatically if the app goes offline.
            </p>
            {!isNativeAndroid && (
              <p className="text-xs text-text-muted mt-3">
                Browser preview uses local storage here; Android uses the SQLite outbox.
              </p>
            )}
          </div>
        ) : (
          queue.map((item) => (
            <div key={item.queueKey} className="card rounded-3xl p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-[11px] uppercase tracking-widest text-text-muted">{getKindLabel(item.kind)}</p>
                  <h3 className="text-text-primary text-lg font-bold mt-1">{item.payload?.date || 'Queued item'}</h3>
                </div>
                <span className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-semibold ${item.retryCount > 0 ? 'bg-tint-yellow text-accent-yellow' : 'bg-tint-green text-accent-green'}`}>
                  {item.retryCount > 0 ? 'Retrying' : 'Waiting'}
                </span>
              </div>

              <p className="text-sm text-text-secondary mt-3 leading-6">{getPayloadSummary(item)}</p>

              <div className="grid grid-cols-2 gap-2 mt-4 text-xs">
                <InfoPill label="Queued" value={formatTimestamp(item.createdAt)} />
                <InfoPill label="Updated" value={formatTimestamp(item.updatedAt)} />
                <InfoPill label="Retries" value={String(item.retryCount)} />
                <InfoPill label="Key" value={item.idempotencyKey.slice(0, 8)} />
              </div>
            </div>
          ))
        )}

        <div className="card rounded-3xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <CloudOff size={16} className="text-accent-blue" />
            <p className="text-sm font-semibold text-text-primary">How it works</p>
          </div>
          <p className="text-sm text-text-muted leading-6">
            When the device is offline, Step2Win stores the sync payload locally, retries on reconnect, and removes it only after the server confirms success or a duplicate request.
          </p>
        </div>
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  icon,
}: {
  label: string;
  value: string;
  icon: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-border bg-bg-input px-3 py-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-text-muted">{label}</span>
        {icon}
      </div>
      <p className="text-sm font-bold text-text-primary mt-2 break-words">{value}</p>
    </div>
  );
}

function InfoPill({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-border bg-bg-input px-3 py-2">
      <p className="text-[11px] uppercase tracking-widest text-text-muted">{label}</p>
      <p className="text-xs text-text-primary font-semibold mt-1 break-words">{value}</p>
    </div>
  );
}