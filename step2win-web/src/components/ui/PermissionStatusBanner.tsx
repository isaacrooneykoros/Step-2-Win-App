import { AlertTriangle, BellOff, ChevronRight, Footprints, Info } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { permissionCopy } from '../../utils/platform';

interface PermissionStatusBannerProps {
  status: 'granted' | 'denied' | 'unavailable';
  permissionName: 'steps' | 'notifications' | 'both';
  onEnable?: () => void;
  dismissible?: boolean;
}

const COPY = {
  steps: {
    icon: Footprints,
    title: 'Step counting is off',
    description: `Allow ${permissionCopy().motionName} so your steps count toward challenges.`,
    unavailable: 'Step counting needs the Step2Win phone app.',
  },
  notifications: {
    icon: BellOff,
    title: 'Notifications are off',
    description: 'Turn them on to hear about challenge deadlines and payouts.',
    unavailable: 'Notifications need the mobile app.',
  },
  both: {
    icon: AlertTriangle,
    title: 'Some permissions are off',
    description: 'Allow step counting and notifications to use every feature.',
    unavailable: 'These features need the mobile app.',
  },
} as const;

/**
 * Slim status strip for screens that depend on a device permission.
 * Hidden when granted; "Fix" takes the user to Settings.
 */
export function PermissionStatusBanner({ status, permissionName, onEnable }: PermissionStatusBannerProps) {
  const navigate = useNavigate();
  const copy = COPY[permissionName];

  if (status === 'granted') return null;

  if (status === 'unavailable') {
    return (
      <div className="sticky top-0 z-40 flex items-center gap-3 border-b border-border-light bg-bg-sunken px-4 py-2.5" role="status">
        <Info size={18} className="shrink-0 text-text-muted" aria-hidden />
        <p className="min-w-0 flex-1 text-callout text-text-secondary">{copy.unavailable}</p>
      </div>
    );
  }

  const Icon = copy.icon;
  return (
    <div className="sticky top-0 z-40 flex items-center gap-3 border-b border-warning/30 bg-warning-soft px-4 py-2" role="status">
      <Icon size={18} className="shrink-0 text-warning" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-callout font-semibold text-text-primary">{copy.title}</p>
        <p className="text-caption text-text-secondary">{copy.description}</p>
      </div>
      <button
        type="button"
        onClick={() => {
          onEnable?.();
          navigate('/settings');
        }}
        className="inline-flex min-h-[44px] shrink-0 items-center gap-0.5 rounded-full px-2 text-callout font-semibold text-text-primary hover:bg-warning/10"
      >
        Fix
        <ChevronRight size={16} aria-hidden />
      </button>
    </div>
  );
}
