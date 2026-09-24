import { http, qs } from '../system/http'
import type { SupportAdminUser, SupportTicket, SupportTicketMessage } from '../../types/admin'

export type QueueView = 'active' | 'awaiting' | 'overdue' | 'mine' | 'unassigned' | 'resolved' | 'notices' | 'all'
export type TicketStatus = SupportTicket['status']
export type TicketPriority = SupportTicket['priority']
export type TicketCategory = SupportTicket['category']

export interface QueueTicket extends SupportTicket {
  is_notice: boolean
  user_email: string | null
  last_message_at: string | null
  last_message_is_admin: boolean | null
  last_message_preview: string
  first_staff_reply_at: string | null
  waiting_on: 'staff' | 'user' | null
  waiting_since: string | null
  waiting_hours: number | null
  age_hours: number | null
  tags: string[]
  /** Response target for this ticket's priority (Settings > Support desk). */
  sla_target_hours: number
  /** Waiting on staff longer than the target. */
  overdue: boolean
  /** The escalation job flagged this wait. */
  escalated: boolean
  escalated_at: string | null
}

export interface QueueResponse {
  view: QueueView
  total: number
  results: QueueTicket[]
  counts: Record<QueueView, number>
  urgent_active: number
  oldest_waiting_hours: number | null
  sla_hours: Record<TicketPriority, number>
}

export interface SupportTag { id: number; name: string; open_count: number; total_count: number }

export interface ReplyTemplate {
  id: number
  title: string
  body: string
  category: TicketCategory | null
  usage_count: number
  created_by: string | null
  created_at: string
  updated_at: string
}

export type ReplyTemplateInput = { title: string; body: string; category: TicketCategory | '' }

export interface TicketEvent {
  id: number
  admin_username: string
  action: string
  description: string
  changes: Record<string, { old: unknown; new: unknown }> | null
  created_at: string
}

export interface Conversation {
  ticket: QueueTicket
  messages: SupportTicketMessage[]
  events: TicketEvent[]
}

export interface QueueParams {
  view: QueueView
  status?: string
  priority?: string
  category?: string
  tag?: string
  assigned_to?: string
  q?: string
  sort?: string
  limit?: number
  offset?: number
}

export const supportApi = {
  queue: (p: QueueParams) => http<QueueResponse>(`/api/admin/support/queue/${qs({ ...p })}`),
  conversation: (id: number) => http<Conversation>(`/api/admin/support/tickets/${id}/conversation/`),
  reply: (id: number, message: string) =>
    http<{ message: string; reply: SupportTicketMessage }>(`/api/admin/support/tickets/${id}/reply/`, { body: { message } }),
  update: (id: number, data: Partial<{ status: TicketStatus; priority: TicketPriority; assigned_to: number | null; admin_notes: string }>) =>
    http<{ message: string; ticket: SupportTicket }>(`/api/admin/support/tickets/${id}/update/`, { body: data }),
  admins: () => http<{ results: SupportAdminUser[] }>('/api/admin/support/admins/'),
  tags: () => http<{ results: SupportTag[] }>('/api/admin/support/tags/'),
  deleteTag: (id: number) => http<void>(`/api/admin/support/tags/${id}/`, { method: 'DELETE' }),
  setTags: (id: number, tags: string[]) => http<{ id: number; tags: string[] }>(`/api/admin/support/tickets/${id}/tags/`, { body: { tags } }),
  templates: () => http<{ results: ReplyTemplate[] }>('/api/admin/support/templates/'),
  createTemplate: (data: ReplyTemplateInput) => http<ReplyTemplate>('/api/admin/support/templates/', { body: data }),
  updateTemplate: (id: number, data: Partial<ReplyTemplateInput>) =>
    http<ReplyTemplate>(`/api/admin/support/templates/${id}/`, { method: 'PATCH', body: data }),
  deleteTemplate: (id: number) => http<void>(`/api/admin/support/templates/${id}/`, { method: 'DELETE' }),
  templateUsed: (id: number) => http<{ ok: boolean }>(`/api/admin/support/templates/${id}/used/`, { method: 'POST' }),
}
