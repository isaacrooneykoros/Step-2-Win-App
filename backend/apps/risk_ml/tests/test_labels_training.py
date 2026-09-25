"""Labels pipeline, HeldPayout ingestion guard, and offline training (refusal + success)."""

from datetime import date, timedelta
from io import StringIO
from types import SimpleNamespace
from unittest import mock

from django.contrib.auth import get_user_model
from django.core.management import call_command
from django.core.management.base import CommandError
from django.test import TestCase

from apps.risk_ml import labels as labels_mod
from apps.risk_ml.features import FEATURE_VERSION
from apps.risk_ml.models import Label, ModelArtifact, RiskScore, UserDayFeatures
from apps.risk_ml.scoring import score_days
from apps.risk_ml.synthetic import generate_population
from apps.risk_ml.training import (TrainingRefused, train_anomaly,
                                   train_supervised)
from apps.steps.models import FraudFlag

User = get_user_model()


def mkuser(i):
    # No password: skips the slow hasher (these users never log in).
    return User.objects.create(username=f"u{i}", email=f"u{i}@example.com", phone_number=f"2547130{i:05d}")


class LabelHarvestTests(TestCase):
    def setUp(self):
        self.user = mkuser(1)
        self.day = date(2026, 9, 1)

    def flag(self, action, day=None, reviewed=True):
        details = {"message": "x"}
        if action:
            details["admin_action"] = action
        return FraudFlag.objects.create(user=self.user, flag_type="step_velocity_spike", severity="high",
                                        date=day or self.day, details=details, reviewed=reviewed)

    def test_flag_actions_map_to_labels_idempotently(self):
        self.flag("ban")
        self.flag("dismiss", day=self.day + timedelta(days=1))
        self.flag("warn", day=self.day + timedelta(days=2))
        self.flag(None, reviewed=False)  # still open: ignored
        first = labels_mod.harvest_flag_labels()
        self.assertEqual(first["created"], 3)
        again = labels_mod.harvest_flag_labels()
        self.assertEqual((again["created"], again["updated"]), (0, 3))
        by_day = {lab.date_start: lab.label for lab in Label.objects.all()}
        self.assertEqual(by_day[self.day], "cheat")
        self.assertEqual(by_day[self.day + timedelta(days=1)], "honest")
        self.assertEqual(by_day[self.day + timedelta(days=2)], "unsure")
        self.assertTrue(all(lab.source == "admin_flag_action" for lab in Label.objects.all()))

    def test_resolution_priority_and_conflicts(self):
        d2 = self.day + timedelta(days=1)
        labels_mod.upsert_label(user_id=self.user.pk, date_start=self.day, date_end=self.day, label="cheat",
                                source="admin_flag_action", source_ref="flag:1")
        labels_mod.upsert_label(user_id=self.user.pk, date_start=self.day, date_end=self.day, label="honest",
                                source="admin_manual", source_ref="admin:9")  # direct review wins
        labels_mod.upsert_label(user_id=self.user.pk, date_start=d2, date_end=d2, label="cheat",
                                source="admin_flag_action", source_ref="flag:2")
        labels_mod.upsert_label(user_id=self.user.pk, date_start=d2, date_end=d2, label="honest",
                                source="admin_flag_action", source_ref="flag:3")  # same-source conflict
        labels_mod.upsert_label(user_id=self.user.pk, date_start=self.day, date_end=self.day + timedelta(days=4),
                                label="cheat", source="synthetic", source_ref="syn:1")
        resolved = labels_mod.resolve_day_labels()
        self.assertEqual(resolved[(self.user.pk, self.day)], "honest")
        self.assertNotIn((self.user.pk, d2), resolved)
        self.assertNotIn((self.user.pk, self.day + timedelta(days=3)), resolved)  # synthetic excluded
        with_syn = labels_mod.resolve_day_labels(include_synthetic=True)
        self.assertEqual(with_syn[(self.user.pk, self.day + timedelta(days=3))], "cheat")

    def test_held_payouts_are_a_noop_before_the_model_exists(self):
        # Phase 1a's HeldPayout is installed now; simulate a deployment without it.
        with mock.patch.object(labels_mod, "find_held_payout_model", return_value=None):
            self.assertEqual(labels_mod.harvest_held_payout_labels()["available"], False)

    def test_finds_the_installed_held_payout_model(self):
        from apps.challenges.models import HeldPayout

        self.assertIs(labels_mod.find_held_payout_model(), HeldPayout)

    def test_real_held_payouts_are_ingested(self):
        from decimal import Decimal

        from apps.challenges.models import Challenge, HeldPayout, Participant

        challenge = Challenge.objects.create(
            creator=self.user, name="Label week", entry_fee=Decimal("100.00"), milestone=10000,
            start_date=self.day, end_date=self.day + timedelta(days=6), status="completed",
            total_pool=Decimal("200.00"),
        )
        others = [mkuser(i) for i in (2, 3)]
        holds = {}
        for user, status in ((self.user, "released"), (others[0], "forfeited"), (others[1], "held")):
            p = Participant.objects.create(challenge=challenge, user=user, steps=20000)
            holds[status] = HeldPayout.objects.create(
                challenge=challenge, participant=p, user=user, amount=Decimal("90.00"),
                status=status, note=f"review note {status}",
            )
        out = labels_mod.harvest_held_payout_labels()
        self.assertTrue(out["available"])
        self.assertEqual((out["created"], out["skipped"]), (2, 1))
        rel = Label.objects.get(source_ref=f"heldpayout:{holds['released'].pk}")
        self.assertEqual((rel.label, rel.date_start, rel.date_end), ("honest", self.day, self.day + timedelta(days=6)))
        self.assertEqual(rel.notes, "review note released")
        self.assertEqual(Label.objects.get(source_ref=f"heldpayout:{holds['forfeited'].pk}").label, "cheat")
        self.assertFalse(Label.objects.filter(source_ref=f"heldpayout:{holds['held'].pk}").exists())

    def test_held_payouts_are_ingested_when_present(self):
        challenge = SimpleNamespace(start_date=self.day, end_date=self.day + timedelta(days=6))
        rows = [
            SimpleNamespace(pk=1, user_id=self.user.pk, status="released", challenge=challenge, review_note="ok"),
            SimpleNamespace(pk=2, user_id=self.user.pk, decision="forfeited", challenge=challenge),
            SimpleNamespace(pk=3, user_id=self.user.pk, status="pending", challenge=challenge),
        ]
        fake = SimpleNamespace(objects=SimpleNamespace(all=lambda: SimpleNamespace(iterator=lambda chunk_size: iter(rows))))
        with mock.patch.object(labels_mod, "find_held_payout_model", return_value=fake):
            out = labels_mod.harvest_held_payout_labels()
        self.assertEqual((out["created"], out["skipped"]), (2, 1))
        rel = Label.objects.get(source_ref="heldpayout:1")
        self.assertEqual((rel.label, rel.date_start, rel.date_end), ("honest", self.day, self.day + timedelta(days=6)))
        self.assertEqual(Label.objects.get(source_ref="heldpayout:2").label, "cheat")


class TrainingRefusalTests(TestCase):
    def test_supervised_refuses_without_labels(self):
        with self.assertRaises(TrainingRefused) as ctx:
            train_supervised()
        msg = str(ctx.exception)
        self.assertIn("0 labelled user-days", msg)
        self.assertIn("need at least 200", msg)
        self.assertFalse(ModelArtifact.objects.exists())

    def test_supervised_refuses_with_one_class(self):
        user = mkuser(2)
        for i in range(40):
            d = date(2026, 8, 1) + timedelta(days=i)
            UserDayFeatures.objects.create(user=user, date=d, feature_version=FEATURE_VERSION, features={"steps": 5000})
            Label.objects.create(user=user, date_start=d, date_end=d, label="honest", source="admin_manual",
                                 source_ref="admin:1")
        with self.assertRaises(TrainingRefused) as ctx:
            train_supervised(min_labels=10, min_per_class=5)
        self.assertIn("0 labelled cheat days", str(ctx.exception))

    def test_command_explains_refusal(self):
        with self.assertRaises(CommandError) as ctx:
            call_command("risk_ml_train_supervised", stdout=StringIO())
        self.assertIn("Refused", str(ctx.exception))
        with self.assertRaises(CommandError):
            call_command("risk_ml_train_anomaly", stdout=StringIO())

    def test_synthetic_labels_do_not_count(self):
        user = mkuser(3)
        for i in range(300):
            d = date(2026, 1, 1) + timedelta(days=i)
            UserDayFeatures.objects.create(user=user, date=d, feature_version=FEATURE_VERSION, features={"steps": i})
            Label.objects.create(user=user, date_start=d, date_end=d, label="cheat" if i % 2 else "honest",
                                 source="synthetic", source_ref=f"syn:{i}")
        with self.assertRaises(TrainingRefused):
            train_supervised()


class TrainingSuccessTests(TestCase):
    """Uses synthetic feature rows stored for fake users; labels are 'admin_manual' in the test DB."""

    @classmethod
    def setUpTestData(cls):
        train, evaluation = generate_population(seed=5, honest_per_archetype=3, cheats_per_archetype=2,
                                                history_days=14, eval_days=7)
        users = {}
        rows, cls.n_rows = [], 0
        for i, d in enumerate(train + evaluation):
            u = users.get(d.user.uid)
            if u is None:
                u = users[d.user.uid] = mkuser(100 + d.user.uid)
            rows.append(UserDayFeatures(user=u, date=d.day, feature_version=FEATURE_VERSION, features=d.features,
                                        steps=d.features["steps"]))
        UserDayFeatures.objects.bulk_create(rows)
        cls.n_rows = len(rows)
        cls.evaluation = [(users[d.user.uid], d) for d in evaluation]
        cls.train = [(users[d.user.uid], d) for d in train]

    def _label_all(self):
        for u, d in self.train + self.evaluation:
            Label.objects.create(user=u, date_start=d.day, date_end=d.day,
                                 label="cheat" if d.is_cheat_day else "honest",
                                 source="admin_manual", source_ref="admin:test")

    def test_anomaly_training_pure_python_and_activation(self):
        art = train_anomaly(days=10000, n_trees=20, max_samples=64, min_rows=50, use_sklearn=False, activate=True)
        self.assertTrue(art.is_active)
        self.assertEqual(art.payload["training_rows"], self.n_rows)
        self.assertIn("Known biases", art.model_card)
        days = sorted({d.day for _, d in self.evaluation})
        out = score_days(days[0], days[-1])
        self.assertTrue(out["model_version"].startswith("evidence-v1+iforest-"))
        self.assertTrue(RiskScore.objects.filter(model_version=out["model_version"]).exists())

    def test_supervised_training_with_enough_labels(self):
        self._label_all()
        art = train_supervised(min_labels=100, min_per_class=10, use_sklearn=False, threshold=0.8)
        m = art.metrics
        self.assertGreater(m["test_rows"], 0)
        self.assertGreater(m["test_positive"], 0)
        self.assertIsNotNone(m["auc"])
        self.assertIn("honest_user_fpr_at_hold", m)
        self.assertIn("Known biases", art.model_card)
        self.assertIn("time split at", art.model_card)
        self.assertEqual(art.trained_on, "real")
        self.assertFalse(art.is_active)
        # Time-based split: every training day precedes every test day.
        self.assertTrue(m["split_date"])

    def test_synthetic_model_cannot_be_activated(self):
        for u, d in self.train + self.evaluation:
            Label.objects.create(user=u, date_start=d.day, date_end=d.day,
                                 label="cheat" if d.is_cheat_day else "honest",
                                 source="synthetic", source_ref="syn")
        art = train_supervised(min_labels=100, min_per_class=10, include_synthetic=True, use_sklearn=False)
        self.assertEqual(art.trained_on, "synthetic")
        self.assertIn("NOT FOR PRODUCTION", art.model_card)
        with self.assertRaises(CommandError):
            call_command("risk_ml_artifacts", activate=art.version, stdout=StringIO())
        art.refresh_from_db()
        self.assertFalse(art.is_active)


