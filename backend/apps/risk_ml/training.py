"""
OFFLINE training (management commands / GitHub Action). Never import from a request path.

- ``train_anomaly``: isolation forest on the feature store (unsupervised).
- ``train_supervised``: logistic regression or gradient-boosted trees on labelled
  user-days, only once there are enough labels of both classes. Evaluated with a
  time-based split; writes a model card. Refuses (``TrainingRefused``) with a reason.

Both store a ``ModelArtifact`` (inactive unless ``activate=True``) whose payload is
pure JSON evaluated by ``ml.runtime`` in production.
"""

from __future__ import annotations

import json
import logging
from collections import Counter
from datetime import date, timedelta
from pathlib import Path

from django.conf import settings
from django.db import transaction
from django.utils import timezone

from .features import FEATURE_VERSION
from .labels import resolve_day_labels
from .ml import pytrain, runtime
from .models import Label, ModelArtifact, UserDayFeatures
from .scoring import (FEATURE_LABELS, build_anomaly_payload, feature_names,
                      impute_values, vectorize)

logger = logging.getLogger(__name__)

DEFAULT_MIN_LABELS = 200
DEFAULT_MIN_PER_CLASS = 30
DEFAULT_MIN_ANOMALY_ROWS = 500


class TrainingRefused(Exception):
    """Not enough (or unsuitable) data; the message says why and what's needed."""


def sklearn_available() -> bool:
    try:
        import sklearn  # noqa: F401
    except ImportError:
        return False
    return True


def hold_threshold() -> float:
    return float(getattr(settings, "RISK_ML_HOLD_THRESHOLD", 0.8))


def iter_feature_rows(start: date | None = None, end: date | None = None, page: int = 2000):
    qs = UserDayFeatures.objects.filter(feature_version=FEATURE_VERSION, user__deleted_at__isnull=True)
    if start:
        qs = qs.filter(date__gte=start)
    if end:
        qs = qs.filter(date__lte=end)
    last = 0
    while True:
        rows = list(qs.filter(pk__gt=last).order_by("pk").values_list("pk", "user_id", "date", "features")[:page])
        if not rows:
            return
        last = rows[-1][0]
        for _pk, uid, day, feats in rows:
            yield uid, day, feats


def _activate(artifact: ModelArtifact):
    if artifact.trained_on != "real":
        raise TrainingRefused("synthetic-trained models can't be activated")
    with transaction.atomic():
        ModelArtifact.objects.filter(kind=artifact.kind, is_active=True).exclude(pk=artifact.pk).update(is_active=False)
        artifact.is_active = True
        artifact.save(update_fields=["is_active"])


def activate_version(version: str) -> ModelArtifact:
    art = ModelArtifact.objects.get(version=version)
    _activate(art)
    return art


def _export(artifact: ModelArtifact, out_dir: str | None):
    if not out_dir:
        return None
    path = Path(out_dir)
    path.mkdir(parents=True, exist_ok=True)
    (path / f"{artifact.version}.json").write_text(json.dumps(artifact.payload, separators=(",", ":")), encoding="utf-8")
    (path / f"{artifact.version}.model_card.md").write_text(artifact.model_card, encoding="utf-8")
    return str(path)


# ── anomaly ─────────────────────────────────────────────────────────────────


def train_anomaly(*, days: int = 90, n_trees: int = 100, max_samples: int = 256, seed: int = 0,
                  use_sklearn: bool | None = None, min_rows: int = DEFAULT_MIN_ANOMALY_ROWS,
                  activate: bool = False, out_dir: str | None = None) -> ModelArtifact:
    end = timezone.now().date()
    start = end - timedelta(days=days)
    cheat_days = {k for k, v in resolve_day_labels().items() if v == Label.LABEL_CHEAT}
    rows, excluded = [], 0
    for uid, day, feats in iter_feature_rows(start, end):
        if (uid, day) in cheat_days:
            excluded += 1  # keep confirmed cheating out of "normal"
            continue
        rows.append(feats)
    if len(rows) < min_rows:
        raise TrainingRefused(
            f"Only {len(rows)} user-days in the feature store for {start}..{end} (need {min_rows}). "
            "Let the nightly job collect more days (or widen --days) before training the anomaly model.")
    use_sklearn = sklearn_available() if use_sklearn is None else use_sklearn
    impute = impute_values(rows)
    X = [vectorize(r, impute) for r in rows]
    if use_sklearn:
        from sklearn.ensemble import IsolationForest

        from .ml.export_sklearn import export_isolation_forest

        model = IsolationForest(n_estimators=n_trees, max_samples=min(max_samples, len(X)), random_state=seed).fit(X)
        forest = export_isolation_forest(model)
    else:
        forest = pytrain.train_isolation_forest(X, n_trees=n_trees, max_samples=max_samples, seed=seed)
    payload = build_anomaly_payload(rows, forest)
    version = f"iforest-{FEATURE_VERSION}-{timezone.now():%Y%m%d%H%M%S}"
    q = payload["calibration"]["score_quantiles"]
    card = "\n".join([
        f"# Model card: {version}",
        "",
        "- Kind: isolation forest (unsupervised anomaly), SHADOW ONLY - never used for enforcement.",
        f"- Trainer: {forest.get('trainer')} ({n_trees} trees, max_samples {forest['max_samples']}, seed {seed})",
        f"- Data window: {start} .. {end}; {len(rows)} user-days (feature version {FEATURE_VERSION}); "
        f"{excluded} days labelled cheat were excluded.",
        f"- Raw score quantiles: p50 {q[len(q) // 2]:.3f}, p95 {q[int(len(q) * 0.95)]:.3f}, max {q[-1]:.3f}",
        f"- Inputs: {', '.join(feature_names())}",
        "",
        "## Known biases",
        "- 'Unusual' is relative to the current user base: if cheating is common, it looks normal.",
        "- iOS users have no motion (gait) data; missing values are imputed with the median, so the",
        "  forest partly learns 'iPhone' vs 'Android' as a pattern. Compare score distributions per platform.",
        "- Stored step totals are the discounted approved values (see anti-cheat audit), not raw counts.",
        "- New users have no personal baseline (baseline features missing for their first 5 recorded days).",
    ])
    art = ModelArtifact.objects.create(kind=ModelArtifact.KIND_ANOMALY, version=version, feature_version=FEATURE_VERSION,
                                       payload=payload, model_card=card, trained_on="real",
                                       metrics={"training_rows": len(rows), "excluded_cheat_days": excluded,
                                                "window": [str(start), str(end)]})
    if activate:
        _activate(art)
    _export(art, out_dir)
    return art


# ── supervised ──────────────────────────────────────────────────────────────


def build_labelled_dataset(*, include_synthetic: bool = False) -> list[tuple[int, date, dict, int]]:
    labels = resolve_day_labels(include_synthetic=include_synthetic)
    if not labels:
        return []
    days = sorted({d for _, d in labels})
    out = []
    for uid, day, feats in iter_feature_rows(days[0], days[-1]):
        lab = labels.get((uid, day))
        if lab is not None:
            out.append((uid, day, feats, int(lab == Label.LABEL_CHEAT)))
    return out


def check_label_readiness(dataset, *, min_labels: int, min_per_class: int) -> None:
    n = len(dataset)
    pos = sum(1 for *_, y in dataset if y)
    neg = n - pos
    problems = []
    if n < min_labels:
        problems.append(f"{n} labelled user-days with features (need at least {min_labels})")
    if pos < min_per_class:
        problems.append(f"{pos} labelled cheat days (need at least {min_per_class})")
    if neg < min_per_class:
        problems.append(f"{neg} labelled honest days (need at least {min_per_class})")
    if problems:
        raise TrainingRefused(
            "Not enough labels to train a supervised model: " + "; ".join(problems) + ". "
            "Labels come from admin decisions on anti-cheat flags, payout-hold reviews and the admin "
            "'label this day' endpoint (synthetic labels are excluded). Until then the shadow anomaly "
            "score is the only model; a supervised model trained on a handful of noisy labels would "
            "mostly learn which rules fired, not who cheated.")


def time_split(dataset, test_fraction: float):
    dates = sorted({d for _, d, _, _ in dataset})
    cut_idx = max(1, int(round(len(dates) * (1 - test_fraction))))
    if cut_idx >= len(dates):
        raise TrainingRefused("labels cover too few distinct days for a time-based split")
    cut = dates[cut_idx]
    train = [r for r in dataset if r[1] < cut]
    test = [r for r in dataset if r[1] >= cut]
    for name, part in (("training", train), ("test", test)):
        ys = {y for *_, y in part}
        if ys != {0, 1}:
            raise TrainingRefused(f"the {name} period (split at {cut}) doesn't contain both cheat and honest labels")
    return train, test, cut


def train_supervised(*, min_labels: int = DEFAULT_MIN_LABELS, min_per_class: int = DEFAULT_MIN_PER_CLASS,
                     model_kind: str = "logreg", threshold: float | None = None, test_fraction: float = 0.3,
                     include_synthetic: bool = False, activate: bool = False, out_dir: str | None = None,
                     use_sklearn: bool | None = None) -> ModelArtifact:
    threshold = hold_threshold() if threshold is None else threshold
    dataset = build_labelled_dataset(include_synthetic=include_synthetic)
    check_label_readiness(dataset, min_labels=min_labels, min_per_class=min_per_class)
    train, test, cut = time_split(dataset, test_fraction)
    use_sklearn = sklearn_available() if use_sklearn is None else use_sklearn
    if model_kind == "gbt" and not use_sklearn:
        raise TrainingRefused("gradient-boosted trees need scikit-learn (pip install -r requirements-ml.txt) "
                              "in the offline environment; use --model logreg otherwise")

    names = feature_names()
    impute = impute_values([f for _, _, f, _ in train])
    Xtr = [vectorize(f, impute) for _, _, f, _ in train]
    ytr = [y for *_, y in train]
    Xte = [vectorize(f, impute) for _, _, f, _ in test]
    yte = [y for *_, y in test]

    if model_kind == "gbt":
        from sklearn.ensemble import GradientBoostingClassifier

        from .ml.export_sklearn import export_gradient_boosting

        est = GradientBoostingClassifier(n_estimators=150, max_depth=3, learning_rate=0.05, subsample=0.8,
                                         random_state=0).fit(Xtr, ytr)
        model = export_gradient_boosting(est)
        importances = list(zip(names, [float(v) for v in est.feature_importances_]))
    elif model_kind == "logreg":
        if use_sklearn:
            from sklearn.linear_model import LogisticRegression

            from .ml.export_sklearn import export_logistic_regression

            n = len(Xtr)
            mean = [sum(r[j] for r in Xtr) / n for j in range(len(names))]
            scale = [((sum((r[j] - mean[j]) ** 2 for r in Xtr) / n) ** 0.5) or 1.0 for j in range(len(names))]
            Z = [[(r[j] - mean[j]) / scale[j] for j in range(len(names))] for r in Xtr]
            est = LogisticRegression(C=1.0, class_weight="balanced", max_iter=2000).fit(Z, ytr)
            model = export_logistic_regression(est, mean, scale)
        else:
            model = pytrain.train_logreg(Xtr, ytr)
        importances = list(zip(names, [abs(c) for c in model["coef"]]))
    else:
        raise TrainingRefused(f"unknown model kind {model_kind!r} (logreg or gbt)")

    p_test = [runtime.predict_proba(model, x) for x in Xte]
    metrics = {
        "split_date": str(cut), "train_rows": len(train), "test_rows": len(test),
        "train_positive": sum(ytr), "test_positive": sum(yte),
        "auc": pytrain.roc_auc(yte, p_test),
        "at_hold_threshold": pytrain.confusion_at(yte, p_test, threshold),
        "thresholds": [pytrain.confusion_at(yte, p_test, t) for t in (0.5, 0.7, 0.8, 0.9)],
    }
    honest_users = {uid for (uid, _, _, y) in test if y == 0}
    flagged_honest = {uid for (uid, _, _, y), p in zip(test, p_test) if y == 0 and p >= threshold}
    metrics["honest_user_fpr_at_hold"] = (len(flagged_honest) / len(honest_users)) if honest_users else None
    importances.sort(key=lambda t: t[1], reverse=True)
    metrics["feature_importance"] = importances[:15]

    sources = Counter(Label.objects.filter(source__in=list(Label.REAL_SOURCES)
                                           + ([Label.SOURCE_SYNTHETIC] if include_synthetic else []))
                      .values_list("source", flat=True))
    version = f"{model_kind}-{FEATURE_VERSION}-{timezone.now():%Y%m%d%H%M%S}"
    trained_on = "synthetic" if include_synthetic else "real"
    card = _model_card(version, model_kind, model, metrics, dataset, sources, threshold, trained_on)
    payload = {"format": 1, "feature_version": FEATURE_VERSION, "feature_names": names, "impute": impute,
               "model": model, "threshold": threshold}
    art = ModelArtifact.objects.create(kind=ModelArtifact.KIND_SUPERVISED, version=version,
                                       feature_version=FEATURE_VERSION, payload=payload, metrics=metrics,
                                       model_card=card, trained_on=trained_on)
    if activate:
        _activate(art)
    _export(art, out_dir)
    return art


def _fmt(v, pct=False):
    if v is None:
        return "n/a"
    return f"{v * 100:.1f}%" if pct else f"{v:.3f}"


def _model_card(version, kind, model, m, dataset, sources, threshold, trained_on) -> str:
    dates = sorted(d for _, d, _, _ in dataset)
    hold = m["at_hold_threshold"]
    no_gait = sum(1 for _, _, f, _ in dataset if not f.get("gait_sync_count"))
    lines = [
        f"# Model card: {version}",
        "",
        f"- Kind: {kind} ({model.get('trainer')}), SHADOW ONLY. Output: probability a user-day is cheating.",
        f"- Trained on: {trained_on.upper()} labels" + (" - NOT FOR PRODUCTION" if trained_on != "real" else ""),
        f"- Data window: {dates[0]} .. {dates[-1]}; time split at {m['split_date']} "
        f"(train {m['train_rows']} rows / {m['train_positive']} cheat, test {m['test_rows']} rows / {m['test_positive']} cheat)",
        f"- Label sources: {dict(sources)}",
        "",
        "## Test-period metrics",
        f"- ROC AUC: {_fmt(m['auc'])}",
        f"- At the payout-hold threshold {threshold}: precision {_fmt(hold['precision'], True)}, "
        f"recall {_fmt(hold['recall'], True)}, false-positive rate {_fmt(hold['false_positive_rate'], True)}",
        f"- Honest-labelled users with any test day above the hold threshold: {_fmt(m['honest_user_fpr_at_hold'], True)}",
        "",
        "| threshold | precision | recall | FPR |",
        "|---:|---:|---:|---:|",
    ]
    for t in m["thresholds"]:
        lines.append(f"| {t['threshold']} | {_fmt(t['precision'], True)} | {_fmt(t['recall'], True)} | "
                     f"{_fmt(t['false_positive_rate'], True)} |")
    lines += ["", "## Feature importance (top 15)"]
    for name, w in m["feature_importance"]:
        lines.append(f"- {name} ({FEATURE_LABELS.get(name, '')}): {w:.4f}")
    lines += [
        "",
        "## Known biases",
        "- Selection bias: flag-derived labels exist only where a rule fired, so the model partly learns",
        "  the old rules (including their false positives, e.g. velocity-spike and late-sync hits).",
        "- Flag actions are account-level moderation decisions, not verified per-day findings (noisy).",
        f"- {no_gait} of {len(dataset)} labelled days have no motion data (iOS or app closed); gait features are imputed.",
        "- Small test period: metrics have wide uncertainty; re-check on the next period before trusting.",
    ]
    return "\n".join(lines) + "\n"
