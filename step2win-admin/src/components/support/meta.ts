import type { BadgeTone } from '../../lib/status'
import type { QueueTicket, QueueView, TicketCategory, TicketPriority, TicketStatus } from './api'

export const STATUS_LABEL: Record<TicketStatus, string> = {
  open: 'Open',
  in_progress: 'In progress',
  resolved: 'Resolved',
  closed: 'Closed',
}

export const STATUS_TONE: Record<TicketStatus, BadgeTone> = {
  open: 'warning',
  in_progress: 'info',
  resolved: 'success',
  closed: 'neutral',
}

export const PRIORITY_LABEL: Record<TicketPriority, string> = {
  urgent: 'Urgent',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
}

export const PRIORITY_TONE: Record<TicketPriority, BadgeTone> = {
  urgent: 'danger',
  high: 'danger',
  medium: 'warning',
  low: 'neutral',
}

export const CATEGORY_LABEL: Record<TicketCategory, string> = {
  general: 'General',
  account: 'Account',
  challenge: 'Challenge',
  payment: 'Payment',
  technical: 'Technical',
  other: 'Other',
}

export const VIEW_LABEL: Record<QueueView, string> = {
  awaiting: 'Needs reply',
  overdue: 'Overdue',
  active: 'Open',
  mine: 'Assigned to me',
  unassigned: 'Unassigned',
  resolved: 'Resolved',
  notices: 'Notices sent',
  all: 'All',
}

export const VIEW_EMPTY: Record<QueueView, { title: string; description: string }> = {
  awaiting: { title: 'No customer is waiting for a reply', description: 'Tickets appear here when a customer writes and staff have not answered yet.' },
  overdue: { title: 'Nothing is past its response target', description: 'Tickets waiting longer than the target for their priority (Settings > Support desk) appear here.' },
  active: { title: 'No open tickets', description: 'New tickets from the app land here.' },
  mine: { title: 'Nothing assigned to you', description: 'Replying to an unassigned ticket assigns it to you.' },
  unassigned: { title: 'Every open ticket has an owner', description: 'New tickets arrive unassigned unless auto-assignment is on.' },
  resolved: { title: 'No resolved tickets', description: 'Resolved and closed conversations are kept here.' },
  notices: { title: 'No notices sent', description: 'Messages sent to users from Trust & Safety decisions appear here.' },
  all: { title: 'No tickets', description: 'Tickets created in the app appear here.' },
}

/** Used only until the queue response (Settings > Support desk) arrives. */
export const DEFAULT_TARGET_HOURS: Record<TicketPriority, number> = {
  urgent: 2,
  high: 8,
  medium: 24,
  low: 48,
}

export type SlaState = 'breached' | 'due' | 'ok'

export function slaState(t: Pick<QueueTicket, 'waiting_on' | 'waiting_hours' | 'priority' | 'sla_target_hours'>): SlaState | null {
  if (t.waiting_on !== 'staff' || t.waiting_hours === null) return null
  const target = t.sla_target_hours ?? DEFAULT_TARGET_HOURS[t.priority] ?? 24
  if (t.waiting_hours >= target) return 'breached'
  if (t.waiting_hours >= target * 0.5) return 'due'
  return 'ok'
}

export const SLA_TEXT: Record<SlaState, string> = {
  breached: 'text-danger',
  due: 'text-warning',
  ok: 'text-ink-secondary',
}

/** Fill {username}, {ticket_id}, {subject}, {agent} in a saved reply. Unknown placeholders stay as typed. */
export function fillTemplate(body: string, vars: Record<string, string | number | null | undefined>): string {
  return body.replace(/\{(\w+)\}/g, (m, key: string) => {
    const v = vars[key]
    return v === undefined || v === null || v === '' ? m : String(v)
  })
}

export const TEMPLATE_VARIABLES = ['{username}', '{ticket_id}', '{subject}', '{agent}']