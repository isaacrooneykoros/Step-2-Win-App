import { useState, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { MessageSquare } from 'lucide-react';
import { challengesService } from '../../services/api';
import { useToast } from '../ui/Toast';
import type { ChatMessage } from '../../types';
import { getStoredAccessToken, resolveWsBaseUrl } from '../../config/network';
import { usePrefersReducedMotion } from '../../lib/motion';
import { Skeleton } from './Skeleton';
import { ChatBubble, ChatComposer, ChatSystemLine } from '../challenge-detail/ChatParts';

interface ChallengeChatProps {
  challengeId: number;
}

/** REST + websocket-invalidation chat (legacy variant of GroupChat). */
export function ChallengeChat({ challengeId }: ChallengeChatProps) {
  const [message, setMessage] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const reduced = usePrefersReducedMotion();

  const { data: messages = [], isLoading } = useQuery({
    queryKey: ['challenges', challengeId, 'chat'],
    queryFn: () => challengesService.getChatMessages(challengeId),
    retry: 1,
  });

  const sendMutation = useMutation({
    mutationFn: (msg: string) => challengesService.sendChatMessage(challengeId, msg),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['challenges', challengeId, 'chat'] });
      setMessage('');
    },
    onError: (error: any) => {
      showToast({
        message: error.response?.data?.error || 'Message not sent. Try again.',
        type: 'error',
      });
    },
  });

  // WebSocket connection for real-time updates
  useEffect(() => {
    let websocket: WebSocket | null = null;
    let cancelled = false;

    const connect = async () => {
      const token = await getStoredAccessToken();
      if (!token || cancelled) return;

      const wsBase = resolveWsBaseUrl();
      const wsUrl = `${wsBase}/ws/challenges/${challengeId}/chat/?token=${encodeURIComponent(token)}`;

      websocket = new WebSocket(wsUrl);

      websocket.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.type === 'chat.message') {
          queryClient.invalidateQueries({ queryKey: ['challenges', challengeId, 'chat'] });
        }
      };

      websocket.onerror = (error) => {
        console.error('Chat WebSocket error:', error);
      };
    };

    void connect();

    return () => {
      cancelled = true;
      websocket?.close();
    };
  }, [challengeId, queryClient]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'nearest' });
  }, [messages, reduced]);

  const handleSend = () => {
    const trimmed = message.trim();
    if (!trimmed || sendMutation.isPending) return;
    sendMutation.mutate(trimmed);
  };

  return (
    <section className="flex flex-col overflow-hidden rounded-card border border-border-light bg-bg-card shadow-card">
      <header className="border-b border-border-light px-4 py-3">
        <h2 className="text-headline text-text-primary">Group chat</h2>
      </header>

      <div className="max-h-[400px] min-h-[200px] overflow-y-auto px-4 pb-3" role="log" aria-live="polite" aria-label="Chat messages">
        {isLoading ? (
          <div className="space-y-3 pt-3" aria-hidden>
            <Skeleton className="h-9 w-2/3 rounded-2xl" />
            <Skeleton className="ml-auto h-9 w-1/2 rounded-2xl" />
            <Skeleton className="h-9 w-3/5 rounded-2xl" />
          </div>
        ) : messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 text-center">
            <span className="mb-3 inline-flex h-11 w-11 items-center justify-center rounded-xl bg-bg-input text-text-secondary" aria-hidden>
              <MessageSquare size={20} />
            </span>
            <p className="text-callout font-medium text-text-primary">No messages yet</p>
          </div>
        ) : (
          messages.map((msg: ChatMessage, i: number) => {
            if (msg.is_system) return <ChatSystemLine key={msg.id} content={msg.content} />;
            const prev = messages[i - 1];
            return (
              <ChatBubble
                key={msg.id}
                sender={msg.sender}
                content={msg.content}
                createdAt={msg.created_at}
                mine={msg.is_mine}
                firstInRun={!prev || prev.is_system || prev.sender !== msg.sender}
              />
            );
          })
        )}
        <div ref={messagesEndRef} />
      </div>

      <ChatComposer value={message} onChange={(e) => setMessage(e.target.value)} onSend={handleSend} sending={sendMutation.isPending} />
    </section>
  );
}
