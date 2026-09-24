import { forwardRef, useId, type ChangeEvent, type KeyboardEvent } from 'react';
import { ArrowUp } from 'lucide-react';
import Avatar from '../ui/Avatar';
import { Spinner } from '../ui/Spinner';

export function formatChatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

export function formatChatDay(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((startOf(today) - startOf(date)) / 86_400_000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return date.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' });
}

export function ChatDayDivider({ iso }: { iso: string }) {
  return (
    <div className="my-3 flex items-center gap-3" role="separator" aria-label={formatChatDay(iso)}>
      <span className="h-px flex-1 bg-border-light" aria-hidden />
      <span className="text-micro font-semibold uppercase tracking-wide text-text-muted" aria-hidden>
        {formatChatDay(iso)}
      </span>
      <span className="h-px flex-1 bg-border-light" aria-hidden />
    </div>
  );
}

export function ChatSystemLine({ content }: { content: string }) {
  return <p className="mx-auto my-2 max-w-[85%] text-center text-caption text-text-muted">{content}</p>;
}

interface ChatBubbleProps {
  sender: string;
  content: string;
  createdAt: string;
  mine: boolean;
  /** First message in a run from this sender: shows avatar and name. */
  firstInRun: boolean;
}

export function ChatBubble({ sender, content, createdAt, mine, firstInRun }: ChatBubbleProps) {
  return (
    <div className={`flex items-end gap-2 ${mine ? 'justify-end' : 'justify-start'} ${firstInRun ? 'mt-3' : 'mt-1'}`}>
      {!mine && (
        <span className={`shrink-0 ${firstInRun ? '' : 'invisible'}`}>
          <Avatar name={sender} size="xs" />
        </span>
      )}
      <div className={`flex max-w-[78%] flex-col ${mine ? 'items-end' : 'items-start'}`}>
        {!mine && firstInRun && <span className="mb-1 px-1 text-caption font-medium text-text-secondary">{sender}</span>}
        <div
          className={[
            'rounded-[18px] px-3.5 py-2 text-callout text-text-primary [overflow-wrap:anywhere]',
            mine ? 'rounded-br-md bg-brand-soft' : 'rounded-bl-md bg-bg-input',
          ].join(' ')}
        >
          <span className="sr-only">{mine ? 'You' : sender}: </span>
          <span className="whitespace-pre-wrap">{content}</span>
        </div>
        <time dateTime={createdAt} className="num mt-0.5 px-1 text-micro text-text-muted">
          {formatChatTime(createdAt)}
        </time>
      </div>
    </div>
  );
}

export function ChatTypingIndicator({ names }: { names: string[] }) {
  if (names.length === 0) return null;
  const label =
    names.length === 1 ? `${names[0]} is typing` : names.length === 2 ? `${names[0]} and ${names[1]} are typing` : 'Several people are typing';
  return (
    <div className="mt-3 flex items-center gap-2" role="status" aria-live="polite">
      <span className="inline-flex h-7 items-center gap-1 rounded-full bg-bg-input px-3" aria-hidden>
        {[0, 1, 2].map((dot) => (
          <span
            key={dot}
            className="h-1.5 w-1.5 rounded-full bg-text-muted"
            style={{ animation: `bounce 1.2s ${dot * 0.15}s ease-in-out infinite` }}
          />
        ))}
      </span>
      <span className="text-caption text-text-muted">{label}</span>
    </div>
  );
}

interface ChatComposerProps {
  value: string;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onSend: () => void;
  sending: boolean;
  disabled?: boolean;
}

export const ChatComposer = forwardRef<HTMLInputElement, ChatComposerProps>(function ChatComposer(
  { value, onChange, onSend, sending, disabled = false },
  ref,
) {
  const inputId = useId();
  const canSend = value.trim().length > 0 && !sending && !disabled;
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (canSend) onSend();
    }
  };
  return (
    <form
      className="flex items-center gap-2 border-t border-border-light bg-bg-card px-3 py-2.5"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSend) onSend();
      }}
    >
      <label className="sr-only" htmlFor={inputId}>
        Message
      </label>
      <input
        id={inputId}
        ref={ref}
        value={value}
        onChange={onChange}
        onKeyDown={onKeyDown}
        placeholder="Message the group"
        maxLength={1000}
        autoComplete="off"
        disabled={disabled}
        enterKeyHint="send"
        // Keep the field clear of the bottom navigation when the keyboard scrolls it into view.
        className="h-11 min-w-0 flex-1 scroll-mb-[calc(var(--nav-height)+env(safe-area-inset-bottom)+24px)] rounded-full border border-transparent bg-bg-input px-4 text-callout text-text-primary outline-none placeholder:text-text-muted focus:border-brand disabled:opacity-60"
      />
      <button
        type="submit"
        disabled={!canSend}
        aria-label={sending ? 'Sending message' : 'Send message'}
        className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-brand text-brand-fg transition-colors duration-fast hover:bg-brand-hover disabled:bg-bg-input disabled:text-text-muted"
      >
        {sending ? <Spinner size={16} /> : <ArrowUp size={20} strokeWidth={2.25} aria-hidden />}
      </button>
    </form>
  );
});
