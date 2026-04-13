import { AlertTriangle, ChevronRight } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

interface PermissionStatusBannerProps {
  status: 'granted' | 'denied' | 'unavailable';
  permissionName: 'steps' | 'notifications' | 'both';
  onEnable?: () => void;
  dismissible?: boolean;
}

/**
 * Displays permission status banner with call-to-action
 * Used on screens that require permissions
 */
export function PermissionStatusBanner({
  status,
  permissionName,
  onEnable,
}: PermissionStatusBannerProps) {
  const navigate = useNavigate();

  if (status === 'granted') {
    // Don't show banner when granted
    return null;
  }

  if (status === 'unavailable') {
    return (
      <div className="sticky top-0 z-40 bg-bg-input border-b border-border px-4 py-3 flex items-center gap-3">
        <AlertTriangle size={18} className="text-text-muted flex-shrink-0" />
        <div className="flex-1">
          <p className="text-sm font-semibold text-text-primary">
            {permissionName === 'steps'
              ? 'Step tracking'
              : permissionName === 'notifications'
                ? 'App notifications'
                : 'Permissions'}{' '}
            unavailable
          </p>
          <p className="text-xs text-text-muted">Mobile app required</p>
        </div>
      </div>
    );
  }

  // Denied status
  const getMessage = () => {
    switch (permissionName) {
      case 'steps':
        return {
          title: 'Step tracking permission required',
          description: 'Enable in settings to count and sync your steps',
        };
      case 'notifications':
        return {
          title: 'Notifications disabled',
          description: 'Enable to get alerts about challenges and payouts',
        };
      case 'both':
        return {
          title: 'Enable permissions',
          description: 'Enable both to use all app features',
        };
    }
  };

  const msg = getMessage();

  return (
    <div className="sticky top-0 z-40 bg-tint-yellow/30 border-b border-accent-yellow px-4 py-3 flex items-center gap-3">
      <AlertTriangle size={18} className="text-accent-yellow flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-text-primary">{msg.title}</p>
        <p className="text-xs text-text-secondary">{msg.description}</p>
      </div>
      <button
        onClick={() => {
          onEnable?.();
          navigate('/settings');
        }}
        className="flex-shrink-0 flex items-center gap-1 text-accent-yellow hover:text-accent-yellow/80 transition-colors"
      >
        <span className="text-xs font-semibold">Enable</span>
        <ChevronRight size={16} />
      </button>
    </div>
  );
}
