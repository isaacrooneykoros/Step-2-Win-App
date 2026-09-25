"""
SYNTHETIC scenarios for testing the anomaly model. Never stored as real labels.

Everything here is invented: archetypes of honest users and of cheats, generated as
``DayInputs`` and passed through the SAME feature code as production
(``features.compute_day_features``) and the same population pass (``twin_counts``).

Honest: student, runner (high cadence, big run days), 35k/day worker, treadmill user,
rural late-syncing iPhone user (no motion data). Cheats: phone shaker, script
(too-perfect totals, identical daily curves), vehicle vibration (steps at road speed),
multi-account farm (N accounts, identical hourly curves, shared phone/M-Pesa).

Limitations (see EVALUATION.md): the generator and the evidence checks were written
by the same person from the same threat model, so good separation here is a sanity
check that the plumbing works, not an estimate of real-world accuracy.
"""

from __future__ import annotations

import math
import random
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone as dt_timezone

from .features import (AccountCtx, ChallengeCtx, DayInputs, SyncObs, Waypoint,
                       compute_day_features, twin_counts)

HONEST = ("student", "runner", "worker_35k", "treadmill", "rural_late_sync")
CHEATS = ("phone_shaker", "script", "vehicle_vibration", "account_farm")
# Deliberately careful cheats we do NOT expect server-side data to catch (reported, not asserted).
EVASIVE = ("subtle_shaker", "noisy_script")
BASE_DAY = date(2026, 6, 1)
OFFSET_H = 3
NAIROBI = (-1.2864, 36.8172)


@dataclass
class SynthUser:
    uid: int
    archetype: str
    is_cheat: bool
    account: AccountCtx
    ios: bool = False
    farm_id: int | None = None
    base_lat: float = NAIROBI[0]
    base_lon: float = NAIROBI[1]
    # day -> dict(hourly, syncs, waypoints, cheat_day)
    days: dict = field(default_factory=dict)


def _utc(day: date, hour: float) -> datetime:
    base = datetime(day.year, day.month, day.day, tzinfo=dt_timezone.utc)
    return base + timedelta(hours=hour - OFFSET_H)


def _profile(rng, spec: dict, scale: float = 1.0, noise: float = 0.3) -> list[int]:
    out = [0] * 24
    for hour, mean in spec.items():
        out[hour] = max(0, int(mean * scale * math.exp(rng.gauss(0, noise))))
    for h in range(24):  # background pottering
        if out[h] == 0 and 6 <= h <= 22 and rng.random() < 0.5:
            out[h] = int(rng.uniform(20, 180))
    return out


def _walk_points(rng, day, hour, minutes, km, base, speed_noise=0.1):
    """Waypoints every 30 s along a line: `km` kilometres in `minutes` minutes."""
    n = max(2, int(minutes * 2))
    heading = rng.uniform(0, 2 * math.pi)
    lat, lon = base
    step_km = km / (n - 1)
    pts = []
    start = _utc(day, hour) + timedelta(minutes=rng.uniform(0, max(0.0, 60 - minutes)))
    for i in range(n):
        pts.append(Waypoint(recorded_at=start + timedelta(seconds=30 * i), lat=lat, lon=lon,
                            accuracy_m=rng.uniform(5, 20), hour=hour))
        d = step_km * max(0.0, 1 + rng.gauss(0, speed_noise))
        lat += (d / 111.0) * math.cos(heading)
        lon += (d / 111.0) * math.sin(heading)
    return pts


CLIENT_MAX_SPEED_MPS = 8.0      # StepCaptureForegroundService.WAYPOINT_MAX_SPEED_MPS
CLIENT_MIN_DISTANCE_M = 2.5     # StepCaptureForegroundService.WAYPOINT_MIN_DISTANCE_METERS


def client_filter(points):
    """Mimic the Android capture filter: a fix implying > 8 m/s from the last KEPT fix is
    dropped (and the last kept fix doesn't move), so fast vehicle travel leaves no trace."""
    from .features import haversine_km

    kept = []
    for p in sorted(points, key=lambda w: w.recorded_at):
        if kept:
            last = kept[-1]
            meters = haversine_km(last.lat, last.lon, p.lat, p.lon) * 1000.0
            dt = max(1.0, (p.recorded_at - last.recorded_at).total_seconds())
            if meters < CLIENT_MIN_DISTANCE_M or meters / dt > CLIENT_MAX_SPEED_MPS:
                continue
        kept.append(p)
    return kept


def _gait_sync(rng, when, total, *, walk=True, cadence=(100, 118), carry=("pocket", "in_hand"),
               burst=(7, 14), shake=(0.03, 0.2), conf=(0.65, 0.92)):
    if walk:
        return SyncObs(created_at=when, steps=total, gait_confidence=rng.uniform(*conf),
                       shake_prob=rng.uniform(*shake), walk_prob=rng.uniform(0.7, 0.95), ml_label="walk",
                       cadence=rng.uniform(*cadence), burst_5s=rng.uniform(*burst), carry_mode=rng.choice(carry),
                       interval_std_ms=rng.uniform(25, 60), autocorr=rng.uniform(0.55, 0.85))
    return SyncObs(created_at=when, steps=total)


def _hourly_syncs(rng, day, hourly, hours, *, gait_p=0.8, ios=False, **gait_kw):
    syncs, running = [], 0
    for h in range(24):
        running += hourly[h]
        if h in hours:
            when = _utc(day, h + rng.uniform(0.2, 0.95))
            walk = (not ios) and rng.random() < gait_p
            syncs.append(_gait_sync(rng, when, running, walk=walk, **gait_kw))
    return syncs


# ── archetype day generators ────────────────────────────────────────────────


def _student(rng, u, day, i):
    weekend = day.weekday() >= 5
    spec = {7: 1100, 8: 700, 10: 400, 13: 900, 16: 1200, 17: 900, 20: 500} if not weekend else \
        {10: 800, 12: 900, 15: 1300, 18: 900}
    hourly = _profile(rng, spec, scale=rng.uniform(0.75, 1.3))
    syncs = _hourly_syncs(rng, day, hourly, range(7, 23, 2))
    wps = []
    if rng.random() < 0.3:
        wps = _walk_points(rng, day, 16, 25, hourly[16] / 1000 * 0.72, (u.base_lat, u.base_lon))
    return hourly, syncs, wps


def _runner(rng, u, day, i):
    run_day = day.weekday() in (1, 3, 5)
    spec = {7: 900, 12: 700, 17: 1000, 19: 800}
    if run_day:
        spec[6] = 9500  # ~55 min at 170-180 spm
    hourly = _profile(rng, spec, scale=rng.uniform(0.85, 1.15), noise=0.2)
    syncs = _hourly_syncs(rng, day, hourly, range(7, 23, 2))
    wps = []
    if run_day:
        syncs.append(_gait_sync(rng, _utc(day, 6.95), sum(hourly[:7]), cadence=(165, 182), burst=(14, 17),
                                carry=("in_hand",)))
        wps = _walk_points(rng, day, 6, 55, hourly[6] / 1000 * 1.15, (u.base_lat, u.base_lon))
    return hourly, syncs, wps


def _worker(rng, u, day, i):
    if day.weekday() == 6:
        spec = {10: 1500, 12: 2000, 15: 2500, 18: 1500}
    else:
        spec = {h: 3200 for h in range(7, 18)}
        spec[12] = 1800
    hourly = _profile(rng, spec, scale=rng.uniform(0.9, 1.1), noise=0.15)
    syncs = _hourly_syncs(rng, day, hourly, range(7, 22), carry=("pocket",), cadence=(104, 116))
    wps = _walk_points(rng, day, 9, 50, hourly[9] / 1000 * 0.7, (u.base_lat, u.base_lon)) if rng.random() < 0.3 else []
    return hourly, syncs, wps


def _treadmill(rng, u, day, i):
    gym = day.weekday() in (0, 2, 4)
    spec = {7: 900, 13: 700, 17: 800, 20: 400}
    if gym:
        spec[18] = 5200
    hourly = _profile(rng, spec, scale=rng.uniform(0.85, 1.2), noise=0.2)
    syncs = _hourly_syncs(rng, day, hourly, range(7, 23, 2))
    wps = []
    if gym:  # the walking service records GPS, but the phone stays in the gym
        wps = _walk_points(rng, day, 18, 45, 0.06, (u.base_lat, u.base_lon), speed_noise=0.5)
    return hourly, syncs, wps


def _rural(rng, u, day, i):
    spec = {h: 900 for h in range(6, 17)}
    spec[12] = 400
    hourly = _profile(rng, spec, scale=rng.uniform(0.8, 1.2), noise=0.3)
    syncs = []
    # Signal only in town every 2-3 days: this day's steps upload 1-3 days late.
    if i % 3 != 1:
        delay = rng.choice((1, 2, 3))
        syncs.append(SyncObs(created_at=_utc(day + timedelta(days=delay), 18.5), steps=sum(hourly)))
    else:
        syncs.append(SyncObs(created_at=_utc(day, 19.0), steps=sum(hourly)))
    return hourly, syncs, []


def _shaker(rng, u, day, i):
    base = {7: 700, 12: 600, 17: 900, 19: 500}
    hourly = _profile(rng, base, scale=rng.uniform(0.8, 1.2))
    cheat = u.days_cheat(day)
    syncs = _hourly_syncs(rng, day, hourly, range(7, 22, 3))
    if cheat:
        # Phone on a shaker / swung by hand in the evening and overnight.
        hours = rng.choice(([21, 22, 23, 0, 1, 2], [0, 1, 2, 3, 4], [13, 14, 15, 22, 23]))
        for h in hours:
            hourly[h] += int(rng.uniform(4500, 7000))
        for h in hours:
            if rng.random() < 0.5:  # gait snapshot only when the app/service happened to run
                syncs.append(_gait_sync(rng, _utc(day, h + 0.5), sum(hourly), cadence=(150, 230), burst=(30, 48),
                                        shake=(0.55, 0.92), conf=(0.2, 0.55), carry=("in_hand", "unknown")))
            else:
                syncs.append(SyncObs(created_at=_utc(day, h + 0.5), steps=sum(hourly)))
    return hourly, syncs, []


SCRIPT_CURVE = [0, 0, 0, 0, 0, 0, 600, 1400, 900, 700, 800, 900, 1000, 800, 700, 900, 1100, 1300, 700, 100, 0, 0, 0, 0]


def _script(rng, u, day, i):
    total_target = u.script_total
    scale = total_target / sum(SCRIPT_CURVE)
    hourly = [int(round(v * scale)) for v in SCRIPT_CURVE]
    hourly[7] += total_target - sum(hourly)  # exact round total
    syncs = []
    running = 0
    for h in range(24):
        running += hourly[h]
        if h % 2 == 0 and 6 <= h <= 20:
            syncs.append(SyncObs(created_at=_utc(day, h + 0.5), steps=running,
                                 gait_confidence=0.9 if u.script_fakes_gait else None,
                                 shake_prob=0.05 if u.script_fakes_gait else None,
                                 walk_prob=0.95 if u.script_fakes_gait else None,
                                 ml_label="walk" if u.script_fakes_gait else None,
                                 cadence=110.0 if u.script_fakes_gait else None,
                                 burst_5s=9.0 if u.script_fakes_gait else None,
                                 carry_mode="pocket" if u.script_fakes_gait else None))
    return hourly, syncs, []


def _vehicle(rng, u, day, i):
    spec = {7: 800, 12: 700, 18: 900}
    hourly = _profile(rng, spec, scale=rng.uniform(0.8, 1.2))
    syncs = _hourly_syncs(rng, day, hourly, range(7, 22, 2))
    wps = []
    if u.days_cheat(day):
        # Phone on a boda / matatu seat: vibration counted as steps at road speed. Town
        # traffic (15-28 km/h) survives the client GPS filter; faster legs leave no fixes.
        for h in (8, 9, 16, 17):
            hourly[h] += int(rng.uniform(2200, 4000))
            kmh = rng.uniform(15, 60)
            wps += _walk_points(rng, day, h, 50, kmh * 50 / 60, (u.base_lat, u.base_lon), speed_noise=0.25)
            syncs.append(_gait_sync(rng, _utc(day, h + 0.9), sum(hourly), walk=rng.random() < 0.4,
                                    cadence=(90, 140), burst=(10, 25), shake=(0.2, 0.6), conf=(0.3, 0.7)))
    return hourly, syncs, wps


def _subtle_shaker(rng, u, day, i):
    """Evasive: shakes the phone ~40 min in the afternoon, app closed (no motion data)."""
    hourly, syncs, _ = _student(rng, u, day, i)
    syncs = [SyncObs(created_at=s.created_at, steps=s.steps) for s in syncs]  # no gait snapshots
    if u.days_cheat(day):
        for h in (14, 15):
            hourly[h] += int(rng.uniform(1500, 2500))
    return hourly, syncs, []


def _noisy_script(rng, u, day, i):
    """Evasive: a script that imitates a student's day with random noise and odd totals."""
    hourly, _, _ = _student(rng, u, day, i)
    syncs = _hourly_syncs(rng, day, hourly, range(7, 23, 2), gait_p=0.0)
    return hourly, syncs, []


def _farm(rng, u, day, i):
    # Every account in a farm replays the same recorded day with tiny jitter.
    curve = u.farm_curves[day]
    hourly = [max(0, v + int(rng.uniform(-15, 15))) if v else 0 for v in curve]
    syncs = _hourly_syncs(rng, day, hourly, range(8, 22, 3), gait_p=0.3)
    return hourly, syncs, []


GENERATORS = {
    "student": _student, "runner": _runner, "worker_35k": _worker, "treadmill": _treadmill,
    "rural_late_sync": _rural, "phone_shaker": _shaker, "script": _script,
    "vehicle_vibration": _vehicle, "account_farm": _farm,
    "subtle_shaker": _subtle_shaker, "noisy_script": _noisy_script,
}


# ── population ─────────────────────────────────────────────────────────────


@dataclass
class SynthDay:
    user: SynthUser
    day: date
    features: dict
    is_cheat_day: bool


def generate_population(*, seed: int = 7, honest_per_archetype: int = 30, cheats_per_archetype: int = 6,
                        farm_size: int = 5, history_days: int = 28, eval_days: int = 7):
    """Returns (train_days, eval_days) as lists of SynthDay. Training days are the first
    ``history_days`` (unlabelled, as in production); evaluation days follow."""
    rng = random.Random(seed)
    users: list[SynthUser] = []
    uid = 1
    n_days = history_days + eval_days
    days = [BASE_DAY + timedelta(days=i) for i in range(n_days)]
    eval_start = days[history_days]

    def new_user(arch, cheat, **kw):
        nonlocal uid
        age = rng.uniform(60, 400)
        acc = AccountCtx(account_age_days=age, devices_per_account=1, max_accounts_per_device=1)
        u = SynthUser(uid=uid, archetype=arch, is_cheat=cheat, account=acc,
                      base_lat=NAIROBI[0] + rng.uniform(-0.1, 0.1), base_lon=NAIROBI[1] + rng.uniform(-0.1, 0.1), **kw)
        uid += 1
        users.append(u)
        return u

    for arch in HONEST:
        for _ in range(honest_per_archetype):
            new_user(arch, False, ios=(arch == "rural_late_sync"))
    for arch in ("phone_shaker", "script", "vehicle_vibration", *EVASIVE):
        for k in range(cheats_per_archetype):
            u = new_user(arch, True)
            if arch == "script":
                u.script_total = rng.choice((10000, 12000, 15000, 20000))
                u.script_fakes_gait = k % 2 == 0
    n_farms = max(1, cheats_per_archetype // farm_size + 1)
    for f in range(n_farms):
        # A farm records one real walking day per day and replays it on every account.
        curves = {}
        for d in days:
            spec = {h: rng.uniform(900, 2200) for h in rng.sample(range(7, 20), 8)}
            curves[d] = _profile(rng, spec, noise=0.1)
        base_phone_age = rng.uniform(20, 90)
        for k in range(farm_size):
            u = new_user("account_farm", True, farm_id=f)
            u.farm_curves = curves
            u.account = AccountCtx(account_age_days=base_phone_age + rng.uniform(0, 5), devices_per_account=1,
                                   max_accounts_per_device=2 if k < 4 else 1,
                                   mpesa_shared_accounts=farm_size - 1 if k < 3 else 0,
                                   phone_prefix_cluster=farm_size - 1)

    # Which days a part-time cheat cheats on: never in the first half of history (so they
    # have an honest baseline), most evaluation days.
    for u in users:
        cheat_days = set()
        if u.archetype in ("phone_shaker", "vehicle_vibration", "subtle_shaker"):
            for d in days:
                if d >= eval_start and rng.random() < 0.8:
                    cheat_days.add(d)
                elif d < eval_start and d >= days[history_days // 2] and rng.random() < 0.15:
                    cheat_days.add(d)
        elif u.is_cheat:
            cheat_days = set(days)
        u._cheat_days = cheat_days
        u.days_cheat = (lambda cd: (lambda d: d in cd))(cheat_days)

    # Raw per-day data.
    for u in users:
        for i, d in enumerate(days):
            hourly, syncs, wps = GENERATORS[u.archetype](rng, u, d, i)
            u.days[d] = {"hourly": hourly, "syncs": syncs, "waypoints": client_filter(wps)}

    # Challenges: everyone in a 7-day paid challenge over the evaluation week.
    ch_end = days[-1]
    train, evaluation = [], []
    for d in days:
        twins = twin_counts({u.uid: u.days[d]["hourly"] for u in users})
        for u in users:
            history = [(pd, sum(u.days[pd]["hourly"])) for pd in days if pd < d]
            steps = sum(u.days[d]["hourly"])
            challenges = []
            if d >= eval_start:
                before = sum(sum(u.days[pd]["hourly"]) for pd in days if eval_start <= pd < d)
                challenges = [ChallengeCtx(entry_fee=100.0, milestone=70000, start=eval_start, end=ch_end,
                                           steps_before_day=before)]
            inp = DayInputs(day=d, steps=steps, history=history, hourly=u.days[d]["hourly"],
                            prev_hourly={pd: u.days[pd]["hourly"] for pd in days if d - timedelta(days=7) <= pd < d},
                            syncs=u.days[d]["syncs"], waypoints=u.days[d]["waypoints"], account=u.account,
                            challenges=challenges, twin_count=twins.get(u.uid, 0), local_utc_offset_h=OFFSET_H)
            sd = SynthDay(user=u, day=d, features=compute_day_features(inp), is_cheat_day=u.days_cheat(d))
            (evaluation if d >= eval_start else train).append(sd)
        for u in users:  # free transient waypoint data once a day is featurised
            u.days[d]["waypoints"] = []
    return train, evaluation
