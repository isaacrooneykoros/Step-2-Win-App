export interface DashboardOverview {
  total_users?: number;
  user_growth_pct?: number;
  user_spark?: number[];
  revenue_kes?: number;
  revenue_growth_pct?: number;
  revenue_spark?: number[];
  live_challenges?: number;
  challenge_growth_pct?: number;
  challenge_spark?: number[];
  pending_withdrawals_count?: number;
  pending_withdrawals_amount?: number;
  revenue_chart?: Array<{ date: string; deposits: number; withdrawals: number }>;
  user_chart?: Array<{ date: string; users: number }>;
  step_chart?: Array<{ date: string; steps: number }>;
  challenges_active?: number;
  challenges_pending?: number;
  challenges_completed?: number;
  pending_withdrawals_list?: Array<{
    id: number;
    username: string;
    amount: number;
    phone: string;
    created_at: string;
  }>;
  recent_users?: Array<{
    id: number;
    username: string;
    email: string;
    joined: string;
  }>;
  users: {
    total: number;
    active_week: number;
    new_week: number;
  };
  finance: {
    week_deposits: string;
    week_withdrawals: string;
    pending_withdrawals: string;
  };
  challenges: {
    live: number;
    completed_month: number;
  };
  gamification: {
    xp_distributed_week: number;
  };
  timestamp: string;
}

export interface AdminUser {
  id: number;
  username: string;
  email: string;
  phone_number?: string;
  wallet_balance: string;
  total_steps: number;
  total_earned: string;
  is_active: boolean;
  is_staff: boolean;
  created_at?: string;
}

export interface AdminChallenge {
  id: number;
  name: string;
  status: 'pending' | 'active' | 'completed' | 'cancelled';
  creator: number;
  created_by_username: string;
  entry_fee: string;
  total_pool: string;
  current_entries: number;
  max_participants: number;
  milestone: number;
  start_date: string;
  end_date: string;
}

export interface AdminTransaction {
  id: number;
  user: number | null;
  user_username: string;
  type: 'deposit' | 'withdrawal' | 'challenge_entry' | 'payout' | 'fee' | 'refund';
  amount: string;
  balance_before: string;
  balance_after: string;
  description: string;
  reference_id: string | null;
  created_at: string;
}

export interface AdminWithdrawal {
  id: number;
  user: number;
  user_username: string;
  amount: string;
  account_details: string;
  status: 'pending' | 'approved' | 'rejected' | 'processing';
  rejection_reason: string;
  reference_number: string;
  created_at: string;
  processed_at: string | null;
}

export interface AdminBadge {
  id: number;
  slug: string;
  name: string;
  description: string;
  icon: string;
  badge_type: string;
  color: string;
  users_earned: number;
}

export interface AdminAuthUser {
  id: number;
  username: string;
  email: string;
  is_staff: boolean;
  is_active: boolean;
  profile_picture_url?: string | null;
}

export interface AdminAuthResponse {
  access: string;
  refresh: string;
  user: AdminAuthUser;
}

export interface SupportTicket {
  id: number;
  user: number;
  user_username: string;
  subject: string;
  category: 'general' | 'account' | 'challenge' | 'payment' | 'technical' | 'other';
  message: string;
  status: 'open' | 'in_progress' | 'resolved' | 'closed';
  priority: 'low' | 'medium' | 'high' | 'urgent';
  assigned_to: number | null;
  assigned_to_username: string | null;
  admin_notes: string;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
  message_count: number;
}

export interface SupportTicketMessage {
  id: number;
  ticket: number;
  sender: number | null;
  sender_username: string;
  is_admin: boolean;
  message: string;
  created_at: string;
}

export interface SupportTicketDetailResponse {
  ticket: SupportTicket;
  messages: SupportTicketMessage[];
}

export interface SupportAdminUser {
  id: number;
  username: string;
  email: string;
}

export interface AdminProfile {
  id: number;
  username: string;
  email: string;
  phone_number?: string | null;
  first_name?: string;
  last_name?: string;
  profile_picture?: string | null;
  profile_picture_url?: string | null;
  is_staff: boolean;
  is_superuser?: boolean;
  date_joined?: string;
  last_login?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface AdminNotificationItem {
  type: 'support_ticket' | 'withdrawal' | 'audit_log';
  title: string;
  message: string;
  created_at: string;
  action_url?: string;
  severity?: 'low' | 'medium' | 'high';
}

export interface AdminNotificationSummary {
  total: number;
  open_support_tickets: number;
  pending_withdrawals: number;
  recent_audit_items: number;
}

export interface AdminNotificationsResponse {
  summary: AdminNotificationSummary;
  items: AdminNotificationItem[];
}

export interface FraudFlag {
  id: number;
  user_username: string;
  user_email: string;
  flag_type: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  date: string;
  details: Record<string, unknown>;
  reviewed: boolean;
  actioned: boolean;
  created_at: string;
  last_action?:
    | 'dismiss'
    | 'warn'
    | 'restrict'
    | 'suspend'
    | 'ban'
    | 'unrestrict'
    | 'unsuspend'
    | 'unban';
  current_trust_score?: number;
  current_trust_status?: 'GOOD' | 'WARN' | 'REVIEW' | 'RESTRICT' | 'SUSPEND' | 'BAN';
}

export interface FraudOverview {
  open_flags: number;
  critical_unread: number;
  high_unread: number;
  restricted_users: number;
  suspended_users: number;
  banned_users: number;
  flags_today: number;
  recent_flags: FraudFlag[];
  reviewed_flags: FraudFlag[];
}

export interface WithdrawalQueueItem {
  id: string;
  user_id: number;
  username: string;
  email: string;
  phone: string;
  amount_kes: string;
  method: 'mpesa' | 'bank' | 'paybill';
  destination: string;
  status: 'pending_review' | 'approved' | 'processing' | 'completed' | 'rejected' | 'failed' | 'cancelled';
  created_at: string;
  age_hours: number;
}

export interface WithdrawalStats {
  pending_count: number;
  pending_total_kes: string;
  approved_today: number;
  completed_today: number;
  failed_today: number;
  total_paid_today: string;
}

export interface OpsDuplicateGatewayReference {
  mpesa_reference: string;
  c: number;
}

export interface OpsMonitoringMetrics {
  callback_total_24h: number;
  callback_failures_24h: number;
  callback_failure_rate_pct: number;
  unprocessed_callbacks: number;
  stuck_processing_withdrawals: number;
  stuck_pending_payments: number;
  negative_balance_users: number;
  duplicate_gateway_references: OpsDuplicateGatewayReference[];
  duplicate_request_rejections_today: Record<string, number>;
  withdrawal_queue: {
    count: number;
    oldest_age_hours: number;
  };
  fraud_open_flags: number;
}

export interface OpsMonitoringThresholds {
  max_stuck_processing: number;
  max_unprocessed_callbacks: number;
  max_negative_balance_users: number;
  max_callback_failure_rate_pct: number;
}

export interface OpsMonitoringResponse {
  timestamp: string;
  metrics: OpsMonitoringMetrics;
  thresholds: OpsMonitoringThresholds;
  breaches: string[];
  ok: boolean;
}
