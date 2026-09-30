"""Which payout rules may be used for new challenges.

Rank-based cash payouts (winner takes all, top 3) reward whoever posts the biggest number,
which is the strongest incentive to cheat. They stay paused until payout holds and verified
steps are enforced in production; then turn on "Rank payouts" in the admin console
(Settings > Challenges). The server value RANK_PAYOUTS_ENABLED is the fallback used while
the console value is blank (apps/admin_api/business_rules.py).
Existing challenges keep the rule they were created with.
"""

RANK_PAYOUT_STRUCTURES = frozenset({"winner_takes_all", "top_3"})
# Customer-facing rules that decide payouts by rank, or that the payout code doesn't
# implement yet ("qualification only" currently pays proportionally).
UNAVAILABLE_WIN_CONDITIONS = frozenset({"winner_takes_all", "qualification_only"})

PAUSED_MESSAGE = (
    "Winner-takes-all and top-3 challenges are paused for now. Choose a proportional split."
)


def rank_payouts_enabled() -> bool:
    from apps.admin_api.business_rules import rank_payouts_enabled as enabled

    return enabled()


def allowed_win_conditions() -> list[str]:
    """Rules a customer may pick when creating a challenge."""
    if rank_payouts_enabled():
        return ["proportional", "winner_takes_all"]
    return ["proportional"]


def payout_structure_for(win_condition: str) -> str:
    """The payout rule the resolver actually uses, derived from the customer's choice."""
    return "winner_takes_all" if win_condition == "winner_takes_all" else "proportional"
