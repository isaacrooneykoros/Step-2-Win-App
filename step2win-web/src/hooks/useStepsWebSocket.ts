import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useStepsSyncStore } from '../store/stepsSyncStore';
import { getStoredAccessToken, resolveWsBaseUrl } from '../config/network';
import { usePreference } from '../components/settings/preferences';

export function useStepsWebSocket() {
  const queryClient = useQueryClient();
  const setStepsSocketConnected = useStepsSyncStore((state) => state.setStepsSocketConnected);
  const setLastStepsUpdateAt = useStepsSyncStore((state) => state.setLastStepsUpdateAt);
  const wsBase = resolveWsBaseUrl();
  // Data saver pauses the live socket; steps still refresh after each sync and on resume.
  const dataSaver = usePreference('dataSaver');

  useEffect(() => {
    let socket: WebSocket | null = null;
    let reconnectTimer: number | undefined;
    let cancelled = false;

    if (dataSaver) {
      setStepsSocketConnected(false);
      return;
    }

    const connect = async () => {
      const token = await getStoredAccessToken();
      if (!token || cancelled) {
        setStepsSocketConnected(false);
        return;
      }

      const wsUrl = `${wsBase}/ws/steps/sync/?token=${encodeURIComponent(token)}`;
      socket = new WebSocket(wsUrl);

      socket.onopen = () => {
        setStepsSocketConnected(true);
      };

      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          if (message.type === 'steps.update') {
            const updateTime = message?.payload?.synced_at || new Date().toISOString();
            setLastStepsUpdateAt(updateTime);
            queryClient.invalidateQueries({ queryKey: ['health'] });
            queryClient.invalidateQueries({ queryKey: ['steps'] });
            queryClient.invalidateQueries({ queryKey: ['challenges'] });
            queryClient.invalidateQueries({ queryKey: ['profile'] });
          }
        } catch {
          // ignore malformed messages
        }
      };

      socket.onerror = () => {
        setStepsSocketConnected(false);
      };

      socket.onclose = () => {
        setStepsSocketConnected(false);
        if (!cancelled) {
          reconnectTimer = window.setTimeout(connect, 5000);
        }
      };
    };

    void connect();

    return () => {
      cancelled = true;
      setStepsSocketConnected(false);
      if (reconnectTimer) {
        window.clearTimeout(reconnectTimer);
      }
      socket?.close();
    };
  }, [dataSaver, queryClient, setStepsSocketConnected, setLastStepsUpdateAt, wsBase]);
}
