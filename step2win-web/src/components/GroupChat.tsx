import { useState, useRef } from 'react';
import { Send, Wifi, WifiOff, ChevronDown } from 'lucide-react';
import { useGroupChat } from '../hooks/useGroupChat';
import { ChatMessage } from '../types';

interface GroupChatProps {
  challengeId: number;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit' });
}

function formatDateDivider(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diff = Math.floor((now.getTime() - d.getTime()) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString('en-KE', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  });
}

export default function GroupChat({ challengeId }: GroupChatProps) {
  const { messages, connected, realtimeUnavailable, typingUsers, sending, sendMessage, sendTyping } =
    useGroupChat(challengeId);

  const statusText = connected ? 'Live' : realtimeUnavailable ? 'Fallback mode' : 'Reconnecting...';
  const statusColor = connected ? '#34D399' : realtimeUnavailable ? '#F59E0B' : '#F87171';
  const statusBg = connected ? '#ECFDF5' : realtimeUnavailable ? '#FFFBEB' : '#FEF2F2';

  const [input, setInput] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [userScrolledUp, setUserScrolledUp] = useState(false);

  const scrollToBottom = (behavior: ScrollBehavior = 'smooth') => {
    if (!messagesContainerRef.current) return;
    messagesContainerRef.current.scrollTo({
      top: messagesContainerRef.current.scrollHeight,
      behavior,
    });
  };

  // Check if user has scrolled up manually
  const handleScroll = () => {
    if (!messagesContainerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = messagesContainerRef.current;
    const isNearBottom = scrollHeight - scrollTop - clientHeight < 100;
    setUserScrolledUp(!isNearBottom);
  };

  const handleSend = async () => {
    const text = input.trim();
    if (!text || sending) return;
    setInput('');
    sendTyping(false);
    await sendMessage(text);
    // Force scroll to bottom after sending
    setUserScrolledUp(false);
    setTimeout(() => {
      scrollToBottom('smooth');
    }, 100);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setInput(e.target.value);
    sendTyping(e.target.value.length > 0);
  };

  // Group messages by date for dividers
  const groupedMessages = messages.reduce<
    { date: string; msgs: ChatMessage[] }[]
  >((acc, msg) => {
    const dateKey = new Date(msg.created_at).toDateString();
    const last = acc[acc.length - 1];
    if (last && last.date === dateKey) {
      last.msgs.push(msg);
    } else {
      acc.push({ date: dateKey, msgs: [msg] });
    }
    return acc;
  }, []);

  return (
    <div
      className="flex flex-col rounded-2xl overflow-hidden"
      style={{
        background: '#FFFFFF',
        boxShadow: '0 1px 4px rgba(0,0,0,0.07)',
        height: '420px',
      }}
    >
      {/* ── Chat Header ── */}
      <div
        className="flex items-center justify-between px-4 py-3 flex-shrink-0"
        style={{ borderBottom: '1px solid #F3F4F6' }}
      >
        <div className="flex items-center gap-2">
          <div
            className="w-7 h-7 rounded-lg flex items-center justify-center"
            style={{ background: '#EFF6FF' }}
          >
            <span style={{ fontSize: '14px' }}>💬</span>
          </div>
          <p className="text-[#111827] text-sm font-bold">Group Chat</p>
        </div>

        {/* Connection status pill */}
        <div
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-full"
          style={{ background: statusBg }}
        >
          {connected ? (
            <Wifi size={11} color="#34D399" />
          ) : (
            <WifiOff size={11} color={statusColor} />
          )}
          <span
            className="text-xs font-semibold"
            style={{ color: statusColor }}
          >
            {statusText}
          </span>
        </div>
      </div>

      {/* ── Messages list ── */}
      <div
        ref={messagesContainerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-1 relative"
      >
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full">
            <span style={{ fontSize: '32px', marginBottom: '8px' }}>👋</span>
            <p className="text-[#9CA3AF] text-sm font-medium">
              No messages yet — say hello!
            </p>
          </div>
        )}

        {groupedMessages.map((group) => (
          <div key={group.date}>
            {/* Date divider */}
            <div className="flex items-center gap-3 my-3">
              <div
                className="flex-1 h-px"
                style={{ background: '#F3F4F6' }}
              />
              <span className="text-[#9CA3AF] text-xs font-medium flex-shrink-0">
                {formatDateDivider(group.msgs[0].created_at)}
              </span>
              <div
                className="flex-1 h-px"
                style={{ background: '#F3F4F6' }}
              />
            </div>

            {group.msgs.map((msg, i) => {
              const isMe = msg.is_mine;
              const isSystem = msg.is_system;

              // System message — centered
              if (isSystem) {
                return (
                  <div key={msg.id} className="flex justify-center my-2">
                    <div
                      className="px-3 py-1.5 rounded-full text-xs font-medium"
                      style={{
                        background: '#FFFBEB',
                        color: '#D97706',
                        border: '1px solid #FDE68A',
                      }}
                    >
                      {msg.content}
                    </div>
                  </div>
                );
              }

              // Check if previous message is from same sender (for avatar grouping)
              const prevMsg = group.msgs[i - 1];
              const sameSenderAsPrev =
                prevMsg &&
                !prevMsg.is_system &&
                prevMsg.sender === msg.sender;
              const showSenderName = !isMe && !sameSenderAsPrev;

              return (
                <div
                  key={msg.id}
                  className={`flex items-end gap-2 ${
                    isMe ? 'flex-row-reverse' : 'flex-row'
                  } ${sameSenderAsPrev ? 'mt-0.5' : 'mt-3'}`}
                >
                  {/* Avatar — only on first message in a run */}
                  {!isMe && (
                    <div
                      className="w-7 h-7 rounded-full flex items-center justify-center
                                 text-white text-xs font-bold flex-shrink-0"
                      style={{
                        background: sameSenderAsPrev
                          ? 'transparent'
                          : '#4F9CF9',
                        visibility: sameSenderAsPrev ? 'hidden' : 'visible',
                      }}
                    >
                      {msg.initials}
                    </div>
                  )}

                  <div
                    className={`flex flex-col max-w-[70%] ${
                      isMe ? 'items-end' : 'items-start'
                    }`}
                  >
                    {/* Sender name — only on first in run */}
                    {showSenderName && (
                      <p className="text-[#9CA3AF] text-xs font-medium mb-1 px-1">
                        {msg.sender}
                      </p>
                    )}

                    {/* Bubble */}
                    <div
                      className="px-3 py-2 rounded-2xl"
                      style={{
                        background: isMe ? '#4F9CF9' : '#F3F4F6',
                        color: isMe ? '#FFFFFF' : '#111827',
                        borderBottomRightRadius: isMe ? '6px' : '16px',
                        borderBottomLeftRadius: isMe ? '16px' : '6px',
                        maxWidth: '100%',
                        wordBreak: 'break-word',
                      }}
                    >
                      <p className="text-sm leading-relaxed">{msg.content}</p>
                    </div>

                    {/* Timestamp */}
                    <p
                      className="text-[#9CA3AF] mt-0.5 px-1"
                      style={{ fontSize: '10px' }}
                    >
                      {formatTime(msg.created_at)}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        ))}

        {/* Typing indicator */}
        {typingUsers.length > 0 && (
          <div className="flex items-end gap-2 mt-2">
            <div
              className="w-7 h-7 rounded-full flex items-center justify-center
                            text-white text-xs font-bold flex-shrink-0"
              style={{ background: '#9CA3AF' }}
            >
              {typingUsers[0].slice(0, 1).toUpperCase()}
            </div>
            <div
              className="px-3 py-2 rounded-2xl flex items-center gap-1"
              style={{ background: '#F3F4F6' }}
            >
              {[0, 1, 2].map((dot) => (
                <div
                  key={dot}
                  className="w-1.5 h-1.5 rounded-full"
                  style={{
                    background: '#9CA3AF',
                    animation: `bounce 1.2s ${dot * 0.2}s infinite`,
                  }}
                />
              ))}
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />

        {/* Scroll to bottom button */}
        {userScrolledUp && (
          <button
            onClick={() => {
              setUserScrolledUp(false);
              scrollToBottom('smooth');
            }}
            className="sticky bottom-2 left-1/2 -translate-x-1/2 z-10 w-10 h-10 rounded-full flex items-center justify-center shadow-lg transition-all active:scale-95"
            style={{
              background: '#4F9CF9',
              boxShadow: '0 4px 12px rgba(79,156,249,0.4)',
            }}
          >
            <ChevronDown size={20} color="#FFFFFF" />
          </button>
        )}
      </div>

      {/* ── Input row ── */}
      <div
        className="px-3 py-3 flex items-center gap-2 flex-shrink-0"
        style={{ borderTop: '1px solid #F3F4F6' }}
      >
        <input
          ref={inputRef}
          value={input}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          placeholder="Type a message..."
          maxLength={1000}
          className="flex-1 px-4 py-2.5 rounded-xl text-sm text-[#111827]
                     outline-none placeholder:text-[#9CA3AF]"
          style={{
            background: '#F3F4F6',
            border: '1.5px solid transparent',
            transition: 'border-color 0.15s',
          }}
          onFocus={(e) => (e.target.style.borderColor = '#4F9CF9')}
          onBlur={(e) => (e.target.style.borderColor = 'transparent')}
        />
        <button
          onClick={handleSend}
          disabled={!input.trim() || sending}
          className="w-10 h-10 rounded-xl flex items-center justify-center
                     flex-shrink-0 transition-all active:scale-95"
          style={{
            background: input.trim() ? '#4F9CF9' : '#F3F4F6',
            boxShadow: input.trim()
              ? '0 2px 8px rgba(79,156,249,0.3)'
              : 'none',
          }}
        >
          <Send size={16} color={input.trim() ? '#FFFFFF' : '#9CA3AF'} />
        </button>
      </div>
    </div>
  );
}
