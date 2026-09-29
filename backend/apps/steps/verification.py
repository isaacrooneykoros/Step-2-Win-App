"""User-explainable verification breakdown per user-day ("why" panel).

Built from what the sync path records on HealthRecord (steps, last_raw_steps,
unverified_steps, is_suspicious, evidence tiers, anticheat bookkeeping). The output is
meant for the user ("why don't all my steps count toward challenges?"): plain, kind
wording, stable reason codes, and NO internal evidence (rule names, weights,
thresholds, risk scores) that would help someone tune a cheat.

Version 2 (Phase 1b) separates what counts for goals / streaks / XP (`goal_steps`,
every credited step) from what counts toward challenges (`challenge_steps`, the
money-eligible evidence tiers). Reason codes are stable; see backend/ANTICHEAT.md.
"""

from __future__ import annotations

from typing import Any

from .anti_cheat import DAILY_STEP_CAP

BREAKDOWN_VERSION = 2

# code -> severity. Severity is a UI hint: "positive" (verified parts), "info" (nothing
# to do / something the user can do), "review" (a person will look at it).
REASON_SEVERITY = {
    "walk_session_verified": "positive",
    "sensor_verified": "positive",
    "earlier_credit": "positive",
    "unverified_no_walking_evidence": "info",
    "unverified_motion": "info",
    "vehicle": "info",
    "device_not_verified": "info",
    "app_update_needed": "info",
    "faster_than_walking_pace": "info",
    "daily_limit": "info",
    "partly_verified": "info",
    "under_review": "review",
    "upload_not_verified": "review",
}


def _fmt(n: int) -> str:
    return f"{int(n):,}"


def _step_word(n: int) -> str:
    return "step" if int(n) == 1 else "steps"


def _steps(n: int) -> str:
    return f"{_fmt(n)} {_step_word(n)}"


def _unverified_message(code: str, n: int) -> str:
    s = _steps(n)
    were = "was" if int(n) == 1 else "were"
    return {
        "unverified_no_walking_evidence": (
            f"{s} {were} counted while your phone wasn't checking your walking (for "
            "example with the app closed for a long time). They count for your goals. "
            "Opening the app now and then, or starting a walk, helps your steps count "
            "toward challenges."
        ),
        "unverified_motion": (
            f"{s} came from movement that didn't look like walking, such as the phone "
            "being jiggled or resting on something that vibrates. They still count for "
            "your goals."
        ),
        "vehicle": (
            f"{s} {were} counted while you seemed to be travelling in a vehicle or on a "
            "bike. They still count for your goals, but not toward challenges."
        ),
        "device_not_verified": (
            f"{s} came from a phone we couldn't verify right now, so they count for your "
            "goals but not toward challenges."
        ),
        "app_update_needed": (
            f"{s} came from an app version that can't check walking yet. Update the app "
            "so your steps can count toward challenges. They still count for your goals."
        ),
    }[code]


def build_breakdown(record) -> dict[str, Any]:
    """Breakdown for one HealthRecord (a user-day)."""
    from .evidence import money_steps

    meta = record.anticheat or {}
    stored_steps = max(0, int(record.steps or 0))
    counted = max(int(record.last_raw_steps or 0), stored_steps)
    under_review = bool(record.is_suspicious)
    eligible = min(stored_steps, money_steps(record))
    challenge = 0 if under_review else eligible
    unverified = max(0, counted - challenge)
    legacy = record.eligible_steps is None  # never seen by Phase 1b: full credit
    tier_meta = meta.get("tiers") or {}
    full_credit = legacy or bool(tier_meta.get("full_credit"))

    tiers = {
        "walk_session": int(record.tier_walk_session or 0),
        "sensor_verified": int(record.tier_sensor_verified or 0),
        "wearable": int(record.tier_wearable or 0),
        "earlier_credit": stored_steps if legacy else int(record.tier_grandfathered or 0),
        "unverified": 0 if full_credit else int(record.tier_unverified or 0),
    }

    reasons: list[dict[str, Any]] = []

    def add(code: str, steps_affected: int | None, message: str) -> None:
        reasons.append(
            {
                "code": code,
                "steps_affected": steps_affected,
                "severity": REASON_SEVERITY[code],
                "user_message": message,
            }
        )

    if under_review:
        add(
            "under_review",
            stored_steps,
            "This day is under review, so its steps don't count toward challenges "
            "for now. You don't need to do anything.",
        )

    # What counts, and why (positive reasons first).
    if tiers["walk_session"]:
        n = tiers["walk_session"]
        add("walk_session_verified", n, f"{_steps(n)} from your walks were verified with GPS.")
    if tiers["sensor_verified"]:
        n = tiers["sensor_verified"]
        add(
            "sensor_verified",
            n,
            f"{_steps(n)} were confirmed as walking by your phone's motion sensors.",
        )
    if tiers["earlier_credit"] and stored_steps:
        n = min(stored_steps, tiers["earlier_credit"])
        add(
            "earlier_credit",
            n,
            f"{_steps(n)} counted before step verification started and count in full.",
        )

    # What counts for goals but not toward challenges.
    if not full_credit:
        for code, n in (tier_meta.get("unverified_reasons") or {}).items():
            n = int(n or 0)
            if n > 0 and code in REASON_SEVERITY:
                add(code, n, _unverified_message(code, n))

    pace = max(0, int(record.unverified_steps or 0))
    if pace:
        add(
            "faster_than_walking_pace",
            pace,
            f"{_steps(pace)} arrived faster than walking pace allows "
            "and weren't counted toward challenges.",
        )

    over_cap = max(0, int(meta.get("over_cap_steps", 0) or 0))
    if over_cap or counted > DAILY_STEP_CAP:
        affected = over_cap or max(0, counted - DAILY_STEP_CAP)
        add(
            "daily_limit",
            affected,
            f"Steps above {_fmt(DAILY_STEP_CAP)} in a day aren't counted toward "
            "challenges.",
        )

    reduced = max(0, int(meta.get("reduced_steps", 0) or 0))
    if reduced:
        add(
            "partly_verified",
            reduced,
            f"{_steps(reduced)} couldn't be fully verified, so "
            "they count only partly toward challenges.",
        )

    blocked = max(0, int(meta.get("blocked_uploads", 0) or 0))
    if blocked:
        add(
            "upload_not_verified",
            None,
            "An upload for this day couldn't be verified and wasn't counted."
            if blocked == 1
            else f"{blocked} uploads for this day couldn't be verified and weren't "
            "counted.",
        )

    return {
        "version": BREAKDOWN_VERSION,
        "date": str(record.date),
        "counted_steps": counted,
        "goal_steps": stored_steps,
        "challenge_steps": challenge,
        # v1 compatibility: "credited" always meant "counts toward challenges".
        "credited_steps": challenge,
        "unverified_steps": unverified,
        "under_review": under_review,
        "tiers": tiers,
        "reasons": reasons,
    }
