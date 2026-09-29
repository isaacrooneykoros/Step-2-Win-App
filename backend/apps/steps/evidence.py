"""Phase 1b: walking evidence -> evidence tiers -> money-eligible steps.

Every credited step of a day falls in one tier:

- ``grandfathered``   credit the day already had when it first met Phase 1b (days and
                      part-days before the cut-over keep their credit in full).
- ``wearable``        reserved for Phase 1c (attested watch / band data).
- ``walk_session``    steps of a user-started walk the server verified (GPS route +
                      motion + consistency checks, apps/steps/walks.py).
- ``sensor_verified`` phone step-counter steps covered by on-device walking evidence
                      (Android: per-minute gait attribution uploaded as `evidence_hours`;
                      iOS: CoreMotion/HealthKit, Apple's motion coprocessor).
- ``unverified``      everything else: no evidence (app closed and nothing measuring,
                      old app version, web), motion that didn't look like walking,
                      vehicle travel, a device that failed integrity (when enforced).

Money-eligible = grandfathered + wearable + walk_session + sensor_verified, never more
than the day's credited steps. Goals / streaks / XP keep using all credited steps
(`HealthRecord.steps`). The server is the judge: client evidence is validated, capped
by what the day actually credited, and can only ever *lower* eligibility.

Also here: client time zone handling (day boundaries) and server-side active minutes.
"""

from __future__ import annotations

import math
from typing import Any

from django.conf import settings

TIERS = ("grandfathered", "wearable", "walk_session", "sensor_verified", "unverified")
ELIGIBLE_TIERS = ("grandfathered", "wearable", "walk_session", "sensor_verified")

# Client evidence buckets per local hour. They partition the phone counter's steps of
# that hour: verified (walking/running seen), shake (motion that didn't look like
# walking), unknown (no gait measured / inconclusive), vehicle (in a vehicle or on a
# bike per Activity Recognition), walk (inside a user-started walk session).
EVIDENCE_BUCKETS = ("verified", "shake", "unknown", "vehicle", "walk")
EVIDENCE_SOURCES = ("android_gait_v1", "ios_coremotion")
MAX_HOUR_STEPS = 20_000  # 4 steps/s * 3600 s = 14,400; generous headroom
MAX_STREAMS_PER_DAY = 6

# Time zones: minutes east of UTC. Real-world range UTC-12..UTC+14.
MIN_TZ_OFFSET_MIN = -12 * 60
MAX_TZ_OFFSET_MIN = 14 * 60
# Tolerance used in the velocity day-bound when the phone told us its offset.
KNOWN_OFFSET_TOLERANCE_HOURS = 0.5


def money_requires_evidence() -> bool:
    return bool(getattr(settings, "STEP_MONEY_REQUIRES_EVIDENCE", True))


def _int(value, lo: int = 0, hi: int = MAX_HOUR_STEPS) -> int:
    try:
        n = int(value)
    except (TypeError, ValueError):
        return 0
    return max(lo, min(hi, n))


# ── Payload validation ────────────────────────────────────────────────────────


def clean_evidence_hours(raw) -> list[dict[str, int]] | None:
    """Validate the client's per-hour evidence summary. None = not sent / unusable."""
    if not isinstance(raw, list) or not raw:
        return None
    by_hour: dict[int, dict[str, int]] = {}
    for item in raw[:48]:
        if not isinstance(item, dict):
            continue
        try:
            hour = int(item.get("hour"))
        except (TypeError, ValueError):
            continue
        if not 0 <= hour <= 23:
            continue
        entry = {b: _int(item.get(b)) for b in EVIDENCE_BUCKETS}
        total = sum(entry.values())
        if total > MAX_HOUR_STEPS:
            # Scale an impossible hour down proportionally (never trust the excess).
            factor = MAX_HOUR_STEPS / total
            entry = {b: int(v * factor) for b, v in entry.items()}
        entry["active_minutes"] = _int(item.get("active_minutes"), 0, 60)
        entry["gait_minutes"] = _int(item.get("gait_minutes"), 0, 60)
        entry["hour"] = hour
        by_hour[hour] = entry
    return [by_hour[h] for h in sorted(by_hour)] or None


def evidence_hour_total(entry: dict[str, int]) -> int:
    return sum(int(entry.get(b, 0) or 0) for b in EVIDENCE_BUCKETS)


def store_stream_evidence(meta: dict, stream_key: str, hours: list[dict[str, int]]) -> dict:
    """Keep the latest cumulative evidence per upload stream (one install / session).

    Each stream reports the day cumulatively, so its newest report replaces its older
    one. Different streams (reinstall, a second phone) are kept apart and merged per
    hour by `day_evidence` (the stream that saw most of that hour wins, never a sum, so
    two phones in one pocket can't double the evidence).
    """
    streams = dict(meta.get("evidence_streams") or {})
    streams[stream_key] = {str(h["hour"]): {k: v for k, v in h.items() if k != "hour"} for h in hours}
    if len(streams) > MAX_STREAMS_PER_DAY:
        # Drop the smallest streams (old sessions of the same install).
        ranked = sorted(
            streams.items(),
            key=lambda kv: sum(evidence_hour_total(v) for v in kv[1].values()),
            reverse=True,
        )
        streams = dict(ranked[:MAX_STREAMS_PER_DAY])
    meta["evidence_streams"] = streams
    return meta


def day_evidence(meta: dict) -> dict[int, dict[str, int]]:
    """Per hour, the evidence of the stream that covered most of that hour's steps."""
    best: dict[int, dict[str, int]] = {}
    for stream in (meta.get("evidence_streams") or {}).values():
        if not isinstance(stream, dict):
            continue
        for hour_key, entry in stream.items():
            try:
                hour = int(hour_key)
            except (TypeError, ValueError):
                continue
            if not isinstance(entry, dict):
                continue
            if hour not in best or evidence_hour_total(entry) > evidence_hour_total(best[hour]):
                best[hour] = entry
    return best


# ── Time zone ────────────────────────────────────────────────────────────────


def clean_tz_offset(value) -> int | None:
    try:
        n = int(value)
    except (TypeError, ValueError):
        return None
    if not MIN_TZ_OFFSET_MIN <= n <= MAX_TZ_OFFSET_MIN:
        return None
    return n


def resolve_day_offset(meta: dict, offset_minutes: int | None, tz_name: str | None) -> tuple[int | None, bool]:
    """The UTC offset used for this day's boundaries.

    The phone reports its offset with every sync. A day keeps its first offset; one
    change per day is accepted (travel, a DST switch). Further changes keep the most
    conservative offset seen (the smallest: least time elapsed since local midnight)
    and return hopping=True so the caller records a LOW flag. Returns (offset, hopping).
    """
    tz = dict(meta.get("tz") or {})
    current = tz.get("offset")
    if offset_minutes is None:
        return (int(current) if current is not None else None), False
    hopping = False
    if current is None:
        tz = {"offset": offset_minutes, "name": (tz_name or "")[:64], "changes": 0, "seen": [offset_minutes]}
    elif int(current) != offset_minutes:
        changes = int(tz.get("changes", 0)) + 1
        seen = list(tz.get("seen") or [int(current)])
        if offset_minutes not in seen:
            seen.append(offset_minutes)
        tz["seen"] = seen[-8:]
        tz["changes"] = changes
        if changes == 1:
            tz["offset"] = offset_minutes
            tz["name"] = (tz_name or "")[:64]
        else:
            tz["offset"] = min(seen)
            hopping = True
    meta["tz"] = tz
    return int(tz["offset"]), hopping


# ── Active minutes (server-computed) ──────────────────────────────────────────


def server_active_minutes(hourly_steps: dict[int, int], evidence: dict[int, dict[str, int]], day_steps: int) -> int:
    """Active minutes from the hourly buckets and the evidence, never from the client.

    Per hour: the minutes the phone saw steps in (evidence), bounded by what the hour's
    steps make plausible (>= 1 minute per 240 steps, <= 1 minute per 30 steps, <= 60).
    Without evidence for an hour: steps / 100 (a moderate walking pace). Without any
    hourly data: the day total / 100.
    """
    hours = set(hourly_steps) | set(evidence)
    if not hours:
        return min(1440, math.ceil(max(0, day_steps) / 100)) if day_steps > 0 else 0
    total = 0
    for hour in hours:
        steps_h = max(int(hourly_steps.get(hour, 0) or 0), evidence_hour_total(evidence.get(hour) or {}))
        if steps_h <= 0:
            continue
        lo = math.ceil(steps_h / 240)
        hi = min(60, max(1, math.ceil(steps_h / 30)))
        measured = int((evidence.get(hour) or {}).get("active_minutes", 0) or 0)
        estimate = measured if measured > 0 else math.ceil(steps_h / 100)
        total += max(lo, min(hi, estimate, 60))
    return min(1440, total)


# ── Tiers ─────────────────────────────────────────────────────────────────────


def compute_tiers(
    *,
    credited: int,
    grandfathered: int,
    evidence_source: str | None,
    evidence: dict[int, dict[str, int]],
    walk_verified: int,
    walk_gait_fallback: int,
    server_vehicle_hours: set[int] | None = None,
    integrity_blocked: bool = False,
) -> dict[str, Any]:
    """Split a day's credited steps into tiers. Pure function (tested directly).

    credited            HealthRecord.steps (credited, capped).
    grandfathered       credit the day had when it entered Phase 1b.
    evidence_source     "android_gait_v1" | "ios_coremotion" | None (no evidence).
    evidence            per-hour client evidence (merged across streams).
    walk_verified       steps of server-verified walk sessions that day.
    walk_gait_fallback  gait-verified steps of walks that couldn't be verified by route
                        (e.g. no GPS, treadmill) but weren't mocked or in a vehicle.
    server_vehicle_hours hours where the server saw vehicle-speed movement.
    integrity_blocked   device integrity failed while the policy is enforced.
    """
    credited = max(0, int(credited))
    grandfathered = max(0, min(credited, int(grandfathered)))
    post = credited - grandfathered
    vehicle_hours = server_vehicle_hours or set()

    verified = shake = unknown = vehicle = walk_bucket = 0
    for hour, entry in evidence.items():
        v = int(entry.get("verified", 0) or 0)
        if hour in vehicle_hours:
            vehicle += v
            v = 0
        verified += v
        shake += int(entry.get("shake", 0) or 0)
        unknown += int(entry.get("unknown", 0) or 0)
        vehicle += int(entry.get("vehicle", 0) or 0)
        walk_bucket += int(entry.get("walk", 0) or 0)

    walk_tier = 0
    sensor = 0
    if evidence_source == "ios_coremotion":
        # Apple's motion coprocessor counts steps from its own gait model; HealthKit
        # provenance arrives in Phase 1c. Walks can still add a verified route.
        walk_tier = max(0, int(walk_verified))
        sensor = post
    elif evidence_source == "android_gait_v1":
        walk_tier = min(max(0, int(walk_verified)), walk_bucket)
        fallback = min(max(0, int(walk_gait_fallback)), max(0, walk_bucket - walk_tier))
        sensor = verified + fallback
    else:
        # No device evidence (old app, web): only verified walks can count.
        walk_tier = max(0, int(walk_verified))

    reasons_steps = {
        "vehicle": vehicle,
        "unverified_motion": shake,
        "unverified_no_walking_evidence": 0,
        "device_not_verified": 0,
        "app_update_needed": 0,
    }
    if integrity_blocked:
        reasons_steps["device_not_verified"] = min(post, walk_tier + sensor)
        walk_tier = 0
        sensor = 0

    walk_tier = min(walk_tier, post)
    sensor = min(sensor, post - walk_tier)
    eligible = grandfathered + walk_tier + sensor
    unverified = credited - eligible

    # Explain the unverified part (largest known causes first, remainder = no evidence).
    remaining = unverified
    explained: dict[str, int] = {}
    for code in ("device_not_verified", "vehicle", "unverified_motion"):
        take = min(remaining, max(0, reasons_steps[code]))
        if take:
            explained[code] = take
            remaining -= take
    if remaining > 0:
        code = "app_update_needed" if evidence_source is None else "unverified_no_walking_evidence"
        explained[code] = remaining

    return {
        "tiers": {
            "grandfathered": grandfathered,
            "wearable": 0,
            "walk_session": walk_tier,
            "sensor_verified": sensor,
            "unverified": unverified,
        },
        "eligible": eligible,
        "unverified_reasons": explained,
        "evidence_totals": {
            "verified": verified,
            "shake": shake,
            "unknown": unknown,
            "vehicle": vehicle,
            "walk": walk_bucket,
        },
    }


def challenge_steps_expression():
    """ORM expression for a day's money-eligible steps (NULL = pre-1b day: full credit)."""
    from django.db.models import F
    from django.db.models.functions import Coalesce

    return Coalesce(F("eligible_steps"), F("steps"))


def money_steps(record) -> int:
    """Money-eligible steps of one HealthRecord (0 contribution handled by callers for
    suspicious days)."""
    if record.eligible_steps is None:
        return int(record.steps or 0)
    return int(record.eligible_steps)
