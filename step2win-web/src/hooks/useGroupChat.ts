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

const API_BASE = resolveApiBaseUrl();
const WS_BASE = resolveWsBaseUrl();

export function useGroupChat(challengeId: number) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [connected, setConnected] = useState(false);
  const [realtimeUnavailable, setRealtimeUnavailable] = useState(false);
  const [typingUsers, setTypingUsers] = useState<string[]>([]);
  const [sending, setSending] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const shouldReconnectRef = useRef(true);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>();
  const typingTimer = useRef<ReturnType<typeof setTimeout>>();
  const pollTimer = useRef<ReturnType<typeof setInterval>>();
  const isTypingRef = useRef(false);

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
    let token = await useAuthStore.getState().getAccessToken();
    if (!token) {
      token = await refreshAccessToken();
    }
    if (!token) {
      setConnected(false);
      setRealtimeUnavailable(true);
      shouldReconnectRef.current = false;
      return;
    }

    const url = `${WS_BASE}/ws/challenges/${challengeId}/chat/?token=${encodeURIComponent(token)}`;
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      setRealtimeUnavailable(false);
      reconnectAttemptsRef.current = 0;
      // Clear polling fallback if WS connected
      if (pollTimer.current) clearInterval(pollTimer.current);
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as any;

        if (data.type === 'history') {
          setMessages(data.messages);
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
    pollTimer.current = setInterval(async () => {
      try {
        const data = await challengesService.getChatMessages(challengeId);
        setMessages(data);
      } catch {
        /* ignore */
      }
    }, 5000);
  }, [challengeId]);

  useEffect(() => {
    shouldReconnectRef.current = true;
    reconnectAttemptsRef.current = 0;
    setRealtimeUnavailable(false);
    connect();
    return () => {
      shouldReconnectRef.current = false;
      wsRef.current?.close();
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      if (pollTimer.current) clearInterval(pollTimer.current);
      if (typingTimer.current) clearTimeout(typingTimer.current);
    };
  }, [connect]);

  // ── Send message ──────────────────────────────────────────────────────
  const sendMessage = useCallback(
    async (content: string) => {
      const trimmed = content.trim();
      if (!trimmed) return;
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
          setMessages((prev) => [...prev, msg]);
        }
      } catch (e) {
        console.error('Send failed:', e);
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
    connected,
    realtimeUnavailable,
    typingUsers,
    sending,
    sendMessage,
    sendTyping,
  };
}
