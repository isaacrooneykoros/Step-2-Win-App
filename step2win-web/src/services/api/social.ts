import api from './client';

/**
 * Social layer (friends, teams, weekly rankings, feed). Bragging rights only:
 * nothing here involves money. Backend: backend/apps/social (README.md there).
 */

export interface PublicUser {
  id: number;
  username: string;
  profile_picture_url: string | null;
}

export type Relationship = 'self' | 'friends' | 'outgoing' | 'incoming' | 'blocked' | 'none';
export type Discoverability = 'everyone' | 'friends_of_friends' | 'nobody';

export interface SocialMe {
  friend_code: string;
  discoverability: Discoverability;
  share_goal_hits: boolean;
  share_streaks: boolean;
  share_badges: boolean;
  share_challenges: boolean;
  show_in_rankings: boolean;
  notify_friend_requests: boolean;
  notify_weekly_results: boolean;
  notify_reactions: boolean;
  friends_count: number;
  incoming_requests: number;
  features: {
    social: boolean;
    teams: boolean;
    feed: boolean;
    max_team_members: number;
    max_teams_per_user: number;
    max_friends: number;
  };
}

export type SocialSettingsPatch = Partial<Omit<SocialMe, 'friend_code' | 'friends_count' | 'incoming_requests' | 'features'>>;

export interface Person extends PublicUser {
  relationship: Relationship;
}

export interface Friend extends PublicUser {
  since: string;
  week_steps: number;
}

export interface FriendRequestRow {
  id: number;
  user: PublicUser;
  created_at: string;
  via: string;
}

export interface FriendRankRow {
  rank: number;
  user: PublicUser;
  steps: number;
  days_counted: number;
  last_week_steps: number;
  last_week_rank: number | null;
  movement: number | null;
  is_me: boolean;
}

export interface FriendsLeaderboard {
  week_start: string;
  week_end: string;
  is_current_week: boolean;
  size: number;
  me: FriendRankRow | null;
  rows: FriendRankRow[];
}

export interface TeamRef {
  id: number;
  name: string;
  member_count: number;
  visibility: TeamVisibility;
}

export interface TeamRankRow {
  rank: number | null;
  team: TeamRef;
  steps: number;
  members_counted: number;
  last_week_steps: number;
  last_week_rank: number | null;
  movement: number | null;
  is_mine: boolean;
}

export interface TeamsLeaderboard {
  week_start: string;
  week_end: string;
  is_current_week: boolean;
  rows: TeamRankRow[];
  mine: TeamRankRow[];
}

export interface RankHistory {
  friends_wins: number;
  weeks: Array<{
    week_start: string;
    week_end: string;
    steps: number;
    friends_rank: number | null;
    friends_size: number | null;
    team: { team_id: number; team_name: string; rank: number; steps: number } | null;
  }>;
}

export type TeamVisibility = 'public' | 'invite_only';
export type TeamRole = 'owner' | 'admin' | 'member';

export interface TeamSummary {
  id: number;
  name: string;
  description: string;
  visibility: TeamVisibility;
  member_count: number;
  week_steps: number;
  my_role: TeamRole | null;
  is_disabled: boolean;
}

export interface TeamMemberRow {
  user: PublicUser;
  role: TeamRole;
  joined_at: string;
  steps: number | null;
  rank: number | null;
  is_me: boolean;
}

export interface TeamDetail extends TeamSummary {
  members: TeamMemberRow[];
  invite_code: string | null;
  disabled_reason: string;
  week_start: string;
}

export type FeedKind = 'goal_hit' | 'streak' | 'badge' | 'challenge_qualified' | 'weekly_winner';
export type ReactionKind = 'cheer' | 'fire' | 'strong' | 'clap';

export interface FeedItem {
  id: number;
  kind: FeedKind;
  user: PublicUser;
  is_me: boolean;
  data: Record<string, string | number | undefined>;
  created_at: string;
  reactions: Partial<Record<ReactionKind, number>>;
  my_reaction: ReactionKind | null;
}

export interface FeedPage {
  items: FeedItem[];
  next_before_id: number | null;
}

export type SocialNotificationKind =
  | 'friend_request'
  | 'friend_accepted'
  | 'weekly_results'
  | 'reaction'
  | 'team_role'
  | 'team_removed';

export interface SocialNotification {
  id: number;
  kind: SocialNotificationKind;
  actor: PublicUser | null;
  data: Record<string, unknown>;
  read: boolean;
  created_at: string;
}

export interface NotificationSummary {
  enabled: boolean;
  unread: number;
  latest_id: number | null;
  latest_kind?: SocialNotificationKind | null;
  pending_requests: number;
}

export type ReportReason = 'offensive_name' | 'harassment' | 'spam' | 'cheating' | 'other';
export type WeekParam = 'current' | 'previous';

export const socialService = {
  me: async () => (await api.get<SocialMe>('/api/social/me/')).data,
  updateMe: async (patch: SocialSettingsPatch) => (await api.patch<SocialMe>('/api/social/me/', patch)).data,
  resetFriendCode: async () => (await api.post<{ friend_code: string }>('/api/social/me/reset-code/')).data,

  search: async (q: string) => (await api.get<{ results: Person[] }>('/api/social/users/search/', { params: { q } })).data.results,
  userByCode: async (code: string) => (await api.get<Person>(`/api/social/users/code/${encodeURIComponent(code)}/`)).data,

  friends: async () => (await api.get<{ results: Friend[] }>('/api/social/friends/')).data.results,
  removeFriend: async (userId: number) => api.delete(`/api/social/friends/${userId}/`),
  requests: async () => (await api.get<{ incoming: FriendRequestRow[]; outgoing: FriendRequestRow[] }>('/api/social/friends/requests/')).data,
  sendRequest: async (target: { user_id: number } | { code: string }) =>
    (await api.post<{ status: 'sent' | 'already_sent' | 'accepted'; request_id: number | null; user: Person }>('/api/social/friends/requests/', target)).data,
  respond: async (requestId: number, action: 'accept' | 'decline' | 'cancel') =>
    (await api.post(`/api/social/friends/requests/${requestId}/${action}/`)).data,

  blocks: async () => (await api.get<{ results: Array<PublicUser & { blocked_at: string }> }>('/api/social/blocks/')).data.results,
  block: async (userId: number) => api.post('/api/social/blocks/', { user_id: userId }),
  unblock: async (userId: number) => api.delete(`/api/social/blocks/${userId}/`),
  report: async (payload: { target_type: 'user' | 'team'; user_id?: number; team_id?: number; reason: ReportReason; details?: string; block?: boolean }) =>
    (await api.post<{ status: string; blocked?: boolean }>('/api/social/reports/', payload)).data,

  friendsRanking: async (week: WeekParam = 'current') =>
    (await api.get<FriendsLeaderboard>('/api/social/rankings/friends/', { params: { week } })).data,
  teamsRanking: async (week: WeekParam = 'current') =>
    (await api.get<TeamsLeaderboard>('/api/social/rankings/teams/', { params: { week } })).data,
  history: async () => (await api.get<RankHistory>('/api/social/rankings/history/')).data,

  myTeams: async () => (await api.get<{ results: TeamSummary[] }>('/api/social/teams/')).data.results,
  discoverTeams: async (q = '') => (await api.get<{ results: TeamSummary[] }>('/api/social/teams/discover/', { params: q ? { q } : {} })).data.results,
  createTeam: async (payload: { name: string; description?: string; visibility: TeamVisibility }) =>
    (await api.post<TeamDetail>('/api/social/teams/', payload)).data,
  team: async (id: number, code?: string) =>
    (await api.get<TeamDetail>(`/api/social/teams/${id}/`, { params: code ? { code } : {} })).data,
  updateTeam: async (id: number, patch: Partial<Pick<TeamDetail, 'name' | 'description' | 'visibility'>>) =>
    (await api.patch<TeamDetail>(`/api/social/teams/${id}/`, patch)).data,
  disbandTeam: async (id: number) => api.delete(`/api/social/teams/${id}/`),
  teamAction: async (id: number, action: 'join' | 'leave' | 'reset-code' | 'transfer', body: Record<string, unknown> = {}) =>
    (await api.post<TeamDetail & { status?: string }>(`/api/social/teams/${id}/${action}/`, body)).data,
  joinTeamByCode: async (code: string) => (await api.post<TeamDetail>('/api/social/teams/join-by-code/', { code })).data,
  memberAction: async (teamId: number, userId: number, action: 'remove' | 'role', body: Record<string, unknown> = {}) =>
    (await api.post<TeamDetail>(`/api/social/teams/${teamId}/members/${userId}/${action}/`, body)).data,

  feed: async (before?: number | null) =>
    (await api.get<FeedPage>('/api/social/feed/', { params: before ? { before } : {} })).data,
  react: async (eventId: number, kind: ReactionKind | null) =>
    (await api.post<{ my_reaction: ReactionKind | null }>(`/api/social/feed/${eventId}/react/`, { kind })).data,

  notifications: async () => (await api.get<{ results: SocialNotification[] }>('/api/social/notifications/')).data.results,
  notificationSummary: async () => (await api.get<NotificationSummary>('/api/social/notifications/summary/')).data,
  markRead: async (ids?: number[]) => (await api.post('/api/social/notifications/read/', ids ? { ids } : {})).data,
};
