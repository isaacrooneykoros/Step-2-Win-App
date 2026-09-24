import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, ChevronRight, LifeBuoy, MessageSquarePlus, RotateCcw, Send } from 'lucide-react';
import { Preferences } from '@capacitor/preferences';
import { supportService } from '../services/api';
import { resolveWsBaseUrl } from '../config/network';
import type { SupportCategory, SupportPriority, SupportStatus, SupportTicket, SupportTicketMessage } from '../types';
import { formatDateTime, formatRelativeTime } from '../lib/format';
import { ScreenHeader } from '../components/ui/ScreenHeader';
import { ListGroup } from '../components/ui/ListRow';
import { IconTile, Pill, type Tone } from '../components/ui/Pill';
import Button from '../components/ui/Button';
import Input, { TextArea } from '../components/ui/Input';
import { Sheet } from '../components/ui/Sheet';
import { Segmented } from '../components/ui/Segmented';
import { Skeleton } from '../components/ui/Skeleton';
import { EmptyState } from '../components/ui/EmptyState';
import { LoadError } from '../components/ui/ErrorState';
import { useToast } from '../components/ui/Toast';
import { apiErrorMessage } from '../components/settings/apiError';
import { usePollInterval } from '../hooks/useDataSaver';

const LIMIT = 20;

const STATUS: Record<SupportStatus, { label: string; tone: Tone }> = {
  open: { label: 'Open', tone: 'warning' },
  in_progress: { label: 'In progress', tone: 'info' },
  resolved: { label: 'Resolved', tone: 'success' },
  closed: { label: 'Closed', tone: 'neutral' },
};

const PRIORITY: Record<SupportPriority, { label: string; tone: Tone }> = {
  low: { label: 'Low', tone: 'neutral' },
  medium: { label: 'Medium', tone: 'neutral' },
  high: { label: 'High', tone: 'warning' },
  urgent: { label: 'Urgent', tone: 'danger' },
};

const CATEGORIES: Array<{ value: SupportCategory; label: string }> = [
  { value: 'general', label: 'General' },
  { value: 'account', label: 'Account' },
  { value: 'challenge', label: 'Challenge' },
  { value: 'payment', label: 'Payment' },
  { value: 'technical', label: 'Technical' },
  { value: 'other', label: 'Other' },
];

const categoryLabel = (c: SupportCategory) => CATEGORIES.find((x) => x.value === c)?.label ?? c;

const EMPTY_FORM = { subject: '', category: 'general' as SupportCategory, priority: 'medium' as SupportPriority, message: '' };

export default function SupportScreen() {
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const [offset, setOffset] = useState(0);
  const [showCreate, setShowCreate] = useState(false);
  const [selectedTicketId, setSelectedTicketId] = useState<number | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  const ticketsPoll = usePollInterval(10_000);
  const ticketsQuery = useQuery({
    queryKey: ['support-tickets', '', offset],
    queryFn: () => supportService.getMyTickets({ limit: LIMIT, offset }),
    refetchInterval: ticketsPoll,
  });

  const tickets = ticketsQuery.data?.results ?? [];
  const total = ticketsQuery.data?.total ?? 0;
  const currentPage = Math.floor(offset / LIMIT) + 1;
  const totalPages = Math.max(1, Math.ceil(total / LIMIT));
  const openTickets = tickets.filter((t) => t.status === 'open' || t.status === 'in_progress');
  const doneTickets = tickets.filter((t) => t.status === 'resolved' || t.status === 'closed');

  const openTicket = (id: number) => {
    setSelectedTicketId(id);
    setDetailOpen(true);
  };

  return (
    <div className="pb-nav">
      <ScreenHeader title="Support" back />

      <div className="mx-auto w-full max-w-2xl space-y-6 px-5 pb-8 pt-2">
        <section className="rounded-card border border-border-light bg-bg-card p-5 shadow-card">
          <div className="flex items-start gap-3">
            <IconTile icon={LifeBuoy} tone="brand" size="lg" />
            <div className="min-w-0 flex-1">
              <h2 className="text-headline text-text-primary">How can we help?</h2>
              <p className="mt-1 text-callout text-text-secondary">
                Questions about a challenge, a payment or your account? Send us a message — our team replies right here in the app.
              </p>
            </div>
          </div>
          <Button className="mt-4" fullWidth leftIcon={<MessageSquarePlus size={18} aria-hidden />} onClick={() => setShowCreate(true)}>
            Contact support
          </Button>
        </section>

        {ticketsQuery.isLoading ? (
          <div aria-busy="true" aria-label="Loading tickets">
            <Skeleton className="mb-2 h-3 w-24 rounded" />
            <div className="overflow-hidden rounded-card border border-border-light bg-bg-card">
              {[0, 1, 2].map((i) => (
                <div key={i} className="space-y-2 border-b border-border-light px-4 py-4 last:border-b-0">
                  <Skeleton className="h-4 w-2/3 rounded" />
                  <Skeleton className="h-3 w-1/3 rounded" />
                </div>
              ))}
            </div>
          </div>
        ) : ticketsQuery.isError ? (
          <LoadError resource="your tickets" onRetry={() => ticketsQuery.refetch()} isRetrying={ticketsQuery.isFetching} />
        ) : tickets.length === 0 ? (
          <EmptyState
            icon={MessageSquarePlus}
            title="No conversations yet"
            description="When you contact support, your messages and our replies will appear here."
          />
        ) : (
          <>
            {openTickets.length > 0 && <TicketGroup title="Open" tickets={openTickets} onOpen={openTicket} />}
            {doneTickets.length > 0 && <TicketGroup title="Resolved" tickets={doneTickets} onOpen={openTicket} />}
            {totalPages > 1 && (
              <nav className="flex items-center justify-between gap-3" aria-label="Ticket pages">
                <Button variant="secondary" size="sm" className="!h-11" onClick={() => setOffset(Math.max(0, offset - LIMIT))} disabled={offset === 0}>
                  Previous
                </Button>
                <span className="text-caption text-text-muted">
                  Page <span className="num">{currentPage}</span> of <span className="num">{totalPages}</span>
                </span>
                <Button variant="secondary" size="sm" className="!h-11" onClick={() => setOffset(offset + LIMIT)} disabled={currentPage >= totalPages}>
                  Next
                </Button>
              </nav>
            )}
          </>
        )}
      </div>

      <CreateTicketSheet
        open={showCreate}
        onClose={() => setShowCreate(false)}
        onCreated={() => {
          queryClient.invalidateQueries({ queryKey: ['support-tickets'] });
          showToast({ message: 'Message sent. We’ll reply here soon.', type: 'success' });
        }}
      />

      <TicketThreadSheet ticketId={selectedTicketId} open={detailOpen} onClose={() => setDetailOpen(false)} />
    </div>
  );
}

function TicketGroup({ title, tickets, onOpen }: { title: string; tickets: SupportTicket[]; onOpen: (id: number) => void }) {
  return (
    <ListGroup title={title}>
      {tickets.map((ticket) => {
        const status = STATUS[ticket.status];
        return (
          <button
            key={ticket.id}
            type="button"
            onClick={() => onOpen(ticket.id)}
            className="flex min-h-[64px] w-full items-center gap-3 px-4 py-3 text-left hover:bg-bg-input/60 active:!scale-100 active:bg-bg-input"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-body font-medium text-text-primary">{ticket.subject}</p>
              <p className="mt-0.5 truncate text-caption text-text-muted">
                #{ticket.id} · {categoryLabel(ticket.category)} · <span className="num">{ticket.message_count}</span>{' '}
                {ticket.message_count === 1 ? 'message' : 'messages'}
              </p>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1">
              <Pill tone={status.tone}>{status.label}</Pill>
              <span className="text-micro text-text-muted">{formatRelativeTime(ticket.updated_at)}</span>
            </div>
            <ChevronRight size={18} className="shrink-0 text-text-muted" aria-hidden />
          </button>
        );
      })}
    </ListGroup>
  );
}

/* ───────────── Create ticket ───────────── */

function CreateTicketSheet({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [errors, setErrors] = useState<{ subject?: string; message?: string; form?: string }>({});
  const [sent, setSent] = useState(false);

  const createMutation = useMutation({
    mutationFn: () => supportService.createTicket({ ...form, subject: form.subject.trim(), message: form.message.trim() }),
    onSuccess: () => {
      setSent(true);
      onCreated();
      window.setTimeout(() => {
        setSent(false);
        setForm(EMPTY_FORM);
        onClose();
      }, 800);
    },
    onError: (error: unknown) => setErrors({ form: apiErrorMessage(error, 'We couldn’t send your message. Please try again.') }),
  });

  const submit = () => {
    const next: typeof errors = {};
    if (!form.subject.trim()) next.subject = 'Add a short subject.';
    if (!form.message.trim()) next.message = 'Tell us what’s happening.';
    setErrors(next);
    if (Object.keys(next).length === 0) createMutation.mutate();
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      dismissible={!createMutation.isPending}
      title="Contact support"
      description="Include dates, amounts or challenge names — it helps us sort it out faster."
      footer={
        <div className="flex gap-3 pb-3">
          <Button variant="secondary" fullWidth onClick={onClose} disabled={createMutation.isPending}>
            Cancel
          </Button>
          <Button fullWidth onClick={submit} isLoading={createMutation.isPending} loadingText="Sending" isSuccess={sent} successText="Sent" leftIcon={<Send size={16} aria-hidden />}>
            Send
          </Button>
        </div>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        noValidate
      >
        <Input
          label="Subject"
          value={form.subject}
          onChange={(e) => setForm((p) => ({ ...p, subject: e.target.value }))}
          placeholder="e.g. Withdrawal still pending"
          error={errors.subject}
          maxLength={200}
        />

        <fieldset className="mb-4">
          <legend className="label">Topic</legend>
          <div className="flex flex-wrap gap-2">
            {CATEGORIES.map((c) => {
              const active = form.category === c.value;
              return (
                <button
                  key={c.value}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setForm((p) => ({ ...p, category: c.value }))}
                  className={[
                    'h-11 rounded-full border px-4 text-callout font-semibold',
                    active ? 'border-brand bg-brand-soft text-brand' : 'border-border bg-bg-card text-text-secondary hover:bg-bg-input',
                  ].join(' ')}
                >
                  {c.label}
                </button>
              );
            })}
          </div>
        </fieldset>

        <div className="mb-4">
          <p className="label">
            How urgent is it?
          </p>
          <Segmented<SupportPriority>
            label="Priority"
            value={form.priority}
            onChange={(priority) => setForm((p) => ({ ...p, priority }))}
            options={(Object.keys(PRIORITY) as SupportPriority[]).map((value) => ({ value, label: PRIORITY[value].label }))}
          />
        </div>

        <TextArea
          label="Message"
          rows={5}
          value={form.message}
          onChange={(e) => setForm((p) => ({ ...p, message: e.target.value }))}
          placeholder="Describe the problem and what you expected to happen."
          error={errors.message}
        />
        {errors.form && (
          <p className="rounded-control bg-danger-soft px-3 py-2 text-callout text-danger" role="alert">
            {errors.form}
          </p>
        )}
      </form>
    </Sheet>
  );
}

/* ───────────── Thread ───────────── */

function TicketThreadSheet({ ticketId, open, onClose }: { ticketId: number | null; open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const [replyText, setReplyText] = useState('');
  const chatEndRef = useRef<HTMLLIElement | null>(null);

  const threadPoll = usePollInterval(open && ticketId ? 5000 : false);
  const detailQuery = useQuery({
    queryKey: ['support-ticket-detail', ticketId],
    queryFn: () => supportService.getTicketDetail(ticketId as number),
    enabled: open && ticketId !== null,
    refetchInterval: threadPoll,
  });

  const ticket = detailQuery.data?.ticket;
  const messages = detailQuery.data?.messages ?? [];

  const replyMutation = useMutation({
    mutationFn: () => supportService.replyToTicket(ticketId as number, replyText.trim()),
    onSuccess: () => {
      setReplyText('');
      queryClient.invalidateQueries({ queryKey: ['support-ticket-detail', ticketId] });
      queryClient.invalidateQueries({ queryKey: ['support-tickets'] });
    },
    onError: (error: unknown) => showToast({ message: apiErrorMessage(error, 'Your reply didn’t send. Please try again.'), type: 'error' }),
  });

  const statusMutation = useMutation({
    mutationFn: (status: SupportStatus) => supportService.updateTicketStatus(ticketId as number, status),
    onSuccess: (_d, status) => {
      queryClient.invalidateQueries({ queryKey: ['support-ticket-detail', ticketId] });
      queryClient.invalidateQueries({ queryKey: ['support-tickets'] });
      showToast({ message: status === 'resolved' ? 'Marked as resolved.' : 'Conversation reopened.', type: 'success' });
    },
    onError: (error: unknown) => showToast({ message: apiErrorMessage(error, 'We couldn’t update this conversation.'), type: 'error' }),
  });

  // Keep the newest message in view.
  useEffect(() => {
    if (open) chatEndRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, open]);

  // Live updates while the thread is open.
  useEffect(() => {
    if (!open || !ticketId) return;
    let socket: WebSocket | null = null;
    let cancelled = false;

    const connect = async () => {
      const prefToken = (await Preferences.get({ key: 'access_token' })).value;
      const token = prefToken || localStorage.getItem('access_token');
      if (!token || cancelled) return;
      socket = new WebSocket(`${resolveWsBaseUrl()}/ws/support/tickets/${ticketId}/?token=${encodeURIComponent(token)}`);
      socket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'support.message' && data.message) {
            queryClient.setQueryData(['support-ticket-detail', ticketId], (old: any) => {
              if (!old) return old;
              if ((old.messages || []).some((m: SupportTicketMessage) => m.id === data.message.id)) return old;
              return { ...old, messages: [...(old.messages || []), data.message] };
            });
          }
          if (data.type === 'support.ticket' && data.ticket) {
            queryClient.setQueryData(['support-ticket-detail', ticketId], (old: any) =>
              old?.ticket ? { ...old, ticket: { ...old.ticket, ...data.ticket } } : old,
            );
            queryClient.invalidateQueries({ queryKey: ['support-tickets'] });
          }
        } catch {
          // Ignore malformed websocket payloads
        }
      };
    };
    void connect();
    return () => {
      cancelled = true;
      socket?.close();
    };
  }, [open, queryClient, ticketId]);

  const send = () => {
    if (!replyText.trim() || replyMutation.isPending) return;
    replyMutation.mutate();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  };

  const closed = ticket?.status === 'closed';
  const status = ticket ? STATUS[ticket.status] : null;

  return (
    <Sheet
      open={open}
      onClose={onClose}
      size="lg"
      title={ticket ? ticket.subject : 'Conversation'}
      description={
        ticket ? (
          <span className="flex flex-wrap items-center gap-1.5">
            {status && <Pill tone={status.tone}>{status.label}</Pill>}
            <Pill tone={PRIORITY[ticket.priority].tone}>{`${PRIORITY[ticket.priority].label} priority`}</Pill>
            <span className="text-caption text-text-muted">
              #{ticket.id} · {categoryLabel(ticket.category)}
            </span>
          </span>
        ) : undefined
      }
      footer={
        ticket && !closed ? (
          <div className="pb-3">
            <div className="flex items-end gap-2">
              <label htmlFor="support-reply" className="sr-only">
                Reply
              </label>
              <textarea
                id="support-reply"
                rows={1}
                value={replyText}
                onChange={(e) => setReplyText(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder="Write a reply…"
                className="input-field max-h-32 min-h-[44px] flex-1 resize-none py-2.5"
              />
              <Button onClick={send} isLoading={replyMutation.isPending} loadingText="" disabled={!replyText.trim()} aria-label="Send reply" className="!w-11 shrink-0 !px-0">
                <Send size={18} aria-hidden />
              </Button>
            </div>
            <div className="mt-2 flex items-center justify-between gap-2">
              <p className="text-micro text-text-muted">Enter to send · Shift+Enter for a new line</p>
              {ticket.status === 'resolved' ? (
                <Button variant="ghost" size="sm" className="!h-11" leftIcon={<RotateCcw size={14} aria-hidden />} onClick={() => statusMutation.mutate('in_progress')} isLoading={statusMutation.isPending} loadingText="Updating">
                  Reopen
                </Button>
              ) : (
                <Button variant="ghost" size="sm" className="!h-11" leftIcon={<CheckCircle2 size={14} aria-hidden />} onClick={() => statusMutation.mutate('resolved')} isLoading={statusMutation.isPending} loadingText="Updating">
                  Mark resolved
                </Button>
              )}
            </div>
          </div>
        ) : ticket && closed ? (
          <p className="pb-4 text-center text-caption text-text-muted">This conversation is closed. Contact support again if you still need help.</p>
        ) : undefined
      }
    >
      {detailQuery.isLoading || !ticket ? (
        detailQuery.isError ? (
          <LoadError resource="this conversation" onRetry={() => detailQuery.refetch()} isRetrying={detailQuery.isFetching} />
        ) : (
          <div className="space-y-3 py-2" aria-busy="true" aria-label="Loading conversation">
            <Skeleton className="h-16 w-3/4 rounded-2xl" />
            <Skeleton className="ml-auto h-12 w-2/3 rounded-2xl" />
          </div>
        )
      ) : (
        <ol className="space-y-3 py-1" aria-label="Messages">
          {messages.length === 0 && <li className="py-6 text-center text-callout text-text-muted">No messages yet.</li>}
          {messages.map((message) => (
            <li key={message.id} className={`flex ${message.is_admin ? 'justify-start' : 'justify-end'}`}>
              <div
                className={[
                  'max-w-[85%] rounded-2xl px-3.5 py-2.5',
                  message.is_admin ? 'rounded-bl-md bg-bg-input text-text-primary' : 'rounded-br-md bg-brand text-brand-fg',
                ].join(' ')}
              >
                <p className={`mb-0.5 text-micro font-semibold ${message.is_admin ? 'text-text-secondary' : 'text-brand-fg/80'}`}>
                  {message.is_admin ? 'Step2Win support' : 'You'}
                </p>
                <p className="whitespace-pre-wrap break-words text-callout">{message.message}</p>
                <p className={`mt-1 text-right text-micro ${message.is_admin ? 'text-text-muted' : 'text-brand-fg/70'}`}>
                  <time dateTime={message.created_at}>{formatDateTime(message.created_at)}</time>
                </p>
              </div>
            </li>
          ))}
          <li ref={chatEndRef} aria-hidden />
        </ol>
      )}
    </Sheet>
  );
}
