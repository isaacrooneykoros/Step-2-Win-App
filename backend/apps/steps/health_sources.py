"""Phase 1c: Health Connect (Android) and HealthKit (iOS) as extra step sources.

The phone reads, with the user's opt-in, the steps and workouts other apps and devices
wrote to Health Connect / Apple Health, and uploads a per-hour summary with provenance
(which app wrote it, from which kind of device, recorded how). The server decides what
that summary is worth; the client's labels only inform.

Trust by provenance (``classify``):

- ``manual``     recordingMethod MANUAL_ENTRY / HKMetadataKeyWasUserEntered: never
                 counted (not for goals, not for money). Shown as "not counted".
- ``untrusted``  an origin that isn't on the allowlist: never counted.
- ``ignored``    our own package (we never write, but a copy would be circular).
- ``trusted``    an allowlisted origin, split by device:
    - ``wearable``   watch / band / ring (or an unknown device from a wearable-only
                     app such as Garmin Connect): the ``wearable`` evidence tier, the
                     highest trust.
    - ``phone_app``  the phone itself (Samsung Health, Google Fit, Health Connect's own
                     recording, iPhone): corroboration only.

Merging without double counting (``plan_day``):

- Per hour, trusted origins are merged by MAX, never summed (a Galaxy Watch and
  Samsung Health's phone count of the same walk are the same steps).
- Against our own sensor the day is merged by MAX too: counted = max(our sensor's raw
  day total, the trusted per-hour-max total). We don't merge per hour against our own
  sensor: our ledger attributes catch-up steps (app killed, counted on reopen) to the
  hour it read them, so an hour-by-hour max against another app's timeline would count
  the same steps twice.
- Phone-app steps beyond our sensor count for goals only (``health_app_not_verified``);
  wearable steps beyond our sensor count toward challenges (``wearable`` tier).
- Corroboration: an Android hour whose phone-counter steps our own gait couldn't judge
  (``unknown``) and that a trusted phone app counted within +-15% (>= 250 steps) moves to
  ``sensor_verified`` (``health_app_confirmed``). Shaken or vehicle steps are never
  "confirmed" this way: another app reading the same step counter proves the counter
  counted, not that someone walked.
- A trusted workout (walking / running / hiking) with a GPS route and a plausible pace
  and stride verifies the phone steps of its time window like a walk session.
- Wild disagreement (phone-app steps far above anything our sensor or a wearable saw)
  withholds that excess (not credited, nothing else changes), adds the
  ``sources_disagree_under_review`` reason and a MEDIUM ``health_sources_disagree`` flag
  (payout holds' existing rules decide what that means for money). Never a trust change.

Documented storage shape: ``HealthSourceDay.data`` (the cleaned upload) and
``HealthSourceDay.summary`` (the server's decision), see ANTICHEAT.md "Phase 1c".
"""

from __future__ import annotations

import math
from datetime import datetime, timedelta
from datetime import timezone as dt_timezone
from typing import Any

from django.utils import timezone

SUMMARY_VERSION = 1

PROVIDERS = {"health_connect": "android", "healthkit": "ios"}
DEVICE_TYPES = ("watch", "band", "ring", "phone", "scale", "chest_strap", "head_mounted", "display", "unknown", "other")
WEARABLE_DEVICES = frozenset({"watch", "band", "ring"})
METHODS = ("automatic", "active", "manual", "unknown")
WORKOUT_TYPES = ("walking", "running", "hiking", "treadmill", "wheelchair", "other")
ROUTE_WORKOUTS = frozenset({"walking", "running", "hiking"})

OWN_PACKAGES = frozenset({"com.step2win.app"})

# Caps (strict validation).
MAX_HOUR_ENTRIES = 24 * 12
MAX_ORIGINS = 16
MAX_WORKOUTS = 20
MAX_ORIGIN_LEN = 160
# 4 steps/s for a whole hour = 14,400: anything above in one hour is not a person.
MAX_STEPS_PER_HOUR = 14_400
MAX_WORKOUT_SECONDS = 12 * 3600
MAX_WORKOUT_DISTANCE_M = 100_000

# Corroboration / disagreement / workouts (documented in ANTICHEAT.md "Phase 1c").
CORROBORATION_TOLERANCE = 0.15
CORROBORATION_MIN_STEPS = 250
DISAGREE_MIN_EXCESS = 10_000
DISAGREE_MIN_RATIO = 2.5
# Wearable steps this far above the phone's own count (and >= 3x it): MEDIUM review flag,
# still credited (a watch-only day is normal; a huge one deserves a look before money).
WEARABLE_REVIEW_MIN_EXCESS = 20_000
WORKOUT_MIN_SECONDS = 120
WORKOUT_MIN_ROUTE_POINTS = 10
WORKOUT_MIN_DISTANCE_M = 300
WORKOUT_MAX_SPEED_MPS = {"walking": 2.8, "hiking": 2.8, "running": 6.0}
WORKOUT_MIN_SPEED_MPS = 0.3
WORKOUT_MIN_STRIDE_M = 0.30
WORKOUT_MAX_STRIDE_M = 2.2
ROUTE_DISTANCE_TOLERANCE = 0.35

# Order in which an hour's phone-counter buckets are covered by a wearable (the watch
# saw those steps): verified first, so a watch never "launders" shaken steps of the
# same hour into money when the phone also saw real walking.
WEARABLE_COVER_ORDER = ("verified", "walk", "unknown", "shake", "vehicle")
WORKOUT_COVER_ORDER = ("unknown", "verified", "walk")

# ── Allowlist ─────────────────────────────────────────────────────────────────
# Each line: "<origin>[*] [wearable]  # label". A trailing * is a prefix match.
# "wearable" = the app only records wearables, so data without a device type counts as
# a wearable. Package names verified 2026-09-30 (see ANTICHEAT.md "Phase 1c").
DEFAULT_TRUSTED_ORIGINS_TEXT = """\
android  # This phone (Health Connect)
com.android.healthconnect.phone.*  # This phone (Health Connect)
com.sec.android.app.shealth  # Samsung Health
com.google.android.apps.fitness  # Google Fit
com.fitbit.FitbitMobile  # Fitbit
com.garmin.android.apps.connectmobile wearable  # Garmin Connect
com.xiaomi.wearable wearable  # Mi Fitness
com.huami.watch.hmwatchmanager wearable  # Zepp
com.xiaomi.hm.health wearable  # Zepp Life
com.huawei.health  # Huawei Health
com.strava  # Strava
com.apple.health.*  # Apple Health
com.strava.stravaride  # Strava
com.garmin.connect.mobile wearable  # Garmin Connect
com.huami.watch wearable  # Zepp
HM.wristband wearable  # Zepp Life
com.xiaomi.miwatch.pro wearable  # Mi Fitness
com.huawei.iossporthealth  # Huawei Health
"""


def parse_rules(text: str) -> list[dict[str, Any]]:
    rules = []
    for raw_line in (text or "").splitlines():
        line, _, label = raw_line.partition("#")
        parts = line.split()
        if not parts:
            continue
        pattern = parts[0][:MAX_ORIGIN_LEN]
        flags = {p.lower() for p in parts[1:]}
        prefix = pattern.endswith("*")
        rules.append(
            {
                "pattern": pattern[:-1] if prefix else pattern,
                "prefix": prefix,
                "wearable_only": "wearable" in flags,
                "label": label.strip()[:60] or pattern,
            }
        )
    return rules


def trusted_rules() -> list[dict[str, Any]]:
    """The admin-configured allowlist (Settings > Payout review), else the defaults."""
    text = ""
    try:
        from apps.admin_api.platform import current_settings

        text = getattr(current_settings(), "health_trusted_origins", "") or ""
    except Exception:  # noqa: BLE001 - settings unavailable: defaults
        text = ""
    rules = parse_rules(text)
    return rules or parse_rules(DEFAULT_TRUSTED_ORIGINS_TEXT)


def match_rule(origin: str, rules: list[dict[str, Any]]) -> dict[str, Any] | None:
    for rule in rules:
        if rule["prefix"]:
            if origin.startswith(rule["pattern"]):
                return rule
        elif origin == rule["pattern"]:
            return rule
    return None


def classify(origin: str, device: str, method: str, rules) -> tuple[str, str | None, str]:
    """(trust, kind, label): trust manual | untrusted | ignored | trusted; kind wearable |
    phone_app for trusted data."""
    if origin in OWN_PACKAGES:
        return "ignored", None, "Step2Win"
    rule = match_rule(origin, rules)
    label = rule["label"] if rule else origin
    if method == "manual":
        return "manual", None, label
    if rule is None:
        return "untrusted", None, label
    if device in WEARABLE_DEVICES or (device in ("unknown", "other") and rule["wearable_only"]):
        return "trusted", "wearable", label
    return "trusted", "phone_app", label


# ── Payload validation ────────────────────────────────────────────────────────


class HealthSourcesError(ValueError):
    """The upload is unusable as a whole (wrong platform, wrong shape, over the caps)."""


def _int(value, lo: int, hi: int) -> int | None:
    if isinstance(value, bool):
        return None
    try:
        n = int(value)
    except (TypeError, ValueError):
        return None
    if n < lo:
        return None
    return min(hi, n)


def _float(value, lo: float, hi: float) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(f) or f < lo:
        return None
    return min(hi, f)


def _choice(value, choices, default: str) -> str:
    value = str(value or "").strip().lower()
    return value if value in choices else default


def _origin(value) -> str | None:
    if not isinstance(value, str):
        return None
    value = value.strip()
    if not value or len(value) > MAX_ORIGIN_LEN or any(c.isspace() for c in value):
        return None
    return value


def _parse_time(value) -> datetime | None:
    if not isinstance(value, str) or len(value) > 40:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return None
    return parsed.astimezone(dt_timezone.utc)


def clean_payload(raw, *, platform: str, day, tz_offset_minutes: int | None, now=None) -> dict[str, Any]:
    """Strictly validate one day's health-source summary. Raises HealthSourcesError when
    the upload as a whole is unusable; drops individual entries that are out of range
    (future hours, windows outside the day) and counts them in ``dropped``."""
    now = now or timezone.now()
    if not isinstance(raw, dict):
        raise HealthSourcesError("health_sources must be an object")
    provider = str(raw.get("provider") or "")
    if provider not in PROVIDERS:
        raise HealthSourcesError("unknown provider")
    claimed = str(raw.get("platform") or PROVIDERS[provider]).lower()
    if claimed != PROVIDERS[provider]:
        raise HealthSourcesError("provider and platform don't match")
    if platform != PROVIDERS[provider]:
        raise HealthSourcesError("health sources must come from the same platform as the session")
    hours_raw = raw.get("hours") or []
    workouts_raw = raw.get("workouts") or []
    if not isinstance(hours_raw, list) or not isinstance(workouts_raw, list):
        raise HealthSourcesError("hours and workouts must be lists")
    if len(hours_raw) > MAX_HOUR_ENTRIES or len(workouts_raw) > MAX_WORKOUTS:
        raise HealthSourcesError("too many entries")

    offset = tz_offset_minutes if tz_offset_minutes is not None else 180
    local_now = now + timedelta(minutes=offset)
    if day > local_now.date():
        raise HealthSourcesError("date is in the future")
    last_hour = local_now.hour if day == local_now.date() else 23
    day_start = datetime(day.year, day.month, day.day, tzinfo=dt_timezone.utc) - timedelta(minutes=offset)
    day_end = day_start + timedelta(days=1)

    dropped = 0
    merged: dict[tuple, dict[str, Any]] = {}
    origins: set[str] = set()
    for item in hours_raw:
        if not isinstance(item, dict):
            dropped += 1
            continue
        hour = _int(item.get("hour"), 0, 23)
        origin = _origin(item.get("origin"))
        steps = _int(item.get("steps"), 0, MAX_STEPS_PER_HOUR)
        if hour is None or origin is None or steps is None or hour > last_hour:
            dropped += 1
            continue
        if steps == 0:
            continue
        origins.add(origin)
        if len(origins) > MAX_ORIGINS:
            raise HealthSourcesError("too many origins")
        device = _choice(item.get("device"), DEVICE_TYPES, "unknown")
        method = _choice(item.get("method"), METHODS, "unknown")
        key = (hour, origin, device, method)
        entry = merged.setdefault(key, {"hour": hour, "origin": origin, "device": device, "method": method, "steps": 0})
        entry["steps"] = min(MAX_STEPS_PER_HOUR, entry["steps"] + steps)

    workouts = []
    for item in workouts_raw:
        if not isinstance(item, dict):
            dropped += 1
            continue
        origin = _origin(item.get("origin"))
        start = _parse_time(item.get("start"))
        end = _parse_time(item.get("end"))
        if origin is None or start is None or end is None or end <= start:
            dropped += 1
            continue
        if end <= day_start or start >= day_end or start > now + timedelta(minutes=5):
            dropped += 1
            continue
        if (end - start).total_seconds() > MAX_WORKOUT_SECONDS:
            dropped += 1
            continue
        # Clip to the day (a run across midnight counts on each day for its own part).
        full_seconds = (end - start).total_seconds()
        clip_start, clip_end = max(start, day_start), min(end, day_end, now + timedelta(minutes=5))
        if clip_end <= clip_start:
            dropped += 1
            continue
        share = (clip_end - clip_start).total_seconds() / full_seconds
        distance = _float(item.get("distance_m"), 0, MAX_WORKOUT_DISTANCE_M)
        steps = _int(item.get("steps"), 0, 200_000)
        route = item.get("route") if isinstance(item.get("route"), dict) else None
        route_clean = None
        if route is not None:
            points = _int(route.get("points"), 0, 100_000)
            route_distance = _float(route.get("distance_m"), 0, MAX_WORKOUT_DISTANCE_M)
            if points is not None and route_distance is not None:
                route_clean = {"points": points, "distance_m": round(route_distance * share, 1)}
        workouts.append(
            {
                "start": clip_start.isoformat(),
                "end": clip_end.isoformat(),
                "type": _choice(item.get("type"), WORKOUT_TYPES, "other"),
                "origin": origin,
                "device": _choice(item.get("device"), DEVICE_TYPES, "unknown"),
                "method": _choice(item.get("method"), METHODS, "unknown"),
                "distance_m": round(distance * share, 1) if distance is not None else None,
                "steps": int(steps * share) if steps is not None else None,
                "route": route_clean,
            }
        )
        origins.add(origin)
        if len(origins) > MAX_ORIGINS:
            raise HealthSourcesError("too many origins")

    read_at = _parse_time(raw.get("read_at"))
    return {
        "v": SUMMARY_VERSION,
        "provider": provider,
        "platform": PROVIDERS[provider],
        "read_at": read_at.isoformat() if read_at else now.isoformat(),
        "tz_offset_minutes": offset,
        "hours": sorted(merged.values(), key=lambda e: (e["hour"], e["origin"], e["device"], e["method"])),
        "workouts": workouts,
        "dropped": dropped,
    }


# ── Provenance summary (pure) ────────────────────────────────────────────────


def summarize(data: dict[str, Any], rules) -> dict[str, Any]:
    """Trust per origin, trusted steps per hour (max over origins), not-counted totals."""
    wearable_hours: dict[int, int] = {}
    phone_app_hours: dict[int, int] = {}
    per_origin: dict[str, dict[str, Any]] = {}
    not_counted = {"manual": 0, "untrusted": 0}
    for entry in data.get("hours") or []:
        trust, kind, label = classify(entry["origin"], entry["device"], entry["method"], rules)
        steps = int(entry["steps"])
        hour = int(entry["hour"])
        o = per_origin.setdefault(
            entry["origin"],
            {"origin": entry["origin"], "label": label, "steps": 0, "counted": 0, "devices": set(), "kinds": set(), "trust": set()},
        )
        o["steps"] += steps
        o["devices"].add(entry["device"])
        o["trust"].add(trust)
        if kind:
            o["kinds"].add(kind)
        if trust == "trusted":
            o["counted"] += steps
            bucket = wearable_hours if kind == "wearable" else phone_app_hours
            bucket[hour] = max(bucket.get(hour, 0), steps)
        elif trust in not_counted:
            not_counted[trust] += steps

    origins = []
    for o in sorted(per_origin.values(), key=lambda x: -x["steps"]):
        trust = "trusted" if "trusted" in o["trust"] else ("manual" if o["trust"] == {"manual"} else sorted(o["trust"])[0])
        kind = "wearable" if "wearable" in o["kinds"] else ("phone_app" if o["kinds"] else None)
        origins.append(
            {
                "origin": o["origin"],
                "label": o["label"],
                "trust": trust,
                "kind": kind,
                "devices": sorted(o["devices"]),
                "steps": int(o["steps"]),
                "counted_steps": int(o["counted"]),
            }
        )

    hours = set(wearable_hours) | set(phone_app_hours)
    trusted_hours = {h: max(wearable_hours.get(h, 0), phone_app_hours.get(h, 0)) for h in hours}
    return {
        "wearable_hours": wearable_hours,
        "phone_app_hours": phone_app_hours,
        "trusted_hours": trusted_hours,
        "wearable_total": sum(wearable_hours.values()),
        "phone_app_total": sum(phone_app_hours.values()),
        "trusted_total": sum(trusted_hours.values()),
        "not_counted": not_counted,
        "origins": origins,
    }


def _local_hour_minutes(start: datetime, end: datetime, offset_minutes: int) -> dict[int, float]:
    """Minutes of [start, end) per local hour."""
    out: dict[int, float] = {}
    cur = start
    while cur < end:
        local = cur + timedelta(minutes=offset_minutes)
        next_hour = cur + timedelta(minutes=60 - local.minute, seconds=-local.second, microseconds=-local.microsecond)
        if next_hour <= cur:
            next_hour = cur + timedelta(hours=1)
        seg_end = min(end, next_hour)
        out[local.hour] = out.get(local.hour, 0.0) + (seg_end - cur).total_seconds() / 60.0
        cur = seg_end
    return out


def judge_workout(workout: dict[str, Any], rules, *, hour_steps: dict[int, int], offset_minutes: int) -> dict[str, Any]:
    """Can this workout verify the steps of its window? Returns {verdict, reason,
    steps_by_hour}. steps_by_hour = candidate steps per local hour (before the caller
    caps them by what the phone actually counted)."""
    trust, kind, label = classify(workout["origin"], workout["device"], workout["method"], rules)
    result = {"label": label, "trust": trust, "verdict": "not_verified", "reason": None, "steps_by_hour": {}}
    if trust == "manual":
        result["reason"] = "manual_entry"
        return result
    if trust != "trusted":
        result["reason"] = "untrusted_app"
        return result
    if workout["type"] not in ROUTE_WORKOUTS:
        result["reason"] = "no_route_type"
        return result
    route = workout.get("route") or {}
    start = datetime.fromisoformat(workout["start"])
    end = datetime.fromisoformat(workout["end"])
    seconds = (end - start).total_seconds()
    distance = workout.get("distance_m")
    if route.get("distance_m"):
        route_d = float(route["distance_m"])
        if distance and abs(route_d - distance) > ROUTE_DISTANCE_TOLERANCE * max(route_d, distance):
            result["reason"] = "route_distance_mismatch"
            return result
        distance = min(distance, route_d) if distance else route_d
    if int(route.get("points") or 0) < WORKOUT_MIN_ROUTE_POINTS or not distance:
        result["reason"] = "no_route"
        return result
    if seconds < WORKOUT_MIN_SECONDS or distance < WORKOUT_MIN_DISTANCE_M:
        result["reason"] = "too_short"
        return result
    speed = distance / seconds
    if speed < WORKOUT_MIN_SPEED_MPS or speed > WORKOUT_MAX_SPEED_MPS.get(workout["type"], 2.8):
        result["reason"] = "pace_not_plausible"
        return result
    minutes = _local_hour_minutes(start, end, offset_minutes)
    if workout.get("steps"):
        total_minutes = sum(minutes.values()) or 1.0
        candidate = {h: int(workout["steps"] * m / total_minutes) for h, m in minutes.items()}
    else:
        candidate = {h: int(hour_steps.get(h, 0) * min(1.0, m / 60.0)) for h, m in minutes.items()}
    total = sum(candidate.values())
    if total <= 0:
        result["reason"] = "no_steps"
        return result
    stride = distance / total
    if stride < WORKOUT_MIN_STRIDE_M or stride > WORKOUT_MAX_STRIDE_M:
        result["reason"] = "stride_not_plausible"
        return result
    result.update({"verdict": "verified", "reason": "workout_route_verified", "steps_by_hour": candidate})
    return result


def _take(entry: dict[str, int], amount: int, order) -> int:
    taken = 0
    for bucket in order:
        if taken >= amount:
            break
        have = int(entry.get(bucket, 0) or 0)
        t = min(have, amount - taken)
        if t:
            entry[bucket] = have - t
            taken += t
    return taken


def plan_day(
    summary: dict[str, Any],
    *,
    workouts: list[dict[str, Any]],
    rules,
    sensor_raw: int,
    evidence: dict[int, dict[str, int]],
    evidence_source: str | None,
    offset_minutes: int,
) -> dict[str, Any]:
    """Combine the provenance summary with our own sensor. Pure (tested directly).

    Returns the extra steps to credit (max, never sum), the evidence adjusted for what a
    wearable / workout covered and what a phone app corroborated, and the tier inputs.
    """
    sensor_raw = max(0, int(sensor_raw))
    W = int(summary["wearable_total"])
    T = int(summary["trusted_total"])
    base = max(sensor_raw, W)
    excess = T - base
    disagreement = excess >= DISAGREE_MIN_EXCESS and T >= DISAGREE_MIN_RATIO * max(base, 1)
    extra_wearable = max(0, W - sensor_raw)
    extra_phone_app = max(0, T - sensor_raw) - extra_wearable
    # A watch far above everything the phone saw is normal (phone left at home), so it is
    # credited; a very large gap is still worth a person's look (MEDIUM flag only).
    wearable_review = extra_wearable >= WEARABLE_REVIEW_MIN_EXCESS and W >= 3 * max(sensor_raw, 1)
    withheld = 0
    if disagreement:
        withheld = extra_phone_app
        extra_phone_app = 0

    adjusted = {h: dict(e) for h, e in evidence.items()}
    wearable_hours = summary["wearable_hours"]
    phone_app_hours = summary["phone_app_hours"]
    android = evidence_source == "android_gait_v1"

    # 1. A wearable saw these steps: cover the phone's buckets of the same hour.
    if android:
        for hour, w in wearable_hours.items():
            if hour in adjusted and w > 0:
                _take(adjusted[hour], int(w), WEARABLE_COVER_ORDER)

    # 2. Corroboration by a trusted phone app (same hour, within +-15%).
    corroborated = 0
    corroborated_hours = []
    if android:
        for hour, a in phone_app_hours.items():
            entry = adjusted.get(hour)
            if not entry or wearable_hours.get(hour):
                continue
            phone_total = sum(int(evidence[hour].get(b, 0) or 0) for b in ("verified", "shake", "unknown", "vehicle", "walk"))
            if phone_total < CORROBORATION_MIN_STEPS:
                continue
            if abs(phone_total - a) > CORROBORATION_TOLERANCE * max(phone_total, a):
                continue
            moved = int(entry.get("unknown", 0) or 0)
            if moved:
                entry["verified"] = int(entry.get("verified", 0) or 0) + moved
                entry["unknown"] = 0
                corroborated += moved
                corroborated_hours.append(hour)

    # 3. Workouts with a GPS route verify the steps of their window.
    hour_steps = {}
    for hour in set(evidence) | set(summary["trusted_hours"]):
        phone = sum(int((evidence.get(hour) or {}).get(b, 0) or 0) for b in ("verified", "shake", "unknown", "vehicle", "walk"))
        hour_steps[hour] = max(phone, int(summary["trusted_hours"].get(hour, 0)))
    judged = []
    workout_steps = 0
    for workout in workouts:
        verdict = judge_workout(workout, rules, hour_steps=hour_steps, offset_minutes=offset_minutes)
        verified = 0
        if verdict["verdict"] == "verified":
            for hour, candidate in verdict["steps_by_hour"].items():
                if android:
                    entry = adjusted.get(hour)
                    if entry:
                        verified += _take(entry, int(candidate), WORKOUT_COVER_ORDER)
                else:
                    verified += int(candidate)
        workout_steps += verified
        judged.append(
            {
                "start": workout["start"],
                "end": workout["end"],
                "type": workout["type"],
                "label": verdict["label"],
                "trust": verdict["trust"],
                "verdict": verdict["verdict"],
                "reason": verdict["reason"],
                "distance_m": workout.get("distance_m"),
                "verified_steps": verified,
            }
        )

    return {
        "sensor_raw": sensor_raw,
        "trusted_total": T,
        "wearable_total": W,
        "extra_wearable": extra_wearable,
        "extra_phone_app": extra_phone_app,
        "withheld": withheld,
        "disagreement": disagreement,
        "wearable_review": wearable_review,
        "adjusted_evidence": adjusted,
        "wearable_steps": W,
        "corroborated": corroborated,
        "corroborated_hours": sorted(corroborated_hours),
        "workout_steps": workout_steps,
        "workouts": judged,
    }


# ── Storage + day refresh wiring ─────────────────────────────────────────────


def day_plan_for_record(record, meta: dict, evidence: dict[int, dict[str, int]]):
    """Load the day's stored health sources and plan them against our sensor. None when
    the day has no health-source data."""
    from .models import HealthSourceDay

    stored = HealthSourceDay.objects.filter(user_id=record.user_id, date=record.date).first()
    if stored is None or not stored.data:
        return None
    rules = trusted_rules()
    data = stored.data
    summary = summarize(data, rules)
    applied_before = int(((meta.get("health") or {}).get("applied_extra", 0)) or 0)
    sensor_credit = max(0, int(record.steps or 0) - applied_before)
    streams = [int(v or 0) for v in (meta.get("streams_raw") or {}).values()]
    sensor_raw = max([int(record.last_raw_steps or 0), sensor_credit] + streams)
    plan = plan_day(
        summary,
        workouts=data.get("workouts") or [],
        rules=rules,
        sensor_raw=sensor_raw,
        evidence=evidence,
        evidence_source=meta.get("evidence_source"),
        offset_minutes=int(data.get("tz_offset_minutes", 180) or 0),
    )
    plan["summary"] = summary
    plan["sensor_credit"] = sensor_credit
    plan["stored"] = stored
    return plan


def public_summary(summary: dict[str, Any], plan: dict[str, Any], *, applied_wearable: int, applied_phone_app: int, provider: str) -> dict[str, Any]:
    """Compact, user-safe summary kept on the day (anticheat.health) and served to the
    app / admin timeline. Documented in ANTICHEAT.md."""
    return {
        "v": SUMMARY_VERSION,
        "provider": provider,
        "applied_extra": applied_wearable + applied_phone_app,
        "applied_wearable_extra": applied_wearable,
        "applied_phone_app_extra": applied_phone_app,
        "trusted_total": plan["trusted_total"],
        "wearable_total": plan["wearable_total"],
        "sensor_raw": plan["sensor_raw"],
        "corroborated": plan["corroborated"],
        "workout_steps": plan["workout_steps"],
        "withheld": plan["withheld"],
        "disagreement": plan["disagreement"],
        "wearable_review": plan.get("wearable_review", False),
        "not_counted": dict(summary["not_counted"]),
        "origins": [
            {k: o[k] for k in ("label", "trust", "kind", "steps", "counted_steps")} for o in summary["origins"][:12]
        ],
        "workouts": [
            {k: w[k] for k in ("type", "label", "verdict", "reason", "verified_steps", "start", "end")}
            for w in plan["workouts"][:10]
        ],
    }
