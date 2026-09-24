/**
 * useGroupChat — manages WebSocket connection + message state for a challenge chat.
 *
 * Strategy:
 *  1. Opens WebSocket on mount, receives history as first message
 *  2. Falls back to REST polling (every 5s) if WebSocket fails
 *  3. Sends via WebSocket if open, falls back to POST /chat/ if closed
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import { Preferences } from '@capacitor/preferences';
import { ChatMessage } from '../types';
import { challengesService } from '../services/api';
import { useAuthStore } from '../store/authStore';
import { resolveApiBaseUrl, resolveWsBaseUrl } from '../config/network';
import { isDataSaverOn } from './useDataSaver';

const API_BASE = resolveApiBaseUrl();
const WS_BASE = resolveWsBaseUrl();

export function useGroupChat(challengeId: number) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [connected, setConnected] = useState(false);
  const [realtimeUnavailable, setRealtimeUnavailable] = useState(false);
  const [typingUsers, setTypingUsers] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [historyLoaded, setHistoryLoaded] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const shouldReconnectRef = useRef(true);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>();
  const typingTimer = useRef<ReturnType<typeof setTimeout>>();
  const pollTimer = useRef<ReturnType<typeof setInterval>>();
  const isTypingRef = useRef(false);
  // Bumped on unmount so an in-flight connect() from a previous mount never opens a stray socket.
  const generationRef = useRef(0);

  const refreshAccessToken = useCallback(async (): Promise<string | null> => {
    let refreshToken: string | null = null;
    try {
      const { value } = await Preferences.get({ key: 'refresh_token' });
      refreshToken = value;
    } catch {
      refreshToken = sessionStorage.getItem('refresh_token');
    }

    if (!refreshToken) {
      return null;
    }

    try {
      const response = await fetch(`${API_BASE}/api/auth/refresh/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh: refreshToken }),
      });

      if (!response.ok) {
        return null;
      }

      const payload = (await response.json()) as { access?: string; refresh?: string };
      if (!payload.access) {
        return null;
      }

      try {
        await Preferences.set({ key: 'access_token', value: payload.access });
        if (payload.refresh) {
          await Preferences.set({ key: 'refresh_token', value: payload.refresh });
        }
      } catch {
        sessionStorage.setItem('access_token', payload.access);
        if (payload.refresh) {
          sessionStorage.setItem('refresh_token', payload.refresh);
        }
      }

      return payload.access;
    } catch {
      return null;
    }
  }, []);

  // ── WebSocket connection ──────────────────────────────────────────────
  const connect = useCallback(async () => {
    const generation = generationRef.current;
    let token = await useAuthStore.getState().getAccessToken();
    if (!token) {
      token = await refreshAccessToken();
    }
    if (generation !== generationRef.current) return;
    if (!token) {
      setConnected(false);
      setRealtimeUnavailable(true);
      shouldReconnectRef.current = false;
      return;
    }

    const url = `${WS_BASE}/ws/challenges/${challengeId}/chat/?token=${encodeURIComponent(token)}`;
    const ws = new WebSocket(url);
    wsRef.current = ws;

    // If the handshake stalls, show history over REST while the socket keeps trying.
    setTimeout(() => {
      if (wsRef.current === ws && ws.readyState !== WebSocket.OPEN) startPollingFallback();
    }, 3000);

    ws.onopen = () => {
      setConnected(true);
      setRealtimeUnavailable(false);
      reconnectAttemptsRef.current = 0;
      // Clear polling fallback if WS connected
      if (pollTimer.current) clearInterval(pollTimer.current);
      pollTimer.current = undefined;
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as any;

        if (data.type === 'history') {
          setMessages(data.messages);
          setHistoryLoaded(true);
        } else if (data.type === 'message') {
          setMessages((prev) => {
            // Avoid duplicates
            if (prev.some((m) => m.id === data.id)) return prev;
            return [...prev, data as ChatMessage];
          });
        } else if (data.type === 'typing') {
          const { username, is_typing } = data;
          setTypingUsers((prev) =>
            is_typing
              ? prev.includes(username)
                ? prev
                : [...prev, username]
              : prev.filter((u) => u !== username)
          );
          // Auto-clear typing after 3s in case disconnect event missed
          setTimeout(() => {
            setTypingUsers((prev) => prev.filter((u) => u !== username));
          }, 3000);
        }
      } catch (e) {
        console.error('Chat parse error:', e);
      }
    };

    ws.onclose = (event) => {
      // A socket replaced by a newer connection (e.g. remount) must not tear down its successor.
      if (wsRef.current !== ws) return;
      setConnected(false);
      wsRef.current = null;

      // Permanent failures: do not reconnect forever.
      // 4001 unauthenticated, 4403 forbidden/not participant/public challenge, 4404 not found.
      if ([4001, 4403, 4404, 1008].includes(event.code)) {
        shouldReconnectRef.current = false;
        setRealtimeUnavailable(true);
        startPollingFallback();
        return;
      }

      reconnectAttemptsRef.current += 1;
      if (reconnectAttemptsRef.current >= 3) {
        shouldReconnectRef.current = false;
        setRealtimeUnavailable(true);
        startPollingFallback();
        return;
      }

      if (shouldReconnectRef.current) {
        // Reconnect after 3s
        reconnectTimer.current = setTimeout(connect, 3000);
        // Start polling fallback while disconnected
        startPollingFallback();
      }
    };

    ws.onerror = () => {
      ws.close();
    };
  }, [challengeId, refreshAccessToken]);

  // ── REST polling fallback ─────────────────────────────────────────────
  const startPollingFallback = useCallback(() => {
    if (pollTimer.current) return;
    const poll = async () => {
      try {
        const data = await challengesService.getChatMessages(challengeId);
        setMessages(data);
        setHistoryLoaded(true);
      } catch {
        /* ignore */
      }
    };
    // Fetch once straight away so the thread isn't blank while the socket is down.
    void poll();
    // Fallback polling while the socket is down; much slower under data saver.
    pollTimer.current = setInterval(poll, isDataSaverOn() ? 30_000 : 5000);
  }, [challengeId]);

  useEffect(() => {
    shouldReconnectRef.current = true;
    reconnectAttemptsRef.current = 0;
    setRealtimeUnavailable(false);
    connect();
    return () => {
      shouldReconnectRef.current = false;
      generationRef.current += 1;
      const socket = wsRef.current;
      wsRef.current = null;
      socket?.close();
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      if (pollTimer.current) clearInterval(pollTimer.current);
      pollTimer.current = undefined;
      if (typingTimer.current) clearTimeout(typingTimer.current);
    };
  }, [connect]);

  // ── Send message ──────────────────────────────────────────────────────
  const sendMessage = useCallback(
    async (content: string): Promise<boolean> => {
      const trimmed = content.trim();
      if (!trimmed) return false;
      setSending(true);

      try {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(
            JSON.stringify({ type: 'message', content: trimmed })
          );
        } else {
          // HTTP fallback
          const msg = await challengesService.sendChatMessage(
            challengeId,
            trimmed
          );
          setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
        }
        return true;
      } catch (e) {
        console.error('Send failed:', e);
        return false;
      } finally {
        setSending(false);
      }
    },
    [challengeId]
  );

  // ── Typing indicator ──────────────────────────────────────────────────
  const sendTyping = useCallback((isTyping: boolean) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    if (isTyping === isTypingRef.current) return;
    isTypingRef.current = isTyping;
    wsRef.current.send(JSON.stringify({ type: 'typing', is_typing: isTyping }));

    if (isTyping) {
      // Auto stop typing after 2.5s of no keystrokes
      if (typingTimer.current) clearTimeout(typingTimer.current);
      typingTimer.current = setTimeout(() => sendTyping(false), 2500);
    }
  }, []);

  return {
    messages,
    historyLoaded,
    connected,
    realtimeUnavailable,
    typingUsers,
    sending,
    sendMessage,
    sendTyping,
  };
}
