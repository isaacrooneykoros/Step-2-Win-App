"""
Shadow anomaly scoring: 0-1 score + plain-English reasons per user-day.

The score blends two unsupervised parts:

1. Population rarity - an isolation forest trained OFFLINE on the feature store
   (``ModelArtifact`` kind "anomaly"), evaluated in pure Python. Its output is
   calibrated to a percentile of the training days, so "0.99" means rarer than 99% of
   the days it was trained on. Without an active artifact this part is simply absent.
2. Evidence - interpretable checks on the user's own baseline and known cheating
   patterns (robust z-score vs the user's median, 1-4 AM share, deadline surge, shake
   probability, identical curves, vehicle speed, shared devices / M-Pesa numbers).
   Each yields a strength in [0, 1] and a sentence.

    score = 1 - (1 - W_IF * rarity_part) * prod(1 - strength_i)

Explanations are the evidence sentences plus, when the forest finds the day rare, the
features it used to isolate it. Nothing here changes steps, trust or payouts.
"""

from __future__ import annotations

import logging
import math
from bisect import bisect_left
from dataclasses import dataclass
from datetime import date, timedelta

from .features import FEATURE_VERSION, NIGHT_HOURS
from .ml import runtime

logger = logging.getLogger(__name__)

EVIDENCE_MODEL = "evidence-v1"
W_IF = 0.6                   # max contribution of population rarity
RARITY_START = 0.95          # rarity percentile where the forest starts to count
MAX_EXPLANATIONS = 5

# Model input features: (name, transform, risk direction). Direction +1 = larger is more
# suspicious, -1 = smaller is, 0 = either way. Used for imputation, the forest and for
# phrasing forest-based explanations. Absolute daily volume is deliberately NOT an input
# (a 35k/day worker is honest); volume enters relative to the user's own baseline.
MODEL_FEATURES: list[tuple[str, str, int]] = [
    ("steps_ratio_to_median", "log1p", +1),
    ("steps_robust_z", "clip", +1),
    ("dow_ratio", "log1p", +1),
    ("hour_entropy", "none", 0),
    ("night_share", "none", +1),
    ("longest_active_span_h", "none", +1),
    ("curve_l1_min_prev", "none", -1),
    ("total_repeat_7d", "none", +1),
    ("round_total", "none", +1),
    ("sync_count", "log1p", 0),
    ("late_sync_share", "none", +1),
    ("rejected_count", "log1p", +1),
    ("replay_count", "log1p", +1),
    ("gait_sync_share", "none", 0),
    ("gait_conf_mean", "none", -1),
    ("shake_prob_mean", "none", +1),
    ("cadence_mean", "none", 0),
    ("cadence_std", "none", -1),
    ("burst_max", "none", +1),
    ("gait_interval_std_mean", "none", -1),
    ("route_km_per_1k_steps", "none", -1),
    ("vehicle_step_share", "none", +1),
    ("max_accounts_per_device", "none", +1),
    ("mpesa_shared_accounts", "none", +1),
    ("phone_prefix_cluster", "none", +1),
    ("twin_count", "log1p", +1),
    ("milestone_share_today", "none", +1),
    ("deadline_surge_ratio", "log1p", +1),
    ("account_age_days", "log1p", -1),
]
FEATURE_LABELS = {
    "steps_ratio_to_median": "steps compared with your usual day",
    "steps_robust_z": "how far steps are from your usual range",
    "dow_ratio": "steps compared with the same weekday",
    "hour_entropy": "how evenly steps are spread over the day",
    "night_share": "share of steps between 1 and 4 AM",
    "longest_active_span_h": "longest run of active hours",
    "curve_l1_min_prev": "difference from the closest earlier day's hourly pattern",
    "total_repeat_7d": "days in the past week with the same total",
    "round_total": "a perfectly round daily total",
    "sync_count": "number of syncs",
    "late_sync_share": "share of syncs uploaded after the day ended",
    "rejected_count": "rejected syncs",
    "replay_count": "replayed or invalid syncs",
    "gait_sync_share": "share of syncs with motion data",
    "gait_conf_mean": "walking confidence from motion data",
    "shake_prob_mean": "shake probability from motion data",
    "cadence_mean": "cadence",
    "cadence_std": "variation in cadence",
    "burst_max": "most steps in 5 seconds",
    "gait_interval_std_mean": "variation between steps",
    "route_km_per_1k_steps": "GPS distance per 1,000 steps",
    "vehicle_step_share": "share of steps at vehicle speed",
    "max_accounts_per_device": "accounts on the same phone",
    "mpesa_shared_accounts": "other accounts on the same M-Pesa number",
    "phone_prefix_cluster": "accounts with near-sequential phone numbers",
    "twin_count": "accounts with an identical hourly pattern",
    "milestone_share_today": "share of the remaining milestone done today",
    "deadline_surge_ratio": "steps vs usual on the last day before a deadline",
    "account_age_days": "account age",
}
_CLIP = (-10.0, 25.0)
# Features that say the same thing; a forest reason is skipped if evidence already covers its family.
FAMILIES = {
    "volume": {"steps_ratio_to_median", "steps_robust_z", "dow_ratio", "deadline_surge_ratio",
               "milestone_share_today"},
    "curve": {"curve_l1_min_prev", "total_repeat_7d", "round_total", "twin_count"},
    "motion": {"gait_conf_mean", "shake_prob_mean", "burst_max", "cadence_mean", "cadence_std",
               "gait_interval_std_mean"},
    "route": {"route_km_per_1k_steps", "vehicle_step_share"},
    "linkage": {"max_accounts_per_device", "mpesa_shared_accounts", "phone_prefix_cluster"},
}


def family(name: str) -> str:
    for fam, members in FAMILIES.items():
        if name in members:
            return fam
    return name


def feature_names() -> list[str]:
    return [n for n, _, _ in MODEL_FEATURES]


def _transform(value: float, how: str) -> float:
    if how == "log1p":
        return math.log1p(max(0.0, value))
    if how == "clip":
        return max(_CLIP[0], min(_CLIP[1], value))
    return value


def vectorize(features: dict, impute: dict | None = None) -> list[float]:
    """Feature dict -> model input vector (transformed, missing values imputed)."""
    impute = impute or {}
    row = []
    for name, how, _ in MODEL_FEATURES:
        v = features.get(name)
        if v is None:
            row.append(float(impute.get(name, 0.0)))
        else:
            row.append(_transform(float(v), how))
    return row


def impute_values(feature_rows: list[dict]) -> dict:
    """Training medians of each transformed feature (used for missing values)."""
    out = {}
    for name, how, _ in MODEL_FEATURES:
        vals = sorted(_transform(float(r[name]), how) for r in feature_rows if r.get(name) is not None)
        out[name] = vals[len(vals) // 2] if vals else 0.0
    return out


# ── evidence (interpretable checks) ─────────────────────────────────────────


def _ramp(x, lo, hi):
    if x is None:
        return 0.0
    if hi == lo:
        return 1.0 if x >= hi else 0.0
    return max(0.0, min(1.0, (x - lo) / (hi - lo)))


def _n(v):
    return f"{int(round(v)):,}"


@dataclass
class Evidence:
    code: str
    feature: str
    value: float | int | None
    strength: float
    text: str

    def as_dict(self):
        return {"code": self.code, "feature": self.feature, "value": self.value,
                "contribution": round(self.strength, 3), "text": self.text}


def evidence(f: dict) -> list[Evidence]:
    out: list[Evidence] = []
    steps = f.get("steps") or 0

    def add(code, feature, strength, text):
        if strength > 0.005:
            out.append(Evidence(code, feature, f.get(feature), strength, text))

    ratio, med = f.get("steps_ratio_to_median"), f.get("user_median_steps")
    if ratio is not None and (f.get("history_days") or 0) >= 7 and steps >= 5000:
        add("volume_spike", "steps_ratio_to_median", 0.55 * _ramp(ratio, 2.0, 5.0),
            f"{ratio:.1f}x your usual daily steps ({_n(steps)} vs a typical {_n(med)})")

    night = f.get("night_share")
    if night is not None and steps >= 2000:
        lo, hi = NIGHT_HOURS[0], NIGHT_HOURS[-1] + 1
        add("night_steps", "night_share", 0.6 * _ramp(night, 0.25, 0.8),
            f"{round(night * 100)}% of steps between {lo} and {hi} AM")

    surge, days_left = f.get("deadline_surge_ratio") or 0.0, f.get("days_to_deadline")
    if days_left is not None and days_left <= 1 and surge >= 1.8 and (
            f.get("crossed_milestone_today") or (f.get("milestone_share_today") or 0) >= 0.5):
        tail = " and crossed the challenge milestone that day" if f.get("crossed_milestone_today") else ""
        add("deadline_surge", "deadline_surge_ratio", 0.5 * _ramp(surge, 1.8, 4.0),
            f"steps rose sharply right before the deadline ({surge:.1f}x usual{tail})")

    shake = f.get("shake_prob_mean")
    if shake is not None and (f.get("gait_sync_count") or 0) >= 1:
        add("shake_motion", "shake_prob_mean", 0.7 * _ramp(shake, 0.45, 0.9),
            f"phone motion looked like shaking, not walking (average shake probability {shake:.2f} "
            f"over {f.get('gait_sync_count')} syncs)")

    conf = f.get("gait_conf_mean")
    if conf is not None and (f.get("gait_sync_count") or 0) >= 3 and steps >= 3000:
        add("low_gait_confidence", "gait_conf_mean", 0.25 * _ramp(0.4 - conf, 0.0, 0.3),
            f"low walking confidence from motion data (average {conf:.2f})")

    burst = f.get("burst_max")
    if burst is not None:
        add("burst", "burst_max", 0.25 * _ramp(burst, 28, 45),
            f"up to {_n(burst)} steps in 5 seconds ({burst / 5:.1f} per second; brisk walking is about 2)")

    l1 = f.get("curve_l1_min_prev")
    if l1 is not None and steps >= 3000:
        add("identical_curve", "curve_l1_min_prev", 0.6 * _ramp(0.08 - l1, 0.0, 0.07),
            f"hourly pattern repeats an earlier day almost exactly (only {round(l1 * 50, 1)}% of steps "
            f"fall in different hours; real routines vary more)")

    rep = f.get("total_repeat_7d") or 0
    if rep >= 1:
        add("repeated_total", "total_repeat_7d", min(0.6, 0.35 + 0.1 * rep),
            f"the same daily total ({_n(steps)}) as {rep} of the previous 7 days")

    ent = f.get("hour_entropy")
    if ent is not None and steps >= 5000:
        add("flat_day", "hour_entropy", 0.4 * _ramp(ent, 0.93, 0.99),
            "steps spread almost evenly across the whole day and night")

    span = f.get("longest_active_span_h") or 0
    add("long_span", "longest_active_span_h", 0.35 * _ramp(span, 15, 20),
        f"steps every hour for {span} hours straight")

    vshare, vmax = f.get("vehicle_step_share"), f.get("speed_p95_kmh")
    if vshare is not None and (vmax or 0) >= 25:
        add("vehicle_speed", "vehicle_step_share", 0.7 * _ramp(vshare, 0.1, 0.5),
            f"{round(vshare * 100)}% of steps were counted while moving at vehicle speed (around {vmax:.0f} km/h)")

    kpk = f.get("route_km_per_1k_steps")
    if kpk is not None and (f.get("waypoint_count") or 0) >= 20:
        add("little_movement", "route_km_per_1k_steps", 0.35 * _ramp(0.25 - kpk, 0.0, 0.2),
            f"GPS moved only {kpk:.2f} km per 1,000 steps (walking covers about 0.7 km; a treadmill also looks like this)")

    dev = f.get("max_accounts_per_device") or 0
    add("shared_device", "max_accounts_per_device", 0.5 * _ramp(dev, 1, 3),
        f"this phone is registered to {dev} accounts")

    mp = f.get("mpesa_shared_accounts") or 0
    add("shared_mpesa", "mpesa_shared_accounts", 0.5 * _ramp(mp, 0, 2),
        f"the M-Pesa number is also used by {mp} other account{'s' if mp != 1 else ''}")

    pc = f.get("phone_prefix_cluster") or 0
    add("phone_cluster", "phone_prefix_cluster", 0.3 * _ramp(pc, 1, 4),
        f"{pc} other accounts with near-sequential phone numbers joined within two weeks")

    tw = f.get("twin_count") or 0
    add("twin_accounts", "twin_count", 0.75 * _ramp(tw, 0, 3),
        f"hourly steps match {tw} other account{'s' if tw != 1 else ''} almost exactly today")

    rp = f.get("replay_count") or 0
    add("replays", "replay_count", 0.3 * _ramp(rp, 0, 3), f"{rp} replayed or invalid sync attempts")

    out.sort(key=lambda e: e.strength, reverse=True)
    return out


def context_for(f: dict) -> dict:
    ctx = {}
    if f.get("in_paid_challenge"):
        ctx["entry_fee_exposure_kes"] = f.get("entry_fee_exposure_kes")
    if f.get("days_to_deadline") is not None:
        ctx["days_to_deadline"] = f.get("days_to_deadline")
        ctx["milestone_gap_before"] = f.get("milestone_gap_before")
    if f.get("gait_sync_share") in (None, 0) and (f.get("sync_count") or 0) > 0:
        ctx["no_motion_data"] = True
    ctx["steps"] = f.get("steps")
    return ctx


# ── forest part ────────────────────────────────────────────────────────────


class AnomalyModel:
    """Wraps an anomaly artifact payload: forest + impute medians + calibration."""

    def __init__(self, payload: dict, version: str):
        self.payload = payload
        self.version = version
        self.forest = payload["forest"]
        self.impute = payload.get("impute", {})
        self.quantiles = payload.get("calibration", {}).get("score_quantiles") or []
        self.population = payload.get("population", {})
        names = payload.get("feature_names") or feature_names()
        if names != feature_names():
            raise ValueError("artifact feature list does not match this code; retrain")

    def raw(self, features: dict) -> float:
        return runtime.iforest_score(self.forest, vectorize(features, self.impute))

    def rarity(self, raw: float) -> float:
        """Percentile of ``raw`` among the training days' scores (0..1)."""
        q = self.quantiles
        if not q:
            return 0.0
        return bisect_left(q, raw) / float(len(q))

    def top_features(self, features: dict, k: int = 3) -> list[tuple[str, float]]:
        row = vectorize(features, self.impute)
        credit = runtime.iforest_feature_attribution(self.forest, row)
        scored = []
        for idx, (name, _how, direction) in enumerate(MODEL_FEATURES):
            if features.get(name) is None:
                continue
            med, mad = self.population.get(name, (None, None))
            if med is None:
                continue
            z = (row[idx] - med) / max(1.4826 * (mad or 0.0), 1e-6)
            if direction and z * direction <= 0:
                continue  # unusual in the harmless direction
            if abs(z) < 2.5:
                continue
            scored.append((name, credit.get(idx, 0.0) * min(abs(z), 10.0)))
        scored.sort(key=lambda t: t[1], reverse=True)
        return scored[:k]


def build_anomaly_payload(feature_rows: list[dict], forest: dict) -> dict:
    """Assemble an anomaly artifact from training feature dicts and a fitted forest."""
    impute = impute_values(feature_rows)
    vectors = [vectorize(r, impute) for r in feature_rows]
    scores = sorted(runtime.iforest_score(forest, v) for v in vectors)
    n = len(scores)
    quantiles = [scores[min(n - 1, int(i * n / 200))] for i in range(200)] if n else []
    population = {}
    for idx, (name, _, _) in enumerate(MODEL_FEATURES):
        col = sorted(v[idx] for v, r in zip(vectors, feature_rows) if r.get(name) is not None)
        if col:
            med = col[len(col) // 2]
            mad = sorted(abs(c - med) for c in col)[len(col) // 2]
            population[name] = (med, mad)
    return {"format": 1, "feature_version": FEATURE_VERSION, "feature_names": feature_names(),
            "forest": forest, "impute": impute, "calibration": {"score_quantiles": quantiles},
            "population": population, "training_rows": n}


# ── scorer ────────────────────────────────────────────────────────────────


class Scorer:
    def __init__(self, anomaly: AnomalyModel | None = None):
        self.anomaly = anomaly

    @property
    def model_version(self) -> str:
        return f"{EVIDENCE_MODEL}+{self.anomaly.version}" if self.anomaly else EVIDENCE_MODEL

    def score(self, features: dict) -> dict:
        ev = evidence(features)
        keep = 1.0
        for e in ev:
            keep *= 1.0 - e.strength
        explanations = [e.as_dict() for e in ev]
        rarity = raw = None
        if self.anomaly is not None:
            raw = self.anomaly.raw(features)
            rarity = self.anomaly.rarity(raw)
            part = _ramp(rarity, RARITY_START, 1.0)
            if part > 0:
                keep *= 1.0 - W_IF * part
                covered = {family(e["feature"]) for e in explanations}
                for name, _w in self.anomaly.top_features(features):
                    if family(name) in covered:
                        continue
                    covered.add(family(name))
                    val = features.get(name)
                    explanations.append({
                        "code": "population_rarity", "feature": name, "value": val,
                        "contribution": round(W_IF * part / 3, 3),
                        "text": f"unusual for the whole user base: {FEATURE_LABELS.get(name, name)} "
                                f"({_fmt(val)})",
                    })
        explanations.sort(key=lambda e: e["contribution"], reverse=True)
        return {
            "score": round(1.0 - keep, 4),
            "explanations": explanations[:MAX_EXPLANATIONS],
            "context": {**context_for(features),
                        **({"forest_raw": round(raw, 4), "forest_rarity": round(rarity, 4)} if raw is not None else {})},
        }


def _fmt(v):
    if v is None:
        return "missing"
    if isinstance(v, float) and not v.is_integer():
        return f"{v:.2f}"
    return f"{int(v):,}"


def load_active_scorer() -> Scorer:
    from .models import ModelArtifact

    art = (ModelArtifact.objects.filter(kind=ModelArtifact.KIND_ANOMALY, is_active=True,
                                        feature_version=FEATURE_VERSION).order_by("-created_at").first())
    if art is None:
        return Scorer(None)
    try:
        return Scorer(AnomalyModel(art.payload, art.version))
    except (KeyError, ValueError) as exc:
        logger.warning("risk_ml: active anomaly artifact %s unusable (%s); evidence only", art.version, exc)
        return Scorer(None)


def load_active_supervised():
    from .models import ModelArtifact

    return (ModelArtifact.objects.filter(kind=ModelArtifact.KIND_SUPERVISED, is_active=True,
                                         feature_version=FEATURE_VERSION).order_by("-created_at").first())


def score_days(start: date, end: date, *, scorer: Scorer | None = None, batch: int = 500) -> dict:
    """Score every feature row in [start, end]; upsert RiskScore (idempotent)."""
    from .models import RiskScore, UserDayFeatures

    scorer = scorer or load_active_scorer()
    sup = load_active_supervised()
    if sup is not None and (sup.payload or {}).get("feature_names") != feature_names():
        logger.warning("risk_ml: supervised artifact %s was trained on other features; skipped", sup.version)
        sup = None
    version = scorer.model_version
    qs = (UserDayFeatures.objects.filter(date__range=(start, end), feature_version=FEATURE_VERSION,
                                         user__deleted_at__isnull=True)
          .order_by("pk"))
    written = 0
    pending: dict = {}

    def flush():
        nonlocal written
        if not pending:
            return
        keys = list(pending)
        existing = {(r.user_id, r.date, r.model_version): r for r in RiskScore.objects.filter(
            user_id__in={k[0] for k in keys}, date__in={k[1] for k in keys},
            model_version__in={k[2] for k in keys})}
        upd, new = [], []
        for key, res in pending.items():
            obj = existing.get(key)
            if obj:
                obj.score, obj.explanations, obj.context = res["score"], res["explanations"], res["context"]
                upd.append(obj)
            else:
                new.append(RiskScore(user_id=key[0], date=key[1], model_version=key[2],
                                     feature_version=FEATURE_VERSION, **res))
        if upd:
            RiskScore.objects.bulk_update(upd, ["score", "explanations", "context"], batch_size=200)
        if new:
            RiskScore.objects.bulk_create(new, batch_size=200, ignore_conflicts=True)
        written += len(pending)
        pending.clear()

    last_pk = 0
    while True:
        # Keyset pages (not a live cursor) so writes between pages are safe on any backend.
        page = list(qs.filter(pk__gt=last_pk).values_list("pk", "user_id", "date", "features")[:batch])
        if not page:
            break
        last_pk = page[-1][0]
        for _pk, uid, day, feats in page:
            pending[(uid, day, version)] = scorer.score(feats)
            if sup is not None:
                try:
                    p = runtime.predict_proba(sup.payload["model"], vectorize(feats, sup.payload.get("impute")))
                    pending[(uid, day, sup.version)] = {"score": round(p, 4), "explanations": [],
                                                        "context": {"supervised": True}}
                except (KeyError, ValueError) as exc:  # a bad artifact must not break the nightly run
                    logger.warning("risk_ml: supervised artifact %s failed: %s", sup.version, exc)
                    sup = None
        flush()
    return {"scores": written, "model_version": version, "start": str(start), "end": str(end)}


def recent_window(days: int, today: date) -> tuple[date, date]:
    return today - timedelta(days=max(1, days) - 1), today
