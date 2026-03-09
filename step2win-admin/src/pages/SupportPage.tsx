import { useCallback, useEffect, useRef, useState } from 'react';
import { adminApi } from '../services/adminApi';
import type { SupportAdminUser, SupportTicket, SupportTicketMessage } from '../types/admin';
import { Headset, Search, Filter, MessageSquare, Clock, User } from 'lucide-react';

export function SupportPage() {
  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const [admins, setAdmins] = useState<SupportAdminUser[]>([]);

  const [statusFilter, setStatusFilter] = useState('');
  const [priorityFilter, setPriorityFilter] = useState('');
  const [assignedFilter, setAssignedFilter] = useState('');
  const [searchTerm, setSearchTerm] = useState('');

  const [offset, setOffset] = useState(0);
  const limit = 20;

  const [selectedTicket, setSelectedTicket] = useState<SupportTicket | null>(null);
  const [messages, setMessages] = useState<SupportTicketMessage[]>([]);
  const [replyText, setReplyText] = useState('');
  const [modalLoading, setModalLoading] = useState(false);

  const [editStatus, setEditStatus] = useState('');
  const [editPriority, setEditPriority] = useState('');
  const [editAssignedTo, setEditAssignedTo] = useState('');
  const [editNotes, setEditNotes] = useState('');
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const loadAdmins = useCallback(async () => {
    try {
      const response = await adminApi.getSupportAdmins();
      setAdmins(response.results || []);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  const loadTickets = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await adminApi.getSupportTickets({
        status: statusFilter || undefined,
        priority: priorityFilter || undefined,
        assigned_to: assignedFilter || undefined,
        q: searchTerm || undefined,
        limit,
        offset,
      });
      setTickets(response.results || []);
      setTotal(response.total || 0);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [assignedFilter, offset, priorityFilter, searchTerm, statusFilter]);

  useEffect(() => {
    loadAdmins();
  }, [loadAdmins]);

  useEffect(() => {
    loadTickets();
  }, [loadTickets]);

  useEffect(() => {
    if (!selectedTicket?.id) return;
    const ticketId = selectedTicket.id;
    const interval = setInterval(() => {
      loadTicketDetail(ticketId);
    }, 5000);
    return () => clearInterval(interval);
  }, [selectedTicket?.id]);

  useEffect(() => {
    if (!selectedTicket?.id) return;
    const ticketId = selectedTicket.id;

    const token = localStorage.getItem('admin_jwt');
    if (!token) return;

    const apiBase = import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:8000';
    const wsBase = apiBase.replace(/^http/, 'ws').replace(/\/$/, '');
    const socket = new WebSocket(`${wsBase}/ws/support/tickets/${ticketId}/?token=${encodeURIComponent(token)}`);
    wsRef.current = socket;

    socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        if (data.type === 'support.message' && data.message) {
          setMessages((prev) => {
            const exists = prev.some((message) => message.id === data.message.id);
            if (exists) return prev;
            return [...prev, data.message];
          });
        }

        if (data.type === 'support.ticket' && data.ticket) {
          setSelectedTicket((prev) => {
            if (!prev) return prev;
            return {
              ...prev,
              ...data.ticket,
            };
          });
          setTickets((prev) => prev.map((ticket) => (
            ticket.id === data.ticket.id ? { ...ticket, ...data.ticket } : ticket
          )));
        }
      } catch {
        // Ignore malformed websocket payloads
      }
    };

    return () => {
      socket.close();
      wsRef.current = null;
    };
  }, [selectedTicket?.id]);

  useEffect(() => {
    if (selectedTicket) {
      chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, selectedTicket]);

  const loadTicketDetail = async (ticketId: number) => {
    setModalLoading(true);
    try {
      const detail = await adminApi.getSupportTicketDetail(ticketId);
      setSelectedTicket(detail.ticket);
      setMessages(detail.messages || []);
      setEditStatus(detail.ticket.status);
      setEditPriority(detail.ticket.priority);
      setEditAssignedTo(detail.ticket.assigned_to ? String(detail.ticket.assigned_to) : '');
      setEditNotes(detail.ticket.admin_notes || '');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setModalLoading(false);
    }
  };

  const handleApplySearch = () => {
    setOffset(0);
    loadTickets();
  };

  const handleClearFilters = () => {
    setStatusFilter('');
    setPriorityFilter('');
    setAssignedFilter('');
    setSearchTerm('');
    setOffset(0);
  };

  const handleSaveTicket = async () => {
    if (!selectedTicket) return;
    try {
      await adminApi.updateSupportTicket(selectedTicket.id, {
        status: editStatus,
        priority: editPriority,
        assigned_to: editAssignedTo ? Number(editAssignedTo) : null,
        admin_notes: editNotes,
      });
      await loadTicketDetail(selectedTicket.id);
      await loadTickets();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleSendReply = async () => {
    if (!selectedTicket || !replyText.trim()) return;
    try {
      await adminApi.replySupportTicket(selectedTicket.id, replyText.trim());
      setReplyText('');
      await loadTicketDetail(selectedTicket.id);
      await loadTickets();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleReplyKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (replyText.trim()) {
        handleSendReply();
      }
    }
  };

  const getStatusColor = (status: string) => {
    const colors: Record<string, { bg: string; color: string }> = {
      open: { bg: '#7c2d12', color: '#fdba74' },
      in_progress: { bg: '#0e7490', color: '#67e8f9' },
      resolved: { bg: '#166534', color: '#86efac' },
      closed: { bg: '#374151', color: '#d1d5db' },
    };
    return colors[status] || { bg: '#2d3748', color: '#94a3b8' };
  };

  const getPriorityColor = (priority: string) => {
    const colors: Record<string, { bg: string; color: string }> = {
      low: { bg: '#1e3a8a', color: '#93c5fd' },
      medium: { bg: '#854d0e', color: '#fde68a' },
      high: { bg: '#9a3412', color: '#fdba74' },
      urgent: { bg: '#7f1d1d', color: '#fca5a5' },
    };
    return colors[priority] || { bg: '#2d3748', color: '#94a3b8' };
  };

  const formatDate = (date: string) => new Date(date).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });

  const currentPage = Math.floor(offset / limit) + 1;
  const totalPages = Math.ceil(total / limit);

  return (
    <div className="space-y-6">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h1 style={{ fontSize: '24px', fontWeight: 600, color: '#fff', marginBottom: '4px' }}>
            <Headset size={24} style={{ display: 'inline', marginRight: '8px', verticalAlign: 'middle' }} />
            Support System
          </h1>
          <p style={{ color: '#64748b', fontSize: '14px' }}>
            {total} tickets • Page {currentPage} of {totalPages || 1}
          </p>
        </div>
      </div>

      {error && (
        <div style={{ padding: '12px', background: '#7f1d1d', borderRadius: '6px', color: '#fca5a5' }}>
          {error}
        </div>
      )}

      <div className="stat-card">
        <h3 style={{ fontSize: '16px', fontWeight: 600, marginBottom: '16px', color: '#fff', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Filter size={18} />
          Filters
        </h3>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '16px' }}>
          <div>
            <label style={{ display: 'block', marginBottom: '8px', color: '#64748b', fontSize: '14px' }}>Search</label>
            <div style={{ position: 'relative' }}>
              <Search size={16} style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: '#64748b' }} />
              <input
                type="text"
                placeholder="Subject, username, email..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleApplySearch()}
                style={{ width: '100%', padding: '8px 12px 8px 36px', background: '#1a2332', border: '1px solid #2d3748', borderRadius: '6px', color: '#fff' }}
              />
            </div>
          </div>

          <div>
            <label style={{ display: 'block', marginBottom: '8px', color: '#64748b', fontSize: '14px' }}>Status</label>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              style={{ width: '100%', padding: '8px 12px', background: '#1a2332', border: '1px solid #2d3748', borderRadius: '6px', color: '#fff' }}
            >
              <option value="">All Statuses</option>
              <option value="open">Open</option>
              <option value="in_progress">In Progress</option>
              <option value="resolved">Resolved</option>
              <option value="closed">Closed</option>
            </select>
          </div>

          <div>
            <label style={{ display: 'block', marginBottom: '8px', color: '#64748b', fontSize: '14px' }}>Priority</label>
            <select
              value={priorityFilter}
              onChange={(e) => setPriorityFilter(e.target.value)}
              style={{ width: '100%', padding: '8px 12px', background: '#1a2332', border: '1px solid #2d3748', borderRadius: '6px', color: '#fff' }}
            >
              <option value="">All Priorities</option>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="urgent">Urgent</option>
            </select>
          </div>

          <div>
            <label style={{ display: 'block', marginBottom: '8px', color: '#64748b', fontSize: '14px' }}>Assignee</label>
            <select
              value={assignedFilter}
              onChange={(e) => setAssignedFilter(e.target.value)}
              style={{ width: '100%', padding: '8px 12px', background: '#1a2332', border: '1px solid #2d3748', borderRadius: '6px', color: '#fff' }}
            >
              <option value="">All</option>
              <option value="unassigned">Unassigned</option>
              {admins.map((admin) => (
                <option key={admin.id} value={admin.id}>{admin.username}</option>
              ))}
            </select>
          </div>
        </div>

        <div style={{ display: 'flex', gap: '12px', marginTop: '16px' }}>
          <button
            onClick={handleApplySearch}
            style={{ padding: '8px 16px', background: '#00f5e9', color: '#091120', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 600 }}
          >
            Apply Filters
          </button>
          <button
            onClick={handleClearFilters}
            style={{ padding: '8px 16px', background: '#2d3748', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer' }}
          >
            Clear All
          </button>
        </div>
      </div>

      <div className="stat-card" style={{ padding: 0, overflow: 'auto' }}>
        {loading ? (
          <div style={{ padding: '40px', textAlign: 'center', color: '#64748b' }}>Loading support tickets...</div>
        ) : tickets.length === 0 ? (
          <div style={{ padding: '40px', textAlign: 'center', color: '#64748b' }}>No support tickets found</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #2d3748', background: '#0f172a' }}>
                <th style={{ padding: '12px', textAlign: 'left', color: '#94a3b8', fontSize: '12px', fontWeight: 600 }}>Ticket</th>
                <th style={{ padding: '12px', textAlign: 'left', color: '#94a3b8', fontSize: '12px', fontWeight: 600 }}>User</th>
                <th style={{ padding: '12px', textAlign: 'left', color: '#94a3b8', fontSize: '12px', fontWeight: 600 }}>Status</th>
                <th style={{ padding: '12px', textAlign: 'left', color: '#94a3b8', fontSize: '12px', fontWeight: 600 }}>Priority</th>
                <th style={{ padding: '12px', textAlign: 'left', color: '#94a3b8', fontSize: '12px', fontWeight: 600 }}>Assignee</th>
                <th style={{ padding: '12px', textAlign: 'left', color: '#94a3b8', fontSize: '12px', fontWeight: 600 }}>Updated</th>
                <th style={{ padding: '12px', textAlign: 'left', color: '#94a3b8', fontSize: '12px', fontWeight: 600 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {tickets.map((ticket) => {
                const statusStyle = getStatusColor(ticket.status);
                const priorityStyle = getPriorityColor(ticket.priority);
                return (
                  <tr key={ticket.id} style={{ borderBottom: '1px solid #1a2332' }}>
                    <td style={{ padding: '12px', color: '#e2e8f0' }}>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                        <span style={{ fontWeight: 600 }}>#{ticket.id} {ticket.subject}</span>
                        <span style={{ color: '#64748b', fontSize: '12px' }}>{ticket.category} • {ticket.message_count} messages</span>
                      </div>
                    </td>
                    <td style={{ padding: '12px', color: '#e2e8f0' }}>{ticket.user_username}</td>
                    <td style={{ padding: '12px' }}>
                      <span style={{ padding: '4px 8px', borderRadius: '12px', background: statusStyle.bg, color: statusStyle.color, fontSize: '12px', textTransform: 'capitalize' }}>
                        {ticket.status.replace('_', ' ')}
                      </span>
                    </td>
                    <td style={{ padding: '12px' }}>
                      <span style={{ padding: '4px 8px', borderRadius: '12px', background: priorityStyle.bg, color: priorityStyle.color, fontSize: '12px', textTransform: 'capitalize' }}>
                        {ticket.priority}
                      </span>
                    </td>
                    <td style={{ padding: '12px', color: '#e2e8f0' }}>{ticket.assigned_to_username || 'Unassigned'}</td>
                    <td style={{ padding: '12px', color: '#94a3b8', fontSize: '13px' }}>{formatDate(ticket.updated_at)}</td>
                    <td style={{ padding: '12px' }}>
                      <button
                        onClick={() => loadTicketDetail(ticket.id)}
                        style={{ padding: '6px 10px', background: '#00f5e9', color: '#091120', border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: '12px', fontWeight: 600 }}
                      >
                        View
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {totalPages > 1 && (
        <div style={{ display: 'flex', justifyContent: 'center', gap: '8px' }}>
          <button
            onClick={() => setOffset(Math.max(0, offset - limit))}
            disabled={offset === 0}
            style={{ padding: '8px 12px', background: offset === 0 ? '#1a2332' : '#2d3748', color: '#fff', border: 'none', borderRadius: '6px', cursor: offset === 0 ? 'not-allowed' : 'pointer' }}
          >
            Previous
          </button>
          <span style={{ padding: '8px 12px', color: '#94a3b8' }}>Page {currentPage} of {totalPages}</span>
          <button
            onClick={() => setOffset(offset + limit)}
            disabled={currentPage >= totalPages}
            style={{ padding: '8px 12px', background: currentPage >= totalPages ? '#1a2332' : '#2d3748', color: '#fff', border: 'none', borderRadius: '6px', cursor: currentPage >= totalPages ? 'not-allowed' : 'pointer' }}
          >
            Next
          </button>
        </div>
      )}

      {selectedTicket && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(9,17,32,0.8)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: '20px' }}>
          <div className="stat-card" style={{ width: '100%', maxWidth: '1000px', maxHeight: '90vh', overflow: 'auto' }}>
            {modalLoading ? (
              <div style={{ padding: '24px', color: '#94a3b8' }}>Loading ticket...</div>
            ) : (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                  <h3 style={{ fontSize: '18px', fontWeight: 600, color: '#fff' }}>Ticket #{selectedTicket.id} • {selectedTicket.subject}</h3>
                  <button
                    onClick={() => setSelectedTicket(null)}
                    style={{ padding: '6px 10px', background: '#2d3748', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer' }}
                  >
                    Close
                  </button>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '20px' }}>
                  <div>
                    <p style={{ color: '#64748b', fontSize: '13px', marginBottom: '6px' }}>Status</p>
                    <select value={editStatus} onChange={(e) => setEditStatus(e.target.value)} style={{ width: '100%', padding: '8px 10px', background: '#1a2332', border: '1px solid #2d3748', borderRadius: '6px', color: '#fff' }}>
                      <option value="open">Open</option>
                      <option value="in_progress">In Progress</option>
                      <option value="resolved">Resolved</option>
                      <option value="closed">Closed</option>
                    </select>
                  </div>
                  <div>
                    <p style={{ color: '#64748b', fontSize: '13px', marginBottom: '6px' }}>Priority</p>
                    <select value={editPriority} onChange={(e) => setEditPriority(e.target.value)} style={{ width: '100%', padding: '8px 10px', background: '#1a2332', border: '1px solid #2d3748', borderRadius: '6px', color: '#fff' }}>
                      <option value="low">Low</option>
                      <option value="medium">Medium</option>
                      <option value="high">High</option>
                      <option value="urgent">Urgent</option>
                    </select>
                  </div>
                  <div>
                    <p style={{ color: '#64748b', fontSize: '13px', marginBottom: '6px' }}>Assign To</p>
                    <select value={editAssignedTo} onChange={(e) => setEditAssignedTo(e.target.value)} style={{ width: '100%', padding: '8px 10px', background: '#1a2332', border: '1px solid #2d3748', borderRadius: '6px', color: '#fff' }}>
                      <option value="">Unassigned</option>
                      {admins.map((admin) => (
                        <option key={admin.id} value={admin.id}>{admin.username}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <p style={{ color: '#64748b', fontSize: '13px', marginBottom: '6px' }}>User</p>
                    <div style={{ padding: '8px 10px', background: '#1a2332', border: '1px solid #2d3748', borderRadius: '6px', color: '#fff' }}>
                      {selectedTicket.user_username}
                    </div>
                  </div>
                </div>

                {selectedTicket.resolved_at && (
                  <div style={{ marginBottom: '20px', padding: '10px', background: '#166534', borderRadius: '8px', border: '1px solid #86efac' }}>
                    <p style={{ color: '#86efac', fontSize: '13px', margin: 0 }}>
                      ✓ Marked as resolved on {formatDate(selectedTicket.resolved_at)}
                    </p>
                  </div>
                )}

                <div style={{ marginBottom: '20px' }}>
                  <p style={{ color: '#64748b', fontSize: '13px', marginBottom: '6px' }}>Admin Notes</p>
                  <textarea
                    value={editNotes}
                    onChange={(e) => setEditNotes(e.target.value)}
                    rows={3}
                    style={{ width: '100%', padding: '10px', background: '#1a2332', border: '1px solid #2d3748', borderRadius: '6px', color: '#fff', resize: 'vertical' }}
                  />
                  <div style={{ marginTop: '10px' }}>
                    <button
                      onClick={handleSaveTicket}
                      style={{ padding: '8px 14px', background: '#00f5e9', color: '#091120', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 600 }}
                    >
                      Save Ticket Updates
                    </button>
                  </div>
                </div>

                <div style={{ marginBottom: '20px' }}>
                  <h4 style={{ fontSize: '15px', fontWeight: 600, color: '#fff', marginBottom: '10px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <MessageSquare size={16} /> Conversation
                  </h4>
                  <div style={{ maxHeight: '260px', overflow: 'auto', border: '1px solid #2d3748', borderRadius: '8px', padding: '10px', background: '#0f172a' }}>
                    {messages.length === 0 ? (
                      <p style={{ color: '#64748b' }}>No messages yet.</p>
                    ) : (
                      messages.map((message) => (
                        <div key={message.id} style={{ display: 'flex', justifyContent: message.is_admin ? 'flex-end' : 'flex-start', marginBottom: '12px' }}>
                          <div style={{ maxWidth: '80%', padding: '10px', background: message.is_admin ? '#083344' : '#1f2937', borderRadius: '10px' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px', gap: '10px' }}>
                              <span style={{ color: '#e2e8f0', fontWeight: 600, fontSize: '13px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                                {message.is_admin ? <User size={13} /> : <Clock size={13} />}
                                {message.is_admin ? 'You (Admin)' : 'User'}
                              </span>
                              <span style={{ color: '#94a3b8', fontSize: '12px' }}>{formatDate(message.created_at)}</span>
                            </div>
                            <p style={{ color: '#e2e8f0', margin: 0, whiteSpace: 'pre-wrap' }}>{message.message}</p>
                          </div>
                        </div>
                      ))
                    )}
                    <div ref={chatEndRef} />
                  </div>
                </div>

                <div>
                  <p style={{ color: '#64748b', fontSize: '13px', marginBottom: '6px' }}>Reply as Admin</p>
                  <textarea
                    value={replyText}
                    onChange={(e) => setReplyText(e.target.value)}
                    onKeyDown={handleReplyKeyDown}
                    rows={3}
                    placeholder="Write your response... (Enter to send, Shift+Enter for new line)"
                    style={{ width: '100%', padding: '10px', background: '#1a2332', border: '1px solid #2d3748', borderRadius: '6px', color: '#fff', resize: 'vertical' }}
                  />
                  <div style={{ marginTop: '10px', display: 'flex', justifyContent: 'flex-end' }}>
                    <button
                      onClick={handleSendReply}
                      style={{ padding: '8px 14px', background: '#00f5e9', color: '#091120', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 600 }}
                    >
                      Send Reply
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
