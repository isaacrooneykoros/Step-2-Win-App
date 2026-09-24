import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CloudOff, RefreshCw } from 'lucide-react';
import { useOnlineStatus } from '../../hooks/useOnlineStatus';

/**
 * App-wide connectivity strip. Offline: explains that cached data is shown and
 * steps keep counting. Reconnected: briefly confirms and refreshes stale queries.
 */
export function ConnectionBanner() {
  const online = useOnlineStatus();
  const queryClient = useQueryClient();
  const wasOffline = useRef(false);
  const [showReconnected, setShowReconnected] = useState(false);

  useEffect(() => {
    if (!online) {
      wasOffline.current = true;
      setShowReconnected(false);
      return;
    }
    if (wasOffline.current) {
      wasOffline.current = false;
      setShowReconnected(true);
      queryClient.invalidateQueries();
      const timer = window.setTimeout(() => setShowReconnected(false), 2500);
      return () => window.clearTimeout(timer);
    }
  }, [online, queryClient]);

  if (online && !showReconnected) return null;

  return (
    <div
      className={`fade-in flex items-center gap-2.5 px-4 py-2.5 text-caption font-medium ${
        online ? 'bg-success-soft text-success' : 'bg-bg-input text-text-secondary'
      }`}
      role="status"
    >
      {online ? <RefreshCw size={14} aria-hidden /> : <CloudOff size={14} aria-hidden />}
      <span className="min-w-0 flex-1">
        {online
          ? 'Back online. Refreshing your data.'
          : "You're offline. Showing your last synced data — steps keep counting and will sync when you reconnect."}
      </span>
    </div>
  );
}

export default ConnectionBanner;
