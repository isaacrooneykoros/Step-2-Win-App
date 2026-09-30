import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Ban,
  Download,
  HeartPulse,
  Info,
  Link2,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Smartphone,
  Trash2,
  Unplug,
  Watch,
  type LucideIcon,
} from 'lucide-react';
import { DeviceStepCounter, type HealthSourcesStatus } from '../plugins/deviceStepCounter';
import { getHealthSourcesStatus, healthSourcesSupported, originLabel } from '../services/healthSources';
import { stepsService } from '../services/api/steps';
import { useHealthSync } from '../hooks/useHealthSync';
import { isIOSApp } from '../utils/platform';
import { formatRelativeTime, formatSteps } from '../lib/format';
import type { HealthSourceDay } from '../types';
import { ScreenHeader } from '../components/ui/ScreenHeader';
import { ListGroup, ListRow } from '../components/ui/ListRow';
import { IconTile, Pill, type Tone } from '../components/ui/Pill';
import Button from '../components/ui/Button';
import { Sheet } from '../components/ui/Sheet';
import { EmptyState } from '../components/ui/EmptyState';
import { Skeleton } from '../components/ui/Skeleton';
import { useToast } from '../components/ui/Toast';

const STATUS_KEY = ['health-sources', 'status'] as const;
const SERVER_KEY = ['health-sources', 'server'] as const;

const STATE_META: Record<HealthSourcesStatus['state'], { label: string; tone: Tone }> = {
  connected: { label: 'Connected', tone: 'success' },
  off: { label: 'Off', tone: 'neutral' },
  needs_install: { label: 'Not installed', tone: 'warning' },
  needs_update: { label: 'Update needed', tone: 'warning' },
  permission_denied: { label: 'Access off', tone: 'warning' },
  unavailable: { label: 'Not available', tone: 'neutral' },
};

interface SourceRow {
  label: string;
  kind: 'wearable' | 'phone_app' | null;
  trust: string;
  steps: number;
}

/** What each app's data does, in plain words. */
function describe(row: SourceRow): { icon: LucideIcon; tone: Tone; detail: string; pill: string; pillTone: Tone } {
  if (row.trust === 'manual') {
    return { icon: Ban, tone: 'neutral', detail: 'Typed in by hand', pill: 'Not counted', pillTone: 'neutral' };
  }
  if (row.trust !== 'trusted') {
    return { icon: Ban, tone: 'neutral', detail: 'An app Step2Win can’t check yet', pill: 'Not counted', pillTone: 'neutral' };
  }
  if (row.kind === 'wearable') {
    return { icon: Watch, tone: 'brand', detail: 'Watch or band · counts toward challenges', pill: 'Counted', pillTone: 'success' };
  }
  return { icon: Smartphone, tone: 'info', detail: 'Phone app · confirms your phone’s steps', pill: 'Confirms', pillTone: 'info' };
}

/** The last week's apps, from the server's decisions (trust is decided there). */
function serverRows(days: HealthSourceDay[] | undefined): SourceRow[] {
  const byLabel = new Map<string, SourceRow>();
  for (const day of days ?? []) {
    for (const o of day.origins) {
      if (o.trust === 'ignored') continue;
      const label = o.trust === 'untrusted' && o.label.includes('.') ? 'Other app' : o.label;
      const key = `${label}|${o.trust}|${o.kind ?? ''}`;
      const row = byLabel.get(key) ?? { label, kind: o.kind, trust: o.trust, steps: 0 };
      row.steps += o.steps;
      byLabel.set(key, row);
    }
  }
  return [...byLabel.values()].sort((a, b) => b.steps - a.steps);
}

export default function ConnectedSourcesScreen() {
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { requestSync } = useHealthSync();
  const [confirm, setConfirm] = useState<'disconnect' | 'remove' | null>(null);
  const supported = healthSourcesSupported();
  const ios = isIOSApp();
  const storeName = ios ? 'Apple Health' : 'Health Connect';

  const status = useQuery({
    queryKey: STATUS_KEY,
    queryFn: getHealthSourcesStatus,
    enabled: supported,
    staleTime: 15_000,
  });
  const server = useQuery({
    queryKey: SERVER_KEY,
    queryFn: () => stepsService.getHealthSources(7),
    enabled: supported && !!status.data?.optedIn,
    staleTime: 60_000,
  });

  const setStatus = useCallback(
    (next: HealthSourcesStatus | null | undefined) => {
      if (next) queryClient.setQueryData(STATUS_KEY, next);
    },
    [queryClient],
  );

  const refreshAll = useCallback(async () => {
    // Our own steps first, then the health summaries (native uploaders do both).
    requestSync('health_sources');
    await new Promise((r) => setTimeout(r, 2500));
    await queryClient.invalidateQueries({ queryKey: SERVER_KEY });
    await queryClient.invalidateQueries({ queryKey: ['steps'] });
  }, [queryClient, requestSync]);

  const connect = useMutation({
    mutationFn: () => DeviceStepCounter.healthSourcesConnect(),
    onSuccess: async (next) => {
      setStatus(next);
      if (next.state === 'connected') {
        showToast({ message: `${storeName} is connected.`, type: 'success' });
        await refreshAll();
      } else if (next.state === 'permission_denied') {
        showToast({ message: `Step2Win can’t read steps until you allow it in ${storeName}.`, type: 'info' });
      }
    },
    onError: () => showToast({ message: `${storeName} couldn’t be opened. Your phone’s own step count carries on.`, type: 'error' }),
  });

  const readNow = useMutation({
    mutationFn: () => DeviceStepCounter.healthSourcesRead({ force: true }),
    onSuccess: async (next) => {
      setStatus(next);
      await refreshAll();
    },
    onError: () => showToast({ message: `Couldn’t read ${storeName} right now. Try again later.`, type: 'error' }),
  });

  const install = useMutation({
    mutationFn: () => DeviceStepCounter.healthSourcesInstall(),
    onSuccess: (r) => {
      if (!r.opened) showToast({ message: 'The Play Store couldn’t be opened on this phone.', type: 'info' });
    },
  });

  const disconnect = useMutation({
    mutationFn: () => DeviceStepCounter.healthSourcesDisconnect(),
    onSuccess: (next) => {
      setStatus(next);
      setConfirm(null);
      showToast({ message: `${storeName} is disconnected. Steps already counted stay counted.`, type: 'success' });
    },
    onError: () => showToast({ message: 'Couldn’t disconnect. Try again.', type: 'error' }),
  });

  const removeData = useMutation({
    mutationFn: () => stepsService.deleteHealthSources(),
    onSuccess: async () => {
      setConfirm(null);
      await queryClient.invalidateQueries({ queryKey: SERVER_KEY });
      await queryClient.invalidateQueries({ queryKey: ['steps'] });
      await queryClient.invalidateQueries({ queryKey: ['health'] });
      showToast({ message: `Imported ${storeName} data was removed from Step2Win.`, type: 'success' });
    },
    onError: () => showToast({ message: 'Couldn’t remove the imported data. Try again.', type: 'error' }),
  });

  const rows = useMemo(() => {
    const fromServer = serverRows(server.data);
    if (fromServer.length > 0) return fromServer;
    // Nothing on the server yet: what this phone read today (trust not decided yet).
    return (status.data?.todayOrigins ?? []).map((o) => ({
      label: originLabel(o.origin),
      kind: o.device === 'watch' || o.device === 'band' || o.device === 'ring' ? ('wearable' as const) : ('phone_app' as const),
      trust: o.steps > 0 ? 'pending' : 'manual',
      steps: o.steps + o.manual_steps,
    }));
  }, [server.data, status.data?.todayOrigins]);

  if (!supported) {
    return (
      <div className="pb-nav">
        <ScreenHeader title="Connected sources" back />
        <EmptyState
          icon={HeartPulse}
          title="Needs the Step2Win app"
          description="Connecting Health Connect or Apple Health works in the Step2Win app on Android or iPhone."
        />
      </div>
    );
  }

  const s = status.data;
  const meta = s ? STATE_META[s.state] : null;
  const busy = connect.isPending || readNow.isPending || disconnect.isPending || removeData.isPending;

  return (
    <div className="pb-nav">
      <ScreenHeader title="Connected sources" back />
      <div className="mx-auto w-full max-w-2xl space-y-6 px-5 pb-8 pt-2">
        <section aria-label={storeName} className="rounded-card border border-border-light bg-bg-card p-4 shadow-card">
          <div className="flex items-center gap-3">
            <IconTile icon={HeartPulse} tone={s?.state === 'connected' ? 'brand' : 'neutral'} />
            <div className="min-w-0 flex-1">
              <p className="text-headline text-text-primary">{storeName}</p>
              <p className="text-caption text-text-muted">
                {s?.lastReadAt ? <>Read {formatRelativeTime(s.lastReadAt)}</> : 'Steps and workouts from your other apps and devices'}
              </p>
            </div>
            {status.isLoading ? <Skeleton className="h-6 w-20 rounded-full" /> : meta ? <Pill tone={meta.tone}>{meta.label}</Pill> : null}
          </div>
          {s?.state === 'connected' && s.todaySourceSteps > 0 && (
            <p className="mt-3 text-callout text-text-secondary">
              Today your connected apps recorded <span className="num font-semibold text-text-primary">{formatSteps(s.todaySourceSteps)}</span> steps.
              Step2Win counts the higher of this and your phone’s own count, never both added together.
            </p>
          )}
        </section>

        {(!s || s.state === 'off') && !status.isLoading && (
          <ExplainAndConnect storeName={storeName} ios={ios} busy={busy} connecting={connect.isPending} onConnect={() => connect.mutate()} />
        )}

        {s?.state === 'needs_install' && (
          <Notice
            icon={Download}
            title="Health Connect isn’t installed"
            body="On this Android version Health Connect is a separate app from the Play Store. Install it, then come back and connect. Step2Win keeps counting with your phone’s sensor either way."
          >
            <Button fullWidth size="lg" leftIcon={<Download size={18} aria-hidden />} isLoading={install.isPending} onClick={() => install.mutate()}>
              Install Health Connect
            </Button>
            <Button fullWidth variant="ghost" onClick={() => connect.mutate()} disabled={busy}>
              I’ve installed it
            </Button>
          </Notice>
        )}

        {s?.state === 'needs_update' && (
          <Notice icon={Download} title="Health Connect needs an update" body="Update Health Connect from the Play Store, then come back. Your phone’s own step count carries on meanwhile.">
            <Button fullWidth size="lg" leftIcon={<Download size={18} aria-hidden />} isLoading={install.isPending} onClick={() => install.mutate()}>
              Update Health Connect
            </Button>
            <Button fullWidth variant="ghost" onClick={() => connect.mutate()} disabled={busy}>
              I’ve updated it
            </Button>
          </Notice>
        )}

        {s?.state === 'permission_denied' && (
          <Notice
            icon={ShieldCheck}
            title="Access is off"
            body={`Step2Win can’t read your steps from ${storeName} right now. Allow “Steps” (and “Exercise” for workouts) to connect again.`}
          >
            <Button fullWidth size="lg" leftIcon={<Link2 size={18} aria-hidden />} isLoading={connect.isPending} onClick={() => connect.mutate()}>
              Allow access
            </Button>
          </Notice>
        )}

        {s?.state === 'unavailable' && (
          <Notice
            icon={Info}
            title={`${storeName} isn’t available on this phone`}
            body="That’s fine: Step2Win counts your steps with your phone’s own sensor, and walks you start in the app are verified with GPS."
          />
        )}

        {s?.optedIn && (s.state === 'connected' || rows.length > 0) && (
          <ListGroup
            title="Apps and devices"
            footer="Watches and bands from trusted apps count toward challenges. Phone apps confirm the steps your phone counted. Steps typed in by hand, and apps Step2Win can’t check, are never counted."
          >
            {server.isLoading && rows.length === 0 ? (
              <div className="p-4">
                <Skeleton className="h-4 w-40 rounded" />
                <Skeleton className="mt-2 h-3 w-56 rounded" />
              </div>
            ) : rows.length === 0 ? (
              <div className="p-4 text-callout text-text-muted">No steps from other apps in the last few days.</div>
            ) : (
              rows.map((row) => {
                const d =
                  row.trust === 'pending'
                    ? { icon: row.kind === 'wearable' ? Watch : Smartphone, tone: 'neutral' as Tone, detail: 'Read on this phone · being checked', pill: 'Checking', pillTone: 'neutral' as Tone }
                    : describe(row);
                return (
                  <ListRow
                    key={`${row.label}-${row.trust}-${row.kind}`}
                    leading={<IconTile icon={d.icon} tone={d.tone} size="sm" />}
                    title={row.label}
                    subtitle={
                      <>
                        {d.detail} · <span className="num">{formatSteps(row.steps)}</span> steps
                      </>
                    }
                    trailing={<Pill tone={d.pillTone}>{d.pill}</Pill>}
                  />
                );
              })
            )}
          </ListGroup>
        )}

        {s?.optedIn && (
          <ListGroup title="Manage">
            {s.state === 'connected' && (
              <ListRow
                leading={<IconTile icon={RefreshCw} tone="neutral" size="sm" />}
                title="Read now"
                subtitle={readNow.isPending ? 'Reading…' : `Checks ${storeName} for new steps`}
                onClick={() => readNow.mutate()}
                disabled={busy}
              />
            )}
            <ListRow
              leading={<IconTile icon={Settings2} tone="neutral" size="sm" />}
              title={ios ? 'Open the Health app' : 'Open Health Connect'}
              subtitle={ios ? 'Sharing > Apps > Step2Win' : 'See or change what Step2Win may read'}
              onClick={() => void DeviceStepCounter.healthSourcesOpenSettings().catch(() => null)}
              chevron
            />
            <ListRow
              leading={<IconTile icon={Unplug} tone="neutral" size="sm" />}
              title="Disconnect"
              subtitle="Stop reading. Steps already counted stay counted."
              onClick={() => setConfirm('disconnect')}
              disabled={busy}
            />
            <ListRow
              leading={<IconTile icon={Trash2} tone="danger" size="sm" />}
              title="Remove imported data"
              subtitle={`Delete what Step2Win received from ${storeName}`}
              destructive
              onClick={() => setConfirm('remove')}
              disabled={busy}
            />
          </ListGroup>
        )}
      </div>

      <Sheet
        open={confirm === 'disconnect'}
        onClose={() => setConfirm(null)}
        dismissible={!disconnect.isPending}
        title={`Disconnect ${storeName}?`}
        description={
          ios
            ? 'Step2Win stops reading Apple Health. To remove its access completely, also turn it off in the Health app (Sharing > Apps > Step2Win).'
            : 'Step2Win stops reading Health Connect and gives back its access. Steps already counted stay counted.'
        }
        footer={
          <div className="flex flex-col gap-2">
            <Button fullWidth size="lg" variant="danger" isLoading={disconnect.isPending} loadingText="Disconnecting…" onClick={() => disconnect.mutate()}>
              Disconnect
            </Button>
            <Button fullWidth variant="ghost" onClick={() => setConfirm(null)} disabled={disconnect.isPending}>
              Keep connected
            </Button>
          </div>
        }
      >
        <span />
      </Sheet>

      <Sheet
        open={confirm === 'remove'}
        onClose={() => setConfirm(null)}
        dismissible={!removeData.isPending}
        title="Remove imported data?"
        description={`Step2Win deletes the steps and workouts it received from ${storeName}. Those days go back to your phone’s own count, which can lower your progress in active challenges.`}
        footer={
          <div className="flex flex-col gap-2">
            <Button fullWidth size="lg" variant="danger" isLoading={removeData.isPending} loadingText="Removing…" onClick={() => removeData.mutate()}>
              Remove data
            </Button>
            <Button fullWidth variant="ghost" onClick={() => setConfirm(null)} disabled={removeData.isPending}>
              Cancel
            </Button>
          </div>
        }
      >
        <span />
      </Sheet>
    </div>
  );
}

/** The explanation shown before Health Connect's / Apple's own permission screen. */
function ExplainAndConnect({
  storeName,
  ios,
  busy,
  connecting,
  onConnect,
}: {
  storeName: string;
  ios: boolean;
  busy: boolean;
  connecting: boolean;
  onConnect: () => void;
}) {
  const points: Array<{ icon: LucideIcon; title: string; body: string }> = [
    {
      icon: Watch,
      title: 'Count your watch or band',
      body: ios
        ? 'Steps your Apple Watch recorded while your phone wasn’t with you can count, including toward challenges.'
        : 'Steps a Galaxy Watch, Fitbit, Garmin or Mi Band recorded while your phone wasn’t with you can count, including toward challenges.',
    },
    {
      icon: ShieldCheck,
      title: 'Confirm your phone’s steps',
      body: 'When another trusted app counted the same steps at the same time, that confirms them. Runs recorded with a GPS route count like a walk.',
    },
    {
      icon: Ban,
      title: 'What never counts',
      body: 'Steps typed in by hand and steps from apps Step2Win can’t check. Your steps are never added twice: Step2Win takes the higher count.',
    },
    {
      icon: Info,
      title: 'What Step2Win reads',
      body: `Only steps and workouts from the last few days, and which app or device recorded them. Step2Win never writes to ${storeName}. Route maps stay on your phone.`,
    },
  ];
  return (
    <section aria-label={`Connect ${storeName}`} className="space-y-4">
      <ul className="space-y-3">
        {points.map((p) => (
          <li key={p.title} className="flex gap-3">
            <IconTile icon={p.icon} tone="neutral" size="sm" />
            <div className="min-w-0">
              <p className="text-callout font-semibold text-text-primary">{p.title}</p>
              <p className="text-callout text-text-secondary">{p.body}</p>
            </div>
          </li>
        ))}
      </ul>
      <Button fullWidth size="lg" leftIcon={<Link2 size={18} aria-hidden />} isLoading={connecting} loadingText="Opening…" disabled={busy} onClick={onConnect}>
        Connect {storeName}
      </Button>
      <p className="text-center text-caption text-text-muted">
        Optional. {storeName} will ask what to share. Step2Win keeps counting with your phone’s own sensor either way.
      </p>
    </section>
  );
}

function Notice({ icon, title, body, children }: { icon: LucideIcon; title: string; body: string; children?: ReactNode }) {
  return (
    <section className="space-y-3 rounded-card border border-border-light bg-bg-card p-4 shadow-card">
      <div className="flex gap-3">
        <IconTile icon={icon} tone="warning" size="sm" />
        <div className="min-w-0">
          <p className="text-callout font-semibold text-text-primary">{title}</p>
          <p className="text-callout text-text-secondary">{body}</p>
        </div>
      </div>
      {children}
    </section>
  );
}
