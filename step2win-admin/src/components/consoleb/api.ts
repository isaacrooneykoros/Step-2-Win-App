/**
 * API client for the admin console "Part B" features: announcements, help centre,
 * anti-cheat policy versions, scheduled-job pause / history, data export queue,
 * support desk actions, content moderation and trust tools.
 */
import { http, qs } from '../system/http'

// ── Announcements ──────────────────────────────────────────────────────────

export type Severity = 'info' | 'warning' | 'success'
export type Audience = 'all' | 'android' | 'ios' | 'web' | 'segment'
export type Segment = 'active_challenge' | 'paid_challenge' | 'new_users' | 'no_challenge_yet'
export type AnnouncementState = 'draft' | 'scheduled' | 'live' | 'ended' | 'archived'

export interface Announcement {
  id: number
  title: string
  body: string
  severity: Severity
  audience: Audience
  segment: Segment | null
  link_url: string | null
  link_label: string | null
  starts_at: string
  ends_at: string | null
  dismissible: boolean
  priority: number
  status: 'draft' | 'published' | 'archived'
  state: AnnouncementState
  published_at: string | null
  dismissals: number
  reach: number | null
  created_by: string | null
  updated_by: string | null
  created_at: string
  updated_at: string
}

export type AnnouncementInput = Partial<Pick<Announcement,
  'title' | 'body' | 'severity' | 'audience' | 'segment' | 'link_url' | 'link_label' | 'starts_at' | 'ends_at' | 'dismissible' | 'priority'>>

export const AUDIENCES: Array<{ value: Audience; label: string }> = [
  { value: 'all', label: 'Everyone' },
  { value: 'android', label: 'Android app' },
  { value: 'ios', label: 'iPhone app' },
  { value: 'web', label: 'Web app' },
  { value: 'segment', label: 'A group of customers' },
]
export const SEGMENTS: Array<{ value: Segment; label: string }> = [
  { value: 'active_challenge', label: 'In an active challenge' },
  { value: 'paid_challenge', label: 'In an active paid challenge' },
  { value: 'new_users', label: 'Joined in the last 14 days' },
  { value: 'no_challenge_yet', label: 'Never joined a challenge' },
]

// ── Help centre ────────────────────────────────────────────────────────────

export interface HelpCategory {
  id: number
  title: string
  description: string
  order: number
  is_published: boolean
  article_count: number
  published_count: number
  updated_at: string
}

export interface HelpArticle {
  id: number
  category: number
  category_title: string
  title: string
  body: string
  order: number
  is_published: boolean
  updated_by: string | null
  created_at: string
  updated_at: string
}

// ── Anti-cheat policy ──────────────────────────────────────────────────────

export type PolicyConfig = Record<string, Record<string, number | boolean>>

export interface AntiCheatPolicy {
  id: string
  version: string
  is_active: boolean
  description: string
  config: PolicyConfig
  created_at: string
  updated_at: string
}

// ── Ops ────────────────────────────────────────────────────────────────────

export interface JobRun {
  id: number
  trigger: string
  started_at: string
  finished_at: string | null
  status: string
  duration_ms: number | null
  error: string | null
  result: string | null
}

export type ExportStatus = 'pending' | 'running' | 'ready' | 'failed' | 'expired'

export interface DataExport {
  id: string
  user_id: number
  username: string | null
  status: ExportStatus
  status_label: string
  requested_at: string
  started_at: string | null
  finished_at: string | null
  expires_at: string | null
  attempts: number
  size_bytes: number
  download_count: number
  last_downloaded_at: string | null
  error: string | null
}

// ── Moderation ─────────────────────────────────────────────────────────────

export interface UserRef { id: number; username: string; is_active: boolean; deleted: boolean }

export interface FeedItem {
  id: number
  kind: string
  kind_label: string
  user: UserRef | null
  data: Record<string, unknown>
  created_at: string
  hidden: boolean
  hidden_at: string | null
  hidden_by: string | null
  hidden_reason: string | null
}

export interface ChatMessage {
  id: number
  challenge_id: number
  challenge_name: string
  user: UserRef | null
  message: string
  is_system: boolean
  created_at: string
  hidden: boolean
  hidden_at: string | null
  hidden_by: string | null
  hidden_reason: string | null
}

export interface TeamMember { user: UserRef | null; role: 'owner' | 'admin' | 'member'; joined_at: string }

// ── Trust ──────────────────────────────────────────────────────────────────

export interface LinkCluster {
  key: string
  size: number
  strong_pairs: number
  medium_pairs: number
  max_pair_score: number
  first_seen_at: string
  members: Array<{ user_id: number; username: string }>
}

export interface LinkageRun { id: number; started_at: string; finished_at: string | null; ok: boolean; stats: Record<string, unknown> }

export interface RiskModel {
  version: string
  kind: 'anomaly' | 'supervised'
  feature_version: string
  trained_on: string
  is_active: boolean
  metrics: Record<string, unknown>
  model_card: string
  created_at: string
}

export type RiskLabel = 'cheat' | 'honest' | 'unsure'

const enc = encodeURIComponent

export const consoleB = {
  // Announcements
  announcements: (status?: string) => http<{ results: Announcement[] }>(`/api/admin/content/announcements/${qs({ status })}`),
  createAnnouncement: (body: AnnouncementInput) => http<Announcement>('/api/admin/content/announcements/', { body }),
  updateAnnouncement: (id: number, body: AnnouncementInput) => http<Announcement>(`/api/admin/content/announcements/${id}/`, { method: 'PATCH', body }),
  deleteAnnouncement: (id: number) => http<void>(`/api/admin/content/announcements/${id}/`, { method: 'DELETE' }),
  publishAnnouncement: (id: number) => http<Announcement>(`/api/admin/content/announcements/${id}/publish/`, { method: 'POST', body: {} }),
  archiveAnnouncement: (id: number) => http<Announcement>(`/api/admin/content/announcements/${id}/archive/`, { method: 'POST', body: {} }),
  duplicateAnnouncement: (id: number) => http<Announcement>(`/api/admin/content/announcements/${id}/duplicate/`, { method: 'POST', body: {} }),

  // Help centre
  helpCategories: () => http<{ results: HelpCategory[] }>('/api/admin/content/help/categories/'),
  createHelpCategory: (body: Partial<HelpCategory>) => http<HelpCategory>('/api/admin/content/help/categories/', { body }),
  updateHelpCategory: (id: number, body: Partial<HelpCategory>) => http<HelpCategory>(`/api/admin/content/help/categories/${id}/`, { method: 'PATCH', body }),
  deleteHelpCategory: (id: number) => http<void>(`/api/admin/content/help/categories/${id}/`, { method: 'DELETE' }),
  reorderHelpCategories: (ids: number[]) => http<{ results: HelpCategory[] }>('/api/admin/content/help/categories/reorder/', { body: { ids } }),
  helpArticles: (category?: number) => http<{ results: HelpArticle[] }>(`/api/admin/content/help/articles/${qs({ category })}`),
  createHelpArticle: (body: Partial<HelpArticle>) => http<HelpArticle>('/api/admin/content/help/articles/', { body }),
  updateHelpArticle: (id: number, body: Partial<HelpArticle>) => http<HelpArticle>(`/api/admin/content/help/articles/${id}/`, { method: 'PATCH', body }),
  deleteHelpArticle: (id: number) => http<void>(`/api/admin/content/help/articles/${id}/`, { method: 'DELETE' }),
  reorderHelpArticles: (category: number, ids: number[]) => http<{ results: HelpArticle[] }>('/api/admin/content/help/articles/reorder/', { body: { category, ids } }),

  // Anti-cheat policy
  policies: () => http<{ active_version: string | null; default_config: PolicyConfig; results: AntiCheatPolicy[] }>('/api/admin/anticheat/policies/'),
  createPolicy: (body: { version: string; description: string; config: PolicyConfig }) => http<AntiCheatPolicy>('/api/admin/anticheat/policies/', { body }),
  activatePolicy: (id: string, reason: string) => http<AntiCheatPolicy>(`/api/admin/anticheat/policies/${id}/activate/`, { body: { reason } }),

  // Scheduled jobs
  pauseJob: (name: string, reason: string) => http<unknown>(`/api/admin/monitoring/jobs/${enc(name)}/pause/`, { body: { reason } }),
  resumeJob: (name: string) => http<unknown>(`/api/admin/monitoring/jobs/${enc(name)}/resume/`, { method: 'POST', body: {} }),
  jobRuns: (name: string) => http<{ name: string; results: JobRun[] }>(`/api/admin/monitoring/jobs/${enc(name)}/runs/`),

  // Data exports
  exports: (status?: string, q?: string) => http<{ counts: Record<ExportStatus, number>; results: DataExport[] }>(`/api/admin/privacy/exports/${qs({ status, q })}`),
  retryExport: (id: string) => http<DataExport>(`/api/admin/privacy/exports/${id}/retry/`, { method: 'POST', body: {} }),

  // Support desk
  outboundTicket: (body: { user_id: number; subject: string; message: string; category?: string; priority?: string }) =>
    http<{ id: number }>('/api/admin/support/tickets/outbound/', { body }),
  mergeTickets: (target: number, duplicateIds: number[]) =>
    http<{ id: number; merged: number[]; messages_moved: number }>(`/api/admin/support/tickets/${target}/merge/`, { body: { duplicate_ids: duplicateIds } }),
  bulkTickets: (ticketIds: number[], action: 'assign' | 'unassign' | 'close' | 'resolve' | 'reopen', assignedTo?: number) =>
    http<{ updated: number[] }>('/api/admin/support/tickets/bulk/', { body: { ticket_ids: ticketIds, action, assigned_to: assignedTo } }),
  renameTag: (id: number, name: string) => http<{ id: number; name: string }>(`/api/admin/support/tags/${id}/`, { method: 'PATCH', body: { name } }),

  // Moderation
  feed: (q?: string, hidden?: boolean) => http<{ results: FeedItem[] }>(`/api/admin/social/feed/${qs({ q, hidden: hidden ? 1 : undefined })}`),
  setFeedHidden: (id: number, hide: boolean, reason: string) =>
    http<FeedItem>(`/api/admin/social/feed/${id}/${hide ? 'hide' : 'unhide'}/`, { body: { reason } }),
  chatMessages: (q?: string, hidden?: boolean, challenge?: number) =>
    http<{ results: ChatMessage[] }>(`/api/admin/social/challenge-messages/${qs({ q, hidden: hidden ? 1 : undefined, challenge })}`),
  setChatHidden: (id: number, hide: boolean, reason: string) =>
    http<ChatMessage>(`/api/admin/social/challenge-messages/${id}/${hide ? 'hide' : 'unhide'}/`, { body: { reason } }),
  teamMembers: (teamId: number) => http<{ members: TeamMember[] }>(`/api/admin/social/teams/${teamId}/members/`),
  removeTeamMember: (teamId: number, userId: number, reason: string) =>
    http<{ members: TeamMember[] }>(`/api/admin/social/teams/${teamId}/members/${userId}/remove/`, { body: { reason } }),
  transferTeam: (teamId: number, userId: number, reason: string) =>
    http<{ members: TeamMember[] }>(`/api/admin/social/teams/${teamId}/transfer/`, { body: { user_id: userId, reason } }),
  deleteTeam: (teamId: number) => http<void>(`/api/admin/social/teams/${teamId}/`, { method: 'DELETE' }),
  resolveReport: (id: number, body: { status: 'actioned' | 'dismissed'; note: string; action?: string; feed_event_id?: number }) =>
    http<unknown>(`/api/admin/social/reports/${id}/resolve/`, { body }),

  // Trust tools
  clusters: (minSize = 2) => http<{ count: number; last_run: unknown; results: LinkCluster[] }>(`/api/admin/linkage/clusters/${qs({ min_size: minSize })}`),
  linkageRuns: () => http<{ results: LinkageRun[] }>('/api/admin/linkage/runs/'),
  riskModels: () => http<{ note: string; results: RiskModel[] }>('/api/admin/risk-ml/models/'),
  activateModel: (version: string, reason: string) => http<unknown>(`/api/admin/risk-ml/models/${enc(version)}/activate/`, { body: { reason } }),
  labelUserDays: (body: { user_id: number; date_start: string; date_end?: string; label: RiskLabel; notes?: string }) =>
    http<unknown>('/api/admin/risk-ml/labels/', { body }),
}
