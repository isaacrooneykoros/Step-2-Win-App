"""Explanations, forest part of the score, and the synthetic ranking test."""

from django.test import SimpleTestCase

from apps.risk_ml.evaluation import run_synthetic_evaluation, train_forest
from apps.risk_ml.scoring import AnomalyModel, Scorer, evidence
from apps.risk_ml.synthetic import CHEATS, HONEST, generate_population


def base(**kw):
    f = {"steps": 8000, "history_days": 20, "user_median_steps": 8000.0, "steps_ratio_to_median": 1.0,
         "night_share": 0.02, "hour_entropy": 0.7, "longest_active_span_h": 4, "gait_sync_count": 0,
         "twin_count": 0, "max_accounts_per_device": 1, "mpesa_shared_accounts": 0, "phone_prefix_cluster": 0,
         "replay_count": 0, "total_repeat_7d": 0, "days_to_deadline": None, "deadline_surge_ratio": 0.0}
    f.update(kw)
    return f


def texts(f):
    return [e["text"] for e in Scorer(None).score(f)["explanations"]]


class ExplanationTests(SimpleTestCase):
    def test_ordinary_day_scores_zero_without_reasons(self):
        res = Scorer(None).score(base())
        self.assertEqual(res["score"], 0.0)
        self.assertEqual(res["explanations"], [])

    def test_volume_spike_sentence(self):
        t = texts(base(steps=27200, steps_ratio_to_median=3.4, user_median_steps=8000.0))
        self.assertIn("3.4x your usual daily steps (27,200 vs a typical 8,000)", t)

    def test_night_sentence(self):
        t = texts(base(steps=10000, night_share=0.92))
        self.assertIn("92% of steps between 1 and 4 AM", t)

    def test_deadline_sentence(self):
        t = texts(base(steps=20000, steps_ratio_to_median=2.5, days_to_deadline=0, deadline_surge_ratio=2.5,
                       crossed_milestone_today=1, milestone_share_today=1.0))
        self.assertTrue(any(s.startswith("steps rose sharply right before the deadline (2.5x usual") for s in t), t)

    def test_multi_account_and_vehicle_sentences(self):
        t = texts(base(twin_count=4, mpesa_shared_accounts=2, max_accounts_per_device=3,
                       vehicle_step_share=0.4, speed_p95_kmh=45.0))
        joined = " | ".join(t)
        self.assertIn("hourly steps match 4 other accounts almost exactly today", joined)
        self.assertIn("the M-Pesa number is also used by 2 other accounts", joined)
        self.assertIn("this phone is registered to 3 accounts", joined)
        self.assertIn("40% of steps were counted while moving at vehicle speed (around 45 km/h)", joined)

    def test_strongest_first_and_capped(self):
        f = base(steps=30000, steps_ratio_to_median=4.5, night_share=0.8, twin_count=5, shake_prob_mean=0.9,
                 gait_sync_count=4, total_repeat_7d=3, mpesa_shared_accounts=3, max_accounts_per_device=4)
        res = Scorer(None).score(f)
        contribs = [e["contribution"] for e in res["explanations"]]
        self.assertEqual(contribs, sorted(contribs, reverse=True))
        self.assertLessEqual(len(res["explanations"]), 5)
        self.assertGreater(res["score"], 0.95)
        self.assertLessEqual(res["score"], 1.0)

    def test_late_sync_and_missing_gait_are_not_evidence(self):
        # The rural late-sync / iPhone pattern must not be treated as suspicious by itself.
        codes = [e.code for e in evidence(base(late_sync_share=1.0, days_late_max=3, gait_sync_share=0.0))]
        self.assertEqual(codes, [])

    def test_context_carries_money_at_stake(self):
        res = Scorer(None).score(base(in_paid_challenge=1, entry_fee_exposure_kes=200.0, days_to_deadline=2,
                                      milestone_gap_before=5000))
        self.assertEqual(res["context"]["entry_fee_exposure_kes"], 200.0)
        self.assertEqual(res["context"]["days_to_deadline"], 2)


class ForestPartTests(SimpleTestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        train, cls.eval_days = generate_population(seed=3, honest_per_archetype=6, cheats_per_archetype=3,
                                                   history_days=21, eval_days=5)
        cls.payload = train_forest([d.features for d in train], n_trees=40, seed=3)

    def test_payload_round_trips_and_calibrates(self):
        model = AnomalyModel(self.payload, "test")
        q = self.payload["calibration"]["score_quantiles"]
        self.assertEqual(q, sorted(q))
        self.assertEqual(model.rarity(q[0] - 1), 0.0)
        self.assertEqual(model.rarity(q[-1] + 1), 1.0)
        scorer = Scorer(model)
        self.assertEqual(scorer.model_version, "evidence-v1+test")
        res = scorer.score(self.eval_days[0].features)
        self.assertIn("forest_rarity", res["context"])

    def test_feature_list_mismatch_is_rejected(self):
        bad = dict(self.payload, feature_names=["something_else"])
        with self.assertRaises(ValueError):
            AnomalyModel(bad, "bad")


class SyntheticRankingTests(SimpleTestCase):
    """Cheat scenarios must rank above the honest archetypes (synthetic data only)."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.summary = run_synthetic_evaluation(seed=11, honest_per_archetype=10, cheats_per_archetype=5, n_trees=60)

    def test_auc(self):
        self.assertGreaterEqual(self.summary["variants"]["combined"]["auc"], 0.95)

    def test_every_cheat_archetype_above_every_honest_archetype(self):
        arch = self.summary["variants"]["combined"]["archetypes"]
        honest_p90 = max(arch[a]["p90"] for a in HONEST)
        for cheat in CHEATS:
            self.assertGreater(arch[cheat]["median"], honest_p90, f"{cheat} vs honest p90 {honest_p90}")

    def test_honest_false_positive_rate_is_low(self):
        at = self.summary["variants"]["combined"]["at_0.7"]
        self.assertLessEqual(at["false_positive_rate"], 0.02)

    def test_forest_adds_to_evidence(self):
        v = self.summary["variants"]
        self.assertGreaterEqual(v["combined"]["at_0.7"]["recall"], v["evidence_only"]["at_0.7"]["recall"])
