// Account linkage (anti-cheat Phase 2a): /api/admin/linkage/.

export type LinkStrength = 'strong' | 'medium' | 'weak'

export interface LinkedAccount {
  user_id: number
  username: string
  joined: string | null
  is_active: boolean
  trust_status: string | null
  cluster: string | null
}

export interface LinkEdgeRow {
  id: number
  user_a: number
  user_b: number
  edge_type: string
  label: string
  strength: LinkStrength
  weight: number
  evidence: Record<string, unknown>
  explanation: string
  evidence_first_at: string | null
  evidence_last_at: string | null
  first_detected_at: string
  active: boolean
  household: boolean
}

export interface LinkPair {
  user_a: number
  user_b: number
  linked: boolean
  strong: boolean
  strong_types: string[]
  medium_types: string[]
  medium_sum: number
  weak_types: string[]
  score: number
  household: boolean
}

export interface HouseholdMarkRow {
  id: number
  user_a: number
  user_b: number
  usernames: Array<string | null>
  note: string
  created_by: string | null
  created_at: string
  active: boolean
  revoked_at: string | null
  revoked_by: string | null
  revoke_note: string
}

export interface LinkedHold {
  id: number
  user_id: number
  username: string | null
  challenge_id: number
  challenge_name: string
  amount: string
  status: string
  created_at: string
  linked_reason: Record<string, unknown> | null
}

export interface LinkedAccountsResponse {
  user_id: number
  cluster: {
    key: string
    size: number
    strong_pairs: number
    medium_pairs: number
    max_pair_score: number
    first_seen_at: string
    computed_at: string
  } | null
  accounts: LinkedAccount[]
  pairs: LinkPair[]
  edges: LinkEdgeRow[]
  households: HouseholdMarkRow[]
  holds: LinkedHold[]
  last_run: { finished_at: string; ok: boolean; seconds: number | null } | null
  policy_note: string
}

export type TimelineCategory = 'steps' | 'syncs' | 'devices' | 'flags' | 'trust' | 'admin' | 'money' | 'risk' | 'linkage'

export interface TimelineDay {
  date: string
  counted: number
  credited: number
  money_eligible: number
  unverified: number
  under_review: boolean
  syncs: number
  rejected_syncs: number
  flags: number
  risk_score: number | null
}

export interface TimelineEvent {
  at: string
  day: string
  category: TimelineCategory
  kind: string
  title: string
  detail: string
  tone: 'neutral' | 'info' | 'warning' | 'danger' | 'success'
  meta: Record<string, unknown>
}

export interface TimelineResponse {
  user_id: number
  start: string
  end: string
  categories: TimelineCategory[]
  days: TimelineDay[]
  events: TimelineEvent[]
}

export interface LinkageSettings {
  holds_enabled: boolean
  same_challenge_hold: boolean
  strong_link_paid_hold: boolean
  strong_link_paid_includes_payout_number: boolean
  paid_lookback_days: number
  behaviour_lookback_days: number
  medium_link_threshold: number
  network_max_accounts: number
  colocation_max_accounts: number
  business_number_min_accounts: number
  bounds: Record<string, [number, number]>
}
