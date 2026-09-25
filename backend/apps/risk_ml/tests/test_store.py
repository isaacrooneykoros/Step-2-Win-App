"""Feature store from the database: known rows -> known features, idempotent recompute,
nightly pipeline, account-deletion cleanup, and no side effects on steps/trust/money."""

from datetime import datetime, timedelta, timezone as dt_timezone
from decimal import Decimal

from django.conf import settings
from django.contrib.auth import get_user_model
from django.test import TestCase

from apps.challenges.models import Challenge, Participant
from apps.payments.models import PaymentTransaction
from apps.risk_ml.feature_store import (compute_features, local_today,
                                        normalize_phone)
from apps.risk_ml.features import FEATURE_VERSION
from apps.risk_ml.models import Label, RiskScore, UserDayFeatures
from apps.risk_ml.pipeline import compute_features_and_scores
from apps.risk_ml.scoring import score_days
from apps.steps.models import (DeviceRegistration, HealthRecord,
                               HourlyStepRecord, LocationWaypoint,
                               StepSyncEvent, TrustScore)

User = get_user_model()


def local_dt(day, hour, minute=0):
    return datetime(day.year, day.month, day.day, tzinfo=dt_timezone.utc) + timedelta(hours=hour - 3, minutes=minute)


class FeatureStoreTests(TestCase):
    def setUp(self):
        self.day = local_today() - timedelta(days=1)
        self.alice = User.objects.create_user(username="alice", email="a@example.com", phone_number="254712000001",
                                              password="pass12345!")
        self.bob = User.objects.create_user(username="bob", email="b@example.com", phone_number="254712000002",
                                            password="pass12345!")
        for i in range(1, 11):
            HealthRecord.objects.create(user=self.alice, date=self.day - timedelta(days=i), steps=5000,
                                        source="device_sensor")
        HealthRecord.objects.create(user=self.alice, date=self.day, steps=17000, source="device_sensor")
        HealthRecord.objects.create(user=self.bob, date=self.day, steps=3000, source="device_sensor")
        for hour, steps in ((1, 5000), (2, 5000), (3, 5000), (9, 2000)):
            HourlyStepRecord.objects.create(user=self.alice, date=self.day, hour=hour, steps=steps)
        for n, (hour, conf, shake) in enumerate(((2, 0.3, 0.8), (3, 0.4, 0.6), (10, None, None))):
            payload = {"date": self.day.isoformat(), "steps": 10000 + n, "session_token": "SECRET"}
            if conf is not None:
                payload.update(gait_confidence=conf, cadence_spm=190.0, burst_steps_5s=40, carry_mode="in_hand")
            ev = StepSyncEvent.objects.create(user=self.alice, client_event_id=f"e{n}", payload_hash=f"h{n}",
                                              raw_steps_total=payload["steps"], ml_shake_probability=shake,
                                              raw_payload=payload)
            StepSyncEvent.objects.filter(pk=ev.pk).update(created_at=local_dt(self.day, hour, 30))
        lat = -1.28
        for i in range(21):  # 0.7 km walk at 09:00
            LocationWaypoint.objects.create(user=self.alice, date=self.day, hour=9,
                                            recorded_at=local_dt(self.day, 9) + timedelta(seconds=30 * i),
                                            latitude=lat, longitude=36.8, accuracy_m=8)
            lat += 0.035 / 111.0
        for user in (self.alice, self.bob):  # one phone, two accounts
            DeviceRegistration.objects.create(user=user, device_id="android-shared-1", platform="android")
        PaymentTransaction.objects.create(user=self.bob, type="deposit", amount_kes=Decimal("100"),
                                          order_id="o-1", phone_number="0712000001", narration="deposit")
        creator = User.objects.create_user(username="creator", email="c@example.com", phone_number="254799000001",
                                           password="pass12345!")
        challenge = Challenge.objects.create(creator=creator, name="Week", entry_fee=Decimal("150.00"),
                                             milestone=30000, start_date=self.day - timedelta(days=5),
                                             end_date=self.day + timedelta(days=1), status="active")
        Participant.objects.create(challenge=challenge, user=self.alice)

    def features(self, user):
        return UserDayFeatures.objects.get(user=user, date=self.day, feature_version=FEATURE_VERSION).features

    def test_known_inputs_produce_known_features(self):
        out = compute_features(self.day, self.day)
        self.assertEqual(out["rows"], 2)
        f = self.features(self.alice)
        self.assertEqual(f["steps"], 17000)
        self.assertEqual(f["user_median_steps"], 5000.0)
        self.assertAlmostEqual(f["steps_ratio_to_median"], 3.4)
        self.assertEqual(f["hourly_total"], 17000)
        self.assertAlmostEqual(f["night_share"], 15000 / 17000, places=3)
        self.assertEqual(f["sync_count"], 3)
        self.assertEqual(f["gait_sync_count"], 2)
        self.assertAlmostEqual(f["gait_conf_mean"], 0.35)
        self.assertAlmostEqual(f["shake_prob_mean"], 0.7)
        self.assertEqual(f["burst_max"], 40.0)
        self.assertEqual(f["steps_raw_max"], 10002)
        self.assertEqual(f["waypoint_count"], 21)
        self.assertAlmostEqual(f["route_km"], 0.7, places=2)
        self.assertAlmostEqual(f["route_km_per_1k_steps"], 0.35, places=2)  # 0.7 km for the 2,000 steps at 09:00
        self.assertEqual(f["devices_per_account"], 1)
        self.assertEqual(f["max_accounts_per_device"], 2)
        self.assertEqual(f["mpesa_shared_accounts"], 1)  # bob paid from alice's number
        self.assertEqual(f["in_paid_challenge"], 1)
        self.assertEqual(f["entry_fee_exposure_kes"], 150.0)
        self.assertEqual(f["days_to_deadline"], 1)
        self.assertEqual(f["milestone_gap_before"], 30000 - 5 * 5000)
        self.assertEqual(f["crossed_milestone_today"], 1)
        self.assertGreaterEqual(f["account_age_days"], 0.0)
        row = UserDayFeatures.objects.get(user=self.alice, date=self.day)
        self.assertEqual(row.steps, 17000)
        self.assertTrue(row.in_paid_challenge)
        # Privacy: no coordinates, tokens or phone numbers in the stored features.
        blob = str(f)
        for secret in ("-1.28", "36.8", "SECRET", "0712000001", "254712000001"):
            self.assertNotIn(secret, blob)

    def test_bob_sees_the_shared_phone_and_number(self):
        compute_features(self.day, self.day)
        f = self.features(self.bob)
        self.assertEqual(f["max_accounts_per_device"], 2)
        self.assertEqual(f["mpesa_shared_accounts"], 1)
        self.assertIsNone(f["steps_ratio_to_median"])  # no baseline yet

    def test_recompute_is_idempotent_and_incremental(self):
        compute_features(self.day, self.day)
        first = {r.pk: r.features for r in UserDayFeatures.objects.all()}
        again = compute_features(self.day, self.day)
        self.assertEqual(again["created"], 0)
        self.assertEqual({r.pk: r.features for r in UserDayFeatures.objects.all()}, first)
        # A late sync for the same day changes the row in place.
        HealthRecord.objects.filter(user=self.bob, date=self.day).update(steps=4000)
        compute_features(self.day, self.day)
        self.assertEqual(UserDayFeatures.objects.count(), 2)
        self.assertEqual(self.features(self.bob)["steps"], 4000)

    def test_scores_are_idempotent(self):
        compute_features(self.day, self.day)
        score_days(self.day, self.day)
        score_days(self.day, self.day)
        self.assertEqual(RiskScore.objects.count(), 2)
        alice = RiskScore.objects.get(user=self.alice)
        bob = RiskScore.objects.get(user=self.bob)
        self.assertGreater(alice.score, bob.score)
        joined = " | ".join(e["text"] for e in alice.explanations)
        self.assertIn("3.4x your usual daily steps", joined)
        self.assertIn("between 1 and 4 AM", joined)
        self.assertEqual(alice.model_version, "evidence-v1")

    def test_pipeline_runs_twice_without_side_effects(self):
        TrustScore.objects.create(user=self.alice, score=90)
        before_hr = list(HealthRecord.objects.order_by("pk").values_list("steps", "is_suspicious"))
        before_part = list(Participant.objects.values_list("steps", "qualified", "payout"))
        before_wallet = list(User.objects.order_by("pk").values_list("wallet_balance", "locked_balance"))
        s1 = compute_features_and_scores(days=3, today=self.day + timedelta(days=1))
        s2 = compute_features_and_scores(days=3, today=self.day + timedelta(days=1))
        self.assertEqual(s1["features"]["rows"], s2["features"]["rows"])
        self.assertEqual(RiskScore.objects.filter(date=self.day).count(), 2)
        self.assertEqual(list(HealthRecord.objects.order_by("pk").values_list("steps", "is_suspicious")), before_hr)
        self.assertEqual(list(Participant.objects.values_list("steps", "qualified", "payout")), before_part)
        self.assertEqual(list(User.objects.order_by("pk").values_list("wallet_balance", "locked_balance")),
                         before_wallet)
        self.assertEqual(TrustScore.objects.get(user=self.alice).score, 90)

    def test_deleted_accounts_are_skipped(self):
        User.objects.filter(pk=self.bob.pk).update(deleted_at=local_dt(self.day, 12))
        compute_features(self.day, self.day)
        self.assertFalse(UserDayFeatures.objects.filter(user=self.bob).exists())

    def test_normalize_phone(self):
        for raw in ("254712000001", "+254712000001", "0712000001", "712000001", "254 712 000 001"):
            self.assertEqual(normalize_phone(raw), "712000001")
        self.assertIsNone(normalize_phone("del_12"))

    def test_beat_schedule_entry(self):
        entry = settings.CELERY_BEAT_SCHEDULE["risk-ml-features-and-scores"]
        self.assertEqual(entry["task"], "apps.risk_ml.tasks.compute_features_and_scores_task")
        self.assertEqual(entry["kwargs"], {"days": 3})
        from apps.risk_ml.tasks import compute_features_and_scores_task

        self.assertTrue(callable(compute_features_and_scores_task))


class AccountDeletionCleanupTests(TestCase):
    def test_anonymising_an_account_drops_features_and_scores(self):
        from apps.users.account_deletion import delete_account

        day = local_today() - timedelta(days=1)
        user = User.objects.create_user(username="leaver", email="l@example.com", phone_number="254712000099",
                                        password="pass12345!")
        other = User.objects.create_user(username="stayer", email="s@example.com", phone_number="254712000098",
                                         password="pass12345!")
        for u in (user, other):
            HealthRecord.objects.create(user=u, date=day, steps=6000, source="device_sensor")
        compute_features(day, day)
        score_days(day, day)
        Label.objects.create(user=user, date_start=day, date_end=day, label="honest", source="admin_manual",
                             source_ref="admin:1", notes="called the user, lives near the office")
        self.assertEqual(UserDayFeatures.objects.filter(user=user).count(), 1)

        delete_account(user)

        self.assertFalse(UserDayFeatures.objects.filter(user=user).exists())
        self.assertFalse(RiskScore.objects.filter(user=user).exists())
        self.assertEqual(Label.objects.get(user=user).notes, "")  # label kept, free text scrubbed
        self.assertTrue(UserDayFeatures.objects.filter(user=other).exists())
        self.assertTrue(RiskScore.objects.filter(user=other).exists())
