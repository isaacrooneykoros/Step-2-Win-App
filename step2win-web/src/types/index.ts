// ==================== User Types ====================

export interface User {
  id: number;
  username: string;
  email: string;
  phone_number?: string | null;
  daily_goal: number;
  stride_length_cm: number;
  weight_kg: number;
  calibration_quality?: 'excellent' | 'good' | 'noisy' | null;
  calibration_variance_pct?: number | null;
  last_calibrated_at?: string | null;
  wallet_balance: string;
  locked_balance: string;
  available_balance: string;
  device_bound: boolean;
  total_steps: number;
  challenges_won: number;
  challenges_joined: number;
  total_earned: string;
  current_streak: number;
  best_streak: number;
  best_day_steps: number;
  win_rate: number;
  avg_payout_kes: string;
  player_rank: 'Newcomer' | 'Challenger' | 'Competitor' | 'Veteran' | 'Elite' | 'Champion';
  member_since: string;
  trust_score?: number;
  trust_status?: 'GOOD' | 'WARN' | 'REVIEW' | 'RESTRICT' | 'SUSPEND' | 'BAN';
  created_at: string;
}

// ==================== Challenge Types ====================

export type MilestoneType = 50000 | 70000 | 90000;
export type ChallengeStatus = 'pending' | 'active' | 'completed' | 'cancelled';
export type ChallengeWinCondition = 'proportional' | 'winner_takes_all' | 'qualification_only';

export interface Challenge {
  id: number;
  name: string;
  description: string;
  creator: number;
  creator_username: string;
  milestone: MilestoneType;
  milestone_display: string;
  entry_fee: string;
  total_pool: string;
  max_participants: number;
  current_participants: number;
  user_steps?: number;
  user_payout?: number;
  user_rank?: number;
  status: ChallengeStatus;
  status_display: string;
  start_date: string;
  end_date: string;
  invite_code: string;
  is_private: boolean;
  win_condition: ChallengeWinCondition;
  win_condition_display?: string;
  theme_emoji: string;
  theme: 'blue' | 'green' | 'purple' | 'orange' | 'pink';
  days_remaining: number;
  is_full: boolean;
  created_at: string;
}

export interface ChallengeDetail extends Challenge {
  participants: Participant[];
  my_participation: Participant | null;
  platform_fee: string;
  net_pool: string;
}

export interface Participant {
  id: number;
  user: number;
  user_id?: number;  // Alias for compatibility
  username: string;
  steps: number;
  qualified: boolean;
  payout: string;
  estimated_payout?: string;  // For display during active challenges
  rank: number | null;
  joined_at: string;
  progress_percentage: number;
}

export interface ChallengeStats {
  challenge_id: number;
  challenge_name: string;
  status: ChallengeStatus;
  total_participants: number;
  qualified_count: number;
  qualification_rate: string;
  total_pool: string;
  platform_fee: string;
  net_pool: string;
  entry_fee: string;
  average_steps: number;
  top_performer: {
    username: string | null;
    steps: number;
  };
  milestone: MilestoneType;
  days_remaining: number;
  start_date: string;
  end_date: string;
}

export interface ChallengeMessage {
  id: number;
  user: number | null;
  username: string | null;
  message: string;
  is_system: boolean;
  event_type: string;
  created_at: string;
}

// ── New Chat Types for Real-Time Group Chat ──────────────────────────────────
export interface ChatMessage {
  id: number;
  sender: string;
  initials: string;
  content: string;
  created_at: string; // ISO string
  is_system: boolean;
  is_mine: boolean;
}

export type ChatEvent =
  | { type: 'history'; messages: ChatMessage[] }
  | ({ type: 'message' } & ChatMessage)
  | { type: 'typing'; username: string; is_typing: boolean }
  | { type: 'error'; error: string };

export interface ChallengeSocialStats {
  most_consistent: {
    username: string;
    days_active: number;
  } | null;
  biggest_single_day: {
    username: string;
    steps: number;
    date: string;
  } | null;
  most_improved: {
    username: string;
    improvement_percent: number;
  } | null;
}

export interface LobbyChallenge {
  id: number;
  name: string;
  status: 'pending' | 'active' | 'completed';
  milestone: number;
  milestone_label: string;
  entry_fee: string;
  total_pool: string;
  effective_pool_kes: string;
  max_participants: number;
  participant_count: number;
  spots_remaining: number;
  fill_percentage: number;
  is_almost_full: boolean;
  days_remaining: number;
  hours_remaining: number;
  is_starting_soon: boolean;
  is_featured: boolean;
  is_platform_challenge: boolean;
  platform_bonus_kes: string;
  theme: 'blue' | 'green' | 'purple' | 'orange' | 'pink';
  user_is_joined: boolean;
  invite_code: string;
  start_date: string;
  end_date: string;
}

export interface SpectatorParticipant {
  rank: number;
  username: string;
  avatar_initials: string;
  steps: number;
  steps_display: string;
  qualified: boolean;
  progress_pct: number;
  estimated_payout: number | null;
}

export interface SpectatorLeaderboard {
  challenge: {
    id: number;
    name: string;
    milestone: number;
    status: string;
    end_date: string;
    total_pool: string;
    entry_fee: string;
    theme: string;
  };
  leaderboard: SpectatorParticipant[];
  qualified_count: number;
  total_participants: number;
  user_is_participant: boolean;
}

export interface MyResultEntry {
  username: string;
  final_steps: number;
  final_rank: number | null;
  qualified: boolean;
  payout_kes: string;
  payout_method: 'proportional' | 'dead_heat' | 'tiebreaker' | 'refund' | 'no_payout';
  tied_with_count: number;
}

export interface MyRecentResults {
  has_results: boolean;
  message?: string;
  challenge?: {
    id: number;
    name: string;
    payout_structure: string;
    milestone: number;
    total_pool: string;
    net_pool: string;
    entry_fee: string;
    end_date: string;
  };
  my_result?: {
    final_steps: number;
    final_rank: number | null;
    qualified: boolean;
    payout_kes: string;
    payout_method: string;
    tied_with_count: number;
    tiebreaker_label: string;
    finalized_at: string | null;
  };
  leaderboard?: MyResultEntry[];
  summary?: {
    total_participants: number;
    qualified_count: number;
    is_refund: boolean;
  };
}

export type LobbyFilter = 'all' | 'joinable' | 'active' | 'ending_soon';
export type LobbySort = 'featured' | 'pool' | 'ending' | 'newest' | 'filling';
export type MilestoneFilter = 'all' | '50000' | '70000' | '90000';

// ==================== Wallet Types ====================

export type TransactionType = 'deposit' | 'withdrawal' | 'challenge_entry' | 'payout' | 'fee' | 'refund';
export type WithdrawalStatus = 'pending' | 'approved' | 'rejected' | 'processing';

export interface Transaction {
  id: number;
  user: number;
  user_username: string;
  type: TransactionType;
  type_display: string;
  amount: string;
  balance_before: string;
  balance_after: string;
  description: string;
  reference_id: string | null;
  metadata: Record<string, any> | null;
  created_at: string;
}

export interface Withdrawal {
  id: number;
  amount: string;
  account_details: string;
  status: WithdrawalStatus;
  status_display: string;
  rejection_reason: string;
  reference_number: string;
  created_at: string;
  processed_at: string | null;
}

export interface WalletSummary {
  balance: string;
  locked_balance: string;
  available_balance: string;
  total_deposited: string;
  total_withdrawn: string;
  total_earned: string;
}

// ==================== Steps Types ====================

export type StepSource = 'device_sensor' | 'health_connect' | 'google_fit' | 'apple_health' | 'manual';
export type StepsPeriod = '1d' | '1w' | '1m' | '3m' | '1y' | 'all';

export interface HealthRecord {
  id: number;
  date: string;
  source: StepSource;
  synced_at: string;
  steps: number;
  distance_km: number | null;
  calories_active: number | null;
  active_minutes: number | null;
  is_suspicious: boolean;
  approved_steps?: number;
  submitted_steps?: number;
  trust_score?: number;
  trust_status?: 'GOOD' | 'WARN' | 'REVIEW' | 'RESTRICT' | 'SUSPEND' | 'BAN';
  flags_raised?: number;
}

export interface HealthSummary {
  today_steps: number;
  today_goal: number;
  remaining_today: number;
  percent_complete: number;
  today_distance: number | null;
  today_calories: number | null;
  today_active_mins: number | null;
  week_total_steps: number;
  week_avg_steps: number;
  week_distance: number;
  week_calories: number;
  week_active_mins: number;
  best_day_steps: number;
}

export interface HourlyStep {
  hour: number;        // 0–23
  steps: number;
  distance_km: number;
  calories: number;
}

export interface LocationWaypoint {
  hour: number;
  recorded_at: string; // ISO datetime
  latitude: number;
  longitude: number;
  accuracy_m: number;
}

export interface DayDetail {
  date: string;
  total_steps: number;
  total_km: number;
  total_calories: number;
  active_minutes: number;
  peak_hour: number | null;
  peak_steps: number;
  hourly: HourlyStep[];
  waypoints: LocationWaypoint[];
  goal: number;
  goal_achieved: boolean;
}

// ==================== Auth Types ====================

export interface LoginCredentials {
  username: string;
  password: string;
}

export interface RegisterData {
  username: string;
  email: string;
  phone_number?: string;
  password: string;
  confirm_password: string;
}

export interface AuthResponse {
  access: string;
  refresh: string;
  user: User;
}

export interface ChangePasswordData {
  old_password: string;
  new_password: string;
  confirm_password: string;
}

// ==================== Device Types ====================

export interface DeviceBinding {
  device_id: string;
  platform: 'android' | 'ios';
}

export interface DeviceStatus {
  bound: boolean;
  platform: string | null;
  device_id: string | null;
  last_sync: string | null;
  last_sync_time: string | null;
}

// ==================== API Types ====================

export interface ApiError {
  error: boolean;
  message: string;
  details?: Record<string, string[]>;
}

export interface PaginatedResponse<T> {
  count: number;
  next: string | null;
  previous: string | null;
  results: T[];
}

// ==================== Form Types ====================

export interface CreateChallengeForm {
  name: string;
  description?: string;
  milestone: MilestoneType;
  entry_fee: number;
  max_participants: number;
  is_public: boolean;
  duration_days: number;
  win_condition?: ChallengeWinCondition;
  theme_emoji?: string;
}

export interface JoinChallengeForm {
  invite_code: string;
}

export interface DepositForm {
  amount: number;
  payment_method?: 'card' | 'bank' | 'paypal';
}

export interface WithdrawForm {
  amount: number;
  phone_number: string;
}

export interface StepSyncForm {
  steps: number;
  date: string;
  source: StepSource;
  distance_km?: number | null;
  calories_active?: number | null;
  active_minutes?: number | null;
  cadence_spm?: number | null;
  burst_steps_5s?: number | null;
}

// ==================== Support Types ====================

export type SupportStatus = 'open' | 'in_progress' | 'resolved' | 'closed';
export type SupportPriority = 'low' | 'medium' | 'high' | 'urgent';
export type SupportCategory = 'general' | 'account' | 'challenge' | 'payment' | 'technical' | 'other';

export interface SupportTicket {
  id: number;
  subject: string;
  category: SupportCategory;
  status: SupportStatus;
  priority: SupportPriority;
  message: string;
  admin_notes: string;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
  message_count: number;
}

export interface SupportTicketMessage {
  id: number;
  sender_username: string;
  is_admin: boolean;
  message: string;
  created_at: string;
}

export interface SupportTicketListResponse {
  total: number;
  results: SupportTicket[];
}

export interface SupportTicketDetailResponse {
  ticket: SupportTicket;
  messages: SupportTicketMessage[];
}

export interface CreateSupportTicketData {
  subject: string;
  category: SupportCategory;
  priority: SupportPriority;
  message: string;
}

// ==================== Legal Document Types ====================

export interface LegalDocument {
  id:             number;
  document_type:  string;
  title:          string;
  slug:           string;
  content_html:   string;
  version:        number;
  version_label:  string;
  notify_users:   boolean;
  change_summary: string;
  published_at:   string;
  has_update:     boolean;
  uploaded_file:  string | null;
}
