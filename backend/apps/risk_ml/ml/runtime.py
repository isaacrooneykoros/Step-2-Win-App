"""
Evaluate exported models in pure Python (no NumPy).

JSON formats (``format`` = 1):

Isolation forest::

    {"kind": "isolation_forest", "format": 1, "feature_names": [...],
     "max_samples": 256, "input_dtype": "float32" | "float64",
     "trees": [{"feature": [...], "threshold": [...], "left": [...], "right": [...],
                "n": [...]}]}

    A node with ``feature == -1`` is a leaf. Samples go LEFT when x[feature] <= threshold
    (the scikit-learn convention). ``n`` is the number of training samples in the node.
    ``score`` returns 2 ** (-E[h(x)] / c(max_samples)), which is exactly
    ``-IsolationForest.score_samples`` in scikit-learn: ~0.5 is ordinary, close to 1 is
    easy to isolate (anomalous).

Gradient-boosted trees (binary)::

    {"kind": "gbt", "format": 1, "feature_names": [...], "init_raw": float,
     "learning_rate": float, "input_dtype": ...,
     "trees": [{"feature": [...], "threshold": [...], "left": [...], "right": [...],
                "value": [...]}]}

Logistic regression::

    {"kind": "logreg", "format": 1, "feature_names": [...], "mean": [...],
     "scale": [...], "coef": [...], "intercept": float}
"""

from __future__ import annotations

import math
import struct

EULER_GAMMA = 0.5772156649015329


def to_float32(x: float) -> float:
    """Round a Python float to the nearest float32 (scikit-learn trees compare float32 inputs)."""
    return struct.unpack("f", struct.pack("f", float(x)))[0]


def average_path_length(n: float) -> float:
    """c(n): average path length of an unsuccessful BST search (Liu et al. 2008)."""
    if n <= 1:
        return 0.0
    if n <= 2:
        return 1.0
    return 2.0 * (math.log(n - 1.0) + EULER_GAMMA) - 2.0 * (n - 1.0) / n


def sigmoid(z: float) -> float:
    if z >= 0:
        return 1.0 / (1.0 + math.exp(-z))
    e = math.exp(z)
    return e / (1.0 + e)


def _prepare(row, model) -> list[float]:
    if model.get("input_dtype") == "float32":
        return [to_float32(v) for v in row]
    return [float(v) for v in row]


def _leaf_and_depth(tree: dict, x: list[float]) -> tuple[int, int]:
    feature, threshold = tree["feature"], tree["threshold"]
    left, right = tree["left"], tree["right"]
    node, depth = 0, 0
    while feature[node] != -1:
        node = left[node] if x[feature[node]] <= threshold[node] else right[node]
        depth += 1
    return node, depth


def iforest_path_lengths(model: dict, row) -> list[float]:
    """Per-tree path length h(x) (depth + c(n_leaf))."""
    x = _prepare(row, model)
    out = []
    for tree in model["trees"]:
        leaf, depth = _leaf_and_depth(tree, x)
        out.append(depth + average_path_length(tree["n"][leaf]))
    return out


def iforest_score(model: dict, row) -> float:
    """Anomaly score in (0, 1); equals -score_samples() of scikit-learn's IsolationForest."""
    lengths = iforest_path_lengths(model, row)
    mean = sum(lengths) / len(lengths)
    return 2.0 ** (-mean / average_path_length(model["max_samples"]))


def iforest_feature_attribution(model: dict, row) -> dict[int, float]:
    """
    Which features isolated this row: each split on the root-to-leaf path credits its
    feature with 1 / (depth + 1) (early splits isolate more), averaged over trees.
    A cheap, model-faithful attribution in the spirit of DIFFI; used only to phrase
    explanations, never to decide anything.
    """
    x = _prepare(row, model)
    credit: dict[int, float] = {}
    for tree in model["trees"]:
        feature, threshold = tree["feature"], tree["threshold"]
        left, right = tree["left"], tree["right"]
        node, depth = 0, 0
        while feature[node] != -1:
            f = feature[node]
            credit[f] = credit.get(f, 0.0) + 1.0 / (depth + 1.0)
            node = left[node] if x[f] <= threshold[node] else right[node]
            depth += 1
    n = float(len(model["trees"])) or 1.0
    return {f: c / n for f, c in credit.items()}


def gbt_raw(model: dict, row) -> float:
    x = _prepare(row, model)
    total = model["init_raw"]
    lr = model["learning_rate"]
    for tree in model["trees"]:
        leaf, _ = _leaf_and_depth(tree, x)
        total += lr * tree["value"][leaf]
    return total


def gbt_proba(model: dict, row) -> float:
    return sigmoid(gbt_raw(model, row))


def logreg_raw(model: dict, row) -> float:
    z = model["intercept"]
    for v, m, s, c in zip(row, model["mean"], model["scale"], model["coef"]):
        z += c * ((float(v) - m) / (s or 1.0))
    return z


def logreg_proba(model: dict, row) -> float:
    return sigmoid(logreg_raw(model, row))


def predict_proba(model: dict, row) -> float:
    kind = model.get("kind")
    if kind == "gbt":
        return gbt_proba(model, row)
    if kind == "logreg":
        return logreg_proba(model, row)
    raise ValueError(f"not a supervised model: {kind!r}")
