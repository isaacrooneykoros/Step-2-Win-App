"""
Small pure-Python trainers and metrics.

Used offline (management commands) when scikit-learn isn't installed, and by the
synthetic evaluation / tests. They write the same JSON format as ``export_sklearn`` so
the runtime can't tell the difference. They are deliberately simple and slow-ish
(seconds for tens of thousands of rows); never call them from a web request.
"""

from __future__ import annotations

import math
import random
from operator import add, mul

from .runtime import sigmoid

# ── Isolation forest ────────────────────────────────────────────────────────


def _build_itree(rows: list[list[float]], idx: list[int], depth: int, max_depth: int,
                 rng: random.Random, tree: dict) -> int:
    node = len(tree["feature"])
    tree["feature"].append(-1)
    tree["threshold"].append(-2.0)
    tree["left"].append(-1)
    tree["right"].append(-1)
    tree["n"].append(len(idx))
    if depth >= max_depth or len(idx) <= 1:
        return node
    n_features = len(rows[idx[0]])
    # Features that still vary inside this node, tried in random order (as ExtraTree does).
    candidates = list(range(n_features))
    rng.shuffle(candidates)
    for f in candidates:
        lo = min(rows[i][f] for i in idx)
        hi = max(rows[i][f] for i in idx)
        if hi > lo:
            thr = lo + rng.random() * (hi - lo)
            if thr >= hi:  # guard float edge case so both sides are non-empty
                thr = lo
            left_idx = [i for i in idx if rows[i][f] <= thr]
            right_idx = [i for i in idx if rows[i][f] > thr]
            tree["feature"][node] = f
            tree["threshold"][node] = thr
            tree["left"][node] = _build_itree(rows, left_idx, depth + 1, max_depth, rng, tree)
            tree["right"][node] = _build_itree(rows, right_idx, depth + 1, max_depth, rng, tree)
            return node
    return node  # every feature constant: leaf


def train_isolation_forest(rows: list[list[float]], *, n_trees: int = 100, max_samples: int = 256,
                           seed: int = 0) -> dict:
    if not rows:
        raise ValueError("no rows to train on")
    rng = random.Random(seed)
    m = min(max_samples, len(rows))
    max_depth = int(math.ceil(math.log2(max(m, 2))))
    trees = []
    for _ in range(n_trees):
        idx = rng.sample(range(len(rows)), m)
        tree = {"feature": [], "threshold": [], "left": [], "right": [], "n": []}
        _build_itree(rows, idx, 0, max_depth, rng, tree)
        trees.append(tree)
    return {"kind": "isolation_forest", "format": 1, "max_samples": m, "input_dtype": "float64",
            "trees": trees, "trainer": "pure-python"}


# ── Logistic regression ─────────────────────────────────────────────────────


def train_logreg(rows: list[list[float]], y: list[int], *, l2: float = 1.0, epochs: int = 400,
                 lr: float = 0.1, class_weight_balanced: bool = True) -> dict:
    """Full-batch gradient descent on standardised inputs with L2 (C = 1 / l2)."""
    n, d = len(rows), len(rows[0])
    mean = [sum(r[j] for r in rows) / n for j in range(d)]
    scale = []
    for j in range(d):
        var = sum((r[j] - mean[j]) ** 2 for r in rows) / n
        scale.append(math.sqrt(var) or 1.0)
    xs = [[(r[j] - mean[j]) / scale[j] for j in range(d)] for r in rows]
    cols = [list(c) for c in zip(*xs)]
    pos = sum(y) or 1
    neg = (n - sum(y)) or 1
    w_pos = n / (2.0 * pos) if class_weight_balanced else 1.0
    w_neg = n / (2.0 * neg) if class_weight_balanced else 1.0
    weights = [w_pos if t else w_neg for t in y]
    coef = [0.0] * d
    b = 0.0
    for _ in range(epochs):
        z = [b] * n
        for j in range(d):
            if coef[j]:
                z = list(map(add, z, [coef[j] * v for v in cols[j]]))
        errs = [w * (sigmoid(zi) - t) for zi, w, t in zip(z, weights, y)]
        for j in range(d):
            g = sum(map(mul, errs, cols[j]))
            coef[j] -= lr * (g / n + l2 * coef[j] / n)
        b -= lr * sum(errs) / n
    return {"kind": "logreg", "format": 1, "mean": mean, "scale": scale, "coef": coef,
            "intercept": b, "trainer": "pure-python"}


# ── Metrics ─────────────────────────────────────────────────────────────────


def roc_auc(y: list[int], scores: list[float]) -> float | None:
    """Mann-Whitney AUC with tie handling. None if only one class present."""
    pos = [s for s, t in zip(scores, y) if t]
    neg = [s for s, t in zip(scores, y) if not t]
    if not pos or not neg:
        return None
    ranked = sorted((s, i) for i, s in enumerate(scores))
    ranks = [0.0] * len(scores)
    i = 0
    while i < len(ranked):
        j = i
        while j + 1 < len(ranked) and ranked[j + 1][0] == ranked[i][0]:
            j += 1
        avg = (i + j) / 2.0 + 1.0
        for k in range(i, j + 1):
            ranks[ranked[k][1]] = avg
        i = j + 1
    rank_pos = sum(r for r, t in zip(ranks, y) if t)
    return (rank_pos - len(pos) * (len(pos) + 1) / 2.0) / (len(pos) * len(neg))


def confusion_at(y: list[int], scores: list[float], threshold: float) -> dict:
    tp = sum(1 for s, t in zip(scores, y) if t and s >= threshold)
    fp = sum(1 for s, t in zip(scores, y) if not t and s >= threshold)
    fn = sum(1 for s, t in zip(scores, y) if t and s < threshold)
    tn = sum(1 for s, t in zip(scores, y) if not t and s < threshold)
    return {
        "threshold": threshold, "tp": tp, "fp": fp, "fn": fn, "tn": tn,
        "precision": tp / (tp + fp) if tp + fp else None,
        "recall": tp / (tp + fn) if tp + fn else None,
        "false_positive_rate": fp / (fp + tn) if fp + tn else None,
    }
