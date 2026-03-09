import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LifeBuoy, MessageCircle, Plus, Send, User, Clock } from 'lucide-react';
import { Preferences } from '@capacitor/preferences';
import { supportService } from '../services/api';
import { useToast } from '../components/ui/Toast';
import { BaseModal } from '../components/ui/BaseModal';
import type { SupportCategory, SupportPriority, SupportStatus, SupportTicket } from '../types';

const LIMIT = 20;

export default function SupportScreen() {
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  const [statusFilter, setStatusFilter] = useState<'' | SupportStatus>('');
  const [offset, setOffset] = useState(0);

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createForm, setCreateForm] = useState({
    subject: '',
    category: 'general' as SupportCategory,
    priority: 'medium' as SupportPriority,
    message: '',
  });

  const [selectedTicketId, setSelectedTicketId] = useState<number | null>(null);
  const [replyText, setReplyText] = useState('');
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const ticketsQuery = useQuery({
    queryKey: ['support-tickets', statusFilter, offset],
    queryFn: () => supportService.getMyTickets({ status: statusFilter || undefined, limit: LIMIT, offset }),
    refetchInterval: 10000,
  });

  const detailQuery = useQuery({
    queryKey: ['support-ticket-detail', selectedTicketId],
    queryFn: () => supportService.getTicketDetail(selectedTicketId as number),
    enabled: selectedTicketId !== null,
    refetchInterval: selectedTicketId ? 5000 : false,
  });

  const createMutation = useMutation({
    mutationFn: () => supportService.createTicket(createForm),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['support-tickets'] });
      setShowCreateModal(false);
      setCreateForm({ subject: '', category: 'general', priority: 'medium', message: '' });
      showToast({ message: 'Support ticket submitted successfully', type: 'success' });
    },
    onError: (error: any) => {
      showToast({ message: error.response?.data?.error || 'Failed to submit ticket', type: 'error' });
    },
  });

  const replyMutation = useMutation({
    mutationFn: () => supportService.replyToTicket(selectedTicketId as number, replyText.trim()),
    onSuccess: () => {
      setReplyText('');
      queryClient.invalidateQueries({ queryKey: ['support-ticket-detail', selectedTicketId] });
      queryClient.invalidateQueries({ queryKey: ['support-tickets'] });
      showToast({ message: 'Reply sent successfully', type: 'success' });
    },
    onError: (error: any) => {
      showToast({ message: error.response?.data?.error || 'Failed to send reply', type: 'error' });
    },
  });

  const updateStatusMutation = useMutation({
    mutationFn: (newStatus: SupportStatus) => supportService.updateTicketStatus(selectedTicketId as number, newStatus),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['support-ticket-detail', selectedTicketId] });
      queryClient.invalidateQueries({ queryKey: ['support-tickets'] });
      showToast({ message: 'Ticket status updated successfully', type: 'success' });
    },
    onError: (error: any) => {
      showToast({ message: error.response?.data?.error || 'Failed to update ticket status', type: 'error' });
    },
  });

  const tickets = ticketsQuery.data?.results || [];
  const total = ticketsQuery.data?.total || 0;
  const currentPage = Math.floor(offset / LIMIT) + 1;
  const totalPages = Math.max(1, Math.ceil(total / LIMIT));

  const selectedTicket = detailQuery.data?.ticket;
  const selectedMessages = detailQuery.data?.messages || [];

  useEffect(() => {
    if (selectedTicketId !== null) {
      chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [selectedMessages, selectedTicketId]);

  useEffect(() => {
    if (!selectedTicketId) return;

    let socket: WebSocket | null = null;
    let cancelled = false;

    const connectSocket = async () => {
      const prefToken = (await Preferences.get({ key: 'access_token' })).value;
      const token = prefToken || localStorage.getItem('access_token');
      if (!token || cancelled) return;

      const apiBase = (import.meta.env.VITE_API_BASE_URL as string | undefined) || 'http://127.0.0.1:8000';
      const wsBase = apiBase.replace(/^http/, 'ws').replace(/\/$/, '');
      socket = new WebSocket(`${wsBase}/ws/support/tickets/${selectedTicketId}/?token=${encodeURIComponent(token)}`);
      wsRef.current = socket;

      socket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);

          if (data.type === 'support.message' && data.message) {
            queryClient.setQueryData(['support-ticket-detail', selectedTicketId], (oldData: any) => {
              if (!oldData) return oldData;
              const exists = (oldData.messages || []).some((message: any) => message.id === data.message.id);
              if (exists) return oldData;
              return {
                ...oldData,
                messages: [...(oldData.messages || []), data.message],
              };
            });
          }

          if (data.type === 'support.ticket' && data.ticket) {
            queryClient.setQueryData(['support-ticket-detail', selectedTicketId], (oldData: any) => {
              if (!oldData?.ticket) return oldData;
              return {
                ...oldData,
                ticket: {
                  ...oldData.ticket,
                  ...data.ticket,
                },
              };
            });
            queryClient.invalidateQueries({ queryKey: ['support-tickets'] });
          }
        } catch {
          // Ignore malformed websocket payloads
        }
      };
    };

    connectSocket();

    return () => {
      cancelled = true;
      socket?.close();
      wsRef.current = null;
    };
  }, [queryClient, selectedTicketId]);

  const getStatusClass = (status: SupportStatus) => {
    if (status === 'open') return 'bg-warning/20 text-warning border border-warning/30';
    if (status === 'in_progress') return 'bg-accent-blue/20 text-accent-blue border border-accent-blue/30';
    if (status === 'resolved') return 'bg-success/20 text-success border border-success/30';
    return 'bg-text-muted/20 text-text-muted border border-border';
  };

  const getPriorityClass = (priority: SupportPriority) => {
    if (priority === 'low') return 'bg-accent-blue/20 text-accent-blue border border-accent-blue/30';
    if (priority === 'medium') return 'bg-warning/20 text-warning border border-warning/30';
    if (priority === 'high') return 'bg-orange-100 text-orange-700 border border-orange-200';
    return 'bg-error/20 text-error border border-error/30';
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const handleCreateTicket = () => {
    if (!createForm.subject.trim() || !createForm.message.trim()) {
      showToast({ message: 'Subject and message are required', type: 'error' });
      return;
    }
    createMutation.mutate();
  };

  const handleReply = () => {
    if (!replyText.trim()) {
      showToast({ message: 'Reply message is required', type: 'error' });
      return;
    }
    replyMutation.mutate();
  };

  const handleReplyKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (!replyMutation.isPending && replyText.trim()) {
        handleReply();
      }
    }
  };

  const handleMarkResolved = () => {
    if (updateStatusMutation.isPending) return;
    updateStatusMutation.mutate('resolved');
  };

  const handleReopenTicket = () => {
    if (updateStatusMutation.isPending) return;
    updateStatusMutation.mutate('in_progress');
  };

  return (
    <div className="screen-enter pb-nav bg-bg-page">
      <div className="pt-safe px-4 pt-4 pb-3 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-black text-text-primary flex items-center gap-2">
            <LifeBuoy size={24} />
            Support
          </h1>
          <p className="text-sm text-text-muted mt-1">Create and track your support tickets</p>
        </div>
        <button
          onClick={() => setShowCreateModal(true)}
          className="btn-primary px-4 py-2.5 rounded-2xl text-sm flex items-center gap-2"
        >
          <Plus size={16} /> New
        </button>
      </div>

      <div className="px-4 pb-4">
        <div className="bg-bg-card rounded-2xl p-1.5 flex">
          {[
            { label: 'All', value: '' },
            { label: 'Open', value: 'open' },
            { label: 'In Progress', value: 'in_progress' },
            { label: 'Resolved', value: 'resolved' },
            { label: 'Closed', value: 'closed' },
          ].map((item) => (
            <button
              key={item.label}
              onClick={() => {
                setStatusFilter(item.value as '' | SupportStatus);
                setOffset(0);
              }}
              className={`flex-1 py-2 rounded-xl text-xs font-semibold ${
                statusFilter === item.value ? 'bg-white text-text-primary shadow-sm' : 'text-text-muted'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      <div className="px-4 pb-4">
        {ticketsQuery.isLoading ? (
          <div className="bg-white rounded-3xl overflow-hidden shadow-sm">
            {[1, 2, 3].map((i) => (
              <div key={i} className="p-4 border-b border-border last:border-b-0">
                <div className="skeleton h-5 rounded mb-2" />
                <div className="skeleton h-4 rounded w-2/3" />
              </div>
            ))}
          </div>
        ) : tickets.length === 0 ? (
          <div className="bg-white rounded-3xl p-10 text-center shadow-sm">
            <MessageCircle size={32} className="mx-auto text-text-muted mb-3" />
            <p className="text-text-secondary text-sm">No support tickets found</p>
          </div>
        ) : (
          <div className="bg-white rounded-3xl overflow-hidden shadow-sm">
            {tickets.map((ticket: SupportTicket, idx) => (
              <button
                key={ticket.id}
                onClick={() => setSelectedTicketId(ticket.id)}
                className={`w-full text-left p-4 ${idx < tickets.length - 1 ? 'border-b border-border' : ''}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-text-primary font-semibold text-sm truncate">#{ticket.id} {ticket.subject}</p>
                    <p className="text-text-muted text-xs mt-1 line-clamp-2">{ticket.message}</p>
                    <div className="mt-2 flex items-center gap-2">
                      <span className={`text-[11px] px-2 py-1 rounded-lg font-semibold ${getStatusClass(ticket.status)}`}>
                        {ticket.status.replace('_', ' ')}
                      </span>
                      <span className={`text-[11px] px-2 py-1 rounded-lg font-semibold ${getPriorityClass(ticket.priority)}`}>
                        {ticket.priority}
                      </span>
                    </div>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <p className="text-text-muted text-xs">{formatDate(ticket.updated_at)}</p>
                    <p className="text-text-muted text-xs mt-1">{ticket.message_count} msgs</p>
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {totalPages > 1 && (
        <div className="px-4 pb-6 flex items-center justify-between">
          <button
            onClick={() => setOffset(Math.max(0, offset - LIMIT))}
            disabled={offset === 0}
            className="btn-secondary px-4 py-2 rounded-xl disabled:opacity-40"
          >
            Previous
          </button>
          <span className="text-xs text-text-muted">Page {currentPage} of {totalPages}</span>
          <button
            onClick={() => setOffset(offset + LIMIT)}
            disabled={currentPage >= totalPages}
            className="btn-secondary px-4 py-2 rounded-xl disabled:opacity-40"
          >
            Next
          </button>
        </div>
      )}

      <BaseModal open={showCreateModal} onClose={() => setShowCreateModal(false)}>
        <h2 className="text-2xl font-black text-text-primary mb-2">New Support Ticket</h2>
        <p className="text-sm text-text-muted mb-6">Tell us your issue and we’ll respond in-app.</p>

        <div className="space-y-4 mb-6">
          <div>
            <label className="block text-sm font-semibold text-text-secondary mb-2">Subject</label>
            <input
              type="text"
              value={createForm.subject}
              onChange={(e) => setCreateForm((prev) => ({ ...prev, subject: e.target.value }))}
              className="input-field w-full"
              placeholder="e.g. Withdrawal pending for too long"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-semibold text-text-secondary mb-2">Category</label>
              <select
                value={createForm.category}
                onChange={(e) => setCreateForm((prev) => ({ ...prev, category: e.target.value as SupportCategory }))}
                className="input-field w-full"
              >
                <option value="general">General</option>
                <option value="account">Account</option>
                <option value="challenge">Challenge</option>
                <option value="payment">Payment</option>
                <option value="technical">Technical</option>
                <option value="other">Other</option>
              </select>
            </div>

            <div>
              <label className="block text-sm font-semibold text-text-secondary mb-2">Priority</label>
              <select
                value={createForm.priority}
                onChange={(e) => setCreateForm((prev) => ({ ...prev, priority: e.target.value as SupportPriority }))}
                className="input-field w-full"
              >
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-sm font-semibold text-text-secondary mb-2">Message</label>
            <textarea
              rows={5}
              value={createForm.message}
              onChange={(e) => setCreateForm((prev) => ({ ...prev, message: e.target.value }))}
              className="input-field w-full"
              placeholder="Describe the issue with as much detail as possible"
            />
          </div>
        </div>

        <div className="flex gap-3">
          <button
            onClick={() => setShowCreateModal(false)}
            className="flex-1 btn-secondary py-3 rounded-2xl"
          >
            Cancel
          </button>
          <button
            onClick={handleCreateTicket}
            disabled={createMutation.isPending}
            className="flex-1 btn-primary py-3 rounded-2xl disabled:opacity-40"
          >
            {createMutation.isPending ? 'Submitting...' : 'Submit Ticket'}
          </button>
        </div>
      </BaseModal>

      <BaseModal open={selectedTicketId !== null} onClose={() => setSelectedTicketId(null)}>
        {detailQuery.isLoading || !selectedTicket ? (
          <div className="py-8 text-center text-text-muted">Loading ticket…</div>
        ) : (
          <>
            <h2 className="text-xl font-black text-text-primary mb-2">#{selectedTicket.id} {selectedTicket.subject}</h2>
            <div className="flex items-center gap-2 mb-4">
              <span className={`text-[11px] px-2 py-1 rounded-lg font-semibold ${getStatusClass(selectedTicket.status)}`}>
                {selectedTicket.status.replace('_', ' ')}
              </span>
              <span className={`text-[11px] px-2 py-1 rounded-lg font-semibold ${getPriorityClass(selectedTicket.priority)}`}>
                {selectedTicket.priority}
              </span>
            </div>

            {/* Status Action Buttons */}
            {selectedTicket.status !== 'closed' && (
              <div className="mb-4 pb-4 border-b border-border">
                {selectedTicket.status === 'resolved' ? (
                  <button
                    onClick={handleReopenTicket}
                    disabled={updateStatusMutation.isPending}
                    className="w-full btn-secondary py-2.5 rounded-xl text-sm disabled:opacity-40"
                  >
                    {updateStatusMutation.isPending ? 'Updating...' : 'Reopen Ticket'}
                  </button>
                ) : (
                  <button
                    onClick={handleMarkResolved}
                    disabled={updateStatusMutation.isPending}
                    className="w-full btn-primary py-2.5 rounded-xl text-sm disabled:opacity-40"
                  >
                    {updateStatusMutation.isPending ? 'Updating...' : 'Mark as Resolved'}
                  </button>
                )}
              </div>
            )}

            <div className="max-h-80 overflow-y-auto bg-bg-input rounded-2xl p-3 mb-4">
              {selectedMessages.length === 0 ? (
                <p className="text-text-muted text-sm">No messages yet.</p>
              ) : (
                <div className="space-y-3">
                  {selectedMessages.map((message) => (
                    <div key={message.id} className={`flex ${message.is_admin ? 'justify-start' : 'justify-end'}`}>
                      <div className={`max-w-[85%] rounded-2xl p-3 ${message.is_admin ? 'bg-tint-blue' : 'bg-white border border-border'}`}>
                        <div className="flex items-center justify-between mb-1.5 gap-3">
                          <span className="text-xs font-semibold text-text-secondary flex items-center gap-1.5">
                            {message.is_admin ? <User size={13} /> : <Clock size={13} />}
                            {message.is_admin ? 'Support' : 'You'}
                          </span>
                          <span className="text-[11px] text-text-muted">{formatDate(message.created_at)}</span>
                        </div>
                        <p className="text-sm text-text-primary whitespace-pre-wrap">{message.message}</p>
                      </div>
                    </div>
                  ))}
                  <div ref={chatEndRef} />
                </div>
              )}
            </div>

            <div className="space-y-3">
              <textarea
                rows={3}
                value={replyText}
                onChange={(e) => setReplyText(e.target.value)}
                onKeyDown={handleReplyKeyDown}
                className="input-field w-full"
                placeholder="Write a message... (Enter to send, Shift+Enter for new line)"
              />
              <div className="flex gap-3">
                <button
                  onClick={() => setSelectedTicketId(null)}
                  className="flex-1 btn-secondary py-3 rounded-2xl"
                >
                  Close
                </button>
                <button
                  onClick={handleReply}
                  disabled={replyMutation.isPending || !replyText.trim()}
                  className="flex-1 btn-primary py-3 rounded-2xl disabled:opacity-40 flex items-center justify-center gap-2"
                >
                  <Send size={16} />
                  {replyMutation.isPending ? 'Sending...' : 'Send Reply'}
                </button>
              </div>
            </div>
          </>
        )}
      </BaseModal>
    </div>
  );
}
