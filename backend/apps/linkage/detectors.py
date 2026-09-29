"""
Edge detectors: each one reads existing data and adds account-to-account edges.

Every detector is batched and streams rows (``values_list(...).iterator()``); none
loads model instances or raw payloads. Evidence is privacy-minimised: masked
identifiers ("ending 123", "…a1b2"), keyed hashes of network prefixes, counts and
dates. Raw phone numbers, IP addresses and coordinates are used transiently and never
stored.

Edge types, strength and weight (see ANTICHEAT.md "Account linkage"):

  strong  shared_device           1.00  same device id registered by both accounts (any time)
  strong  shared_payout_account   1.00  same M-Pesa number / bank / paybill account where at
                                        least one account withdraws or is paid out to it
  medium  shared_deposit_number   0.50  same M-Pesa number used only for deposits
  weak    shared_business_number  0.05  a number/account shared by MORE than
                                        ``business_number_min_accounts`` (default 10) accounts:
                                        a business, agent or till number, context only
  medium  co_location             0.30 / 0.45 / 0.60  walked within ~100 m and 5 min of each
                                        other for 15+ min on 1 / 2 / 3+ days
  medium  twin_curves             0.30 / 0.45 / 0.60  near-identical hourly step curves on
                                        1 / 2 / 3+ days (risk_ml.features.twin_pairs)
  medium  handover                0.40  steps alternate between the two accounts (one active
                                        exactly when the other stops), 2+ days
  medium  joint_challenges        0.30 / 0.40  both qualified in the same 3+ small challenges
                                        (0.40 when they also joined within 30 min each time)
  weak    phone_sequence          0.10 / 0.25  profile numbers within 99 / 10 of each other,
                                        registered within 14 days
  weak    shared_network          0.15  logged in from the same home-sized network (/24, /48),
                                        compared by keyed hash (DeviceSession.network_hash)
"""

from __future__ import annotations

import logging
import math
import time
from collections import defaultdict
from datetime import date, datetime, timedelta
from datetime import timezone as dt_timezone

from django.contrib.auth import get_user_model
from django.db.models import Count
from django.utils import timezone

from .models import STRENGTH_MEDIUM, STRENGTH_STRONG, STRENGTH_WEAK, LinkEdge

logger = logging.getLogger(__name__)

BATCH = 500
MAX_ACCOUNTS_PER_IDENTIFIER = 200     # pairs are formed among at most this many accounts
PHONE_SEQUENCE_GAP = 99
PHONE_SEQUENCE_TIGHT_GAP = 10
PHONE_SEQUENCE_WINDOW = timedelta(days=14)
NETWORK_LOOKBACK_DAYS = 90            # = network hash retention
COLOC_CELL_DEG = 0.0005               # ~55 m; neighbours included -> "within ~100 m"
COLOC_SLOT_S = 300                    # 5-minute time slots (+ the next slot)
COLOC_MIN_SLOTS = 3                   # 15 minutes together in total
COLOC_MAX_ACCURACY_M = 50.0
JOINT_LOOKBACK_DAYS = 90
JOINT_MAX_PARTICIPANTS = 50           # big public challenges say nothing about a pair
JOINT_MIN_BOTH_QUALIFIED = 3
JOINT_CLOSE_JOIN = timedelta(minutes=30)
HANDOVER_DAILY_LOOKBACK_DAYS = 28
HANDOVER_ACTIVE_HOUR = 250
HANDOVER_MIN_DAY_STEPS = 1000
HANDOVER_MIN_DAYS = 2
HANDOVER_MIN_CORR_DAYS = 10
HANDOVER_MAX_CORR = -0.7

PAYOUT_ROLES = {"withdrawal", "payout"}


# ── small helpers ───────────────────────────────────────────────────────────


def normalize_phone(raw) -> str | None:
    from apps.risk_ml.feature_store import normalize_phone as _n

    return _n(raw)


def phone_variants(n9: str) -> list[str]:
    return [n9, "0" + n9, "254" + n9, "+254" + n9]


def mask_device(device_id: str) -> str:
    return "…" + str(device_id)[-4:]


def mask_account(key: str) -> str:
    return "ending " + key.rsplit(":", 1)[-1][-3:]


def _iso(v):
    return v.isoformat() if v else None


def _chunks(seq, n=BATCH):
    seq = list(seq)
    for i in range(0, len(seq), n):
        yield seq[i:i + n]


def live_user_ids(ids=None) -> set:
    User = get_user_model()
    qs = User.objects.filter(deleted_at__isnull=True)
    if ids is not None:
        out = set()
        for chunk in _chunks(ids):
            out |= set(qs.filter(pk__in=chunk).values_list("pk", flat=True))
        return out
    return set(qs.values_list("pk", flat=True).iterator(chunk_size=5000))


class Edges:
    """In-memory edge collector keyed by (a, b, type) with a < b. Keeps the heaviest
    observation per key and widens its evidence time range."""

    def __init__(self):
        self.rows: dict = {}

    def add(self, u, v, etype, strength, weight, evidence, first=None, last=None):
        if u is None or v is None or u == v:
            return
        a, b = (u, v) if u < v else (v, u)
        key = (a, b, etype)
        cur = self.rows.get(key)
        if cur is None or weight > cur["weight"]:
            prev = cur
            cur = {"strength": strength, "weight": round(float(weight), 3),
                   "evidence": evidence, "first": first, "last": last}
            if prev:
                cur["first"] = min([t for t in (first, prev["first"]) if t] or [None])
                cur["last"] = max([t for t in (last, prev["last"]) if t] or [None])
            self.rows[key] = cur
        else:
            if first and (cur["first"] is None or first < cur["first"]):
                cur["first"] = first
            if last and (cur["last"] is None or last > cur["last"]):
                cur["last"] = last

    def __len__(self):
        return len(self.rows)

    def pairs(self):
        return {(a, b) for a, b, _ in self.rows}

    def touching(self, user_ids):
        ids = set(user_ids)
        return {k: v for k, v in self.rows.items() if k[0] in ids or k[1] in ids}


def _pairs(members, cap=MAX_ACCOUNTS_PER_IDENTIFIER):
    members = sorted(members)[:cap]
    for i, a in enumerate(members):
        for b in members[i + 1:]:
            yield a, b


def _relative(pair, per_user: dict) -> dict:
    """Evidence keyed "a"/"b" (the ordered pair) instead of user ids."""
    a, b = pair if pair[0] < pair[1] else (pair[1], pair[0])
    return {"a": per_user.get(a), "b": per_user.get(b)}


# ── strong / money detectors ────────────────────────────────────────────────


def detect_shared_devices(edges: Edges, *, live: set, user_ids=None) -> int:
    """Same device id registered by several accounts (DeviceRegistration keeps the
    history of every device each account ever bound; step sessions and sync events
    reference these rows, and User.device_id is the currently bound one)."""
    from apps.steps.models import DeviceRegistration

    if user_ids is not None:
        devices = set()
        for chunk in _chunks(user_ids):
            devices |= set(DeviceRegistration.objects.filter(user_id__in=chunk)
                           .exclude(device_id="").values_list("device_id", flat=True))
    else:
        devices = set(DeviceRegistration.objects.exclude(device_id="").values("device_id")
                      .annotate(n=Count("user_id", distinct=True)).filter(n__gte=2)
                      .values_list("device_id", flat=True))
    by_device = defaultdict(dict)
    for chunk in _chunks(devices):
        for dev, uid, platform, first, last in (
            DeviceRegistration.objects.filter(device_id__in=chunk)
            .values_list("device_id", "user_id", "platform", "first_seen_at", "last_seen_at")
        ):
            if live is None or uid in live:
                by_device[dev][uid] = (platform, first, last)
    n = 0
    for dev, users in by_device.items():
        if len(users) < 2:
            continue
        for a, b in _pairs(users):
            fa, fb = users[a], users[b]
            evidence = {"device": mask_device(dev), "platform": fa[0] or fb[0],
                        "accounts_on_device": len(users),
                        "first_seen": {"a": _iso(fa[1]), "b": _iso(fb[1])},
                        "last_seen": {"a": _iso(fa[2]), "b": _iso(fb[2])}}
            # The link exists from the moment the second account used the device.
            first = max(t for t in (fa[1], fb[1]) if t) if (fa[1] and fb[1]) else None
            last = max([t for t in (fa[2], fb[2]) if t] or [None])
            edges.add(a, b, LinkEdge.TYPE_SHARED_DEVICE, STRENGTH_STRONG, 1.0, evidence, first, last)
            n += 1
    return n


def _money_key_rows(user_ids=None):
    """Yield (key, user_id, role, at) for every payment identifier. Keys: "m:<9 digits>"
    (M-Pesa), "b:<bank>:<account>", "p:<shortcode>:<account>"."""
    from apps.payments.models import PaymentTransaction, WithdrawalRequest

    User = get_user_model()

    def user_rows(qs):
        for uid, phone, joined in qs.values_list("pk", "phone_number", "date_joined").iterator(chunk_size=5000):
            n9 = normalize_phone(phone)
            if n9:
                yield "m:" + n9, uid, "profile", joined

    def payment_rows(qs):
        for uid, phone, typ, at in qs.values_list("user_id", "phone_number", "type", "created_at").iterator(chunk_size=5000):
            n9 = normalize_phone(phone)
            if n9:
                yield "m:" + n9, uid, "deposit" if typ == "deposit" else "payout", at

    def withdrawal_rows(qs):
        for uid, method, phone, bank, acct, short, at in qs.values_list(
            "user_id", "method", "phone_number", "bank_code", "account_number", "short_code", "created_at"
        ).iterator(chunk_size=5000):
            if method == "mpesa":
                n9 = normalize_phone(phone)
                if n9:
                    yield "m:" + n9, uid, "withdrawal", at
            elif method == "bank" and (acct or "").strip():
                yield f"b:{(bank or '').strip()}:{acct.strip()}", uid, "withdrawal", at
            elif method == "paybill" and (short or "").strip():
                yield f"p:{short.strip()}:{(acct or '').strip()}", uid, "withdrawal", at

    if user_ids is None:
        yield from user_rows(User.objects.all())
        yield from payment_rows(PaymentTransaction.objects.all())
        yield from withdrawal_rows(WithdrawalRequest.objects.all())
        return

    own = []
    for chunk in _chunks(user_ids):
        own += list(user_rows(User.objects.filter(pk__in=chunk)))
        own += list(payment_rows(PaymentTransaction.objects.filter(user_id__in=chunk)))
        own += list(withdrawal_rows(WithdrawalRequest.objects.filter(user_id__in=chunk)))
    yield from own
    keys = {r[0] for r in own}
    phones = [v for k in keys if k.startswith("m:") for v in phone_variants(k[2:])]
    for chunk in _chunks(phones):
        yield from user_rows(User.objects.filter(phone_number__in=chunk))
        yield from payment_rows(PaymentTransaction.objects.filter(phone_number__in=chunk))
        yield from withdrawal_rows(WithdrawalRequest.objects.filter(phone_number__in=chunk))
    accounts = [k.rsplit(":", 1)[-1] for k in keys if not k.startswith("m:")]
    for chunk in _chunks(accounts):
        yield from withdrawal_rows(WithdrawalRequest.objects.filter(account_number__in=chunk))


BUSINESS_PAIR_CAP = 50  # context-only edges: don't spell out every pair of a big group


def detect_shared_money(edges: Edges, *, live: set, user_ids=None, business_min: int = 10) -> int:
    """Same payment identifier. More than ``business_min`` accounts on one identifier is
    a shared business/agent number: a weak, context-only edge (never strong)."""
    per_key: dict = defaultdict(dict)  # key -> uid -> [roles set, first, last]
    for key, uid, role, at in _money_key_rows(user_ids):
        if live is not None and uid not in live:
            continue
        slot = per_key[key].get(uid)
        if slot is None:
            per_key[key][uid] = [{role}, at, at]
        else:
            slot[0].add(role)
            if at and (slot[1] is None or at < slot[1]):
                slot[1] = at
            if at and (slot[2] is None or at > slot[2]):
                slot[2] = at
    n = 0
    for key, users in per_key.items():
        if len(users) < 2:
            continue
        kind = {"m": "mpesa", "b": "bank", "p": "paybill"}[key[0]]
        if len(users) > business_min:
            for a, b in _pairs(users, cap=BUSINESS_PAIR_CAP):
                edges.add(a, b, LinkEdge.TYPE_SHARED_BUSINESS_NUMBER, STRENGTH_WEAK, 0.05,
                          {"kind": kind, "account": mask_account(key), "accounts_sharing": len(users)})
                n += 1
            continue
        for a, b in _pairs(users):
            ra, rb = users[a][0], users[b][0]
            payout = bool((ra | rb) & PAYOUT_ROLES)
            evidence = {"kind": kind, "account": mask_account(key), "accounts_sharing": len(users),
                        "roles": {"a": sorted(ra), "b": sorted(rb)}}
            firsts = [t for t in (users[a][1], users[b][1]) if t]
            lasts = [t for t in (users[a][2], users[b][2]) if t]
            first = max(firsts) if len(firsts) == 2 else None
            last = max(lasts) if lasts else None
            if payout:
                edges.add(a, b, LinkEdge.TYPE_SHARED_PAYOUT_ACCOUNT, STRENGTH_STRONG, 1.0, evidence, first, last)
            else:
                edges.add(a, b, LinkEdge.TYPE_SHARED_DEPOSIT_NUMBER, STRENGTH_MEDIUM, 0.5, evidence, first, last)
            n += 1
    return n


# ── weak detectors ──────────────────────────────────────────────────────────


def detect_phone_sequence(edges: Edges, *, live: set) -> int:
    User = get_user_model()
    rows = []
    for uid, phone, joined in User.objects.filter(deleted_at__isnull=True).values_list(
            "pk", "phone_number", "date_joined").iterator(chunk_size=5000):
        n9 = normalize_phone(phone)
        if n9 and n9.isdigit() and uid in live:
            rows.append((int(n9), uid, joined))
    rows.sort()
    n = 0
    for i, (num, uid, joined) in enumerate(rows):
        j = i + 1
        while j < len(rows) and rows[j][0] - num <= PHONE_SEQUENCE_GAP:
            onum, ouid, ojoined = rows[j]
            j += 1
            if joined and ojoined and abs(ojoined - joined) <= PHONE_SEQUENCE_WINDOW:
                gap = onum - num
                weight = 0.25 if gap <= PHONE_SEQUENCE_TIGHT_GAP else 0.10
                days = round(abs((ojoined - joined).total_seconds()) / 86400.0, 1)
                edges.add(uid, ouid, LinkEdge.TYPE_PHONE_SEQUENCE, STRENGTH_WEAK, weight,
                          {"number_gap": gap, "joined_days_apart": days},
                          max(joined, ojoined), max(joined, ojoined))
                n += 1
    return n


def detect_shared_network(edges: Edges, *, live: set, max_accounts: int, now=None) -> int:
    """Uses only ``DeviceSession.network_hash`` (keyed HMAC of the login /24 or /48,
    kept 90 days; full IPs are not used, see apps/users/network_privacy.py; private
    addresses have no hash). Networks with more than ``max_accounts`` accounts are
    public (Safaricom/Airtel carrier NAT, campus Wi-Fi) and ignored."""
    from apps.users.models import DeviceSession

    now = now or timezone.now()
    cutoff = now - timedelta(days=NETWORK_LOOKBACK_DAYS)
    nets: dict = defaultdict(dict)
    hubs: set = set()
    for uid, prefix, created, last in (DeviceSession.objects.filter(last_active_at__gte=cutoff)
                                       .exclude(network_hash="")
                                       .values_list("user_id", "network_hash", "created_at", "last_active_at")
                                       .iterator(chunk_size=5000)):
        if uid not in live:
            continue
        if prefix in hubs:
            continue
        slot = nets[prefix].get(uid)
        if slot is None:
            nets[prefix][uid] = [created, last]
        else:
            slot[0] = min(slot[0], created)
            slot[1] = max(slot[1], last)
        if len(nets[prefix]) > max_accounts:
            hubs.add(prefix)
            del nets[prefix]
    n = 0
    for prefix, users in nets.items():
        if len(users) < 2:
            continue
        tag = "net-" + prefix[:8]
        for a, b in _pairs(users):
            first = max(users[a][0], users[b][0])
            last = max(users[a][1], users[b][1])
            edges.add(a, b, LinkEdge.TYPE_SHARED_NETWORK, STRENGTH_WEAK, 0.15,
                      {"network": tag, "accounts_on_network": len(users)}, first, last)
            n += 1
    return n


# ── behavioural detectors ───────────────────────────────────────────────────


def _days(today: date, lookback: int) -> list[date]:
    return [today - timedelta(days=i) for i in range(lookback - 1, -1, -1)]


def detect_co_location(edges: Edges, *, live: set, today: date, lookback: int, max_accounts: int) -> int:
    """GPS fixes of different accounts within ~100 m and 5 minutes of each other.
    Coded against LocationWaypoint (walk sessions from Phase 1b write waypoints too).
    Crowded place-times (more than ``max_accounts`` accounts: a group walk, a stadium)
    are ignored. Coordinates are bucketed in memory for one day at a time and dropped."""
    from apps.steps.models import LocationWaypoint

    together: dict = defaultdict(lambda: defaultdict(set))  # pair -> day -> slots
    for day in _days(today, lookback):
        cells: dict = defaultdict(set)
        for uid, at, lat, lon, acc in (LocationWaypoint.objects.filter(date=day)
                                       .values_list("user_id", "recorded_at", "latitude", "longitude", "accuracy_m")
                                       .iterator(chunk_size=5000)):
            if uid not in live or (acc and acc > COLOC_MAX_ACCURACY_M) or lat is None or lon is None:
                continue
            key = (int(at.timestamp() // COLOC_SLOT_S), math.floor(lat / COLOC_CELL_DEG),
                   math.floor(lon / COLOC_CELL_DEG))
            cells[key].add(uid)
        for (slot, ilat, ilon), here in cells.items():
            near = set(here)
            for ds in (0, 1):
                for dl in (-1, 0, 1):
                    for dn in (-1, 0, 1):
                        if ds == 0 and dl == 0 and dn == 0:
                            continue
                        near |= cells.get((slot + ds, ilat + dl, ilon + dn), set())
            if len(near) < 2 or len(near) > max_accounts:
                continue
            for u in here:
                for v in near:
                    if u != v:
                        pair = (u, v) if u < v else (v, u)
                        together[pair][day].add(slot)
        del cells
    n = 0
    for pair, per_day in together.items():
        slots = sum(len(s) for s in per_day.values())
        if slots < COLOC_MIN_SLOTS:
            continue
        days = len(per_day)
        weight = 0.6 if days >= 3 else 0.45 if days >= 2 else 0.3
        all_slots = [s for ss in per_day.values() for s in ss]
        first = datetime.fromtimestamp(min(all_slots) * COLOC_SLOT_S, tz=dt_timezone.utc)
        last = datetime.fromtimestamp(max(all_slots) * COLOC_SLOT_S, tz=dt_timezone.utc)
        edges.add(pair[0], pair[1], LinkEdge.TYPE_CO_LOCATION, STRENGTH_MEDIUM, weight,
                  {"days_together": days, "minutes_together": slots * COLOC_SLOT_S // 60,
                   "last_day": max(per_day).isoformat()}, first, last)
        n += 1
    return n


def _day_curves(day: date, user_ids=None) -> dict:
    from apps.steps.models import HourlyStepRecord

    qs = HourlyStepRecord.objects.filter(date=day)
    if user_ids is not None:
        qs = qs.filter(user_id__in=user_ids)
    curves = defaultdict(lambda: [0] * 24)
    for uid, hour, steps in qs.values_list("user_id", "hour", "steps").iterator(chunk_size=5000):
        if 0 <= hour < 24:
            curves[uid][hour] += int(steps or 0)
    return dict(curves)


def _day_to_dt(d: date):
    return datetime(d.year, d.month, d.day, tzinfo=dt_timezone.utc)


def detect_twin_curves(edges: Edges, *, live: set, today: date, lookback: int) -> int:
    """Near-identical hourly step curves on the same day (reuses the risk model's twin
    detection, apps.risk_ml.features.twin_pairs)."""
    from apps.risk_ml.features import twin_pairs

    days_by_pair: dict = defaultdict(list)
    for day in _days(today, lookback):
        curves = {u: v for u, v in _day_curves(day).items() if u in live}
        for u, twins in twin_pairs(curves).items():
            for v in twins:
                if u < v:
                    days_by_pair[(u, v)].append(day)
    n = 0
    for (a, b), days in days_by_pair.items():
        weight = 0.6 if len(days) >= 3 else 0.45 if len(days) >= 2 else 0.3
        edges.add(a, b, LinkEdge.TYPE_TWIN_CURVES, STRENGTH_MEDIUM, weight,
                  {"twin_days": len(days), "days": [d.isoformat() for d in sorted(days)[-7:]]},
                  _day_to_dt(min(days)), _day_to_dt(max(days)))
        n += 1
    return n


def detect_joint_challenges(edges: Edges, *, live: set, today: date) -> int:
    from apps.challenges.models import Participant

    since = today - timedelta(days=JOINT_LOOKBACK_DAYS)
    by_challenge = defaultdict(list)
    for cid, uid, qualified, joined in (Participant.objects
                                        .filter(challenge__end_date__gte=since)
                                        .exclude(challenge__status="cancelled")
                                        .values_list("challenge_id", "user_id", "qualified", "joined_at")
                                        .iterator(chunk_size=5000)):
        if uid in live:
            by_challenge[cid].append((uid, bool(qualified), joined))
    stats = defaultdict(lambda: [0, 0, 0, None])  # together, both qualified, joined close, last
    for cid, rows in by_challenge.items():
        if len(rows) < 2 or len(rows) > JOINT_MAX_PARTICIPANTS:
            continue
        rows.sort()
        for i, (a, qa, ja) in enumerate(rows):
            for b, qb, jb in rows[i + 1:]:
                s = stats[(a, b)]
                s[0] += 1
                if qa and qb:
                    s[1] += 1
                if ja and jb and abs(ja - jb) <= JOINT_CLOSE_JOIN:
                    s[2] += 1
                last = max(t for t in (ja, jb) if t) if (ja or jb) else None
                if last and (s[3] is None or last > s[3]):
                    s[3] = last
    n = 0
    for (a, b), (together, both, close, last) in stats.items():
        if both < JOINT_MIN_BOTH_QUALIFIED:
            continue
        weight = 0.4 if close >= JOINT_MIN_BOTH_QUALIFIED else 0.3
        edges.add(a, b, LinkEdge.TYPE_JOINT_CHALLENGES, STRENGTH_MEDIUM, weight,
                  {"challenges_together": together, "both_qualified": both,
                   "joined_within_30_min": close}, None, last)
        n += 1
    return n


def _pearson(xs, ys):
    n = len(xs)
    if n < 2:
        return None
    mx, my = sum(xs) / n, sum(ys) / n
    sx = math.sqrt(sum((x - mx) ** 2 for x in xs))
    sy = math.sqrt(sum((y - my) ** 2 for y in ys))
    if not sx or not sy:
        return None
    return sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / (sx * sy)


def handover_day(a: list[int], b: list[int]) -> bool:
    """One phone (or one walker) passed between accounts: both walked that day, never in
    the same hour, and the activity switches owner at least twice (A, B, A)."""
    if sum(a) < HANDOVER_MIN_DAY_STEPS or sum(b) < HANDOVER_MIN_DAY_STEPS:
        return False
    ha = {h for h, s in enumerate(a) if s >= HANDOVER_ACTIVE_HOUR}
    hb = {h for h, s in enumerate(b) if s >= HANDOVER_ACTIVE_HOUR}
    if not ha or not hb or ha & hb:
        return False
    owners = ["a" if h in ha else "b" for h in sorted(ha | hb)]
    switches = sum(1 for x, y in zip(owners, owners[1:]) if x != y)
    return switches >= 2


def detect_handover(edges: Edges, *, candidates: set, today: date, lookback: int) -> int:
    """Only for pairs that already share some other evidence (the pair space is
    otherwise quadratic): hourly handovers, or daily totals that move in opposite
    directions (one account's steps rise exactly when the other's fall)."""
    from apps.steps.models import HealthRecord

    if not candidates:
        return 0
    users = sorted({u for p in candidates for u in p})
    hourly = defaultdict(dict)  # uid -> day -> curve
    for day in _days(today, lookback):
        for chunk in _chunks(users):
            for uid, curve in _day_curves(day, chunk).items():
                hourly[uid][day] = curve
    daily = defaultdict(dict)
    since = today - timedelta(days=HANDOVER_DAILY_LOOKBACK_DAYS - 1)
    for chunk in _chunks(users):
        for uid, d, steps, raw in (HealthRecord.objects.filter(user_id__in=chunk, date__range=(since, today))
                                   .values_list("user_id", "date", "steps", "last_raw_steps")):
            daily[uid][d] = max(int(steps or 0), int(raw or 0))
    n = 0
    for a, b in candidates:
        days = [d for d in hourly.get(a, {}) if d in hourly.get(b, {})
                and handover_day(hourly[a][d], hourly[b][d])]
        dates = sorted(set(daily.get(a, {})) | set(daily.get(b, {})))
        corr = None
        if len(dates) >= HANDOVER_MIN_CORR_DAYS:
            xs = [daily[a].get(d, 0) for d in dates]
            ys = [daily[b].get(d, 0) for d in dates]
            if (sum(1 for x in xs if x >= HANDOVER_MIN_DAY_STEPS) >= 3
                    and sum(1 for y in ys if y >= HANDOVER_MIN_DAY_STEPS) >= 3):
                corr = _pearson(xs, ys)
        anti = corr is not None and corr <= HANDOVER_MAX_CORR
        if len(days) >= HANDOVER_MIN_DAYS or anti:
            first = _day_to_dt(min(days)) if days else _day_to_dt(dates[0])
            last = _day_to_dt(max(days)) if days else _day_to_dt(dates[-1])
            edges.add(a, b, LinkEdge.TYPE_HANDOVER, STRENGTH_MEDIUM, 0.4,
                      {"handover_days": len(days), "days": [d.isoformat() for d in sorted(days)[-7:]],
                       "daily_correlation": None if corr is None else round(corr, 3)}, first, last)
            n += 1
    return n


# ── orchestration ───────────────────────────────────────────────────────────

DETECTOR_TYPES = {
    "shared_device": (LinkEdge.TYPE_SHARED_DEVICE,),
    "shared_money": (LinkEdge.TYPE_SHARED_PAYOUT_ACCOUNT, LinkEdge.TYPE_SHARED_DEPOSIT_NUMBER),
    "phone_sequence": (LinkEdge.TYPE_PHONE_SEQUENCE,),
    "shared_network": (LinkEdge.TYPE_SHARED_NETWORK,),
    "co_location": (LinkEdge.TYPE_CO_LOCATION,),
    "twin_curves": (LinkEdge.TYPE_TWIN_CURVES,),
    "joint_challenges": (LinkEdge.TYPE_JOINT_CHALLENGES,),
    "handover": (LinkEdge.TYPE_HANDOVER,),
}


def detect_all(cfg, *, today: date, now=None) -> tuple[Edges, set, dict]:
    """Run every detector. Returns (edges, edge types whose detector succeeded, stats).
    A failing detector is logged and skipped; its existing edges are left untouched."""
    edges = Edges()
    ok_types: set = set()
    stats: dict = {}
    live = live_user_ids()
    lookback = int(cfg.behaviour_lookback_days)
    plan = [
        ("shared_device", lambda: detect_shared_devices(edges, live=live)),
        ("shared_money", lambda: detect_shared_money(edges, live=live,
                                                     business_min=int(cfg.business_number_min_accounts))),
        ("phone_sequence", lambda: detect_phone_sequence(edges, live=live)),
        ("shared_network", lambda: detect_shared_network(edges, live=live,
                                                         max_accounts=int(cfg.network_max_accounts), now=now)),
        ("co_location", lambda: detect_co_location(edges, live=live, today=today, lookback=lookback,
                                                   max_accounts=int(cfg.colocation_max_accounts))),
        ("twin_curves", lambda: detect_twin_curves(edges, live=live, today=today, lookback=lookback)),
        ("joint_challenges", lambda: detect_joint_challenges(edges, live=live, today=today)),
        # Last: it only examines pairs the other detectors found.
        ("handover", lambda: detect_handover(edges, candidates=edges.pairs(), today=today, lookback=lookback)),
    ]
    for name, fn in plan:
        t0 = time.monotonic()
        try:
            count = fn()
            ok_types |= set(DETECTOR_TYPES[name])
            stats[name] = {"edges": count, "seconds": round(time.monotonic() - t0, 3)}
        except Exception as exc:  # one broken source must not stop the others
            logger.exception("linkage: detector %s failed", name)
            stats[name] = {"error": type(exc).__name__, "seconds": round(time.monotonic() - t0, 3)}
    stats["live_users"] = len(live)
    return edges, ok_types, stats


def live_strong_edges(user_ids) -> Edges:
    """Strong edges touching ``user_ids``, computed right now (used at settlement so an
    account created or re-bound since the last nightly run is still caught)."""
    edges = Edges()
    ids = list(user_ids)
    if not ids:
        return edges
    detect_shared_devices(edges, live=None, user_ids=ids)
    from .models import LinkageSettings

    detect_shared_money(edges, live=None, user_ids=ids,
                        business_min=int(LinkageSettings.load().business_number_min_accounts))
    rows = {k: v for k, v in edges.touching(ids).items() if v["strength"] == STRENGTH_STRONG}
    live = live_user_ids({u for k in rows for u in k[:2]})
    edges.rows = {k: v for k, v in rows.items() if k[0] in live and k[1] in live}
    return edges
