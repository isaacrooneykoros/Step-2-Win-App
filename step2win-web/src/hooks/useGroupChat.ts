/**
 * useGroupChat — manages WebSocket connection + message state for a challenge chat.
 *
 * Strategy:
 *  1. Opens WebSocket on mount, receives history as first message
 *  2. Falls back to REST polling (every 5s) if WebSocket fails
 *  3. Sends via WebSocket if open, falls back to POST /chat/ if closed
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import { ChatMessage } from '../types';
import { challengesService } from '../services/api';
import { useAuthStore } from '../store/authStore';

const WS_BASE =
  import.meta.env.VITE_WS_URL ||
  (import.meta.env.VITE_API_BASE_URL
    ?.replace('https://', 'wss://')
    .replace('http://', 'ws://')) ||
  'ws://localhost:8000';

export function useGroupChat(challengeId: number) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [connected, setConnected] = useState(false);
  const [typingUsers, setTypingUsers] = useState<string[]>([]);
  const [sending, setSending] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>();
  const typingTimer = useRef<ReturnType<typeof setTimeout>>();
  const pollTimer = useRef<ReturnType<typeof setInterval>>();
  const isTypingRef = useRef(false);

  // ── WebSocket connection ──────────────────────────────────────────────
  const connect = useCallback(async () => {
    const token = await useAuthStore.getState().getAccessToken();
    if (!token) return;

    const url = `${WS_BASE}/ws/challenges/${challengeId}/chat/?token=${token}`;
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
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

    ws.onclose = () => {
      setConnected(false);
      wsRef.current = null;
      // Reconnect after 3s
      reconnectTimer.current = setTimeout(connect, 3000);
      // Start polling fallback while disconnected
      startPollingFallback();
    };

    ws.onerror = () => {
      ws.close();
    };
  }, [challengeId]);

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
    connect();
    return () => {
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
    typingUsers,
    sending,
    sendMessage,
    sendTyping,
  };
}
