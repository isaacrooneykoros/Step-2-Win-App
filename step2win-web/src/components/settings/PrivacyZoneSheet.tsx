import { useEffect, useState } from 'react';
import { useMutation, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { Home as HomeIcon, LocateFixed, ShieldCheck } from 'lucide-react';
import { stepsService } from '../../services/api/steps';
import { getCurrentCoordinates, requestForegroundLocationPermission } from '../../services/locationPermissions';
import { isNativeApp } from '../../utils/platform';
import type { PrivacyZoneStatus } from '../../types';
import { Sheet } from '../ui/Sheet';
import Button from '../ui/Button';
import { Segmented } from '../ui/Segmented';
import { IconTile, Pill } from '../ui/Pill';
import { Skeleton } from '../ui/Skeleton';
import { ErrorInline } from '../ui/ErrorState';
import { useToast } from '../ui/Toast';
import { apiErrorMessage } from './apiError';

type Radius = '200' | '300' | '500';

export const PRIVACY_ZONE_QUERY_KEY = ['walks', 'privacy-zone'] as const;

interface PrivacyZoneSheetProps {
  open: boolean;
  onClose: () => void;
  zone: UseQueryResult<PrivacyZoneStatus>;
}

/**
 * Optional home privacy zone: the start and end of walk routes near home are hidden from
 * everyone else. The server keeps only coarse, salted cells, never the point itself.
 */
export function PrivacyZoneSheet({ open, onClose, zone }: PrivacyZoneSheetProps) {
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const [radius, setRadius] = useState<Radius>('300');
  const [locating, setLocating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const enabled = !!zone.data?.enabled;
  const savedRadius = zone.data?.radius_m;

  // Opening the sheet shows the saved size when it's one of the choices.
  useEffect(() => {
    if (!open) return;
    setError(null);
    if (savedRadius === 200 || savedRadius === 300 || savedRadius === 500) setRadius(String(savedRadius) as Radius);
  }, [open, savedRadius]);

  const save = useMutation({
    mutationFn: async () => {
      setError(null);
      setLocating(true);
      try {
        if (isNativeApp()) {
          const granted = await requestForegroundLocationPermission().catch(() => false);
          if (!granted) throw new Error('location_denied');
        }
        const here = await getCurrentCoordinates();
        return await stepsService.setPrivacyZone({
          latitude: Number(here.latitude.toFixed(6)),
          longitude: Number(here.longitude.toFixed(6)),
          radius_m: Number(radius),
        });
      } finally {
        setLocating(false);
      }
    },
    onSuccess: (data) => {
      queryClient.setQueryData(PRIVACY_ZONE_QUERY_KEY, data);
      showToast({ message: 'Home privacy zone is on.', type: 'success' });
      onClose();
    },
    onError: (err: unknown) => {
      const message = err instanceof Error ? err.message : '';
      if (message === 'location_denied') {
        setError('Step2Win needs location access once to find your home. You can allow it in your phone settings.');
      } else if (message === 'unavailable' || (err as GeolocationPositionError)?.code !== undefined) {
        setError('We couldn’t find your location. Check that location is on and try again.');
      } else {
        setError(apiErrorMessage(err, 'Couldn’t save your privacy zone. Try again.'));
      }
    },
  });

  const remove = useMutation({
    mutationFn: stepsService.deletePrivacyZone,
    onSuccess: () => {
      queryClient.setQueryData(PRIVACY_ZONE_QUERY_KEY, { enabled: false, radius_m: null });
      showToast({ message: 'Home privacy zone removed.', type: 'success' });
      onClose();
    },
    onError: (err: unknown) => setError(apiErrorMessage(err, 'Couldn’t remove your privacy zone. Try again.')),
  });

  const busy = save.isPending || remove.isPending;

  return (
    <Sheet
      open={open}
      onClose={onClose}
      dismissible={!busy}
      title="Home privacy zone"
      description="Hide the start and end of your walk routes near home from everyone else."
      footer={
        <div className="flex flex-col gap-2">
          <Button
            fullWidth
            size="lg"
            leftIcon={<LocateFixed size={18} aria-hidden />}
            isLoading={save.isPending}
            loadingText={locating ? 'Finding your location…' : 'Saving…'}
            disabled={busy || zone.isLoading}
            onClick={() => save.mutate()}
          >
            {enabled ? 'Move to my current location' : 'Set to my current location'}
          </Button>
          {enabled && (
            <Button fullWidth variant="ghost" className="text-danger" isLoading={remove.isPending} loadingText="Removing…" disabled={busy} onClick={() => remove.mutate()}>
              Remove privacy zone
            </Button>
          )}
        </div>
      }
    >
      <div className="flex items-center gap-3 rounded-card border border-border-light p-4">
        <IconTile icon={HomeIcon} tone={enabled ? 'brand' : 'neutral'} />
        <div className="min-w-0 flex-1">
          <p className="text-callout font-semibold text-text-primary">Status</p>
          {zone.isLoading ? (
            <Skeleton className="mt-1 h-4 w-32 rounded" />
          ) : (
            <p className="num text-caption text-text-muted">
              {enabled ? `On · ${zone.data?.radius_m ?? 300} m around home` : 'Off'}
            </p>
          )}
        </div>
        {!zone.isLoading && <Pill tone={enabled ? 'success' : 'neutral'}>{enabled ? 'On' : 'Off'}</Pill>}
      </div>
      {zone.isError && <ErrorInline className="mt-3" message="Couldn’t load your privacy zone." onRetry={() => zone.refetch()} />}

      <p className="mb-2 mt-5 text-callout font-semibold text-text-primary">Size of the zone</p>
      <Segmented<Radius>
        label="Size of the privacy zone"
        value={radius}
        onChange={setRadius}
        options={[
          { value: '200', label: <span className="num">200 m</span> },
          { value: '300', label: <span className="num">300 m</span> },
          { value: '500', label: <span className="num">500 m</span> },
        ]}
      />

      <ul className="mt-5 space-y-3">
        <li className="flex gap-3">
          <ShieldCheck size={18} className="mt-0.5 shrink-0 text-success" aria-hidden />
          <p className="text-callout text-text-secondary">
            Stand at home and tap the button. Your exact location is not stored: we keep only a rough area, enough to hide routes near it.
          </p>
        </li>
        <li className="flex gap-3">
          <ShieldCheck size={18} className="mt-0.5 shrink-0 text-success" aria-hidden />
          <p className="text-callout text-text-secondary">
            You always see your full route yourself. The zone only changes what others can see, and it doesn’t affect how your steps count.
          </p>
        </li>
      </ul>

      {error && (
        <p className="mt-4 rounded-control bg-danger-soft px-3 py-2 text-callout text-danger" role="alert">
          {error}
        </p>
      )}
    </Sheet>
  );
}

export default PrivacyZoneSheet;
