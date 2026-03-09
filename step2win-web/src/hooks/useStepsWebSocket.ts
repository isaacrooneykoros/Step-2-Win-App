import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useStepsSyncStore } from '../store/stepsSyncStore';

export function useStepsWebSocket() {
  const queryClient = useQueryClient();
  const setStepsSocketConnected = useStepsSyncStore((state) => state.setStepsSocketConnected);
  const setLastStepsUpdateAt = useStepsSyncStore((state) => state.setLastStepsUpdateAt);

  useEffect(() => {
    const token = localStorage.getItem('access_token');
    if (!token) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws/steps/sync/?token=${token}`;
    let socket: WebSocket | null = null;
    let reconnectTimer: number | undefined;

    const connect = () => {
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
        reconnectTimer = window.setTimeout(connect, 5000);
      };
    };

    connect();

    return () => {
      setStepsSocketConnected(false);
      if (reconnectTimer) {
        window.clearTimeout(reconnectTimer);
      }
      socket?.close();
    };
  }, [queryClient, setStepsSocketConnected, setLastStepsUpdateAt]);
}
