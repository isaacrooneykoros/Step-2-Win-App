"""
Regenerate tests/fixtures/sklearn_parity.json (OFFLINE, needs requirements-ml.txt).

    python -m venv mlvenv && mlvenv/Scripts/pip install -r backend/requirements-ml.txt
    cd backend && ../mlvenv/Scripts/python -m apps.risk_ml.tools.make_parity_fixture

Fits scikit-learn IsolationForest / GradientBoostingClassifier / LogisticRegression on
deterministic random data, exports them with ``export_sklearn`` and records
scikit-learn's own outputs for a set of probe rows. The Django test suite (which has no
scikit-learn) then checks that the pure-Python runtime reproduces those outputs.
No Django import here.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import sklearn
from sklearn.ensemble import GradientBoostingClassifier, IsolationForest
from sklearn.linear_model import LogisticRegression

from apps.risk_ml.ml.export_sklearn import (export_gradient_boosting,
                                            export_isolation_forest,
                                            export_logistic_regression)

OUT = Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "sklearn_parity.json"


def main() -> int:
    rng = np.random.default_rng(20260925)
    n, d = 600, 6
    X = rng.normal(size=(n, d))
    X[:, 2] = np.round(X[:, 2] * 3)  # a discrete column (ties, like counts)
    X[:, 4] = np.abs(X[:, 4]) ** 2  # skewed column
    y = ((X[:, 0] + 0.7 * X[:, 1] - 0.4 * X[:, 3] + rng.normal(scale=0.8, size=n)) > 0.3).astype(int)
    probes = np.vstack([rng.normal(size=(40, d)), rng.normal(scale=4.0, size=(10, d))])

    iforest = IsolationForest(n_estimators=40, max_samples=128, max_features=0.8, random_state=7).fit(X)
    gbt = GradientBoostingClassifier(n_estimators=30, max_depth=3, learning_rate=0.1, random_state=7).fit(X, y)
    mean, scale = X.mean(axis=0), X.std(axis=0)
    logreg = LogisticRegression(C=1.0, max_iter=1000).fit((X - mean) / scale, y)

    payload = {
        "generated_with": {"scikit-learn": sklearn.__version__, "numpy": np.__version__},
        "probes": probes.tolist(),
        "isolation_forest": {
            "model": export_isolation_forest(iforest),
            "expected_score": (-iforest.score_samples(probes)).tolist(),
        },
        "gbt": {
            "model": export_gradient_boosting(gbt),
            "expected_proba": gbt.predict_proba(probes)[:, 1].tolist(),
        },
        "logreg": {
            "model": export_logistic_regression(logreg, mean, scale),
            "expected_proba": logreg.predict_proba((probes - mean) / scale)[:, 1].tolist(),
        },
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    print(f"wrote {OUT} ({OUT.stat().st_size / 1024:.0f} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
