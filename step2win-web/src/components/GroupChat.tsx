import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { ArrowDown, MessageSquare } from 'lucide-react';
import { useGroupChat } from '../hooks/useGroupChat';
import type { ChatMessage } from '../types';
import Pill from './ui/Pill';
import { Skeleton } from './ui/Skeleton';
import { useToast } from './ui/Toast';
import { usePrefersReducedMotion } from '../lib/motion';
import { ChatBubble, ChatComposer, ChatDayDivider, ChatSystemLine, ChatTypingIndicator } from './challenge-detail/ChatParts';

interface GroupChatProps {
  challengeId: number;
}

export default function GroupChat({ challengeId }: GroupChatProps) {
  const { messages, historyLoaded, connected, realtimeUnavailable, typingUsers, sending, sendMessage, sendTyping } = useGroupChat(challengeId);
  const { showToast } = useToast();
  const reduced = usePrefersReducedMotion();

  const [input, setInput] = useState('');
  const [userScrolledUp, setUserScrolledUp] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const initialScrollDone = useRef(false);

  const scrollToBottom = (smooth = true) => {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth && !reduced ? 'smooth' : 'auto' });
  };

  // Follow new messages unless the reader has scrolled back through history.
  useEffect(() => {
    if (userScrolledUp) return;
    // Jump straight to the latest message when history first arrives; glide after that.
    scrollToBottom(initialScrollDone.current);
    if (messages.length > 0) initialScrollDone.current = true;
  }, [messages.length, typingUsers.length]);

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    setUserScrolledUp(el.scrollHeight - el.scrollTop - el.clientHeight > 96);
  };

  const handleSend = async () => {
    const text = input.trim();
    if (!text || sending) return;
    setInput('');
    sendTyping(false);
    const ok = await sendMessage(text);
    if (!ok) {
      setInput(text);
      showToast({ message: 'Message not sent. Check your connection and try again.', type: 'error' });
      return;
    }
    setUserScrolledUp(false);
    window.setTimeout(() => scrollToBottom(), 60);
  };

  const handleInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    setInput(event.target.value);
    sendTyping(event.target.value.length > 0);
  };

  const groups = messages.reduce<{ date: string; msgs: ChatMessage[] }[]>((acc, msg) => {
    const key = new Date(msg.created_at).toDateString();
    const last = acc[acc.length - 1];
    if (last && last.date === key) last.msgs.push(msg);
    else acc.push({ date: key, msgs: [msg] });
    return acc;
  }, []);

  const status = connected
    ? { label: 'Live', tone: 'success' as const, dot: 'live' as const }
    : realtimeUnavailable || historyLoaded
      ? { label: 'Updates every few seconds', tone: 'neutral' as const, dot: true }
      : { label: 'Connecting', tone: 'warning' as const, dot: true };

  return (
    <section
      aria-labelledby={`chat-title-${challengeId}`}
      className="flex h-[440px] flex-col overflow-hidden rounded-card border border-border-light bg-bg-card shadow-card"
    >
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border-light px-4 py-3">
        <h2 id={`chat-title-${challengeId}`} className="text-headline text-text-primary">
          Group chat
        </h2>
        <Pill tone={status.tone} dot={status.dot}>
          {status.label}
        </Pill>
      </header>

      <div className="relative min-h-0 flex-1">
        <div
          ref={containerRef}
          onScroll={handleScroll}
          className="h-full overflow-y-auto overscroll-contain px-4 pb-3"
          role="log"
          aria-live="polite"
          aria-label="Chat messages"
        >
          {!historyLoaded && messages.length === 0 ? (
            <div className="space-y-3 pt-4" aria-hidden>
              <Skeleton className="h-9 w-2/3 rounded-2xl" />
              <Skeleton className="ml-auto h-9 w-1/2 rounded-2xl" />
              <Skeleton className="h-9 w-3/5 rounded-2xl" />
            </div>
          ) : messages.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center px-6 text-center">
              <span className="mb-3 inline-flex h-11 w-11 items-center justify-center rounded-xl bg-bg-input text-text-secondary" aria-hidden>
                <MessageSquare size={20} />
              </span>
              <p className="text-callout font-medium text-text-primary">No messages yet</p>
              <p className="mt-1 text-caption text-text-muted">Cheer the group on or share how your walk went.</p>
            </div>
          ) : (
            groups.map((group) => (
              <div key={group.date}>
                <ChatDayDivider iso={group.msgs[0].created_at} />
                {group.msgs.map((msg, i) => {
                  if (msg.is_system) return <ChatSystemLine key={msg.id} content={msg.content} />;
                  const prev = group.msgs[i - 1];
                  const firstInRun = !prev || prev.is_system || prev.sender !== msg.sender;
                  return (
                    <ChatBubble
                      key={msg.id}
                      sender={msg.sender}
                      content={msg.content}
                      createdAt={msg.created_at}
                      mine={msg.is_mine}
                      firstInRun={firstInRun}
                    />
                  );
                })}
              </div>
            ))
          )}
          <ChatTypingIndicator names={typingUsers} />
        </div>

        {userScrolledUp && (
          <button
            type="button"
            onClick={() => {
              setUserScrolledUp(false);
              scrollToBottom();
            }}
            className="absolute bottom-3 left-1/2 inline-flex h-11 -translate-x-1/2 items-center gap-1.5 rounded-full border border-border-light bg-bg-elevated px-4 text-caption font-semibold text-text-primary shadow-raised"
          >
            <ArrowDown size={14} aria-hidden />
            Latest messages
          </button>
        )}
      </div>

      <ChatComposer ref={inputRef} value={input} onChange={handleInputChange} onSend={handleSend} sending={sending} />
    </section>
  );
}
