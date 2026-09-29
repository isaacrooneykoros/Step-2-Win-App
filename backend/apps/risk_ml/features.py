"""
Per user-day feature computation (pure Python, no database access).

``compute_day_features(DayInputs)`` turns plain data for one user and one day into a
flat dict of numbers (or None when not applicable). The database loader in
``feature_store.py`` and the synthetic scenarios in ``synthetic.py`` both build
``DayInputs``, so tests and the evaluation exercise exactly the production code path.

Privacy: waypoints come in only as transient input; the output holds distances,
speeds and counts, never coordinates. Phone numbers never enter this module (the
loader passes counts only).

Bump FEATURE_VERSION when a definition changes; rows of different versions are kept
side by side and models record the version they were trained on.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone as dt_timezone

FEATURE_VERSION = "f1"

# Hours of the phone's local day counted as "1-4 AM" (01:00-03:59).
NIGHT_HOURS = (1, 2, 3)
ACTIVE_HOUR_STEPS = 250          # an hour with at least this many steps is "active"
BASELINE_DAYS = 28               # rolling window for the user's own baseline
MIN_BASELINE_DAYS = 5            # fewer recorded days -> no personal baseline (None)
BASELINE_FLOOR_STEPS = 500       # keeps ratios sane for near-inactive users
GPS_MAX_ACCURACY_M = 50.0        # ignore fixes worse than this
GPS_MAX_GAP_S = 30 * 60          # consecutive fixes further apart are not a segment
GPS_GLITCH_KMH = 200.0           # faster than this is a GPS jump, not travel
VEHICLE_KMH = 20.0               # sustained speed above this is not walking/running
LATE_SYNC_GRACE_H = 1            # a sync this long after the local day ended is "late"


@dataclass
class SyncObs:
    """One sync upload (from StepSyncEvent; gait fields from its payload)."""

    created_at: datetime
    accepted: bool = True
    replay: bool = False
    steps: int | None = None
    gait_confidence: float | None = None
    shake_prob: float | None = None
    walk_prob: float | None = None
    ml_label: str | None = None
    cadence: float | None = None
    burst_5s: float | None = None
    carry_mode: str | None = None
    interval_std_ms: float | None = None
    autocorr: float | None = None


@dataclass
class Waypoint:
    recorded_at: datetime
    lat: float
    lon: float
    accuracy_m: float = 0.0
    hour: int | None = None


@dataclass
class ChallengeCtx:
    """A challenge the user was in on this day."""

    entry_fee: float
    milestone: int
    start: date
    end: date
    steps_before_day: int  # user's steps from start up to (not including) this day


@dataclass
class AccountCtx:
    account_age_days: float | None = None
    devices_per_account: int = 0
    max_accounts_per_device: int = 0     # including this account; 1 = not shared
    mpesa_shared_accounts: int = 0       # OTHER accounts using the same M-Pesa number
    phone_prefix_cluster: int = 0        # OTHER accounts, near-identical number, joined within 14 days


@dataclass
class DayInputs:
    day: date
    steps: int = 0
    history: list[tuple[date, int]] = field(default_factory=list)   # prior days with a record
    hourly: list[int] = field(default_factory=lambda: [0] * 24)
    prev_hourly: dict[date, list[int]] = field(default_factory=dict)  # up to 7 prior days
    syncs: list[SyncObs] = field(default_factory=list)
    waypoints: list[Waypoint] = field(default_factory=list)
    account: AccountCtx = field(default_factory=AccountCtx)
    challenges: list[ChallengeCtx] = field(default_factory=list)
    twin_count: int = 0                  # other accounts with a near-identical hourly curve today
    local_utc_offset_h: int = 3          # Kenya (EAT)


# ── small maths helpers ─────────────────────────────────────────────────────


def median(values):
    vals = sorted(values)
    n = len(vals)
    if not n:
        return None
    mid = n // 2
    return float(vals[mid]) if n % 2 else (vals[mid - 1] + vals[mid]) / 2.0


def mad(values, med=None):
    if not values:
        return None
    med = median(values) if med is None else med
    return median([abs(v - med) for v in values])


def _mean(values):
    return sum(values) / len(values) if values else None


def _std(values):
    if len(values) < 2:
        return None
    m = sum(values) / len(values)
    return math.sqrt(sum((v - m) ** 2 for v in values) / len(values))


def cosine(a, b):
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(x * x for x in b))
    if not na or not nb:
        return None
    return sum(x * y for x, y in zip(a, b)) / (na * nb)


def share_l1(a, b):
    """L1 distance between two hourly curves as shares of their totals (0 = identical, 2 = disjoint)."""
    ta, tb = sum(a), sum(b)
    if ta <= 0 or tb <= 0:
        return None
    return sum(abs(x / ta - y / tb) for x, y in zip(a, b))


def haversine_km(lat1, lon1, lat2, lon2):
    r = 6371.0088
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(h)))


def _r(v, nd=4):
    return None if v is None else round(float(v), nd)


# ── feature groups ─────────────────────────────────────────────────────────


def volume_features(inp: DayInputs) -> dict:
    window_start = inp.day - timedelta(days=BASELINE_DAYS)
    hist = [s for d, s in inp.history if window_start <= d < inp.day and s > 0]
    out = {"steps": int(inp.steps), "history_days": len(hist), "dow": inp.day.weekday(),
           "is_weekend": int(inp.day.weekday() >= 5)}
    raw = [s.steps for s in inp.syncs if s.steps is not None and s.accepted and not s.replay]
    out["steps_raw_max"] = max(raw) if raw else None
    if len(hist) >= MIN_BASELINE_DAYS:
        med = median(hist)
        dev = mad(hist, med)
        scale = max(1.4826 * dev, 0.1 * med, BASELINE_FLOOR_STEPS)
        out["user_median_steps"] = round(med, 1)
        out["user_mad_steps"] = round(dev, 1)
        out["steps_robust_z"] = _r((inp.steps - med) / scale, 3)
        out["steps_ratio_to_median"] = _r(inp.steps / max(med, BASELINE_FLOOR_STEPS), 3)
        same_dow = [s for d, s in inp.history if d < inp.day and s > 0 and d.weekday() == inp.day.weekday()
                    and d >= inp.day - timedelta(days=35)]
        out["dow_ratio"] = _r(inp.steps / max(median(same_dow), BASELINE_FLOOR_STEPS), 3) if len(same_dow) >= 2 else None
    else:
        out.update(user_median_steps=None, user_mad_steps=None, steps_robust_z=None,
                   steps_ratio_to_median=None, dow_ratio=None)
    return out


def timing_features(inp: DayInputs) -> dict:
    hourly = [max(0, int(h)) for h in (inp.hourly or [0] * 24)][:24]
    hourly += [0] * (24 - len(hourly))
    total = sum(hourly)
    out = {"hourly_total": total,
           "hourly_coverage": _r(total / inp.steps, 3) if inp.steps > 0 else None}
    if total <= 0:
        out.update(hour_entropy=None, night_share=None, max_hour_steps=0, active_hours=0,
                   longest_active_span_h=0, curve_l1_min_prev=None,
                   total_repeat_7d=_repeat_count(inp),
                   round_total=int(inp.steps >= 1000 and inp.steps % 100 == 0))
        return out
    shares = [h / total for h in hourly]
    ent = -sum(p * math.log(p) for p in shares if p > 0) / math.log(24)
    longest = run = 0
    for h in hourly:
        run = run + 1 if h >= ACTIVE_HOUR_STEPS else 0
        longest = max(longest, run)
    # Distance to the most similar of the previous 7 days' hourly shapes. People repeat
    # routines, but never to within a few percent in every hour; replayed/scripted days do.
    dists = []
    if total >= 1000:
        for d, prev in sorted(inp.prev_hourly.items()):
            if inp.day - timedelta(days=7) <= d < inp.day and sum(prev) >= 1000:
                dist = share_l1(hourly, prev)
                if dist is not None:
                    dists.append(dist)
    out.update(
        hour_entropy=_r(ent, 4),
        night_share=_r(sum(hourly[h] for h in NIGHT_HOURS) / total, 4),
        max_hour_steps=max(hourly),
        active_hours=sum(1 for h in hourly if h >= ACTIVE_HOUR_STEPS),
        longest_active_span_h=longest,
        curve_l1_min_prev=_r(min(dists), 4) if dists else None,
        total_repeat_7d=_repeat_count(inp),
        round_total=int(inp.steps >= 1000 and inp.steps % 100 == 0),
    )
    return out


def _repeat_count(inp: DayInputs) -> int:
    if inp.steps < 1000:
        return 0
    lo = inp.day - timedelta(days=7)
    return sum(1 for d, s in inp.history if lo <= d < inp.day and abs(s - inp.steps) <= 5)


def _local_day_end_utc(day: date, offset_h: int) -> datetime:
    end_local = datetime(day.year, day.month, day.day, tzinfo=dt_timezone.utc) + timedelta(days=1)
    return end_local - timedelta(hours=offset_h)


def sync_features(inp: DayInputs) -> dict:
    syncs = sorted(inp.syncs, key=lambda s: s.created_at)
    n = len(syncs)
    out = {"sync_count": n,
           "accepted_sync_count": sum(1 for s in syncs if s.accepted and not s.replay),
           "rejected_count": sum(1 for s in syncs if not s.accepted and not s.replay),
           "replay_count": sum(1 for s in syncs if s.replay)}
    if not n:
        out.update(max_sync_gap_h=None, late_sync_share=None, days_late_max=0)
        return out
    gaps = [(b.created_at - a.created_at).total_seconds() / 3600.0 for a, b in zip(syncs, syncs[1:])]
    day_end = _local_day_end_utc(inp.day, inp.local_utc_offset_h)
    grace = timedelta(hours=LATE_SYNC_GRACE_H)
    late = [s for s in syncs if s.created_at > day_end + grace]
    out["max_sync_gap_h"] = _r(max(gaps), 2) if gaps else None
    out["late_sync_share"] = _r(len(late) / n, 3)
    out["days_late_max"] = max([int((s.created_at - day_end).total_seconds() // 86400) + 1 for s in late] or [0])
    return out


def gait_features(inp: DayInputs) -> dict:
    syncs = inp.syncs
    n = len(syncs)
    gait = [s for s in syncs if s.gait_confidence is not None]
    conf = [s.gait_confidence for s in gait]
    shake = [s.shake_prob for s in syncs if s.shake_prob is not None]
    walk = [s.walk_prob for s in syncs if s.walk_prob is not None]
    cad = [s.cadence for s in syncs if s.cadence is not None and s.cadence > 0]
    burst = [s.burst_5s for s in syncs if s.burst_5s is not None]
    istd = [s.interval_std_ms for s in syncs if s.interval_std_ms is not None]
    ac = [s.autocorr for s in syncs if s.autocorr is not None]
    labels = [s.ml_label for s in syncs if s.ml_label]
    carry = [s.carry_mode or "unknown" for s in gait]
    out = {
        "gait_sync_count": len(gait),
        "gait_sync_share": _r(len(gait) / n, 3) if n else None,
        "gait_conf_mean": _r(_mean(conf), 4),
        "gait_conf_min": _r(min(conf), 4) if conf else None,
        "shake_prob_mean": _r(_mean(shake), 4),
        "shake_prob_max": _r(max(shake), 4) if shake else None,
        "walk_prob_mean": _r(_mean(walk), 4),
        "ml_shake_label_share": _r(sum(1 for lab in labels if lab == "shake") / len(labels), 3) if labels else None,
        "cadence_mean": _r(_mean(cad), 2),
        "cadence_std": _r(_std(cad), 2),
        "cadence_max": _r(max(cad), 2) if cad else None,
        "burst_max": _r(max(burst), 2) if burst else None,
        "burst_mean": _r(_mean(burst), 2),
        "gait_interval_std_mean": _r(_mean(istd), 2),
        "gait_autocorr_mean": _r(_mean(ac), 4),
    }
    for mode in ("in_hand", "pocket", "bag", "unknown"):
        out[f"carry_{mode}_share"] = _r(carry.count(mode) / len(carry), 3) if carry else None
    return out


def route_features(inp: DayInputs) -> dict:
    pts = sorted((w for w in inp.waypoints if not w.accuracy_m or w.accuracy_m <= GPS_MAX_ACCURACY_M),
                 key=lambda w: w.recorded_at)
    out = {"waypoint_count": len(inp.waypoints), "route_km": 0.0, "route_km_per_1k_steps": None,
           "speed_p95_kmh": None, "fast_time_share": None, "vehicle_step_share": None}
    if len(pts) < 2:
        return out
    km = 0.0
    total_s = fast_s = 0.0
    speeds: list[float] = []
    hour_time: dict[int, list[float]] = {}  # hour -> [seconds, fast seconds]
    covered_hours: set[int] = set()
    for a, b in zip(pts, pts[1:]):
        dt = (b.recorded_at - a.recorded_at).total_seconds()
        if dt <= 0 or dt > GPS_MAX_GAP_S:
            continue
        d = haversine_km(a.lat, a.lon, b.lat, b.lon)
        kmh = d / (dt / 3600.0)
        if kmh > GPS_GLITCH_KMH:
            continue
        km += d
        total_s += dt
        hour = a.hour if a.hour is not None else (a.recorded_at + timedelta(hours=inp.local_utc_offset_h)).hour
        covered_hours.add(hour)
        slot = hour_time.setdefault(hour, [0.0, 0.0])
        slot[0] += dt
        if dt >= 5:
            speeds.append(kmh)
        if kmh >= VEHICLE_KMH:
            fast_s += dt
            slot[1] += dt
    out["route_km"] = _r(km, 3)
    # 95th percentile, not max: one GPS jump shouldn't read as a car ride.
    speeds.sort()
    out["speed_p95_kmh"] = _r(speeds[min(len(speeds) - 1, int(0.95 * len(speeds)))], 1) if speeds else None
    out["fast_time_share"] = _r(fast_s / total_s, 3) if total_s else None
    hourly = inp.hourly or [0] * 24
    covered_steps = sum(hourly[h] for h in covered_hours if 0 <= h < 24)
    if covered_steps >= 500:
        # Compare distance with the steps of the SAME hours (uploads carry partial routes).
        out["route_km_per_1k_steps"] = _r(km / (covered_steps / 1000.0), 3)
    hourly_total = sum(hourly)
    if hourly_total > 0:
        vehicle_hours = [h for h, (t, f) in hour_time.items() if t > 0 and f / t >= 0.5 and 0 <= h < 24]
        out["vehicle_step_share"] = _r(sum(hourly[h] for h in vehicle_hours) / hourly_total, 3)
    return out


def account_features(inp: DayInputs) -> dict:
    a = inp.account
    return {
        "account_age_days": _r(a.account_age_days, 1),
        "devices_per_account": a.devices_per_account,
        "max_accounts_per_device": a.max_accounts_per_device,
        "mpesa_shared_accounts": a.mpesa_shared_accounts,
        "phone_prefix_cluster": a.phone_prefix_cluster,
        "twin_count": inp.twin_count,
    }


def money_features(inp: DayInputs, ratio_to_median) -> dict:
    active = [c for c in inp.challenges if c.start <= inp.day <= c.end]
    out = {"in_challenge": int(bool(active)), "in_paid_challenge": 0, "entry_fee_exposure_kes": 0.0,
           "days_to_deadline": None, "milestone_gap_before": None, "milestone_share_today": None,
           "crossed_milestone_today": 0, "deadline_surge_ratio": 0.0}
    if not active:
        return out
    paid = [c for c in active if c.entry_fee > 0]
    out["in_paid_challenge"] = int(bool(paid))
    out["entry_fee_exposure_kes"] = round(sum(c.entry_fee for c in paid), 2)
    nearest = min(active, key=lambda c: (c.end - inp.day).days)
    out["days_to_deadline"] = (nearest.end - inp.day).days
    gap = max(0, nearest.milestone - nearest.steps_before_day)
    out["milestone_gap_before"] = gap
    out["milestone_share_today"] = _r(min(inp.steps / gap, 5.0), 3) if gap > 0 else 0.0
    out["crossed_milestone_today"] = int(any(
        c.steps_before_day < c.milestone <= c.steps_before_day + inp.steps for c in active))
    if out["days_to_deadline"] <= 1 and ratio_to_median is not None:
        out["deadline_surge_ratio"] = ratio_to_median
    return out


def compute_day_features(inp: DayInputs) -> dict:
    feats: dict = {}
    feats.update(volume_features(inp))
    feats.update(timing_features(inp))
    feats.update(sync_features(inp))
    feats.update(gait_features(inp))
    feats.update(route_features(inp))
    feats.update(account_features(inp))
    feats.update(money_features(inp, feats.get("steps_ratio_to_median")))
    return feats


# ── population pass (cross-account) ─────────────────────────────────────────

TWIN_MIN_STEPS = 2000
TWIN_MAX_L1 = 0.05


def _curve_keys(vec: list[int]) -> tuple:
    total = sum(vec) or 1
    fine = tuple(int(round(v / total * 50)) for v in vec)
    coarse = tuple(int(round(v / total * 20)) for v in vec)
    return fine, coarse


def twin_counts(curves: dict) -> dict:
    """
    ``curves``: {user_id: 24-hour vector} for ONE day. Returns {user_id: number of OTHER
    accounts whose hourly shape is near-identical (share L1 distance <= 0.05, i.e.
    within a few percent in every hour)}.

    Buckets by quantised shape first so it stays ~linear for thousands of users; exact
    and near-exact copies land in the same bucket. Curves that differ by noise straddling
    a bucket edge can be missed (documented limitation).
    """
    return {u: len(s) for u, s in twin_pairs(curves).items()}


def twin_pairs(curves: dict) -> dict:
    """Same detection as ``twin_counts`` but returns {user_id: set of twin user ids}
    (used by apps.linkage to build account-to-account edges)."""
    buckets: dict = {}
    eligible = {u: v for u, v in curves.items() if sum(v) >= TWIN_MIN_STEPS}
    for uid, vec in eligible.items():
        for key in _curve_keys(vec):
            buckets.setdefault(key, []).append(uid)
    twins: dict = {u: set() for u in curves}
    for members in buckets.values():
        if len(members) < 2 or len(members) > 500:
            continue
        for i, a in enumerate(members):
            for b in members[i + 1:]:
                if b in twins[a]:
                    continue
                dist = share_l1(eligible[a], eligible[b])
                if dist is not None and dist <= TWIN_MAX_L1:
                    twins[a].add(b)
                    twins[b].add(a)
    return twins
