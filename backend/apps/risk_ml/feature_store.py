"""
Build and store UserDayFeatures from existing data (batched, incremental, idempotent).

``compute_features(start, end)`` recomputes every user-day in [start, end] for users
with any activity in that window, ``CHUNK`` users at a time, pulling only the columns
it needs (JSON payload keys are extracted in SQL, raw payloads are never loaded).
Re-running it for the same window rewrites the same rows (unique on user/date/version).

Read-only with respect to every other app.
"""

from __future__ import annotations

import logging
import re
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone as dt_timezone

from django.conf import settings
from django.contrib.auth import get_user_model
from django.db.models import Count
from django.db.models.fields.json import KT
from django.utils import timezone

from .features import (FEATURE_VERSION, AccountCtx, ChallengeCtx, DayInputs,
                       SyncObs, Waypoint, compute_day_features, twin_counts)
from .models import UserDayFeatures

logger = logging.getLogger(__name__)

CHUNK = 100                       # users per batch
HISTORY_DAYS = 35                 # baseline + day-of-week look-back
MAX_CHALLENGE_LOOKBACK_DAYS = 120
LATE_SYNC_LOOKAHEAD_DAYS = 9      # syncs for a day can arrive this long afterwards
PHONE_CLUSTER_WINDOW = timedelta(days=14)

_PAYLOAD_KEYS = {
    "p_date": "raw_payload__date",
    "p_gait_confidence": "raw_payload__gait_confidence",
    "p_cadence": "raw_payload__cadence_spm",
    "p_burst": "raw_payload__burst_steps_5s",
    "p_carry": "raw_payload__carry_mode",
    "p_interval_std": "raw_payload__gait_interval_std_ms",
    "p_autocorr": "raw_payload__gait_autocorr",
}


def utc_offset_hours() -> int:
    return int(getattr(settings, "RISK_ML_LOCAL_UTC_OFFSET_HOURS", 3))


def local_today() -> date:
    return (timezone.now() + timedelta(hours=utc_offset_hours())).date()


def _day_start_utc(d: date) -> datetime:
    return datetime(d.year, d.month, d.day, tzinfo=dt_timezone.utc) - timedelta(hours=utc_offset_hours())


def _num(v):
    if v is None or v == "":
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _parse_day(v):
    if isinstance(v, date):
        return v
    if isinstance(v, str) and len(v) >= 10:
        try:
            return date.fromisoformat(v[:10])
        except ValueError:
            return None
    return None


def normalize_phone(raw) -> str | None:
    """Kenyan MSISDN -> 9 national digits ("7XXXXXXXX"); None if it doesn't look like one."""
    digits = re.sub(r"\D", "", str(raw or ""))
    if len(digits) < 9:
        return None
    return digits[-9:]


def _phone_variants(n9: str) -> list[str]:
    return [n9, "0" + n9, "254" + n9, "+254" + n9]


def candidate_user_ids(start: date, end: date) -> list[int]:
    from apps.steps.models import HealthRecord, HourlyStepRecord, StepSyncEvent

    ids = set(HealthRecord.objects.filter(date__range=(start, end)).values_list("user_id", flat=True).distinct())
    ids |= set(HourlyStepRecord.objects.filter(date__range=(start, end)).values_list("user_id", flat=True).distinct())
    ids |= set(StepSyncEvent.objects.filter(created_at__gte=_day_start_utc(start),
                                            created_at__lt=_day_start_utc(end + timedelta(days=1)))
               .values_list("user_id", flat=True).distinct())
    User = get_user_model()
    live = User.objects.filter(pk__in=ids, deleted_at__isnull=True).values_list("pk", flat=True)
    return sorted(live)


# ── loaders (one chunk of users) ─────────────────────────────────────────────


def _load_health(user_ids, since: date, end: date) -> dict:
    from apps.steps.models import HealthRecord

    out = defaultdict(dict)
    for uid, d, steps in (HealthRecord.objects.filter(user_id__in=user_ids, date__range=(since, end))
                          .values_list("user_id", "date", "steps").iterator(chunk_size=2000)):
        out[uid][d] = int(steps or 0)
    return out


def _load_hourly(user_ids, since: date, end: date) -> dict:
    from apps.steps.models import HourlyStepRecord

    out = defaultdict(dict)
    for uid, d, hour, steps in (HourlyStepRecord.objects.filter(user_id__in=user_ids, date__range=(since, end))
                                .values_list("user_id", "date", "hour", "steps").iterator(chunk_size=5000)):
        if 0 <= hour < 24:
            out[uid].setdefault(d, [0] * 24)[hour] += int(steps or 0)
    return out


def _load_syncs(user_ids, start: date, end: date) -> dict:
    from apps.steps.models import StepSyncEvent

    offset = timedelta(hours=utc_offset_hours())
    qs = (StepSyncEvent.objects
          .filter(user_id__in=user_ids,
                  created_at__gte=_day_start_utc(start) - timedelta(days=1),
                  created_at__lt=_day_start_utc(end + timedelta(days=LATE_SYNC_LOOKAHEAD_DAYS)))
          .annotate(**{k: KT(v) for k, v in _PAYLOAD_KEYS.items()})
          .values("user_id", "created_at", "accepted", "replay_detected", "raw_steps_total",
                  "ml_walk_probability", "ml_shake_probability", "ml_motion_label", *_PAYLOAD_KEYS))
    out = defaultdict(lambda: defaultdict(list))
    for row in qs.iterator(chunk_size=2000):
        day = _parse_day(row["p_date"]) or (row["created_at"] + offset).date()
        if not (start <= day <= end):
            continue
        out[row["user_id"]][day].append(SyncObs(
            created_at=row["created_at"],
            accepted=bool(row["accepted"]),
            replay=bool(row["replay_detected"]),
            steps=row["raw_steps_total"],
            gait_confidence=_num(row["p_gait_confidence"]),
            shake_prob=row["ml_shake_probability"],
            walk_prob=row["ml_walk_probability"],
            ml_label=row["ml_motion_label"],
            cadence=_num(row["p_cadence"]),
            burst_5s=_num(row["p_burst"]),
            carry_mode=row["p_carry"] or None,
            interval_std_ms=_num(row["p_interval_std"]),
            autocorr=_num(row["p_autocorr"]),
        ))
    return out


def _load_waypoints(user_id, start: date, end: date) -> dict:
    """Coordinates are used transiently to measure distance/speed and then dropped."""
    from apps.steps.models import LocationWaypoint

    out = defaultdict(list)
    for d, hour, at, lat, lon, acc in (LocationWaypoint.objects.filter(user_id=user_id, date__range=(start, end))
                                       .order_by("recorded_at")
                                       .values_list("date", "hour", "recorded_at", "latitude", "longitude",
                                                    "accuracy_m").iterator(chunk_size=2000)):
        out[d].append(Waypoint(recorded_at=at, lat=lat, lon=lon, accuracy_m=acc or 0.0, hour=hour))
    return out


def _load_accounts(users) -> dict:
    """Account/device/M-Pesa linkage counts per user. Phone numbers never leave this function."""
    from apps.payments.models import PaymentTransaction, WithdrawalRequest
    from apps.steps.models import DeviceRegistration

    User = get_user_model()
    ids = [u.pk for u in users]
    devices = defaultdict(set)
    for uid, dev in DeviceRegistration.objects.filter(user_id__in=ids).values_list("user_id", "device_id"):
        if dev:
            devices[uid].add(dev)
    all_devices = set().union(*devices.values()) if devices else set()
    per_device = dict(DeviceRegistration.objects.filter(device_id__in=all_devices)
                      .values("device_id").annotate(n=Count("user_id", distinct=True))
                      .values_list("device_id", "n")) if all_devices else {}

    numbers = defaultdict(set)
    for u in users:
        n9 = normalize_phone(u.phone_number)
        if n9:
            numbers[u.pk].add(n9)
    for model in (PaymentTransaction, WithdrawalRequest):
        for uid, phone in model.objects.filter(user_id__in=ids).values_list("user_id", "phone_number").distinct():
            n9 = normalize_phone(phone)
            if n9:
                numbers[uid].add(n9)
    all_numbers = set().union(*numbers.values()) if numbers else set()
    users_by_number = defaultdict(set)
    if all_numbers:
        variants = [v for n in all_numbers for v in _phone_variants(n)]
        for step in range(0, len(variants), 400):
            batch = variants[step:step + 400]
            for uid, phone in User.objects.filter(phone_number__in=batch).values_list("pk", "phone_number"):
                users_by_number[normalize_phone(phone)].add(uid)
            for model in (PaymentTransaction, WithdrawalRequest):
                for uid, phone in model.objects.filter(phone_number__in=batch).values_list("user_id", "phone_number"):
                    users_by_number[normalize_phone(phone)].add(uid)

    out = {}
    for u in users:
        own = normalize_phone(u.phone_number)
        cluster = 0
        if own:
            joined = u.date_joined
            near = (User.objects.filter(phone_number__contains=own[:7],
                                        date_joined__range=(joined - PHONE_CLUSTER_WINDOW, joined + PHONE_CLUSTER_WINDOW))
                    .exclude(pk=u.pk).values_list("phone_number", flat=True)[:200])
            cluster = sum(1 for p in near if (normalize_phone(p) or "")[:7] == own[:7])
        out[u.pk] = {
            "joined": u.date_joined,
            "devices_per_account": len(devices.get(u.pk, ())),
            "max_accounts_per_device": max([per_device.get(d, 1) for d in devices.get(u.pk, ())] or [0]),
            "mpesa_shared_accounts": max([len(users_by_number[n] - {u.pk}) for n in numbers.get(u.pk, ())] or [0]),
            "phone_prefix_cluster": cluster,
        }
    return out


def _load_challenges(user_ids, start: date, end: date) -> dict:
    from apps.challenges.models import Participant

    out = defaultdict(list)
    for uid, fee, milestone, c_start, c_end in (
        Participant.objects.filter(user_id__in=user_ids, challenge__start_date__lte=end,
                                   challenge__end_date__gte=start)
        .exclude(challenge__status="cancelled")
        .values_list("user_id", "challenge__entry_fee", "challenge__milestone",
                     "challenge__start_date", "challenge__end_date")
    ):
        out[uid].append((float(fee or 0), int(milestone or 0), c_start, c_end))
    return out


def _population_twins(day: date) -> dict:
    from apps.steps.models import HourlyStepRecord

    curves = defaultdict(lambda: [0] * 24)
    for uid, hour, steps in (HourlyStepRecord.objects.filter(date=day)
                             .values_list("user_id", "hour", "steps").iterator(chunk_size=5000)):
        if 0 <= hour < 24:
            curves[uid][hour] += int(steps or 0)
    return twin_counts(dict(curves))


# ── main entry points ────────────────────────────────────────────────────────


def build_day_inputs(uid, day, *, health, hourly, syncs, waypoints, account, challenges, twins) -> DayInputs:
    hist = health.get(uid, {})
    hours = hourly.get(uid, {})
    ch = []
    for fee, milestone, c_start, c_end in challenges.get(uid, ()):
        if c_start <= day <= c_end:
            before = sum(s for d, s in hist.items() if c_start <= d < day)
            ch.append(ChallengeCtx(entry_fee=fee, milestone=milestone, start=c_start, end=c_end,
                                   steps_before_day=before))
    acc = account.get(uid, {})
    joined = acc.get("joined")
    age = None
    if joined is not None:
        age = max(0.0, (_day_start_utc(day + timedelta(days=1)) - joined).total_seconds() / 86400.0)
    return DayInputs(
        day=day,
        steps=hist.get(day, 0),
        history=sorted((d, s) for d, s in hist.items() if d < day),
        hourly=hours.get(day, [0] * 24),
        prev_hourly={d: v for d, v in hours.items() if day - timedelta(days=7) <= d < day},
        syncs=syncs.get(uid, {}).get(day, []),
        waypoints=waypoints.get(day, []),
        account=AccountCtx(
            account_age_days=age,
            devices_per_account=acc.get("devices_per_account", 0),
            max_accounts_per_device=acc.get("max_accounts_per_device", 0),
            mpesa_shared_accounts=acc.get("mpesa_shared_accounts", 0),
            phone_prefix_cluster=acc.get("phone_prefix_cluster", 0),
        ),
        challenges=ch,
        twin_count=twins.get(day, {}).get(uid, 0),
        local_utc_offset_h=utc_offset_hours(),
    )


def compute_features(start: date, end: date, *, user_ids=None, chunk_size: int = CHUNK) -> dict:
    """Recompute and upsert UserDayFeatures for every active user-day in [start, end]."""
    if end < start:
        raise ValueError("end before start")
    days = [start + timedelta(days=i) for i in range((end - start).days + 1)]
    ids = list(user_ids) if user_ids is not None else candidate_user_ids(start, end)
    twins = {d: _population_twins(d) for d in days}
    User = get_user_model()
    written = created = 0
    for i in range(0, len(ids), chunk_size):
        chunk_ids = ids[i:i + chunk_size]
        users = list(User.objects.filter(pk__in=chunk_ids, deleted_at__isnull=True)
                     .only("pk", "phone_number", "date_joined"))
        live_ids = [u.pk for u in users]
        challenges = _load_challenges(live_ids, start, end)
        earliest = min([c[2] for rows in challenges.values() for c in rows] or [start])
        since = max(min(start - timedelta(days=HISTORY_DAYS), earliest),
                    start - timedelta(days=MAX_CHALLENGE_LOOKBACK_DAYS))
        health = _load_health(live_ids, since, end)
        hourly = _load_hourly(live_ids, start - timedelta(days=7), end)
        syncs = _load_syncs(live_ids, start, end)
        account = _load_accounts(users)
        rows = {}
        for uid in live_ids:
            wps = _load_waypoints(uid, start, end)
            for day in days:
                has_data = (day in health.get(uid, {}) or day in hourly.get(uid, {})
                            or day in syncs.get(uid, {}))
                if not has_data:
                    continue
                inp = build_day_inputs(uid, day, health=health, hourly=hourly, syncs=syncs, waypoints=wps,
                                       account=account, challenges=challenges, twins=twins)
                rows[(uid, day)] = compute_day_features(inp)
            del wps
        w, c = _upsert(rows)
        written += w
        created += c
    logger.info("risk_ml features %s..%s: %d rows (%d new) for %d users", start, end, written, created, len(ids))
    return {"rows": written, "created": created, "users": len(ids), "start": str(start), "end": str(end)}


def _upsert(rows: dict) -> tuple[int, int]:
    if not rows:
        return 0, 0
    now = timezone.now()
    uids = {u for u, _ in rows}
    dates = {d for _, d in rows}
    existing = {(f.user_id, f.date): f for f in UserDayFeatures.objects.filter(
        user_id__in=uids, date__in=dates, feature_version=FEATURE_VERSION)}
    to_update, to_create = [], []
    for (uid, day), feats in rows.items():
        obj = existing.get((uid, day))
        steps = int(feats.get("steps") or 0)
        paid = bool(feats.get("in_paid_challenge"))
        if obj:
            obj.features, obj.steps, obj.in_paid_challenge, obj.computed_at = feats, steps, paid, now
            to_update.append(obj)
        else:
            to_create.append(UserDayFeatures(user_id=uid, date=day, feature_version=FEATURE_VERSION,
                                             features=feats, steps=steps, in_paid_challenge=paid))
    if to_update:
        UserDayFeatures.objects.bulk_update(to_update, ["features", "steps", "in_paid_challenge", "computed_at"],
                                            batch_size=200)
    if to_create:
        UserDayFeatures.objects.bulk_create(to_create, batch_size=200, ignore_conflicts=True)
    return len(rows), len(to_create)


def delete_user_risk_data(user_id) -> dict:
    """Account anonymisation: drop derived features and scores; scrub free-text label notes."""
    from .models import Label, RiskScore

    feats = UserDayFeatures.objects.filter(user_id=user_id).delete()[0]
    scores = RiskScore.objects.filter(user_id=user_id).delete()[0]
    notes = Label.objects.filter(user_id=user_id).exclude(notes="").update(notes="")
    return {"features": feats, "scores": scores, "label_notes_scrubbed": notes}


__all__ = ["compute_features", "candidate_user_ids", "local_today", "delete_user_risk_data",
           "normalize_phone"]
