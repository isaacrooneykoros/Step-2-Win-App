"""
Convert fitted scikit-learn estimators to the pure-Python JSON format (see runtime.py).

OFFLINE ONLY: imports scikit-learn / NumPy lazily. Install them from
``backend/requirements-ml.txt`` into a separate environment; production never needs them.
"""

from __future__ import annotations


def _tree_arrays(tree_) -> dict:
    return {
        "feature": [int(f) if int(f) >= 0 else -1 for f in tree_.feature],
        "threshold": [float(t) for t in tree_.threshold],
        "left": [int(v) for v in tree_.children_left],
        "right": [int(v) for v in tree_.children_right],
    }


def export_isolation_forest(model) -> dict:
    """sklearn.ensemble.IsolationForest -> JSON dict (feature indices mapped back to columns)."""
    trees = []
    for est, feats in zip(model.estimators_, model.estimators_features_):
        t = est.tree_
        arrays = _tree_arrays(t)
        # Each tree was fit on X[:, feats]; map its local feature ids to global columns.
        arrays["feature"] = [int(feats[f]) if f >= 0 else -1 for f in arrays["feature"]]
        arrays["n"] = [int(v) for v in t.n_node_samples]
        trees.append(arrays)
    return {
        "kind": "isolation_forest",
        "format": 1,
        "max_samples": int(model.max_samples_),
        "input_dtype": "float32",
        "trees": trees,
        "trainer": "scikit-learn",
    }


def export_gradient_boosting(model) -> dict:
    """Binary sklearn.ensemble.GradientBoostingClassifier (log-loss) -> JSON dict."""
    import numpy as np

    if model.n_classes_ != 2:
        raise ValueError("only binary classifiers are supported")
    zero = np.zeros((1, model.n_features_in_), dtype=np.float64)
    init_raw = float(model._raw_predict_init(zero)[0, 0])
    trees = []
    for est in model.estimators_[:, 0]:
        t = est.tree_
        arrays = _tree_arrays(t)
        arrays["value"] = [float(v[0][0]) for v in t.value]
        trees.append(arrays)
    return {
        "kind": "gbt",
        "format": 1,
        "init_raw": init_raw,
        "learning_rate": float(model.learning_rate),
        "input_dtype": "float32",
        "trees": trees,
        "trainer": "scikit-learn",
    }


def export_logistic_regression(model, mean, scale) -> dict:
    """sklearn LogisticRegression fitted on (X - mean) / scale -> JSON dict."""
    return {
        "kind": "logreg",
        "format": 1,
        "mean": [float(v) for v in mean],
        "scale": [float(v) or 1.0 for v in scale],
        "coef": [float(v) for v in model.coef_[0]],
        "intercept": float(model.intercept_[0]),
        "trainer": "scikit-learn",
    }
