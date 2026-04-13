import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Smartphone, Monitor, AlertTriangle } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../services/api/client';
import { useAuthStore } from '../store/authStore';

interface DeviceSession {
  id: string;
  device_name: string;
  device_type: 'android' | 'ios' | 'web' | 'unknown';
  ip_address: string;
  last_active_at: string;
  created_at: string;
  is_current: boolean;
}

export default function ActiveSessionsScreen() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const sessionId = useAuthStore((state) => state.sessionId);
  const getRefreshToken = useAuthStore((state) => state.getRefreshToken);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [revokingAll, setRevokingAll] = useState(false);

  // Fetch active sessions
  const { data: sessions, isLoading } = useQuery<DeviceSession[]>({
    queryKey: ['sessions'],
    queryFn: async () => {
      const response = await api.get('/api/users/sessions/');
      return response.data;
    },
  });

  // Revoke single session mutation
  const revokeMutation = useMutation({
    mutationFn: async (sessionIdToRevoke: string) => {
      await api.post(`/api/users/sessions/${sessionIdToRevoke}/revoke/`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
      setRevoking(null);
    },
    onError: (error: any) => {
      alert(error.response?.data?.error || 'Failed to revoke session');
      setRevoking(null);
    },
  });

  // Revoke all sessions mutation
  const revokeAllMutation = useMutation({
    mutationFn: async () => {
      const refreshToken = await getRefreshToken();
      await api.post('/api/users/sessions/revoke-all/', {
        current_refresh: refreshToken,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
      setRevokingAll(false);
    },
    onError: (error: any) => {
      alert(error.response?.data?.error || 'Failed to revoke sessions');
      setRevokingAll(false);
    },
  });

  const handleRevoke = (sessionIdToRevoke: string, deviceName: string) => {
    if (confirm(`Log out "${deviceName}"?`)) {
      setRevoking(sessionIdToRevoke);
      revokeMutation.mutate(sessionIdToRevoke);
    }
  };

  const handleRevokeAll = () => {
    const otherSessionsCount = sessions?.filter((s) => s.id !== sessionId).length || 0;
    if (otherSessionsCount === 0) {
      alert('No other devices to log out');
      return;
    }
    if (
      confirm(
        `Log out all ${otherSessionsCount} other device${otherSessionsCount > 1 ? 's' : ''}? This cannot be undone.`
      )
    ) {
      setRevokingAll(true);
      revokeAllMutation.mutate();
    }
  };

  const deviceIcons = {
    android: <Smartphone size={20} className="text-gray-500" />,
    ios: <Smartphone size={20} className="text-gray-500" />,
    web: <Monitor size={20} className="text-gray-500" />,
    unknown: <Smartphone size={20} className="text-gray-500" />,
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins} min ago`;
    if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
    if (diffDays < 7) return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
    return date.toLocaleDateString();
  };

  return (
    <div className="min-h-screen bg-bg-page">
      {/* Header */}
      <div className="bg-bg-elevated border-b border-border-default px-4 py-4 flex items-center gap-3 sticky top-0 z-10">
        <button
          onClick={() => navigate(-1)}
          className="w-10 h-10 rounded-xl bg-bg-input flex items-center justify-center hover:opacity-90 transition-colors"
        >
          <ArrowLeft size={20} className="text-text-primary" />
        </button>
        <div>
          <h1 className="text-text-primary text-lg font-bold">Active Devices</h1>
          <p className="text-text-muted text-xs">Manage your logged-in devices</p>
        </div>
      </div>

      {/* Content */}
      <div className="p-4">
        {/* Info banner */}
        <div className="mb-4 p-4 rounded-xl bg-tint-blue border border-border flex gap-3">
          <AlertTriangle size={20} className="text-blue-500 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-text-primary text-sm font-semibold mb-1">Security Tip</p>
            <p className="text-text-secondary text-xs leading-relaxed">
              If you see a device you don't recognize, log it out immediately and change your
              password.
            </p>
          </div>
        </div>

        {/* Revoke all button */}
        {sessions && sessions.length > 1 && (
          <button
            onClick={handleRevokeAll}
            disabled={revokingAll}
            className="mb-4 w-full py-3 rounded-xl text-error text-sm font-bold border border-error/30 bg-error/10 hover:bg-error/15 transition-colors disabled:opacity-50"
          >
            {revokingAll ? 'Logging out...' : 'Log Out All Other Devices'}
          </button>
        )}

        {/* Loading state */}
        {isLoading && (
          <div className="text-center py-12">
          <div className="inline-block w-8 h-8 border-4 border-border-default border-t-accent-blue rounded-full animate-spin"></div>
          <p className="text-text-muted text-sm mt-3">Loading sessions...</p>
          </div>
        )}

        {/* Sessions list */}
        {!isLoading && sessions && (
          <div className="rounded-2xl overflow-hidden bg-bg-card border border-border shadow-sm">
            {sessions.map((session, i) => {
              const isCurrent = session.id === sessionId;

              return (
                <div
                  key={session.id}
                  className={`flex items-center gap-3 px-4 py-4 ${
                    i > 0 ? 'border-t border-border-light' : ''
                  }`}
                >
                  {/* Icon */}
                  <div className="w-10 h-10 rounded-xl bg-bg-input flex items-center justify-center flex-shrink-0">
                    {deviceIcons[session.device_type]}
                  </div>

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-text-primary text-sm font-bold truncate">
                        {session.device_name}
                      </p>
                      {isCurrent && (
                        <span
                          className="text-xs px-2 py-0.5 rounded-full font-bold bg-tint-blue text-accent-blue"
                        >
                          This device
                        </span>
                      )}
                    </div>
                    <p className="text-text-muted text-xs mt-0.5">
                      {session.ip_address}  {formatDate(session.last_active_at)}
                    </p>
                  </div>

                  {/* Revoke button - not shown for current device */}
                  {!isCurrent && (
                    <button
                      onClick={() => handleRevoke(session.id, session.device_name)}
                      disabled={revoking === session.id}
                      className="text-red-400 text-xs font-bold flex-shrink-0 hover:text-red-600 transition-colors disabled:opacity-50"
                    >
                      {revoking === session.id ? 'Logging out...' : 'Log out'}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Empty state */}
        {!isLoading && sessions && sessions.length === 0 && (
          <div className="text-center py-12">
            <Smartphone size={48} className="text-text-muted mx-auto mb-3" />
            <p className="text-text-muted text-sm">No active sessions</p>
          </div>
        )}
      </div>
    </div>
  );
}

