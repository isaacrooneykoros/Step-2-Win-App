"""
Anti-cheat Phase 0: stop hurting honest users without making cheating easier.

Every test here encodes a behaviour that was wrong before Phase 0 (and fails on the
old code) or an adversarial case that must keep failing for cheaters.
See backend/ANTICHEAT.md for the rule table.
"""

import importlib
import uuid
from datetime import datetime, time, timedelta
from datetime import timezone as dt_timezone
from unittest.mock import patch

from django.apps import apps as django_apps
from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.test import TestCase, override_settings
from django.utils import timezone
from rest_framework.test import APITestCase
from rest_framework_simplejwt.tokens import RefreshToken

from apps.steps.anti_cheat import (DAILY_STEP_CAP, TRUST_SYNC_FLOOR,
                                   assess_velocity, cap_trust_deduction,
                                   compute_baseline_context, resolve_source_key,
                                   run_anti_cheat)
from apps.steps.models import (DeviceRegistration, FraudFlag, HealthRecord,
                               HourlyStepRecord, LocationWaypoint, StepSession,
                               StepSyncEvent, TrustScore)

User = get_user_model()

HONEST_GAIT = {
    "cadence_spm": 112,
    "burst_steps_5s": 9,
    "gait_state": "confirmed_walking",
    "gait_confidence": 86,
    "gait_dominant_freq_hz": 1.8,
    "gait_autocorr": 0.72,
    "gait_interval_std_ms": 60,
    "gait_valid_peaks_2s": 5,
    "gait_gyro_variance": 0.8,
    "gait_jerk_rms": 4.0,
    "carry_mode": "pocket",
    "ml_motion_label": "walk",
    "ml_walk_probability": 0.91,
    "ml_shake_probability": 0.04,
    "ml_model_version": "shakewalk-logreg-v1",
}

# The app opened while sitting: the 3-second window saw no walking.
RESTING_SNAPSHOT = {
    "cadence_spm": 0,
    "burst_steps_5s": 0,
    "gait_state": "idle",
    "gait_confidence": 4,
    "gait_dominant_freq_hz": 0.2,
    "gait_autocorr": 0.05,
    "gait_interval_std_ms": 900,
    "gait_valid_peaks_2s": 0,
    "gait_gyro_variance": 0.01,
    "gait_jerk_rms": 0.3,
    "carry_mode": "unknown",
    "ml_motion_label": "other",
    "ml_walk_probability": 0.2,
    "ml_shake_probability": 0.05,
    "ml_model_version": "shakewalk-logreg-v1",
}

# A phone on a shaker / in the hand being shaken.
SHAKER_GAIT = {
    "cadence_spm": 150,
    "burst_steps_5s": 14,
    "gait_state": "suspicious_motion",
    "gait_confidence": 30,
    "gait_dominant_freq_hz": 4.5,
    "gait_autocorr": 0.9,
    "gait_interval_std_ms": 20,
    "gait_valid_peaks_2s": 8,
    "gait_gyro_variance": 6.0,
    "gait_jerk_rms": 25.0,
    "carry_mode": "in_hand",
    "ml_motion_label": "shake",
    "ml_walk_probability": 0.1,
    "ml_shake_probability": 0.93,
    "ml_model_version": "shakewalk-logreg-v1",
}

NULL_GAIT = {key: None for key in HONEST_GAIT}


class Phase0SyncBase(APITestCase):
    platform = "android"

    def setUp(self):
        cache.clear()
        self.user = User.objects.create_user(
            username=f"p0_{uuid.uuid4().hex[:8]}",
            email=f"p0_{uuid.uuid4().hex[:8]}@example.com",
            password="TestPass123!",
            device_id="p0-device",
            device_platform=self.platform,
        )
        self.client.credentials(
            HTTP_AUTHORIZATION=f"Bearer {RefreshToken.for_user(self.user).access_token}"
        )
        tick = patch("apps.steps.views._allow_sync_tick", return_value=True)
        tick.start()
        self.addCleanup(tick.stop)
        response = self.client.post(
            "/api/steps/session/start/",
            {
                "device_id": "p0-device",
                "platform": self.platform,
                "app_version": "1.0.0",
                "ml_model_version": "shakewalk-logreg-v1",
            },
            format="json",
        )
        self.assertIn(response.status_code, (200, 201), response.content)
        self.session = response.json()
        self.sequence = self.session["sequence_start"]

    def payload(self, steps, *, day=None, gait=None, ts=None, **extra):
        body = {
            "date": str(day or timezone.now().date()),
            "source": "device_sensor",
            "steps": steps,
            "distance_km": round(steps * 0.00078, 2),
            "active_minutes": max(1, round(steps / 120)),
            "calories_active": max(1, round(steps * 0.04)),
            "steps_total": steps,
            "session_id": self.session["session_id"],
            "session_token": self.session["session_token"],
            "client_event_id": str(uuid.uuid4()),
            "sequence_number": self.sequence,
            "timestamp_client": (ts or timezone.now()).isoformat(),
        }
        body.update(HONEST_GAIT if gait is None else gait)
        body.update(extra)
        self.sequence += 1
        return body

    def sync(self, steps, **kwargs):
        return self.client.post(
            "/api/steps/sync/", self.payload(steps, **kwargs), format="json"
        )

    def record(self, day=None):
        return HealthRecord.objects.get(user=self.user, date=day or timezone.now().date())

    def age_record(self, seconds, day=None):
        """Pretend the last accepted sync of the day happened `seconds` ago."""
        HealthRecord.objects.filter(
            user=self.user, date=day or timezone.now().date()
        ).update(
            synced_at=timezone.now() - timedelta(seconds=seconds),
            last_client_timestamp=timezone.now() - timedelta(seconds=seconds),
        )

    def yesterday(self):
        return timezone.now().date() - timedelta(days=1)


# ── Fix 1: full credit for trustworthy input ─────────────────────────────────


class FullCreditTests(Phase0SyncBase):
    def test_clean_honest_android_sync_stores_exactly_the_submitted_steps(self):
        day = self.yesterday()
        response = self.sync(8_432, day=day)
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()["approved_steps"], 8_432)
        record = self.record(day)
        self.assertEqual(record.steps, 8_432)
        self.assertEqual(record.last_raw_steps, 8_432)
        self.assertFalse(record.is_suspicious)
        self.assertEqual(FraudFlag.objects.filter(user=self.user).count(), 0)

    def test_successive_clean_syncs_accumulate_exactly(self):
        day = self.yesterday()
        self.assertEqual(self.sync(5_000, day=day).status_code, 200)
        self.age_record(20 * 60, day)
        self.assertEqual(self.sync(6_900, day=day).status_code, 200)
        self.age_record(20 * 60, day)
        self.assertEqual(self.sync(9_250, day=day).status_code, 200)
        self.assertEqual(self.record(day).steps, 9_250)

    def test_client_source_label_cannot_raise_confidence(self):
        day = self.yesterday()
        # "manual" is a worse source: the label may lower credit ...
        response = self.sync(5_000, day=day, source="manual")
        self.assertEqual(response.status_code, 200, response.content)
        self.assertLess(self.record(day).steps, 5_000)

    def test_source_key_comes_from_server_knowledge(self):
        android = DeviceRegistration.objects.create(
            user=self.user, device_id="x-android", platform="android"
        )
        session = StepSession(user=self.user, device=android)
        self.assertEqual(resolve_source_key(session=session, user=self.user), "phone_sensor_session")
        web = DeviceRegistration.objects.create(user=self.user, device_id="x-web", platform="web")
        self.assertEqual(
            resolve_source_key(session=StepSession(user=self.user, device=web), user=self.user),
            "web",
        )
        self.assertEqual(resolve_source_key(session=None, user=self.user), "phone_unsessioned")
        self.user.device_platform = "web"
        self.assertEqual(resolve_source_key(session=None, user=self.user), "web")

    def test_real_risk_still_reduces_credit(self):
        # Two corroborating HIGH "not walking" signals + mediums on a walking window.
        day = self.yesterday()
        risky = dict(HONEST_GAIT)
        risky.update(
            {
                "gait_state": "possible_walking",
                "gait_confidence": 10,
                "gait_interval_std_ms": 500,
                "gait_autocorr": 0.1,
                "gait_valid_peaks_2s": 1,
                "ml_walk_probability": 0.3,
            }
        )
        self.assertEqual(self.sync(6_000, day=day, gait=risky).status_code, 200)
        self.assertLess(self.record(day).steps, 6_000)


class IosFullCreditTests(Phase0SyncBase):
    platform = "ios"

    def test_ios_sync_with_null_gait_stores_exactly_the_submitted_steps(self):
        day = self.yesterday()
        response = self.sync(7_777, day=day, gait=NULL_GAIT, source="apple_health")
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(self.record(day).steps, 7_777)


# ── Fix 2: velocity raw vs raw, first-sync bound, unverified excess ─────────────


class VelocityTests(Phase0SyncBase):
    def test_raw_vs_raw_no_false_spike_on_a_busy_day(self):
        # Old code compared against the ~75% discounted stored total: 15k raw stored as
        # ~11.2k made a 10-minute +1,500 look like +5.3k -> 400 + HIGH flag.
        day = self.yesterday()
        self.assertEqual(self.sync(15_000, day=day).status_code, 200)
        self.age_record(10 * 60, day)
        response = self.sync(16_500, day=day)
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(self.record(day).steps, 16_500)
        self.assertFalse(
            FraudFlag.objects.filter(user=self.user, flag_type="step_velocity_spike").exists()
        )

    def test_borderline_excess_is_unverified_not_rejected_and_credited_later(self):
        day = self.yesterday()
        self.assertEqual(self.sync(10_000, day=day).status_code, 200)
        self.age_record(5 * 60, day)  # 5 min: plausible +4*300+600 = +1,800
        response = self.sync(13_000, day=day)
        self.assertEqual(response.status_code, 200, response.content)
        record = self.record(day)
        self.assertEqual(record.steps, 11_800)
        self.assertEqual(record.unverified_steps, 1_200)
        self.assertEqual(record.last_raw_steps, 13_000)
        self.assertFalse(FraudFlag.objects.filter(user=self.user).exists())
        # Time passes: the deferred steps become plausible and are credited.
        self.age_record(30 * 60, day)
        self.assertEqual(self.sync(13_100, day=day).status_code, 200)
        record = self.record(day)
        self.assertEqual(record.steps, 13_100)
        self.assertEqual(record.unverified_steps, 0)

    def test_clearly_impossible_jump_is_rejected_and_flagged(self):
        day = self.yesterday()
        self.assertEqual(self.sync(2_000, day=day).status_code, 200)
        self.age_record(60, day)  # +30,000 in one minute
        response = self.sync(32_000, day=day)
        self.assertEqual(response.status_code, 400)
        flag = FraudFlag.objects.get(user=self.user, flag_type="step_velocity_spike")
        self.assertEqual(flag.severity, "high")
        self.assertEqual(self.record(day).steps, 2_000)

    def test_first_sync_of_the_day_is_bounded_by_time_since_local_midnight(self):
        # 00:30 in Nairobi (21:30 UTC the day before); the phone claims 60,000 steps.
        day = timezone.now().date()
        fake_now = datetime.combine(day - timedelta(days=1), time(21, 30), tzinfo=dt_timezone.utc)
        with patch("django.utils.timezone.now", return_value=fake_now):
            response = self.sync(60_000, day=day, ts=fake_now)
        self.assertEqual(response.status_code, 200, response.content)
        record = self.record(day)
        # 2.5 h (with 2 h time-zone tolerance) * 4 steps/s + 2,000 headroom.
        self.assertEqual(record.steps, int(2.5 * 3600 * 4) + 2_000)
        self.assertEqual(record.unverified_steps, 60_000 - record.steps)

    def test_first_sync_bound_unit(self):
        day = timezone.now().date()
        at = datetime.combine(day, time(3, 0), tzinfo=dt_timezone.utc)  # 06:00 EAT
        result = assess_velocity(
            day=day, now=at, submitted=200_000, prev_raw=0, prev_unverified=0,
            last_synced_at=None, last_client_ts=None, client_ts=at,
        )
        self.assertEqual(result.plausible_raw, 8 * 3600 * 4 + 2_000)
        self.assertFalse(result.impossible)

    def test_reinstall_lower_total_still_rejected(self):
        day = self.yesterday()
        self.assertEqual(self.sync(4_000, day=day).status_code, 200)
        response = self.sync(1_000, day=day)
        self.assertEqual(response.status_code, 400)
        self.assertTrue(
            FraudFlag.objects.filter(user=self.user, flag_type="non_monotonic_steps").exists()
        )


# ── Fix 3: suspicion only on strong evidence, sticky per day ──────────────────


class SuspicionTests(Phase0SyncBase):
    def test_walk_credit_rule_never_creates_flags_or_suspicion(self):
        day = self.yesterday()
        self.assertEqual(self.sync(9_000, day=day).status_code, 200)  # ml_walk 0.91
        self.assertFalse(
            FraudFlag.objects.filter(user=self.user, flag_type="ml_walk_high_probability").exists()
        )
        self.assertFalse(self.record(day).is_suspicious)

    def test_single_medium_hit_does_not_exclude_the_day(self):
        day = self.yesterday()
        gait = dict(HONEST_GAIT, gait_dominant_freq_hz=3.4)  # out of band: MEDIUM
        self.assertEqual(self.sync(6_000, day=day, gait=gait).status_code, 200)
        record = self.record(day)
        self.assertFalse(record.is_suspicious)
        self.assertEqual(record.steps, 6_000)
        self.assertFalse(FraudFlag.objects.filter(user=self.user).exists())

    def test_strong_evidence_is_sticky_until_an_admin_clears_it(self):
        day = self.yesterday()
        self.assertEqual(self.sync(3_000, day=day, gait=SHAKER_GAIT).status_code, 200)
        record = self.record(day)
        self.assertTrue(record.is_suspicious)
        first_event = record.anticheat["suspicion"]["sync_events"][0]
        self.assertTrue(StepSyncEvent.objects.filter(id=first_event).exists())

        self.age_record(15 * 60, day)
        self.assertEqual(self.sync(4_000, day=day).status_code, 200)  # clean
        self.assertTrue(self.record(day).is_suspicious)

        # Admin clears the day: later clean syncs keep it clear.
        HealthRecord.objects.filter(user=self.user, date=day).update(is_suspicious=False)
        self.age_record(15 * 60, day)
        self.assertEqual(self.sync(4_500, day=day).status_code, 200)
        self.assertFalse(self.record(day).is_suspicious)

    def test_day_flagged_by_the_old_engine_is_re_decided(self):
        day = self.yesterday()
        HealthRecord.objects.create(
            user=self.user, date=day, steps=3_740, is_suspicious=True,
            source="device_sensor",
        )
        response = self.sync(5_200, day=day)
        self.assertEqual(response.status_code, 200, response.content)
        record = self.record(day)
        self.assertFalse(record.is_suspicious)
        self.assertEqual(record.steps, 5_200)  # the old 25% discount is gone too

    def test_old_day_flagged_on_strong_evidence_is_not_laundered(self):
        day = self.yesterday()
        HealthRecord.objects.create(
            user=self.user, date=day, steps=3_000, is_suspicious=True,
            source="device_sensor",
        )
        FraudFlag.objects.create(
            user=self.user, date=day, flag_type="ml_shake_high_probability",
            severity="high", details={},
        )
        self.assertEqual(self.sync(5_000, day=day).status_code, 200)  # clean snapshot
        self.assertTrue(self.record(day).is_suspicious)
        self.age_record(15 * 60, day)
        self.assertEqual(self.sync(5_500, day=day).status_code, 200)
        self.assertTrue(self.record(day).is_suspicious)


# ── Fix 4: resting snapshot is neutral; shake detection stays effective ─────────


class GaitSnapshotTests(Phase0SyncBase):
    def test_app_opened_while_sitting_is_not_penalised(self):
        day = self.yesterday()
        response = self.sync(6_500, day=day, gait=RESTING_SNAPSHOT)
        self.assertEqual(response.status_code, 200, response.content)
        record = self.record(day)
        self.assertEqual(record.steps, 6_500)
        self.assertFalse(record.is_suspicious)
        self.assertFalse(FraudFlag.objects.filter(user=self.user).exists())
        self.assertEqual(TrustScore.objects.get(user=self.user).score, 100)
        self.assertEqual(record.anticheat["gait_coverage"]["rest_snapshot_steps"], 6_500)

    def test_trivial_delta_with_walking_window_is_neutral(self):
        day = self.yesterday()
        self.assertEqual(self.sync(5_000, day=day).status_code, 200)
        self.age_record(60, day)
        weak = dict(HONEST_GAIT, gait_state="possible_walking", gait_confidence=12)
        self.assertEqual(self.sync(5_040, day=day, gait=weak).status_code, 200)
        self.assertFalse(FraudFlag.objects.filter(user=self.user).exists())

    def test_no_walking_while_steps_are_counted_is_still_evidence(self):
        day = self.yesterday()
        weak = dict(
            HONEST_GAIT, gait_state="possible_walking", gait_confidence=12,
            gait_interval_std_ms=400,
        )
        self.assertEqual(self.sync(4_000, day=day, gait=weak).status_code, 200)
        types = set(FraudFlag.objects.filter(user=self.user).values_list("flag_type", flat=True))
        self.assertIn("gait_confidence_very_low", types)
        self.assertIn("gait_interval_variability_high", types)
        self.assertTrue(self.record(day).is_suspicious)  # two corroborating HIGH rules

    def test_shake_detection_applies_even_with_a_resting_state(self):
        day = self.yesterday()
        sneaky = dict(RESTING_SNAPSHOT, ml_shake_probability=0.92)
        self.assertEqual(self.sync(3_000, day=day, gait=sneaky).status_code, 200)
        self.assertTrue(self.record(day).is_suspicious)


# ── Fix 5: bursts only from live timed events ─────────────────────────────────


class BurstTests(Phase0SyncBase):
    def test_batched_burst_is_neutral(self):
        day = self.yesterday()
        self.assertEqual(self.sync(5_000, day=day, burst_steps_5s=40).status_code, 200)
        self.assertFalse(FraudFlag.objects.filter(user=self.user).exists())
        self.assertEqual(self.record(day).steps, 5_000)

    def test_live_timed_impossible_burst_is_still_flagged(self):
        day = self.yesterday()
        response = self.sync(5_000, day=day, burst_steps_5s=40, burst_source="live_timed")
        self.assertEqual(response.status_code, 200)
        self.assertTrue(
            FraudFlag.objects.filter(user=self.user, flag_type="burst_impossible").exists()
        )


# ── Fix 6: late sync alone never excludes a day ───────────────────────────────


class LateSyncTests(Phase0SyncBase):
    def test_offline_catch_up_is_credited_in_full(self):
        day = timezone.now().date() - timedelta(days=5)
        response = self.sync(7_300, day=day)
        self.assertEqual(response.status_code, 200, response.content)
        record = self.record(day)
        self.assertFalse(record.is_suspicious)
        self.assertEqual(record.steps, 7_300)
        self.assertFalse(FraudFlag.objects.filter(user=self.user, flag_type="late_sync").exists())


# ── Fix 7: baseline ────────────────────────────────────────────────────────────


class BaselineTests(Phase0SyncBase):
    def _history(self, recent_raw, old_raw):
        today = timezone.now().date()
        # Natural day-to-day variation (offsets sum to zero over the 7 recent days).
        for i in range(1, 8):
            raw = recent_raw + (i - 4) * 300
            HealthRecord.objects.create(
                user=self.user, date=today - timedelta(days=i),
                steps=int(raw * 0.75), last_raw_steps=raw,
            )
        for i in range(15, 30):
            HealthRecord.objects.create(
                user=self.user, date=today - timedelta(days=i),
                steps=old_raw + (i % 5) * 400,
            )

    def test_baseline_uses_most_recent_days_raw_totals(self):
        self._history(recent_raw=5_000, old_raw=20_000)
        baseline = compute_baseline_context(self.user, timezone.now().date())
        self.assertEqual(baseline.avg_7d, 5_000.0)

    def test_big_but_plausible_day_is_medium_at_most(self):
        self._history(recent_raw=5_000, old_raw=5_000)
        day = timezone.now().date()
        # 28k hike for a 5k/day walker. Evaluate like a past day would (no velocity cap):
        result = run_anti_cheat(
            user=self.user, steps=28_000, date=day, active_minutes=233,
            source_platform="phone_sensor_session", **HONEST_GAIT
        )
        self.assertTrue(
            all(flag["severity"] in ("medium", "low") for flag in result.flags), result.flags
        )
        self.assertFalse(result.strong_evidence)
        self.assertEqual(result.approved_steps, 28_000)

    def test_huge_ratio_is_medium_not_high(self):
        self._history(recent_raw=2_000, old_raw=2_000)
        result = run_anti_cheat(
            user=self.user, steps=45_000, date=timezone.now().date(),
            active_minutes=375, **HONEST_GAIT
        )
        baseline_flags = [f for f in result.flags if f["flag_type"].startswith("baseline")]
        self.assertTrue(baseline_flags)
        self.assertTrue(all(f["severity"] == "medium" for f in baseline_flags))
        self.assertFalse(result.strong_evidence)


# ── Fix 8: volume ──────────────────────────────────────────────────────────────


class VolumeTests(Phase0SyncBase):
    def test_above_daily_cap_is_capped_not_wiped(self):
        day = self.yesterday()
        response = self.sync(65_000, day=day)
        self.assertEqual(response.status_code, 200, response.content)
        record = self.record(day)
        self.assertEqual(record.steps, DAILY_STEP_CAP)
        self.assertFalse(record.is_suspicious)
        self.assertEqual(record.anticheat["over_cap_steps"], 5_000)
        self.assertEqual(TrustScore.objects.get(user=self.user).score, 100)


# ── Fix 9: trust deductions ────────────────────────────────────────────────────


class TrustDeductionTests(Phase0SyncBase):
    def test_one_bad_day_costs_at_most_one_high_equivalent(self):
        day = self.yesterday()
        steps = 1_000
        for _ in range(6):
            steps += 800
            self.assertEqual(self.sync(steps, day=day, gait=SHAKER_GAIT).status_code, 200)
            self.age_record(15 * 60, day)
        self.assertEqual(TrustScore.objects.get(user=self.user).score, 100 - 8)

    def test_sync_evidence_never_suspends(self):
        TrustScore.objects.create(user=self.user, score=25)
        day = self.yesterday()
        self.assertEqual(self.sync(2_000, day=day, gait=SHAKER_GAIT).status_code, 200)
        trust = TrustScore.objects.get(user=self.user)
        self.assertEqual(trust.score, TRUST_SYNC_FLOOR)
        self.assertEqual(trust.status, "RESTRICT")

    def test_medium_only_evidence_costs_no_trust(self):
        day = self.yesterday()
        gait = dict(HONEST_GAIT, gait_dominant_freq_hz=3.4, gait_gyro_variance=5.0)
        self.assertEqual(self.sync(3_000, day=day, gait=gait).status_code, 200)
        self.assertEqual(TrustScore.objects.get(user=self.user).score, 100)

    def test_cap_helper(self):
        self.assertEqual(cap_trust_deduction(requested=8, has_critical=False, already_today=8, current_score=90), 0)
        self.assertEqual(cap_trust_deduction(requested=15, has_critical=True, already_today=8, current_score=90), 7)
        self.assertEqual(cap_trust_deduction(requested=8, has_critical=False, already_today=0, current_score=24), 3)


class RestrictNoDoublePenaltyTests(Phase0SyncBase):
    """A RESTRICT account is credited plausible x confidence (trust factor 0.75),
    not halved again: payout holds protect the money instead."""

    @override_settings(STEP_ANTICHEAT_V2_ENABLED=False)
    def test_restricted_honest_sync_is_not_halved(self):
        TrustScore.objects.create(user=self.user, score=30)
        day = self.yesterday()
        response = self.sync(8_000, day=day)
        self.assertEqual(response.status_code, 200, response.content)
        # trust factor RESTRICT = 0.75; the removed legacy rule would have made it 3,000.
        self.assertEqual(self.record(day).steps, 6_000)
        self.assertEqual(response.json()["approved_steps"], 6_000)

    @override_settings(STEP_ANTICHEAT_V2_ENABLED=True)
    def test_same_credit_with_v2_flag_on(self):
        TrustScore.objects.create(user=self.user, score=30)
        day = self.yesterday()
        self.assertEqual(self.sync(8_000, day=day).status_code, 200)
        self.assertEqual(self.record(day).steps, 6_000)


# ── Fix 10: hourly route check ────────────────────────────────────────────────


class RouteCheckTests(Phase0SyncBase):
    def _route(self, day, hour_local, utc_start, meters_per_point, points=8):
        out = []
        for i in range(points):
            out.append(
                {
                    "hour": hour_local,
                    "recorded_at": (utc_start + timedelta(minutes=i)).isoformat(),
                    "latitude": -1.2921 + i * meters_per_point / 111_000.0,
                    "longitude": 36.8219,
                    "accuracy_m": 8.0,
                }
            )
        return out

    def _post(self, day, hourly, waypoints):
        return self.client.post(
            "/api/steps/sync/hourly/",
            {"date": str(day), "hourly": hourly, "waypoints": waypoints},
            format="json",
        )

    def test_route_is_compared_with_the_same_hours_not_the_whole_day(self):
        day = self.yesterday()
        HealthRecord.objects.create(user=self.user, date=day, steps=22_000)
        hourly = [{"hour": 7, "steps": 1_200}] + [{"hour": h, "steps": 1_800} for h in range(9, 20)]
        utc = datetime.combine(day, time(4, 0), tzinfo=dt_timezone.utc)  # 07:00 EAT
        # ~0.9 km walked in hour 7 with 1,200 steps: plausible for that hour.
        response = self._post(day, hourly, self._route(day, 7, utc, 120))
        self.assertEqual(response.status_code, 200, response.content)
        self.assertFalse(FraudFlag.objects.filter(user=self.user).exists())

    def test_treadmill_is_informational_and_deduplicated(self):
        day = self.yesterday()
        hourly = [{"hour": 18, "steps": 4_000}]
        utc = datetime.combine(day, time(15, 0), tzinfo=dt_timezone.utc)
        for attempt in range(2):
            start = utc + timedelta(minutes=attempt * 20)
            self.assertEqual(self._post(day, hourly, self._route(day, 18, start, 3)).status_code, 200)
        flags = FraudFlag.objects.filter(user=self.user)
        self.assertEqual(flags.count(), 1)
        flag = flags.get()
        self.assertEqual(flag.flag_type, "route_step_mismatch_low_distance")
        self.assertEqual(flag.severity, "low")
        self.assertEqual(flag.details["occurrences"], 2)

    def test_waypoints_use_the_devices_local_day(self):
        # 01:30 in Nairobi on `day` is 22:30 UTC the day before.
        day = self.yesterday()
        utc = datetime.combine(day - timedelta(days=1), time(22, 30), tzinfo=dt_timezone.utc)
        response = self._post(day, [{"hour": 1, "steps": 300}], self._route(day, 1, utc, 20, points=3))
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(LocationWaypoint.objects.filter(user=self.user, date=day).count(), 3)


# ── Fix 11: session token redaction ───────────────────────────────────────────


class RedactionTests(Phase0SyncBase):
    def test_session_token_is_not_stored_in_raw_payload(self):
        self.assertEqual(self.sync(1_000, day=self.yesterday()).status_code, 200)
        event = StepSyncEvent.objects.get(user=self.user, accepted=True)
        self.assertEqual(event.raw_payload["session_token"], "[redacted]")
        self.assertNotIn(self.session["session_token"], str(event.raw_payload))

    def test_rejected_event_does_not_store_the_token_either(self):
        body = self.payload(800, day=self.yesterday())
        body["session_token"] = "forged-token-value"
        self.assertEqual(self.client.post("/api/steps/sync/", body, format="json").status_code, 401)
        event = StepSyncEvent.objects.get(user=self.user)
        self.assertEqual(event.raw_payload["session_token"], "[redacted]")

    def test_data_migration_redacts_existing_rows(self):
        StepSyncEvent.objects.create(
            user=self.user, client_event_id="old-1", payload_hash="h1",
            raw_payload={"steps": 10, "session_token": "plaintext-secret"},
        )
        StepSyncEvent.objects.create(
            user=self.user, client_event_id="old-2", payload_hash="h2",
            raw_payload={"steps": 11},
        )
        migration = importlib.import_module(
            "apps.steps.migrations.0012_redact_sync_event_session_tokens"
        )
        migration.redact_existing(django_apps, None)
        self.assertEqual(
            StepSyncEvent.objects.get(client_event_id="old-1").raw_payload["session_token"],
            "[redacted]",
        )
        self.assertEqual(StepSyncEvent.objects.get(client_event_id="old-2").raw_payload, {"steps": 11})


# ── Fix 12: adversarial cases ─────────────────────────────────────────────────


class AdversarialTests(Phase0SyncBase):
    def _participant_steps(self, day):
        return sum(
            HealthRecord.objects.filter(user=self.user, date=day, is_suspicious=False)
            .values_list("steps", flat=True)
        )

    def test_phone_shaker_gains_no_money_eligible_steps(self):
        day = self.yesterday()
        total = 0
        for _ in range(4):
            total += 1_500
            self.assertEqual(self.sync(total, day=day, gait=SHAKER_GAIT).status_code, 200)
            self.age_record(10 * 60, day)
        self.assertTrue(self.record(day).is_suspicious)
        self.assertEqual(self._participant_steps(day), 0)
        # Then a "clean-looking" sync can't launder the day.
        self.assertEqual(self.sync(total + 500, day=day).status_code, 200)
        self.assertEqual(self._participant_steps(day), 0)

    def test_shaker_resting_between_uploads_still_caught_when_steps_are_credited(self):
        day = self.yesterday()
        self.assertEqual(self.sync(3_000, day=day, gait=SHAKER_GAIT).status_code, 200)
        self.age_record(10 * 60, day)
        self.assertEqual(self.sync(3_200, day=day, gait=RESTING_SNAPSHOT).status_code, 200)
        self.assertEqual(self._participant_steps(day), 0)

    def test_huge_first_sync_of_the_day_is_bounded(self):
        day = timezone.now().date()
        # 03:30 in Nairobi; a script claims 99,000 steps already.
        fake_now = datetime.combine(day, time(0, 30), tzinfo=dt_timezone.utc)
        with patch("django.utils.timezone.now", return_value=fake_now):
            response = self.sync(99_000, day=day, ts=fake_now)
        self.assertEqual(response.status_code, 200, response.content)
        record = self.record(day)
        plausible = int(5.5 * 3600 * 4) + 2_000
        self.assertEqual(record.unverified_steps, 99_000 - plausible)
        self.assertLessEqual(record.steps, DAILY_STEP_CAP)

    def test_null_gait_large_volume_keeps_todays_behaviour_and_marks_coverage(self):
        day = self.yesterday()
        response = self.sync(40_000, day=day, gait=NULL_GAIT)
        self.assertEqual(response.status_code, 200, response.content)
        record = self.record(day)
        self.assertEqual(record.steps, 40_000)
        self.assertEqual(record.anticheat["gait_coverage"]["no_gait_steps"], 40_000)

    def test_replay_protection_unchanged(self):
        body = self.payload(1_000, day=self.yesterday())
        self.assertEqual(self.client.post("/api/steps/sync/", body, format="json").status_code, 200)
        tampered = dict(body, steps=1_500, steps_total=1_500)
        response = self.client.post("/api/steps/sync/", tampered, format="json")
        self.assertEqual(response.status_code, 400)
        self.assertTrue(response.json().get("replay_detected"))

    def test_impossible_cadence_still_blocks(self):
        day = self.yesterday()
        gait = dict(HONEST_GAIT, cadence_spm=300)
        response = self.sync(5_000, day=day, gait=gait)
        self.assertEqual(response.status_code, 400)
        self.assertTrue(
            FraudFlag.objects.filter(user=self.user, flag_type="cadence_impossible").exists()
        )
        self.assertTrue(self.record(day).is_suspicious)


# ── User-facing verification breakdown ─────────────────────────────────────────


INTERNAL_WORDS = ("gait", "shake", "risk", "rule", "threshold", "fraud", "cheat", "ml_", "weight", "4.0", "burst")


class VerificationBreakdownTests(Phase0SyncBase):
    def get(self, **params):
        return self.client.get("/api/steps/verification/", params)

    def assert_user_safe(self, breakdown):
        for reason in breakdown["reasons"]:
            self.assertEqual(
                set(reason), {"code", "steps_affected", "severity", "user_message"}
            )
            message = reason["user_message"].lower()
            for word in INTERNAL_WORDS:
                self.assertNotIn(word, message, reason)
        self.assertNotIn("anticheat", str(breakdown))

    def test_clean_day_has_no_reasons(self):
        day = self.yesterday()
        self.assertEqual(self.sync(8_000, day=day).status_code, 200)
        body = self.get(date=str(day)).json()
        self.assertEqual(len(body["days"]), 1)
        breakdown = body["days"][0]
        self.assertEqual(breakdown["counted_steps"], 8_000)
        self.assertEqual(breakdown["credited_steps"], 8_000)
        self.assertEqual(breakdown["unverified_steps"], 0)
        self.assertEqual(breakdown["reasons"], [])
        self.assertEqual(self.record(day).verification, breakdown)

    def test_pace_and_daily_limit_reasons(self):
        day = self.yesterday()
        self.assertEqual(self.sync(59_000, day=day).status_code, 200)
        self.age_record(5 * 60, day)
        self.assertEqual(self.sync(64_000, day=day).status_code, 200)
        breakdown = self.get(date=str(day)).json()["days"][0]
        self.assertEqual(breakdown["counted_steps"], 64_000)
        self.assertEqual(breakdown["credited_steps"], DAILY_STEP_CAP)
        self.assertEqual(breakdown["unverified_steps"], 4_000)
        codes = {reason["code"]: reason for reason in breakdown["reasons"]}
        self.assertIn("faster_than_walking_pace", codes)
        self.assertEqual(codes["faster_than_walking_pace"]["steps_affected"], 3_200)
        self.assertIn("3,200 steps arrived faster than walking pace", codes["faster_than_walking_pace"]["user_message"])
        self.assertIn("daily_limit", codes)
        self.assertEqual(
            codes["daily_limit"]["user_message"],
            "Steps above 60,000 in a day aren't counted toward challenges.",
        )
        self.assert_user_safe(breakdown)

    def test_day_under_review_is_explained_without_accusation(self):
        day = self.yesterday()
        self.assertEqual(self.sync(3_000, day=day, gait=SHAKER_GAIT).status_code, 200)
        breakdown = self.get(date=str(day)).json()["days"][0]
        self.assertTrue(breakdown["under_review"])
        self.assertEqual(breakdown["credited_steps"], 0)
        self.assertEqual(breakdown["reasons"][0]["code"], "under_review")
        self.assert_user_safe(breakdown)

    def test_range_is_limited_to_14_days_and_own_records(self):
        today = timezone.now().date()
        for i in range(20):
            HealthRecord.objects.create(user=self.user, date=today - timedelta(days=i), steps=1_000 + i)
        other = User.objects.create_user(
            username="someone_else", email="someone_else@example.com", password="TestPass123!"
        )
        HealthRecord.objects.create(user=other, date=today, steps=99_999, is_suspicious=True)
        body = self.get(days=30).json()
        self.assertEqual(len(body["days"]), 14)
        self.assertNotIn(99_999, [d["counted_steps"] for d in body["days"]])
        single = self.get(date=str(today)).json()["days"]
        self.assertEqual(single[0]["counted_steps"], 1_000)

    def test_other_users_cannot_read_my_breakdown(self):
        day = self.yesterday()
        self.assertEqual(self.sync(5_000, day=day).status_code, 200)
        other = User.objects.create_user(
            username="nosy_user", email="nosy@example.com", password="TestPass123!"
        )
        self.client.credentials(
            HTTP_AUTHORIZATION=f"Bearer {RefreshToken.for_user(other).access_token}"
        )
        self.assertEqual(self.get(date=str(day)).json()["days"], [])
        self.client.credentials()
        self.assertEqual(self.get(date=str(day)).status_code, 401)

    def test_bad_date_is_rejected(self):
        self.assertEqual(self.get(date="not-a-date").status_code, 400)
