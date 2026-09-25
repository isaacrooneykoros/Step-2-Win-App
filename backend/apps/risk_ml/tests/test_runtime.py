"""Pure-Python scorer parity with scikit-learn, and the pure-Python trainers."""

import json
import random
import unittest
from pathlib import Path

from django.test import SimpleTestCase

from apps.risk_ml.ml import pytrain, runtime

FIXTURE = Path(__file__).parent / "fixtures" / "sklearn_parity.json"
TOL = 1e-9

try:
    import sklearn  # noqa: F401
    HAVE_SKLEARN = True
except ImportError:
    HAVE_SKLEARN = False


class SklearnParityFixtureTests(SimpleTestCase):
    """The fixture was produced by tools/make_parity_fixture.py with scikit-learn 1.5.2."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.fx = json.loads(FIXTURE.read_text(encoding="utf-8"))
        cls.probes = cls.fx["probes"]

    def test_isolation_forest_matches_score_samples(self):
        model = self.fx["isolation_forest"]["model"]
        for row, expected in zip(self.probes, self.fx["isolation_forest"]["expected_score"]):
            self.assertAlmostEqual(runtime.iforest_score(model, row), expected, delta=TOL)

    def test_gradient_boosting_matches_predict_proba(self):
        model = self.fx["gbt"]["model"]
        for row, expected in zip(self.probes, self.fx["gbt"]["expected_proba"]):
            self.assertAlmostEqual(runtime.gbt_proba(model, row), expected, delta=TOL)

    def test_logistic_regression_matches_predict_proba(self):
        model = self.fx["logreg"]["model"]
        for row, expected in zip(self.probes, self.fx["logreg"]["expected_proba"]):
            self.assertAlmostEqual(runtime.logreg_proba(model, row), expected, delta=TOL)

    def test_outliers_score_higher(self):
        model = self.fx["isolation_forest"]["model"]
        scores = [runtime.iforest_score(model, r) for r in self.probes]
        self.assertGreater(sum(scores[40:]) / 10, sum(scores[:40]) / 40)  # last 10 probes drawn with sd 4


@unittest.skipUnless(HAVE_SKLEARN, "scikit-learn not installed (offline requirements-ml.txt)")
class LiveSklearnParityTests(SimpleTestCase):
    def test_live_isolation_forest_parity(self):
        import numpy as np
        from sklearn.ensemble import IsolationForest

        from apps.risk_ml.ml.export_sklearn import export_isolation_forest

        rng = np.random.default_rng(1)
        X = rng.normal(size=(300, 5))
        m = IsolationForest(n_estimators=20, max_samples=64, max_features=0.6, random_state=3).fit(X)
        exported = export_isolation_forest(m)
        probes = rng.normal(scale=2, size=(30, 5))
        for row, expected in zip(probes.tolist(), (-m.score_samples(probes)).tolist()):
            self.assertAlmostEqual(runtime.iforest_score(exported, row), expected, delta=TOL)


class PureTrainerTests(SimpleTestCase):
    def test_average_path_length(self):
        self.assertEqual(runtime.average_path_length(1), 0.0)
        self.assertEqual(runtime.average_path_length(2), 1.0)
        self.assertAlmostEqual(runtime.average_path_length(256), 10.2447, places=3)

    def test_pure_isolation_forest_isolates_outliers(self):
        rng = random.Random(0)
        rows = [[rng.gauss(0, 1), rng.gauss(0, 1)] for _ in range(500)]
        forest = pytrain.train_isolation_forest(rows, n_trees=50, max_samples=128, seed=1)
        normal = runtime.iforest_score(forest, [0.0, 0.0])
        outlier = runtime.iforest_score(forest, [6.0, -6.0])
        self.assertLess(normal, 0.5)
        self.assertGreater(outlier, 0.65)
        attribution = runtime.iforest_feature_attribution(forest, [0.0, 9.0])
        self.assertEqual(set(attribution), {0, 1})

    def test_pure_forest_is_deterministic(self):
        rows = [[float(i % 7), float(i % 11)] for i in range(200)]
        a = pytrain.train_isolation_forest(rows, n_trees=5, max_samples=32, seed=4)
        b = pytrain.train_isolation_forest(rows, n_trees=5, max_samples=32, seed=4)
        self.assertEqual(a, b)

    def test_pure_logreg_learns_and_metrics(self):
        rng = random.Random(0)
        rows, y = [], []
        for _ in range(400):
            x = [rng.gauss(0, 1), rng.gauss(0, 1)]
            rows.append(x)
            y.append(int(x[0] + 0.2 * rng.gauss(0, 1) > 0.5))
        model = pytrain.train_logreg(rows, y, epochs=200, lr=0.5)
        scores = [runtime.logreg_proba(model, r) for r in rows]
        self.assertGreater(pytrain.roc_auc(y, scores), 0.95)
        self.assertGreater(model["coef"][0], abs(model["coef"][1]))
        c = pytrain.confusion_at([1, 1, 0, 0], [0.9, 0.2, 0.8, 0.1], 0.5)
        self.assertEqual((c["tp"], c["fn"], c["fp"], c["tn"]), (1, 1, 1, 1))
        self.assertEqual(c["precision"], 0.5)
        self.assertIsNone(pytrain.roc_auc([1, 1], [0.1, 0.2]))
        self.assertEqual(pytrain.roc_auc([0, 1, 0, 1], [0.1, 0.9, 0.5, 0.5]), 0.875)
