import { AlarmClock, Camera, MapPin, Navigation, type LucideIcon } from 'lucide-react';
import { Sheet } from '../ui/Sheet';
import Button from '../ui/Button';
import { IconTile, Pill } from '../ui/Pill';
import { permissionLabel, type DevicePermissions } from './useDevicePermissions';

interface PermissionsSheetProps {
  open: boolean;
  onClose: () => void;
  permissions: DevicePermissions;
}

interface ItemProps {
  icon: LucideIcon;
  title: string;
  description: string;
  state: string;
  actionLabel: string;
  onAction: () => void;
  loading: boolean;
  disabled?: boolean;
  disabledReason?: string;
}

function PermissionItem({ icon, title, description, state, actionLabel, onAction, loading, disabled, disabledReason }: ItemProps) {
  const status = permissionLabel(state);
  return (
    <li className="py-4 first:pt-1 last:pb-1">
      <div className="flex items-start gap-3">
        <IconTile icon={icon} tone={state === 'granted' ? 'brand' : 'neutral'} />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <h3 className="text-body font-medium text-text-primary">{title}</h3>
            <Pill tone={status.tone}>{status.label}</Pill>
          </div>
          <p className="mt-0.5 text-caption text-text-muted">{description}</p>
          {state !== 'unavailable' && (
            <Button
              variant={state === 'granted' ? 'ghost' : 'secondary'}
              size="sm"
              className="-ml-1 mt-2 !h-10"
              onClick={onAction}
              isLoading={loading}
              disabled={disabled}
            >
              {actionLabel}
            </Button>
          )}
          {disabled && disabledReason && <p className="mt-1 text-caption text-text-muted">{disabledReason}</p>}
        </div>
      </div>
    </li>
  );
}

/** Camera, location and alarm permissions — what each is for, its status, and how to change it. */
export function PermissionsSheet({ open, onClose, permissions: p }: PermissionsSheetProps) {
  // iOS: routes are recorded only while the app is open and there are no exact-alarm settings.
  const showBackground = p.backgroundLocation !== 'unavailable';
  const showAlarm = p.exactAlarm !== 'unavailable';
  return (
    <Sheet open={open} onClose={onClose} title="App permissions" description="What Step2Win can access on this phone, and why. You can change these at any time.">
      <ul className="divide-y divide-border-light">
        <PermissionItem
          icon={Camera}
          title="Camera"
          description="Only used to scan challenge invite QR codes."
          state={p.camera}
          actionLabel={p.camera === 'granted' ? 'Check again' : 'Allow camera'}
          onAction={p.requestCamera}
          loading={p.busy === 'camera'}
        />
        <PermissionItem
          icon={MapPin}
          title="Location while using the app"
          description="Records the route of your walks so you can see them on a map."
          state={p.location}
          actionLabel={p.location === 'granted' ? 'Check again' : 'Allow location'}
          onAction={p.requestLocation}
          loading={p.busy === 'location'}
        />
        {showBackground && (
        <PermissionItem
          icon={Navigation}
          title="Location in the background"
          description="Keeps recording your route when Step2Win isn’t on screen."
          state={p.backgroundLocation}
          actionLabel={p.backgroundLocation === 'granted' ? 'Check again' : 'Allow background location'}
          onAction={p.requestBackground}
          loading={p.busy === 'background'}
          disabled={p.location !== 'granted'}
          disabledReason="Allow location while using the app first."
        />
        )}
        {showAlarm && (
        <PermissionItem
          icon={AlarmClock}
          title="Alarms & reminders"
          description="Lets reminders arrive exactly on time (Android 12 and later)."
          state={p.exactAlarm}
          actionLabel={p.exactAlarm === 'granted' ? 'Open alarm settings' : 'Allow exact alarms'}
          onAction={p.openExactAlarm}
          loading={p.busy === 'alarm'}
        />
        )}
      </ul>
    </Sheet>
  );
}

export default PermissionsSheet;
