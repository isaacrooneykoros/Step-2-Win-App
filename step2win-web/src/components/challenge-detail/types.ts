/** Shape of GET /api/challenges/<id>/results/ (inspected from the live API). */
export interface ChallengeResultEntry {
  username: string;
  final_steps: number;
  final_rank: number | null;
  qualified: boolean;
  payout_kes: string;
  payout_method: 'proportional' | 'dead_heat' | 'tiebreaker' | 'refund' | 'no_payout' | string;
  tied_with_count: number;
  tiebreaker_level: number | null;
  tiebreaker_label: string;
  gps_verified_pct?: number;
  milestone_reached_at?: string | null;
}

export interface ChallengeResults {
  challenge: {
    id: number;
    name: string;
    payout_structure: string;
    milestone: number;
    total_pool: string;
    net_pool: string;
    entry_fee: string;
    start_date?: string;
    end_date?: string;
  };
  summary: {
    total_participants: number;
    qualified_count: number;
    is_refund: boolean;
    total_paid_out: string;
  };
  my_result: ChallengeResultEntry | null;
  leaderboard: ChallengeResultEntry[];
}
