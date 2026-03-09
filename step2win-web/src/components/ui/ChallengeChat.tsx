import { useState, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Send } from 'lucide-react';
import { challengesService } from '../../services/api';
import { useToast } from '../ui/Toast';
import type { ChatMessage } from '../../types';

interface ChallengeChatProps {
  challengeId: number;
}

export function ChallengeChat({ challengeId }: ChallengeChatProps) {
  const [message, setMessage] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();
  const { showToast } = useToast();

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
        message: error.response?.data?.error || 'Failed to send message',
        type: 'error',
      });
    },
  });

  // WebSocket connection for real-time updates
  useEffect(() => {
    const token = localStorage.getItem('access_token');
    if (!token) return;

    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProtocol}//${window.location.host}/ws/challenges/${challengeId}/chat/?token=${token}`;
    
    const websocket = new WebSocket(wsUrl);

    websocket.onopen = () => {
      console.log('Chat WebSocket connected');
    };

    websocket.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === 'chat.message') {
        queryClient.invalidateQueries({ queryKey: ['challenges', challengeId, 'chat'] });
      }
    };

    websocket.onerror = (error) => {
      console.error('Chat WebSocket error:', error);
    };

    websocket.onclose = () => {
      console.log('Chat WebSocket disconnected');
    };

    return () => {
      websocket.close();
    };
  }, [challengeId, queryClient]);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = () => {
    const trimmed = message.trim();
    if (!trimmed || sendMutation.isPending) return;
    sendMutation.mutate(trimmed);
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const formatTime = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
    });
  };

  if (isLoading) {
    return (
      <div className="card rounded-4xl p-5">
        <div className="text-center text-text-muted">Loading chat...</div>
      </div>
    );
  }

  return (
    <div className="card rounded-4xl p-5">
      <h3 className="text-lg font-black text-text-primary mb-4 flex items-center gap-2">
        💬 Group Chat
      </h3>

      {/* Messages */}
      <div className="mb-4 space-y-3 max-h-[400px] overflow-y-auto">
        {messages.length === 0 ? (
          <div className="text-center py-10 text-text-muted text-sm">
            No messages yet. Start the conversation!
          </div>
        ) : (
          messages.map((msg: ChatMessage) => {
            const isMe = msg.is_mine;
            const isSystem = msg.is_system;

            if (isSystem) {
              return (
                <div key={msg.id} className="text-center">
                  <span className="text-xs px-3 py-1.5 rounded-full font-semibold bg-tint-blue text-accent-blue">
                    {msg.content}
                  </span>
                </div>
              );
            }

            return (
              <div
                key={msg.id}
                className={`flex ${isMe ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`max-w-[75%] rounded-2xl px-4 py-2 ${
                    isMe
                      ? 'bg-accent-blue text-white'
                      : 'bg-bg-input text-text-primary'
                  }`}
                >
                  {!isMe && (
                    <div className="text-xs font-bold mb-1 opacity-70">
                      {msg.sender}
                    </div>
                  )}
                  <div className="text-sm whitespace-pre-wrap break-words">
                    {msg.content}
                  </div>
                  <div
                    className={`text-[10px] mt-1 ${
                      isMe ? 'text-white/60' : 'text-text-muted'
                    }`}
                  >
                    {formatTime(msg.created_at)}
                  </div>
                </div>
              </div>
            );
          })
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="flex gap-2">
        <input
          type="text"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyPress={handleKeyPress}
          placeholder="Type a message..."
          className="input-field flex-1"
          disabled={sendMutation.isPending}
        />
        <button
          onClick={handleSend}
          disabled={!message.trim() || sendMutation.isPending}
          className="bg-accent-blue text-white px-4 py-2 rounded-2xl flex items-center justify-center disabled:opacity-50 hover:opacity-90 transition-opacity"
        >
          <Send size={20} />
        </button>
      </div>
    </div>
  );
}
