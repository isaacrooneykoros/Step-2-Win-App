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
    # Phase 1c: Health Connect / Apple Health
    "wearable_verified": "positive",
    "workout_verified": "positive",
    "health_app_confirmed": "positive",
    "health_app_not_verified": "info",
    "manual_entry_not_counted": "info",
    "untrusted_app_not_counted": "info",
    "sources_disagree_under_review": "review",
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
        "health_app_not_verified": (
            f"{s} {were} recorded only by another health app on your phone. They count "
            "for your goals, but not toward challenges."
        ),
    }[code]


def _labels(origins, *, trust: str, kind: str | None = None, limit: int = 3) -> str:
    names = []
    for o in origins or []:
        if o.get("trust") != trust or (kind and o.get("kind") != kind):
            continue
        label = str(o.get("label") or "")[:40]
        # Unknown apps are shown by name only when it looks like a name, never a raw id.
        if trust == "untrusted" and ("." in label or not label):
            continue
        if label and label not in names:
            names.append(label)
    names = names[:limit]
    if not names:
        return ""
    if len(names) == 1:
        return names[0]
    return ", ".join(names[:-1]) + " and " + names[-1]


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
        "unverified": (
            min(stored_steps, int((meta.get("health") or {}).get("applied_phone_app_extra", 0) or 0))
            if full_credit
            else int(record.tier_unverified or 0)
        ),
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

    health = meta.get("health") or {}
    origins = health.get("origins") or []
    if health.get("disagreement"):
        n = int(health.get("withheld", 0) or 0)
        add(
            "sources_disagree_under_review",
            n,
            f"Your health app reported many more steps than your phone counted, so "
            f"{_steps(n)} from it aren't counted for now while we take a closer look. "
            "Your phone's own steps still count. You don't need to do anything.",
        )

    # What counts, and why (positive reasons first).
    if tiers["wearable"]:
        n = tiers["wearable"]
        names = _labels(origins, trust="trusted", kind="wearable")
        add(
            "wearable_verified",
            n,
            f"{_steps(n)} were recorded by your watch or fitness band"
            + (f" ({names})." if names else "."),
        )
    workout = min(int(health.get("workout_steps", 0) or 0), tiers["walk_session"])
    if tiers["walk_session"] - workout > 0:
        n = tiers["walk_session"] - workout
        add("walk_session_verified", n, f"{_steps(n)} from your walks were verified with GPS.")
    if workout > 0:
        labels = sorted({w.get("label") for w in health.get("workouts") or [] if w.get("verdict") == "verified" and w.get("label")})
        add(
            "workout_verified",
            workout,
            f"{_steps(workout)} from workouts"
            + (f" recorded in {', '.join(labels[:2])}" if labels else "")
            + " were verified with their GPS route.",
        )
    corroborated = min(int(health.get("corroborated", 0) or 0), tiers["sensor_verified"])
    if tiers["sensor_verified"] - corroborated > 0:
        n = tiers["sensor_verified"] - corroborated
        add(
            "sensor_verified",
            n,
            f"{_steps(n)} were confirmed as walking by your phone's motion sensors.",
        )
    if corroborated > 0:
        names = _labels(origins, trust="trusted", kind="phone_app")
        add(
            "health_app_confirmed",
            corroborated,
            f"{_steps(corroborated)} were confirmed by "
            + (names if names else "another health app on your phone")
            + ", which counted about the same steps at the same time.",
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
    else:
        # Even with full credit, steps only another phone app counted stay goals-only.
        n = int(health.get("applied_phone_app_extra", 0) or 0)
        if n > 0:
            add("health_app_not_verified", n, _unverified_message("health_app_not_verified", n))

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

    not_counted = health.get("not_counted") or {}
    manual = max(0, int(not_counted.get("manual", 0) or 0))
    if manual:
        add(
            "manual_entry_not_counted",
            manual,
            f"{_steps(manual)} {'was' if manual == 1 else 'were'} typed in by hand in a "
            "health app, so they aren't counted.",
        )
    untrusted = max(0, int(not_counted.get("untrusted", 0) or 0))
    if untrusted:
        names = _labels(origins, trust="untrusted")
        add(
            "untrusted_app_not_counted",
            untrusted,
            f"{_steps(untrusted)} came from "
            + (names if names else "apps")
            + " that Step2Win can't check yet, so they aren't counted.",
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
        # Phase 1c: which apps / devices contributed (labels only, no package ids for
        # apps we don't know). Empty without Health Connect / Apple Health.
        "sources": [
            {
                "label": o.get("label") if o.get("trust") == "trusted" or "." not in str(o.get("label") or "") else "Other app",
                "kind": o.get("kind"),
                "status": "counted" if o.get("trust") == "trusted" else "not_counted",
                "reason": o.get("trust"),
                "steps": int(o.get("steps", 0) or 0),
            }
            for o in origins
            if o.get("trust") in ("trusted", "manual", "untrusted")
        ],
    }
