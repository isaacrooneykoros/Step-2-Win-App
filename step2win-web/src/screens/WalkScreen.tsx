import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  BatteryMedium,
  CloudOff,
  Flag,
  Footprints,
  LocateFixed,
  MapPin,
  MapPinOff,
  Route,
  Smartphone,
  WifiOff,
  type LucideIcon,
} from 'lucide-react';
import { ScreenHeader } from '../components/ui/ScreenHeader';
import Button from '../components/ui/Button';
import Card from '../components/ui/Card';
import { IconTile, Pill, type Tone } from '../components/ui/Pill';
import { StatTile } from '../components/ui/StatTile';
import { Sheet } from '../components/ui/Sheet';
import { StickyFooter } from '../components/challenge-detail/StickyFooter';
import { RouteSvg } from '../components/walks/RouteSvg';
import { NoStepSensorNotice } from '../components/walks/StartWalkCard';
import { requestConsent } from '../components/privacy/ConsentHost';
import { formatDistance, formatDuration, formatPace } from '../components/walks/walkFormat';
import { formatSteps } from '../lib/format';
import { openAppSettings } from '../plugins/appSystem';
import type { WalkGpsStatus } from '../plugins/deviceStepCounter';
import { hasNativeStepCounter, permissionCopy } from '../utils/platform';
import {
  clearWalkProblem,
  dismissFinishedWalk,
  elapsedSeconds,
  finishWalk,
  resumeWalkIfAny,
  retryWalkUpload,
  startNewWalk,
  useWalkStore,
  type WalkProblem,
  type WalkStore,
} from '../services/walkSession';

/** Re-render every second while `active`. */
function useSecondTick(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}

export default function WalkScreen() {
  const walk = useWalkStore();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // Reload / app restart during a walk: pick it up again (no-op when nothing is running).
  useEffect(() => {
    void resumeWalkIfAny();
  }, []);

  // Uploaded: refresh step data and show the summary.
  useEffect(() => {
    if (walk.phase !== 'finished') return;
    void queryClient.invalidateQueries({ queryKey: ['steps'] });
    void queryClient.invalidateQueries({ queryKey: ['health'] });
    void queryClient.invalidateQueries({ queryKey: ['walks'] });
    void queryClient.invalidateQueries({ queryKey: ['challenges'] });
    if (walk.summary) {
      const id = String(walk.summary.id);
      queryClient.setQueryData(['walks', 'detail', id], walk.summary);
      dismissFinishedWalk();
      navigate(`/walks/${encodeURIComponent(id)}`, { replace: true });
    }
  }, [walk.phase, walk.summary]);

  if (!hasNativeStepCounter()) {
    return (
      <div className="pb-nav">
        <ScreenHeader title="Walk" back />
        <div className="px-5 pt-6">
          <Explainer
            icon={Smartphone}
            title="Walks need the Step2Win app"
            body="Walks use your phone’s GPS and motion sensors, so they’re available in the Step2Win app for Android and iPhone. Your synced steps still count for your goals."
          />
        </div>
      </div>
    );
  }

  return (
    <div className="pb-nav">
      <ScreenHeader title="Walk" back />
      {walk.phase === 'active' || walk.phase === 'finishing' ? (
        <LiveWalk walk={walk} />
      ) : walk.phase === 'upload_pending' ? (
        <PendingUpload walk={walk} />
      ) : walk.phase === 'finished' ? (
        <div className="px-5 pt-6">
          <Explainer
            icon={Route}
            title="Your walk has ended"
            body="We couldn’t load its summary right now. Your steps still count for your goals, and the walk appears in your history once it’s processed."
          />
          <Button
            fullWidth
            size="lg"
            className="mt-6"
            onClick={() => {
              dismissFinishedWalk();
              navigate('/', { replace: true });
            }}
          >
            Done
          </Button>
        </div>
      ) : (
        <BeforeStart walk={walk} />
      )}
    </div>
  );
}

// ── Before the walk ─────────────────────────────────────────────────────────

function Tip({ icon: Icon, children }: { icon: LucideIcon; children: ReactNode }) {
  return (
    <li className="flex gap-3 px-4 py-3.5">
      <Icon size={18} className="mt-0.5 shrink-0 text-text-secondary" aria-hidden />
      <p className="text-callout text-text-secondary">{children}</p>
    </li>
  );
}

function BeforeStart({ walk }: { walk: WalkStore }) {
  const starting = walk.phase === 'starting';
  useEffect(() => () => clearWalkProblem(), []);

  return (
    <>
      <div className="space-y-6 px-5 pt-2">
        <section className="flex flex-col items-center pt-4 text-center">
          <IconTile icon={Footprints} tone="brand" size="lg" />
          <h1 className="mt-4 text-title text-text-primary">Start a walk</h1>
          <p className="mt-1.5 max-w-sm text-callout text-text-secondary">
            Walks with GPS count toward challenges. Every step still counts for your goals, as always.
          </p>
        </section>

        {walk.problem && <ProblemPanel problem={walk.problem} />}

        <NoStepSensorNotice />

        <ul className="divide-y divide-border-light overflow-hidden rounded-card border border-border-light bg-bg-card shadow-card">
          <Tip icon={Smartphone}>Keep the app open or your phone in your pocket. The screen can be off.</Tip>
          <Tip icon={MapPin}>Your location is used only while the walk is running, to record its route.</Tip>
          <Tip icon={BatteryMedium}>GPS turns off as soon as you finish, to save battery.</Tip>
        </ul>
      </div>

      <StickyFooter>
        <Button
          fullWidth
          size="lg"
          leftIcon={<Footprints size={18} aria-hidden />}
          isLoading={starting}
          loadingText="Getting ready…"
          // Location consent (Kenya DPA; doubles as Play's prominent disclosure) before the first walk.
          onClick={() => void requestConsent('location_walks').then((ok) => { if (ok) void startNewWalk(); })}
        >
          {walk.problem ? 'Try again' : 'Start walk'}
        </Button>
      </StickyFooter>
    </>
  );
}

const problemCopy: Record<WalkProblem, { icon: LucideIcon; title: string; body: string; settings?: boolean }> = {
  location_permission: {
    icon: MapPinOff,
    title: 'Walks need your location',
    body: 'Location records your route, which is how a walk counts toward challenges. It’s only used while a walk is running. Your steps still count for your goals without it.',
    settings: true,
  },
  activity_permission: {
    icon: Footprints,
    title: 'Allow step counting',
    body: '',
    settings: true,
  },
  gps_off: {
    icon: LocateFixed,
    title: 'Turn on location',
    body: 'Your phone’s location (GPS) is off. Turn it on from the quick settings, then try again.',
  },
  offline: {
    icon: WifiOff,
    title: 'You’re offline',
    body: 'Starting a walk needs a connection for a moment. After that, your walk records even without signal.',
  },
  server: {
    icon: CloudOff,
    title: 'Couldn’t start your walk',
    body: 'Something went wrong on our side. Please try again in a moment.',
  },
  unsupported: {
    icon: Smartphone,
    title: 'Walks aren’t available on this phone',
    body: 'This phone can’t count steps during a walk. Your synced steps still count for your goals.',
  },
  web: {
    icon: Smartphone,
    title: 'Walks need the Step2Win app',
    body: 'Walks use your phone’s GPS and motion sensors, so they’re available in the Step2Win app for Android and iPhone.',
  },
};

function ProblemPanel({ problem }: { problem: WalkProblem }) {
  const copy = problemCopy[problem];
  const body =
    problem === 'activity_permission'
      ? `Walks count your steps with ${permissionCopy().motionName}. Allow it for Step2Win, then try again.`
      : copy.body;
  const Icon = copy.icon;
  return (
    <div className="rounded-card bg-warning-soft p-4" role="alert">
      <div className="flex items-start gap-3">
        <Icon size={18} className="mt-0.5 shrink-0 text-warning" aria-hidden />
        <div className="min-w-0">
          <p className="text-callout font-semibold text-text-primary">{copy.title}</p>
          <p className="mt-0.5 text-caption text-text-secondary">{body}</p>
          {copy.settings && (
            <Button variant="secondary" size="sm" className="-ml-1 mt-2 !h-10" onClick={() => void openAppSettings()}>
              Open settings
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function Explainer({ icon, title, body }: { icon: LucideIcon; title: string; body: string }) {
  return (
    <div className="flex flex-col items-center text-center">
      <IconTile icon={icon} tone="neutral" size="lg" />
      <h1 className="mt-4 text-title text-text-primary">{title}</h1>
      <p className="mt-1.5 max-w-sm text-callout text-text-secondary">{body}</p>
    </div>
  );
}

// ── During the walk ─────────────────────────────────────────────────────────

const gpsMeta: Record<WalkGpsStatus, { label: string; tone: Tone }> = {
  ok: { label: 'GPS on', tone: 'success' },
  searching: { label: 'Finding GPS…', tone: 'neutral' },
  off: { label: 'Location is off', tone: 'warning' },
  denied: { label: 'Location not allowed', tone: 'warning' },
  unavailable: { label: 'No GPS', tone: 'neutral' },
};

function LiveWalk({ walk }: { walk: WalkStore }) {
  const finishing = walk.phase === 'finishing';
  const now = useSecondTick(!finishing);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const live = walk.live;
  const elapsed = finishing && live ? live.elapsedS : elapsedSeconds(now);
  const distance = live?.distanceM ?? 0;
  const gps = gpsMeta[live?.gpsStatus ?? 'searching'] ?? gpsMeta.searching;

  return (
    <>
      <div className="space-y-6 px-5 pt-2">
        <section className="flex flex-col items-center pt-2 text-center" aria-label="Walk in progress">
          <Pill tone={gps.tone} dot={live?.gpsStatus === 'ok' ? 'live' : true}>
            {gps.label}
          </Pill>
          <p className="num mt-3 text-display text-text-primary" aria-live="off">
            {formatDuration(elapsed)}
          </p>
          <p className="text-caption text-text-muted">{finishing ? 'Saving your walk…' : 'Walking'}</p>
        </section>

        <Card padding="lg">
          <div className="grid grid-cols-3 gap-3">
            <StatTile label="Steps" value={formatSteps(live?.steps ?? 0)} />
            <StatTile label="Distance" value={formatDistance(distance)} />
            <StatTile label="Pace" value={formatPace(elapsed, distance)} />
          </div>
        </Card>

        <RouteSvg points={walk.route} height={220} />

        {(live?.gpsStatus === 'off' || live?.gpsStatus === 'denied') && (
          <div className="flex items-start gap-3 rounded-card bg-warning-soft p-4" role="status">
            <MapPinOff size={18} className="mt-0.5 shrink-0 text-warning" aria-hidden />
            <p className="text-caption text-text-secondary">
              {live.gpsStatus === 'off'
                ? 'Location is off, so your route isn’t being recorded. Turn it on from the quick settings to keep going.'
                : 'Location isn’t allowed for Step2Win, so your route isn’t being recorded.'}
            </p>
          </div>
        )}

        <div className="flex items-start gap-3 rounded-card bg-bg-sunken p-4">
          <Smartphone size={18} className="mt-0.5 shrink-0 text-text-secondary" aria-hidden />
          <p className="text-caption text-text-secondary">
            Keep the app open or your phone in your pocket. The screen can be off. You can leave this screen; the walk keeps going.
          </p>
        </div>

        {walk.waitingForConnection && (
          <p className="flex items-center gap-2 text-caption text-text-muted" role="status">
            <CloudOff size={14} className="shrink-0" aria-hidden />
            Offline. Your route is saved on this phone and uploads when you’re back online.
          </p>
        )}
      </div>

      <StickyFooter>
        <Button
          fullWidth
          size="lg"
          leftIcon={<Flag size={18} aria-hidden />}
          isLoading={finishing}
          loadingText="Saving your walk…"
          onClick={() => setConfirmOpen(true)}
        >
          Finish walk
        </Button>
      </StickyFooter>

      <Sheet
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        size="sm"
        title="Finish your walk?"
        description="Your route and steps will be saved."
        footer={
          <div className="flex flex-col gap-2">
            <Button
              fullWidth
              size="lg"
              onClick={() => {
                setConfirmOpen(false);
                void finishWalk();
              }}
            >
              Finish walk
            </Button>
            <Button fullWidth variant="ghost" onClick={() => setConfirmOpen(false)}>
              Keep walking
            </Button>
          </div>
        }
      >
        <p className="num text-callout text-text-secondary">
          {formatDuration(elapsed)} · {formatDistance(distance)} · {formatSteps(live?.steps ?? 0)} steps
        </p>
      </Sheet>
    </>
  );
}

// ── Finished, waiting for a connection ──────────────────────────────────────

function PendingUpload({ walk }: { walk: WalkStore }) {
  const [retrying, setRetrying] = useState(false);
  return (
    <div className="space-y-6 px-5 pt-6">
      <div className="flex flex-col items-center text-center">
        <IconTile icon={CloudOff} tone="warning" size="lg" />
        <h1 className="mt-4 text-title text-text-primary">Your walk is saved on this phone</h1>
        <p className="mt-1.5 max-w-sm text-callout text-text-secondary">
          It uploads automatically when you’re back online, even if you close the app. Nothing is lost.
        </p>
      </div>
      {walk.route.length > 1 && <RouteSvg points={walk.route} height={180} />}
      <Button
        fullWidth
        size="lg"
        variant="secondary"
        isLoading={retrying}
        loadingText="Uploading…"
        onClick={async () => {
          setRetrying(true);
          try {
            await retryWalkUpload();
          } finally {
            setRetrying(false);
          }
        }}
      >
        Try again now
      </Button>
    </div>
  );
}
