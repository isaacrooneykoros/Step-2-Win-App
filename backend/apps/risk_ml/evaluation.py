"""
Synthetic evaluation of the anomaly scorer (offline; used by a test and by the
``risk_ml_synthetic_eval`` command that writes EVALUATION.md numbers).
"""

from __future__ import annotations

from collections import defaultdict

from .ml import pytrain
from .scoring import AnomalyModel, Scorer, build_anomaly_payload, vectorize
from .synthetic import CHEATS, EVASIVE, HONEST, generate_population


def train_forest(feature_rows: list[dict], *, n_trees: int = 100, max_samples: int = 256, seed: int = 0,
                 use_sklearn: bool = False) -> dict:
    """Fit an isolation forest on feature dicts; returns the anomaly artifact payload."""
    from .scoring import impute_values

    impute = impute_values(feature_rows)
    X = [vectorize(r, impute) for r in feature_rows]
    if use_sklearn:
        from sklearn.ensemble import IsolationForest  # offline only

        from .ml.export_sklearn import export_isolation_forest

        model = IsolationForest(n_estimators=n_trees, max_samples=min(max_samples, len(X)), random_state=seed)
        model.fit(X)
        forest = export_isolation_forest(model)
    else:
        forest = pytrain.train_isolation_forest(X, n_trees=n_trees, max_samples=max_samples, seed=seed)
    return build_anomaly_payload(feature_rows, forest)


def _pct(values, q):
    if not values:
        return None
    v = sorted(values)
    return v[min(len(v) - 1, int(q * len(v)))]


def run_synthetic_evaluation(*, seed: int = 7, honest_per_archetype: int = 30, cheats_per_archetype: int = 6,
                             n_trees: int = 100, use_sklearn: bool = False) -> dict:
    train, evaluation = generate_population(seed=seed, honest_per_archetype=honest_per_archetype,
                                            cheats_per_archetype=cheats_per_archetype)
    payload = train_forest([d.features for d in train], n_trees=n_trees, seed=seed, use_sklearn=use_sklearn)
    anomaly = AnomalyModel(payload, "synthetic-eval")
    scorers = {"combined": Scorer(anomaly), "evidence_only": Scorer(None)}

    results = {}
    for name, scorer in scorers.items():
        rows = []
        for d in evaluation:
            res = scorer.score(d.features)
            rows.append((d, res))
        results[name] = rows
    # Forest alone (calibrated rarity percentile) for comparison.
    results["forest_only"] = [(d, {"score": anomaly.rarity(anomaly.raw(d.features)), "explanations": []})
                              for d in evaluation]

    summary = {"population": {"train_days": len(train), "eval_days": len(evaluation),
                              "users": len({d.user.uid for d in evaluation})},
               "variants": {}}
    for name, rows in results.items():
        # Headline metrics: the specified cheat scenarios vs everything honest. Evasive
        # archetypes are reported separately (their recall), not mixed into the headline.
        main = [(d, r) for d, r in rows if d.user.archetype not in EVASIVE]
        y = [int(d.is_cheat_day) for d, _ in main]
        s = [r["score"] for _, r in main]
        evasive = [r["score"] for d, r in rows if d.user.archetype in EVASIVE and d.is_cheat_day]
        by_arch = defaultdict(list)
        reasons = defaultdict(lambda: defaultdict(int))
        for d, r in rows:
            key = d.user.archetype
            if d.user.is_cheat and not d.is_cheat_day:
                key = f"{key} (non-cheat days)"
            by_arch[key].append(r["score"])
            for e in r["explanations"][:2]:
                reasons[key][e["code"]] += 1
        honest_scores = [r["score"] for d, r in rows if not d.is_cheat_day]
        summary["variants"][name] = {
            "auc": pytrain.roc_auc(y, s),
            "at_0.5": pytrain.confusion_at(y, s, 0.5),
            "at_0.7": pytrain.confusion_at(y, s, 0.7),
            "honest_p90": _pct(honest_scores, 0.9),
            "honest_p99": _pct(honest_scores, 0.99),
            "evasive_recall_0.5": (sum(1 for v in evasive if v >= 0.5) / len(evasive)) if evasive else None,
            "archetypes": {
                k: {"n": len(v), "median": _pct(v, 0.5), "p10": _pct(v, 0.1), "p90": _pct(v, 0.9),
                    "top_reasons": sorted(reasons[k].items(), key=lambda t: -t[1])[:3]}
                for k, v in sorted(by_arch.items())
            },
        }
    summary["examples"] = {}
    for d, r in results["combined"]:
        a = d.user.archetype
        if a not in summary["examples"] and (d.is_cheat_day or a in HONEST):
            summary["examples"][a] = {"score": r["score"], "reasons": [e["text"] for e in r["explanations"][:3]]}
    summary["honest_archetypes"] = list(HONEST)
    summary["cheat_archetypes"] = list(CHEATS)
    return summary


def render_markdown(summary: dict) -> str:
    lines = []
    pop = summary["population"]
    lines.append(f"Population: {pop['users']} synthetic users, {pop['train_days']} unlabelled training days, "
                 f"{pop['eval_days']} evaluation days.\n")
    for name, v in summary["variants"].items():
        a5, a7 = v["at_0.5"], v["at_0.7"]
        lines.append(f"### {name}\n")
        lines.append(f"- ROC AUC (cheat days vs everything else): {v['auc']:.3f}")
        lines.append(f"- At 0.5: precision {_f(a5['precision'])}, recall {_f(a5['recall'])}, "
                     f"false-positive rate {_f(a5['false_positive_rate'])} ({a5['fp']} honest days flagged)")
        lines.append(f"- At 0.7: precision {_f(a7['precision'])}, recall {_f(a7['recall'])}, "
                     f"false-positive rate {_f(a7['false_positive_rate'])} ({a7['fp']} honest days flagged)")
        lines.append(f"- Honest-day score p90 / p99: {_f(v['honest_p90'])} / {_f(v['honest_p99'])}")
        lines.append(f"- Evasive cheats (subtle_shaker, noisy_script) caught at 0.5: {_f(v['evasive_recall_0.5'])}\n")
        lines.append("| archetype | days | median | p10 | p90 | most common top reasons |")
        lines.append("|---|---:|---:|---:|---:|---|")
        for k, s in v["archetypes"].items():
            reasons = ", ".join(f"{c} ({n})" for c, n in s["top_reasons"]) or "-"
            lines.append(f"| {k} | {s['n']} | {_f(s['median'])} | {_f(s['p10'])} | {_f(s['p90'])} | {reasons} |")
        lines.append("")
    lines.append("### Example explanations (combined scorer)\n")
    for a, ex in summary["examples"].items():
        reasons = "; ".join(ex["reasons"]) or "(no reasons: nothing unusual)"
        lines.append(f"- **{a}** ({ex['score']:.2f}): {reasons}")
    return "\n".join(lines) + "\n"


def _f(v):
    return "-" if v is None else f"{v:.2f}"
