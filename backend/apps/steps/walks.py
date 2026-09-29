"""User-started walks ("Start a walk"): GPS route + motion evidence (Phase 1b).

Flow (foreground only, opt-in): the app starts a walk (server nonce for Play
Integrity), uploads GPS points and the running step / gait counters while walking, and
finishes it. The server then decides a verdict from consistency checks between steps,
distance, duration, cadence and speed, plus the phone's own gait verdicts and mock
location flags. A verified walk's steps count in the ``walk_session`` evidence tier
(apps/steps/evidence.py) for the walk's local day.

Privacy
- Raw points are kept WALK_RAW_POINTS_RETENTION_DAYS (30) days, then deleted by the
  scheduled job ``purge-old-walk-points`` (``purge_old_walk_points``); the simplified
  route (Douglas-Peucker, encoded polyline) is kept.
- Anything that may be shown to others (``shared_polyline``) hides the first and last
  ~250 m of the route and every point inside the user's optional home privacy zone.
- The privacy zone is stored as salted hashes of the geohash cells covering the circle,
  never as coordinates.

Reason codes (stable, user-facing via ``walk_summary``): see REASON_MESSAGES.
Messages are kind and never contain thresholds.
"""

from __future__ import annotations

import hashlib
import math
import secrets
from datetime import datetime, timedelta
from datetime import timezone as dt_timezone
from typing import Any, Iterable

from django.conf import settings
from django.db import transaction
from django.utils import timezone

EARTH_RADIUS_M = 6_371_000.0

MAX_POINTS_PER_CALL = 500
MAX_POINTS_PER_WALK = 5_000
MAX_ACCURACY_M = 75.0
# Segment speeds above this (m/s, ~25 km/h, faster than any sustained run) are
# vehicle speed. Fast fixes are kept and flagged, never silently dropped.
VEHICLE_SPEED_MPS = 7.0
# Hard ceiling for a plausible fix-to-fix jump (teleport / GPS glitch): ~250 km/h.
TELEPORT_SPEED_MPS = 70.0
MIN_SEGMENT_M = 2.0

MIN_DURATION_S = 120
MIN_STEPS = 100
MIN_ROUTE_POINTS = 5
# Plausible stride (m per step) for walking and running. Below: little movement for
# the steps (treadmill, indoors, GPS off, or steps without walking). Above: faster than
# feet (vehicle, bike).
MIN_STRIDE_M = 0.30
MAX_STRIDE_M = 2.2
MAX_WALK_CADENCE_SPM = 230.0
# Steps per second can't exceed this over the walk (sprint ~3.5/s).
MAX_STEPS_PER_S = 4.0
# Walks with more vehicle time than this share are not verified at all.
MAX_VEHICLE_SHARE = 0.20
# Walks where more than this share of the steps looked like shaking are not verified.
MAX_SHAKE_SHARE = 0.25
# GPS must cover this share of the walk's duration to verify all its steps; less
# coverage verifies the covered share only.
FULL_ROUTE_COVERAGE = 0.80
PRIVACY_TRIM_M = 250.0
# Simplification tolerance (m) for the stored route.
SIMPLIFY_TOLERANCE_M = 8.0
DEFAULT_OFFSET_MINUTES = 180  # EAT, when the phone didn't say

REASON_SEVERITY = {
    "walk_session_verified": "positive",
    "walk_too_short": "info",
    "walk_no_route": "info",
    "walk_route_short_for_steps": "info",
    "walk_route_long_for_steps": "info",
    "walk_vehicle": "info",
    "walk_motion_not_walking": "info",
    "walk_mock_location": "review",
    "walk_device_not_verified": "info",
    "walk_cadence_unusual": "info",
}
REASON_MESSAGES = {
    "walk_session_verified": "Your walk was verified with GPS, so its steps count toward challenges.",
    "walk_too_short": "This walk was too short to verify. Walks of a few minutes or more can count toward challenges.",
    "walk_no_route": "We couldn't get a GPS route for this walk (GPS may have been off or blocked indoors). Steps your phone confirmed as walking still count toward challenges.",
    "walk_route_short_for_steps": "The GPS route was short for the number of steps (a treadmill or indoor walk looks like this). Steps your phone confirmed as walking still count toward challenges.",
    "walk_route_long_for_steps": "The route was longer than steps alone would cover, as if part of it was by vehicle or bike, so this walk couldn't be verified. Your steps still count for your goals.",
    "walk_vehicle": "Part of this walk looked like travel in a vehicle or on a bike, so it couldn't be verified. Your steps still count for your goals.",
    "walk_motion_not_walking": "Much of the movement during this walk didn't look like walking, so it couldn't be verified. Your steps still count for your goals.",
    "walk_mock_location": "Your phone reported its location through a location-changing app or setting, so this walk couldn't be verified. Turning that off lets walks count.",
    "walk_device_not_verified": "We couldn't verify this phone right now, so this walk counts for your goals but not toward challenges.",
    "walk_cadence_unusual": "The steps during this walk arrived faster than walking or running allows, so it couldn't be verified. Your steps still count for your goals.",
}
DISQUALIFYING = frozenset(
    {
        "walk_too_short",
        "walk_route_long_for_steps",
        "walk_vehicle",
        "walk_motion_not_walking",
        "walk_mock_location",
        "walk_device_not_verified",
        "walk_cadence_unusual",
    }
)


# ── Geometry ─────────────────────────────────────────────────────────────────


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    d_lat = math.radians(lat2 - lat1)
    d_lon = math.radians(lon2 - lon1)
    a = (
        math.sin(d_lat / 2) ** 2
        + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(d_lon / 2) ** 2
    )
    return EARTH_RADIUS_M * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def _xy(lat: float, lng: float, lat0: float) -> tuple[float, float]:
    """Local equirectangular projection (m); fine for a walk-sized area."""
    x = math.radians(lng) * EARTH_RADIUS_M * math.cos(math.radians(lat0))
    y = math.radians(lat) * EARTH_RADIUS_M
    return x, y


def douglas_peucker(points: list[tuple[float, float]], tolerance_m: float = SIMPLIFY_TOLERANCE_M) -> list[tuple[float, float]]:
    """Simplify a (lat, lng) route, iteratively (no recursion limit on long walks)."""
    n = len(points)
    if n <= 2:
        return list(points)
    lat0 = points[0][0]
    xy = [_xy(lat, lng, lat0) for lat, lng in points]
    keep = [False] * n
    keep[0] = keep[-1] = True
    stack = [(0, n - 1)]
    while stack:
        start, end = stack.pop()
        if end <= start + 1:
            continue
        (x1, y1), (x2, y2) = xy[start], xy[end]
        dx, dy = x2 - x1, y2 - y1
        seg_len_sq = dx * dx + dy * dy
        best, best_i = -1.0, -1
        for i in range(start + 1, end):
            px, py = xy[i]
            if seg_len_sq == 0:
                dist = math.hypot(px - x1, py - y1)
            else:
                t = max(0.0, min(1.0, ((px - x1) * dx + (py - y1) * dy) / seg_len_sq))
                dist = math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
            if dist > best:
                best, best_i = dist, i
        if best > tolerance_m:
            keep[best_i] = True
            stack.append((start, best_i))
            stack.append((best_i, end))
    return [p for p, k in zip(points, keep) if k]


def encode_polyline(points: Iterable[tuple[float, float]]) -> str:
    """Google encoded polyline (precision 5)."""

    def _enc(value: int) -> str:
        value = ~(value << 1) if value < 0 else (value << 1)
        out = []
        while value >= 0x20:
            out.append(chr((0x20 | (value & 0x1F)) + 63))
            value >>= 5
        out.append(chr(value + 63))
        return "".join(out)

    last_lat = last_lng = 0
    parts = []
    for lat, lng in points:
        lat_i, lng_i = int(round(lat * 1e5)), int(round(lng * 1e5))
        parts.append(_enc(lat_i - last_lat))
        parts.append(_enc(lng_i - last_lng))
        last_lat, last_lng = lat_i, lng_i
    return "".join(parts)


def decode_polyline(encoded: str) -> list[tuple[float, float]]:
    points, index, lat, lng = [], 0, 0, 0
    while index < len(encoded):
        for coord in (0, 1):
            shift = result = 0
            while True:
                b = ord(encoded[index]) - 63
                index += 1
                result |= (b & 0x1F) << shift
                shift += 5
                if b < 0x20:
                    break
            delta = ~(result >> 1) if result & 1 else result >> 1
            if coord == 0:
                lat += delta
            else:
                lng += delta
        points.append((lat / 1e5, lng / 1e5))
    return points


# ── Geohash privacy zone ─────────────────────────────────────────────────────

_GEOHASH_BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz"


def geohash(lat: float, lng: float, precision: int = 7) -> str:
    lat_lo, lat_hi, lng_lo, lng_hi = -90.0, 90.0, -180.0, 180.0
    bits, bit, ch, even, out = [16, 8, 4, 2, 1], 0, 0, True, []
    while len(out) < precision:
        if even:
            mid = (lng_lo + lng_hi) / 2
            if lng > mid:
                ch |= bits[bit]
                lng_lo = mid
            else:
                lng_hi = mid
        else:
            mid = (lat_lo + lat_hi) / 2
            if lat > mid:
                ch |= bits[bit]
                lat_lo = mid
            else:
                lat_hi = mid
        even = not even
        if bit < 4:
            bit += 1
        else:
            out.append(_GEOHASH_BASE32[ch])
            bit, ch = 0, 0
    return "".join(out)


def _cell_hash(salt: str, cell: str) -> str:
    return hashlib.sha256(f"{salt}:{cell}".encode()).hexdigest()[:32]


def zone_cells(lat: float, lng: float, radius_m: float, precision: int = 7) -> set[str]:
    """Geohash cells whose sample points fall within radius (+ one cell of margin).
    Precision 7 cells are ~153 m x 153 m at the equator."""
    step_m = 50.0
    reach = radius_m + 160.0
    cells = set()
    n = int(reach // step_m) + 1
    lat_m = 111_320.0
    lng_m = max(1.0, 111_320.0 * math.cos(math.radians(lat)))
    for i in range(-n, n + 1):
        for j in range(-n, n + 1):
            dy, dx = i * step_m, j * step_m
            if math.hypot(dx, dy) > reach:
                continue
            cells.add(geohash(lat + dy / lat_m, lng + dx / lng_m, precision))
    return cells


def set_privacy_zone(user, lat: float, lng: float, radius_m: int):
    from .models import WalkPrivacyZone

    salt = secrets.token_hex(16)
    precision = 7
    hashes = sorted(_cell_hash(salt, c) for c in zone_cells(lat, lng, radius_m, precision))
    zone, _ = WalkPrivacyZone.objects.update_or_create(
        user=user,
        defaults={"salt": salt, "precision": precision, "radius_m": radius_m, "cell_hashes": hashes},
    )
    return zone


def in_zone(zone, lat: float, lng: float) -> bool:
    if zone is None:
        return False
    return _cell_hash(zone.salt, geohash(lat, lng, zone.precision)) in set(zone.cell_hashes or [])


def shared_route(points: list[tuple[float, float]], zone=None, trim_m: float = PRIVACY_TRIM_M) -> list[tuple[float, float]]:
    """The route others may see: first/last ~250 m and privacy-zone points removed."""
    if len(points) < 2:
        return []
    cum = [0.0]
    for a, b in zip(points, points[1:]):
        cum.append(cum[-1] + haversine_m(a[0], a[1], b[0], b[1]))
    total = cum[-1]
    if total <= 2 * trim_m:
        return []
    out = [
        p
        for p, d in zip(points, cum)
        if trim_m <= d <= total - trim_m and not in_zone(zone, p[0], p[1])
    ]
    return out if len(out) >= 2 else []


# ── Points and metrics ───────────────────────────────────────────────────────


def _parse_time(value) -> datetime | None:
    if isinstance(value, datetime):
        dt = value
    else:
        try:
            dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        except (TypeError, ValueError):
            return None
    if timezone.is_naive(dt):
        dt = dt.replace(tzinfo=dt_timezone.utc)
    return dt


def clean_points(raw, *, started_at: datetime, now: datetime | None = None) -> list[dict[str, Any]]:
    """Validate uploaded points. Keeps fast fixes (speed flags them); drops malformed,
    out-of-range, inaccurate (> 75 m) and out-of-window fixes."""
    now = now or timezone.now()
    out = []
    if not isinstance(raw, list):
        return out
    for item in raw[:MAX_POINTS_PER_CALL]:
        if not isinstance(item, dict):
            continue
        t = _parse_time(item.get("t"))
        try:
            lat = float(item.get("lat"))
            lng = float(item.get("lng"))
            acc = max(0.0, float(item.get("acc", 0) or 0))
        except (TypeError, ValueError):
            continue
        if t is None or not (-90 <= lat <= 90 and -180 <= lng <= 180):
            continue
        if math.isnan(lat) or math.isnan(lng) or acc > MAX_ACCURACY_M:
            continue
        if t < started_at - timedelta(minutes=2) or t > now + timedelta(minutes=5):
            continue
        spd = item.get("spd")
        try:
            spd = None if spd is None else max(0.0, float(spd))
        except (TypeError, ValueError):
            spd = None
        out.append(
            {
                "t": t.isoformat(),
                "lat": round(lat, 6),
                "lng": round(lng, 6),
                "acc": round(acc, 1),
                "spd": None if spd is None else round(spd, 2),
                "mock": bool(item.get("mock")),
            }
        )
    return out


def merge_points(existing: list[dict], new: list[dict]) -> list[dict]:
    by_time = {p["t"]: p for p in existing or []}
    for p in new:
        by_time.setdefault(p["t"], p)
    merged = sorted(by_time.values(), key=lambda p: p["t"])
    return merged[:MAX_POINTS_PER_WALK]


def route_metrics(points: list[dict], *, tz_offset_minutes: int) -> dict[str, Any]:
    """Distance (walking segments only), speeds, vehicle time per local hour."""
    distance = 0.0
    vehicle_distance = 0.0
    moving_time = 0.0
    vehicle_seconds = 0.0
    max_speed = 0.0
    vehicle_by_hour: dict[int, float] = {}
    route: list[tuple[float, float]] = []
    prev = None
    for p in points:
        t = _parse_time(p["t"])
        if prev is None:
            prev = (p, t)
            route.append((p["lat"], p["lng"]))
            continue
        pp, pt = prev
        dt = (t - pt).total_seconds()
        if dt <= 0:
            continue
        d = haversine_m(pp["lat"], pp["lng"], p["lat"], p["lng"])
        if d < MIN_SEGMENT_M:
            continue  # standing still / jitter
        speed = d / dt
        if speed > TELEPORT_SPEED_MPS:
            continue  # glitch: skip the fix
        fix_speed = p.get("spd")
        seg_speed = max(speed, fix_speed or 0.0) if fix_speed is not None and dt < 30 else speed
        max_speed = max(max_speed, seg_speed)
        if seg_speed > VEHICLE_SPEED_MPS:
            vehicle_seconds += dt
            vehicle_distance += d
            local_hour = (t + timedelta(minutes=tz_offset_minutes)).hour
            vehicle_by_hour[local_hour] = vehicle_by_hour.get(local_hour, 0.0) + dt
        else:
            distance += d
            moving_time += dt
        route.append((p["lat"], p["lng"]))
        prev = (p, t)
    first_t = _parse_time(points[0]["t"]) if points else None
    last_t = _parse_time(points[-1]["t"]) if points else None
    return {
        "distance_m": distance,
        "vehicle_distance_m": vehicle_distance,
        "moving_time_s": moving_time,
        "vehicle_seconds": vehicle_seconds,
        "max_speed_mps": max_speed,
        "avg_speed_mps": (distance / moving_time) if moving_time > 0 else 0.0,
        "vehicle_by_hour": vehicle_by_hour,
        "gps_span_s": (last_t - first_t).total_seconds() if first_t and last_t else 0.0,
        "route": route,
    }


# ── Verdict ──────────────────────────────────────────────────────────────────


def decide(
    *,
    steps: int,
    duration_s: float,
    metrics: dict[str, Any],
    points_count: int,
    gait_verified: int,
    gait_shake: int,
    gait_unknown: int,
    client_vehicle_seconds: float,
    mock: bool,
    platform: str,
    step_source: str,
    integrity_blocked: bool,
) -> tuple[str, list[str], int]:
    """Consistency checks -> (verdict, reason codes, verified steps). Pure."""
    reasons: list[str] = []
    steps = max(0, int(steps))
    duration_s = max(0.0, float(duration_s))

    if mock:
        reasons.append("walk_mock_location")
    if integrity_blocked:
        reasons.append("walk_device_not_verified")
    if duration_s < MIN_DURATION_S or steps < MIN_STEPS:
        reasons.append("walk_too_short")
    if duration_s > 0 and steps > duration_s * MAX_STEPS_PER_S + 100:
        reasons.append("walk_cadence_unusual")
    elif duration_s >= 60 and (steps / (duration_s / 60.0)) > MAX_WALK_CADENCE_SPM:
        reasons.append("walk_cadence_unusual")

    vehicle_s = max(float(metrics.get("vehicle_seconds", 0.0)), float(client_vehicle_seconds or 0))
    vehicle_share = (vehicle_s / duration_s) if duration_s > 0 else 0.0
    if vehicle_share > MAX_VEHICLE_SHARE:
        reasons.append("walk_vehicle")

    gait_measured = platform == "android" and step_source in ("step_counter", "accelerometer")
    if gait_measured and steps > 0 and gait_shake > MAX_SHAKE_SHARE * steps:
        reasons.append("walk_motion_not_walking")

    distance = float(metrics.get("distance_m", 0.0))
    route_ok = False
    if points_count < MIN_ROUTE_POINTS or distance <= 0:
        reasons.append("walk_no_route")
    elif steps > 0:
        stride = distance / steps
        if stride < MIN_STRIDE_M:
            reasons.append("walk_route_short_for_steps")
        elif stride > MAX_STRIDE_M:
            reasons.append("walk_route_long_for_steps")
        else:
            route_ok = True

    if any(r in DISQUALIFYING for r in reasons) or not route_ok:
        return "unverified", reasons, 0

    # Verified: the walking part of the steps, scaled by GPS coverage.
    eligible = steps
    if gait_measured:
        eligible = max(0, steps - max(0, gait_shake))
    eligible = int(eligible * (1.0 - min(1.0, vehicle_share)))
    coverage = (float(metrics.get("gps_span_s", 0.0)) / duration_s) if duration_s > 0 else 0.0
    if coverage < FULL_ROUTE_COVERAGE:
        eligible = int(eligible * max(0.0, coverage) / FULL_ROUTE_COVERAGE)
    if eligible <= 0:
        return "unverified", reasons + ["walk_no_route"], 0
    return "verified", ["walk_session_verified"], eligible


# ── Lifecycle ────────────────────────────────────────────────────────────────


def local_date_for(started_at: datetime, offset_minutes: int | None):
    offset = DEFAULT_OFFSET_MINUTES if offset_minutes is None else int(offset_minutes)
    return (started_at + timedelta(minutes=offset)).date()


def _int(value, lo=0, hi=200_000) -> int:
    try:
        return max(lo, min(hi, int(value)))
    except (TypeError, ValueError):
        return lo


def apply_counters(walk, data: dict) -> None:
    """Running counters from the phone (never decrease)."""
    walk.steps = max(walk.steps, _int(data.get("steps")))
    walk.gait_verified_steps = max(walk.gait_verified_steps, _int(data.get("gait_verified_steps")))
    walk.gait_shake_steps = max(walk.gait_shake_steps, _int(data.get("gait_shake_steps")))
    walk.gait_unknown_steps = max(walk.gait_unknown_steps, _int(data.get("gait_unknown_steps")))
    walk.vehicle_seconds = max(walk.vehicle_seconds, _int(data.get("vehicle_seconds"), 0, 86_400))
    if data.get("mock_location"):
        walk.mock_location = True


def add_points(walk, raw_points, now=None) -> int:
    points = clean_points(raw_points, started_at=walk.started_at, now=now)
    if any(p["mock"] for p in points):
        walk.mock_location = True
    walk.raw_points = merge_points(walk.raw_points or [], points)
    walk.points_count = len(walk.raw_points)
    return len(points)


def finish_walk(walk, data: dict, *, now=None) -> None:
    """Decide the verdict, store the simplified route, refresh the day's tiers."""
    from . import integrity
    from .evidence import refresh_day
    from .models import HealthRecord

    now = now or timezone.now()
    apply_counters(walk, data)
    add_points(walk, data.get("points") or [], now=now)
    ended_at = _parse_time(data.get("ended_at")) or now
    ended_at = min(max(ended_at, walk.started_at), now + timedelta(minutes=5))
    walk.ended_at = ended_at
    walk.auto_ended = bool(walk.auto_ended or data.get("auto_ended"))
    walk.duration_s = int((ended_at - walk.started_at).total_seconds())
    offset = walk.tz_offset_minutes if walk.tz_offset_minutes is not None else DEFAULT_OFFSET_MINUTES
    metrics = route_metrics(walk.raw_points or [], tz_offset_minutes=offset)
    walk.distance_m = round(metrics["distance_m"], 1)
    walk.avg_speed_mps = round(metrics["avg_speed_mps"], 2)
    walk.max_speed_mps = round(metrics["max_speed_mps"], 2)
    walk.vehicle_seconds = max(walk.vehicle_seconds, int(metrics["vehicle_seconds"]))
    walk.vehicle_hours = [
        {"hour": h, "seconds": int(s)} for h, s in sorted(metrics["vehicle_by_hour"].items())
    ]
    walk.simplified_polyline = encode_polyline(douglas_peucker(metrics["route"]))
    blocked = integrity.blocks_money(
        walk.integrity_status, platform=walk.platform, started_at=walk.started_at, now=now
    )
    verdict, reasons, verified = decide(
        steps=walk.steps,
        duration_s=walk.duration_s,
        metrics=metrics,
        points_count=walk.points_count,
        gait_verified=walk.gait_verified_steps,
        gait_shake=walk.gait_shake_steps,
        gait_unknown=walk.gait_unknown_steps,
        client_vehicle_seconds=walk.vehicle_seconds,
        mock=walk.mock_location,
        platform=walk.platform,
        step_source=walk.step_source,
        integrity_blocked=blocked,
    )
    walk.verdict = verdict
    walk.verdict_reasons = reasons
    walk.verified_steps = verified
    walk.status = "finished"
    walk.save()
    with transaction.atomic():
        record = (
            HealthRecord.objects.select_for_update()
            .filter(user_id=walk.user_id, date=walk.local_date)
            .first()
        )
        if record is not None and (record.anticheat or {}).get("p1b"):
            previous_eligible = record.eligible_steps
            refresh_day(record)
            if previous_eligible != record.eligible_steps:
                from .views import recompute_challenge_progress

                recompute_challenge_progress(walk.user, walk.local_date, record)


def walk_summary(walk, *, zone=None) -> dict[str, Any]:
    route = decode_polyline(walk.simplified_polyline) if walk.simplified_polyline else []
    if not route and walk.raw_points:
        route = [(p["lat"], p["lng"]) for p in walk.raw_points]
    reasons = [
        {"code": c, "severity": REASON_SEVERITY.get(c, "info"), "user_message": REASON_MESSAGES[c]}
        for c in (walk.verdict_reasons or [])
        if c in REASON_MESSAGES
    ]
    return {
        "id": str(walk.id),
        "status": walk.status,
        "verdict": walk.verdict,
        "started_at": walk.started_at.isoformat() if walk.started_at else None,
        "ended_at": walk.ended_at.isoformat() if walk.ended_at else None,
        "local_date": str(walk.local_date),
        "duration_s": int(walk.duration_s or 0),
        "steps": int(walk.steps or 0),
        "verified_steps": int(walk.verified_steps or 0),
        "distance_m": round(float(walk.distance_m or 0.0), 1),
        "avg_speed_mps": round(float(walk.avg_speed_mps or 0.0), 2),
        "max_speed_mps": round(float(walk.max_speed_mps or 0.0), 2),
        "auto_ended": bool(walk.auto_ended),
        "mock_location": bool(walk.mock_location),
        "polyline": encode_polyline(route) if route else "",
        "shared_polyline": encode_polyline(shared_route(route, zone)),
        "reasons": reasons,
    }


def purge_old_walk_points(now=None, batch: int = 500) -> int:
    """Retention: delete raw GPS points of walks that ended more than
    WALK_RAW_POINTS_RETENTION_DAYS ago (the simplified route is kept). Also closes
    walks left active for more than a day (app killed) as abandoned."""
    from .models import WalkSession

    now = now or timezone.now()
    days = int(getattr(settings, "WALK_RAW_POINTS_RETENTION_DAYS", 30))
    cutoff = now - timedelta(days=days)
    WalkSession.objects.filter(status="active", started_at__lt=now - timedelta(days=1)).update(
        status="abandoned", updated_at=now
    )
    purged = 0
    while True:
        ids = list(
            WalkSession.objects.filter(raw_points_purged_at__isnull=True)
            .exclude(status="active")
            .filter(started_at__lt=cutoff)
            .values_list("id", flat=True)[:batch]
        )
        if not ids:
            break
        purged += WalkSession.objects.filter(id__in=ids).update(
            raw_points=[], raw_points_purged_at=now, updated_at=now
        )
    return purged
