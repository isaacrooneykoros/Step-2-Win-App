"""User-explainable verification breakdown per user-day.

Built from what the sync path records on HealthRecord (steps, last_raw_steps,
unverified_steps, is_suspicious, anticheat bookkeeping). The output is meant for the
user ("why don't all my steps count?"): plain, kind wording, stable reason codes, and
NO internal evidence (rule names, weights, thresholds, risk scores) that would help
someone tune a cheat.

Reason codes are stable; see backend/ANTICHEAT.md ("User-facing reason codes").
"""

from __future__ import annotations

from typing import Any

from .anti_cheat import DAILY_STEP_CAP

BREAKDOWN_VERSION = 1

# code -> severity. Severity is a UI hint: "info" (nothing to do), "review" (a person
# will look at it / it is temporarily not counting).
REASON_SEVERITY = {
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


def build_breakdown(record) -> dict[str, Any]:
    """Breakdown for one HealthRecord (a user-day)."""
    meta = record.anticheat or {}
    stored_steps = max(0, int(record.steps or 0))
    counted = max(int(record.last_raw_steps or 0), stored_steps)
    under_review = bool(record.is_suspicious)
    credited = 0 if under_review else stored_steps
    unverified = max(0, counted - credited)

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

    pace = max(0, int(record.unverified_steps or 0))
    if pace:
        add(
            "faster_than_walking_pace",
            pace,
            f"{_fmt(pace)} {_step_word(pace)} arrived faster than walking pace allows "
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
            f"{_fmt(reduced)} {_step_word(reduced)} couldn't be fully verified, so "
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
        "credited_steps": credited,
        "unverified_steps": unverified,
        "under_review": under_review,
        "reasons": reasons,
    }
