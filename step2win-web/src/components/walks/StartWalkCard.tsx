import { ChevronRight, CloudOff, Footprints, Route, Smartphone } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import Card from '../ui/Card';
import { IconTile, Pill } from '../ui/Pill';
import { useWalkStore, loadSensorCapabilities } from '../../services/walkSession';
import { hasNativeStepCounter } from '../../utils/platform';
import { formatSteps } from '../../lib/format';

/** Sensor capabilities of this phone (native only; null on the web or when unknown). */
export function useSensorCapabilities() {
  return useQuery({
    queryKey: ['device', 'sensor-capabilities'],
    queryFn: loadSensorCapabilities,
    enabled: hasNativeStepCounter(),
    staleTime: Infinity,
    gcTime: Infinity,
  });
}

/** Entry point to the walk flow (Home, challenge detail, steps detail). Shows a running walk too. */
export function StartWalkCard({ className = '' }: { className?: string }) {
  const walk = useWalkStore();

  if (walk.phase === 'active' || walk.phase === 'finishing') {
    return (
      <Card to="/walk" padding="md" className={className}>
        <div className="flex items-center gap-3">
          <IconTile icon={Route} tone="brand" />
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-2 text-callout font-semibold text-text-primary">
              Walk in progress
              <Pill tone="brand" dot="live">
                Live
              </Pill>
            </p>
            <p className="num text-caption text-text-muted">
              {walk.live ? `${formatSteps(walk.live.steps)} steps so far` : 'Recording your walk'}
            </p>
          </div>
          <ChevronRight size={18} className="shrink-0 text-text-muted" aria-hidden />
        </div>
      </Card>
    );
  }

  if (walk.phase === 'upload_pending') {
    return (
      <Card to="/walk" padding="md" className={className}>
        <div className="flex items-center gap-3">
          <IconTile icon={CloudOff} tone="warning" />
          <div className="min-w-0 flex-1">
            <p className="text-callout font-semibold text-text-primary">Your walk is saved on this phone</p>
            <p className="text-caption text-text-muted">It uploads automatically when you’re back online.</p>
          </div>
          <ChevronRight size={18} className="shrink-0 text-text-muted" aria-hidden />
        </div>
      </Card>
    );
  }

  if (walk.phase === 'finished' && walk.summary) {
    return (
      <Card to={`/walks/${encodeURIComponent(String(walk.summary.id))}`} padding="md" className={className}>
        <div className="flex items-center gap-3">
          <IconTile icon={Route} tone="success" />
          <div className="min-w-0 flex-1">
            <p className="text-callout font-semibold text-text-primary">Your walk is saved</p>
            <p className="text-caption text-text-muted">See your route and how it counted.</p>
          </div>
          <ChevronRight size={18} className="shrink-0 text-text-muted" aria-hidden />
        </div>
      </Card>
    );
  }

  return (
    <Card to="/walk" padding="md" className={className}>
      <div className="flex items-center gap-3">
        <IconTile icon={Footprints} tone="brand" />
        <div className="min-w-0 flex-1">
          <p className="text-callout font-semibold text-text-primary">Start a walk</p>
          <p className="text-caption text-text-muted">Walks with GPS count toward challenges.</p>
        </div>
        <ChevronRight size={18} className="shrink-0 text-text-muted" aria-hidden />
      </div>
    </Card>
  );
}

/**
 * Phones without a hardware step counter: say so plainly, and what still works.
 * Renders nothing when the phone has one (or on the web).
 */
export function NoStepSensorNotice({ className = '' }: { className?: string }) {
  const caps = useSensorCapabilities();
  if (!caps.data || caps.data.hasStepCounter) return null;
  return (
    <div className={`flex items-start gap-3 rounded-card bg-info-soft p-4 ${className}`} role="note">
      <Smartphone size={18} className="mt-0.5 shrink-0 text-info" aria-hidden />
      <div className="min-w-0">
        <p className="text-callout font-semibold text-text-primary">This phone has no step sensor</p>
        <p className="mt-0.5 text-caption text-text-secondary">
          {caps.data.walkSupported
            ? 'Walks you start in Step2Win can still count, using the phone’s motion sensor instead. Health Connect support is coming soon.'
            : 'Step2Win can’t count steps on this phone yet. Health Connect support is coming soon.'}
        </p>
      </div>
    </div>
  );
}
