"""
Anti-cheat Phase 1b: money-eligible steps need real walking evidence.

Covers evidence tiers, challenge totals, grandfathering, walks (endpoints, consistency,
mock location, vehicle, privacy, retention), Play Integrity (shadow / enforce with a
mocked verifier), server-side vehicle hours, time zones, reinstall resume / second
phone, server-computed active minutes and the v2 "why" breakdown.
See backend/ANTICHEAT.md ("Phase 1b").
"""

import uuid
from datetime import date, datetime, timedelta
from datetime import timezone as dt_timezone
from decimal import Decimal
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.test import SimpleTestCase, TestCase, override_settings
from django.utils import timezone

from apps.challenges.models import Challenge, Participant
from apps.steps import evidence, integrity, walks
from apps.steps.models import (FraudFlag, HealthRecord, HourlyStepRecord,
                               StepSession, WalkPrivacyZone, WalkSession)
from apps.steps.tests.test_anticheat_phase0 import (HONEST_GAIT, NULL_GAIT,
                                                    Phase0SyncBase,
                                                    evidence_hours_for)

User = get_user_model()

INTERNAL_WORDS = ("gait", "shake", "risk", "rule", "threshold", "fraud", "cheat", "integrity", "mock", "spm")


def set_policy(value):
    from apps.admin_api.models import SystemSettings

    s = SystemSettings.load()
    s.device_integrity_policy = value
    s.save()


# ── Pure units ────────────────────────────────────────────────────────────────


class ComputeTiersTests(SimpleTestCase):
    def test_android_buckets_split_credit(self):
        ev = {
            8: {"verified": 3000, "shake": 1000, "unknown": 500, "vehicle": 0, "walk": 0},
            9: {"verified": 2000, "shake": 0, "unknown": 0, "vehicle": 700, "walk": 0},
        }
        r = evidence.compute_tiers(
            credited=7200, grandfathered=0, evidence_source="android_gait_v1",
            evidence=ev, walk_verified=0, walk_gait_fallback=0,
        )
        self.assertEqual(r["tiers"]["sensor_verified"], 5000)
        self.assertEqual(r["tiers"]["unverified"], 2200)
        self.assertEqual(r["eligible"], 5000)
        self.assertEqual(r["unverified_reasons"], {"vehicle": 700, "unverified_motion": 1000, "unverified_no_walking_evidence": 500})

    def test_evidence_never_exceeds_credit(self):
        ev = {8: {"verified": 9000, "shake": 0, "unknown": 0, "vehicle": 0, "walk": 0}}
        r = evidence.compute_tiers(
            credited=4000, grandfathered=0, evidence_source="android_gait_v1",
            evidence=ev, walk_verified=0, walk_gait_fallback=0,
        )
        self.assertEqual(r["eligible"], 4000)
        self.assertEqual(r["tiers"]["unverified"], 0)

    def test_grandfathered_part_is_kept(self):
        r = evidence.compute_tiers(
            credited=8000, grandfathered=5000, evidence_source=None,
            evidence={}, walk_verified=0, walk_gait_fallback=0,
        )
        self.assertEqual(r["tiers"]["grandfathered"], 5000)
        self.assertEqual(r["eligible"], 5000)
        self.assertEqual(r["unverified_reasons"], {"app_update_needed": 3000})

    def test_walk_tier_needs_walk_bucket_on_android_and_fallback(self):
        ev = {7: {"verified": 0, "shake": 0, "unknown": 0, "vehicle": 0, "walk": 4000}}
        r = evidence.compute_tiers(
            credited=4000, grandfathered=0, evidence_source="android_gait_v1",
            evidence=ev, walk_verified=2500, walk_gait_fallback=1000,
        )
        self.assertEqual(r["tiers"]["walk_session"], 2500)
        self.assertEqual(r["tiers"]["sensor_verified"], 1000)

    def test_ios_counts_coremotion_steps(self):
        r = evidence.compute_tiers(
            credited=6000, grandfathered=0, evidence_source="ios_coremotion",
            evidence={}, walk_verified=0, walk_gait_fallback=0,
        )
        self.assertEqual(r["tiers"]["sensor_verified"], 6000)

    def test_integrity_block_and_server_vehicle_hours(self):
        ev = {8: {"verified": 3000}, 9: {"verified": 2000}}
        r = evidence.compute_tiers(
            credited=5000, grandfathered=0, evidence_source="android_gait_v1",
            evidence=ev, walk_verified=0, walk_gait_fallback=0, server_vehicle_hours={9},
        )
        self.assertEqual(r["eligible"], 3000)
        self.assertEqual(r["unverified_reasons"], {"vehicle": 2000})
        r = evidence.compute_tiers(
            credited=5000, grandfathered=1000, evidence_source="android_gait_v1",
            evidence=ev, walk_verified=0, walk_gait_fallback=0, integrity_blocked=True,
        )
        self.assertEqual(r["eligible"], 1000)
        self.assertEqual(r["unverified_reasons"], {"device_not_verified": 4000})


class EvidenceValidationTests(SimpleTestCase):
    def test_clean_evidence_hours(self):
        cleaned = evidence.clean_evidence_hours(
            [
                {"hour": 25, "verified": 10},
                {"hour": "x"},
                {"hour": 8, "verified": -5, "shake": "12", "active_minutes": 99},
                {"hour": 9, "verified": 30_000, "shake": 30_000},
                "junk",
            ]
        )
        self.assertEqual([h["hour"] for h in cleaned], [8, 9])
        self.assertEqual(cleaned[0]["verified"], 0)
        self.assertEqual(cleaned[0]["shake"], 12)
        self.assertEqual(cleaned[0]["active_minutes"], 60)
        self.assertLessEqual(evidence.evidence_hour_total(cleaned[1]), evidence.MAX_HOUR_STEPS)
        self.assertIsNone(evidence.clean_evidence_hours("nope"))

    def test_second_stream_evidence_is_merged_not_summed(self):
        meta = {}
        evidence.store_stream_evidence(meta, "i:a", [{"hour": 8, "verified": 3000}])
        evidence.store_stream_evidence(meta, "i:b", [{"hour": 8, "verified": 2500}, {"hour": 9, "verified": 100}])
        merged = evidence.day_evidence(meta)
        self.assertEqual(merged[8]["verified"], 3000)
        self.assertEqual(merged[9]["verified"], 100)

    def test_timezone_changes(self):
        meta = {}
        self.assertEqual(evidence.resolve_day_offset(meta, 180, "Africa/Nairobi"), (180, False))
        self.assertEqual(evidence.resolve_day_offset(meta, 60, "Europe/London"), (60, False))
        offset, hopping = evidence.resolve_day_offset(meta, 540, "Asia/Tokyo")
        self.assertTrue(hopping)
        self.assertEqual(offset, 60)  # the most conservative offset seen
        self.assertIsNone(evidence.clean_tz_offset(15 * 60))

    def test_server_active_minutes(self):
        # Measured minutes are used within plausible bounds; client can't inflate.
        self.assertEqual(evidence.server_active_minutes({8: 3000}, {8: {"verified": 3000, "active_minutes": 40}}, 3000), 40)
        self.assertEqual(evidence.server_active_minutes({8: 3000}, {8: {"verified": 3000, "active_minutes": 1}}, 3000), 13)
        self.assertEqual(evidence.server_active_minutes({}, {}, 5000), 50)
        self.assertEqual(evidence.server_active_minutes({8: 1000}, {}, 3000), 30)


class WalkMathTests(SimpleTestCase):
    def test_polyline_roundtrip_and_simplification(self):
        pts = [(-1.2921 + i * 0.0001, 36.8219) for i in range(50)]  # straight line
        simplified = walks.douglas_peucker(pts)
        self.assertEqual(len(simplified), 2)
        decoded = walks.decode_polyline(walks.encode_polyline(simplified))
        self.assertAlmostEqual(decoded[0][0], pts[0][0], places=5)
        self.assertAlmostEqual(decoded[-1][0], pts[-1][0], places=5)

    def test_shared_route_hides_start_and_end(self):
        pts = [(-1.30 + i * 0.0005, 36.80) for i in range(41)]  # ~2.2 km
        shared = walks.shared_route(pts)
        self.assertTrue(shared)
        self.assertGreater(walks.haversine_m(*pts[0], *shared[0]), 240)
        self.assertGreater(walks.haversine_m(*pts[-1], *shared[-1]), 240)
        self.assertEqual(walks.shared_route(pts[:5]), [])  # short walk: nothing shared

    def _metrics(self, steps_m=0.75, n=40, dt=15, speed_override=None):
        start = datetime(2026, 9, 28, 6, 0, tzinfo=dt_timezone.utc)
        pts = []
        for i in range(n):
            pts.append({"t": (start + timedelta(seconds=i * dt)).isoformat(), "lat": -1.30 + i * 0.0001, "lng": 36.80, "acc": 5, "spd": speed_override, "mock": False})
        return walks.route_metrics(pts, tz_offset_minutes=180)

    def test_verified_walk(self):
        m = self._metrics()
        steps = int(m["distance_m"] / 0.75)
        verdict, reasons, verified = walks.decide(
            steps=steps, duration_s=600, metrics=m, points_count=40, gait_verified=steps,
            gait_shake=0, gait_unknown=0, client_vehicle_seconds=0, mock=False,
            platform="android", step_source="step_counter", integrity_blocked=False,
        )
        self.assertEqual(verdict, "verified", reasons)
        self.assertEqual(verified, steps)

    def test_consistency_failures(self):
        m = self._metrics()
        base = dict(duration_s=600, metrics=m, points_count=40, gait_unknown=0,
                    client_vehicle_seconds=0, platform="android", step_source="step_counter",
                    integrity_blocked=False)
        steps = int(m["distance_m"] / 0.75)
        # Shaker / treadmill: many steps for a short route.
        v, r, n = walks.decide(steps=steps * 10, gait_verified=0, gait_shake=0, mock=False, **base)
        self.assertEqual((v, n), ("unverified", 0))
        self.assertIn("walk_route_short_for_steps", r)
        # Vehicle: long route for few steps.
        v, r, _ = walks.decide(steps=max(100, steps // 10), gait_verified=100, gait_shake=0, mock=False, **base)
        self.assertIn("walk_route_long_for_steps", r)
        # Mock location.
        v, r, _ = walks.decide(steps=steps, gait_verified=steps, gait_shake=0, mock=True, **base)
        self.assertEqual(v, "unverified")
        self.assertIn("walk_mock_location", r)
        # Motion that didn't look like walking.
        v, r, _ = walks.decide(steps=steps, gait_verified=0, gait_shake=steps, mock=False, **base)
        self.assertIn("walk_motion_not_walking", r)
        # Too short.
        v, r, _ = walks.decide(steps=50, gait_verified=50, gait_shake=0, mock=False, **{**base, "duration_s": 60})
        self.assertIn("walk_too_short", r)

    def test_fast_fixes_are_kept_as_vehicle_time(self):
        start = datetime(2026, 9, 28, 6, 0, tzinfo=dt_timezone.utc)
        pts = [{"t": (start + timedelta(seconds=i * 10)).isoformat(), "lat": -1.30 + i * 0.001, "lng": 36.80, "acc": 5, "spd": None, "mock": False} for i in range(30)]
        m = walks.route_metrics(pts, tz_offset_minutes=180)  # ~11 m/s
        self.assertGreater(m["vehicle_seconds"], 250)
        self.assertEqual(m["distance_m"], 0)
        self.assertIn(9, m["vehicle_by_hour"])  # 06:00 UTC = 09:00 EAT

    def test_privacy_zone_hashes_only(self):
        user = type("U", (), {})()
        zone = WalkPrivacyZone(salt="s" * 32, precision=7, radius_m=300)
        zone.cell_hashes = sorted(walks._cell_hash(zone.salt, c) for c in walks.zone_cells(-1.2921, 36.8219, 300))
        self.assertTrue(walks.in_zone(zone, -1.2921, 36.8219))
        self.assertTrue(walks.in_zone(zone, -1.2921 + 0.002, 36.8219))  # ~220 m
        self.assertFalse(walks.in_zone(zone, -1.2921 + 0.02, 36.8219))  # ~2.2 km
        self.assertNotIn("-1.29", str(zone.cell_hashes))
        del user


class IntegrityEvaluationTests(SimpleTestCase):
    def payload(self, **over):
        now_ms = 1_800_000_000_000
        p = {
            "requestDetails": {"requestPackageName": "com.step2win.app", "nonce": "N1", "timestampMillis": str(now_ms - 5000)},
            "appIntegrity": {"appRecognitionVerdict": "PLAY_RECOGNIZED", "certificateSha256Digest": ["abc"]},
            "deviceIntegrity": {"deviceRecognitionVerdict": ["MEETS_DEVICE_INTEGRITY"]},
            "accountDetails": {"appLicensingVerdict": "LICENSED"},
        }
        for k, v in over.items():
            p[k] = {**p[k], **v}
        return p, now_ms

    def evaluate(self, **over):
        p, now_ms = self.payload(**over)
        return integrity.evaluate_payload(p, expected_nonce="N1", expected_package="com.step2win.app", now_ms=now_ms)

    def test_verdicts(self):
        self.assertEqual(self.evaluate()[0], "verified")
        status, verdict = self.evaluate(requestDetails={"nonce": "other"})
        self.assertEqual(status, "failed")
        self.assertIn("nonce_mismatch", verdict["reasons"])
        status, verdict = self.evaluate(deviceIntegrity={"deviceRecognitionVerdict": ["MEETS_BASIC_INTEGRITY"]})
        self.assertIn("device_not_recognized", verdict["reasons"])
        with self.settings(PLAY_INTEGRITY_ACCEPT_BASIC=True):
            self.assertEqual(self.evaluate(deviceIntegrity={"deviceRecognitionVerdict": ["MEETS_BASIC_INTEGRITY"]})[0], "verified")
        self.assertIn("app_not_recognized", self.evaluate(appIntegrity={"appRecognitionVerdict": "UNRECOGNIZED_VERSION"})[1]["reasons"])
        with self.settings(PLAY_INTEGRITY_ALLOWED_CERT_SHA256="AB:C"):
            self.assertEqual(self.evaluate(appIntegrity={"appRecognitionVerdict": "UNRECOGNIZED_VERSION"})[0], "verified")
        self.assertIn("stale_token", self.evaluate(requestDetails={"timestampMillis": "1"})[1]["reasons"])

    @override_settings(PLAY_INTEGRITY_PACKAGE_NAME="", PLAY_INTEGRITY_SERVICE_ACCOUNT_JSON="")
    def test_unconfigured_is_unavailable(self):
        self.assertEqual(integrity.verify_token("tok", expected_nonce="N")[0], "unavailable")


# ── API ───────────────────────────────────────────────────────────────────────


class P1bSyncBase(Phase0SyncBase):
    def sync_ev(self, steps, hours=None, *, no_evidence=False, **kwargs):
        extra = {}
        if no_evidence:
            extra = {"evidence_source": None, "evidence_hours": None}
        elif hours is not None:
            extra = {"evidence_hours": hours}
        extra.update(kwargs.pop("extra", {}))
        return self.sync(steps, **kwargs, **extra)

    def make_challenge(self, start=None, end=None, milestone=5000):
        today = timezone.now().date()
        challenge = Challenge.objects.create(
            creator=User.objects.create_user(username=f"c{uuid.uuid4().hex[:6]}", email=f"{uuid.uuid4().hex[:6]}@x.com", password="x"),
            name="Evidence week",
            entry_fee=Decimal("100.00"),
            milestone=milestone,
            start_date=start or today - timedelta(days=3),
            end_date=end or today + timedelta(days=3),
            status="active",
            total_pool=Decimal("0.00"),
        )
        return Participant.objects.create(challenge=challenge, user=self.user, steps=0)


class ShakingTests(P1bSyncBase):
    def test_shaking_counts_for_goals_not_challenges(self):
        """The owner's test: shaking the phone produced many counted steps."""
        participant = self.make_challenge()
        day = self.yesterday()
        hours = evidence_hours_for(6000, bucket="shake")
        response = self.sync_ev(6000, hours, day=day, gait=NULL_GAIT)
        self.assertEqual(response.status_code, 200, response.content)
        rec = self.record(day)
        self.assertEqual(rec.steps, 6000)  # goals / XP / streaks
        self.assertEqual(rec.eligible_steps, 0)  # challenges / money
        self.assertEqual(rec.tier_unverified, 6000)
        participant.refresh_from_db()
        self.assertEqual(participant.steps, 0)
        self.assertFalse(participant.qualified)
        breakdown = self.client.get("/api/steps/verification/", {"date": str(day)}).json()["days"][0]
        self.assertEqual(breakdown["goal_steps"], 6000)
        self.assertEqual(breakdown["challenge_steps"], 0)
        codes = [r["code"] for r in breakdown["reasons"]]
        self.assertIn("unverified_motion", codes)
        for r in breakdown["reasons"]:
            for word in INTERNAL_WORDS:
                self.assertNotIn(word, r["user_message"].lower())

    def test_null_gait_app_closed_is_unverified_for_money(self):
        day = self.yesterday()
        hours = evidence_hours_for(4000, bucket="unknown")
        self.assertEqual(self.sync_ev(4000, hours, day=day, gait=NULL_GAIT).status_code, 200)
        rec = self.record(day)
        self.assertEqual((rec.steps, rec.eligible_steps), (4000, 0))
        self.assertEqual(rec.anticheat["tiers"]["unverified_reasons"], {"unverified_no_walking_evidence": 4000})

    def test_old_app_without_evidence(self):
        day = self.yesterday()
        self.assertEqual(self.sync_ev(3000, no_evidence=True, day=day).status_code, 200)
        rec = self.record(day)
        self.assertEqual(rec.eligible_steps, 0)
        self.assertEqual(rec.anticheat["tiers"]["unverified_reasons"], {"app_update_needed": 3000})

    def test_mixed_day_challenge_uses_verified_part_only(self):
        participant = self.make_challenge(milestone=5000)
        day = self.yesterday()
        hours = [{"hour": 7, "verified": 4000}, {"hour": 8, "shake": 3000}]
        self.assertEqual(self.sync_ev(7000, hours, day=day).status_code, 200)
        participant.refresh_from_db()
        self.assertEqual(participant.steps, 4000)
        self.assertFalse(participant.qualified)
        self.assertEqual(self.client.get("/api/steps/today/").status_code, 200)

    def test_runner_cadence_stays_verified(self):
        day = self.yesterday()
        gait = dict(HONEST_GAIT, cadence_spm=192, gait_dominant_freq_hz=3.2)
        hours = [{"hour": 6, "verified": 11_400, "active_minutes": 60}, {"hour": 7, "verified": 3_000, "active_minutes": 30}]
        self.assertEqual(self.sync_ev(14_400, hours, day=day, gait=gait).status_code, 200)
        rec = self.record(day)
        self.assertEqual(rec.eligible_steps, 14_400)
        self.assertFalse(FraudFlag.objects.filter(user=self.user, flag_type__startswith="steps_per_min").exists())


class GrandfatherTests(P1bSyncBase):
    def test_pre_1b_day_keeps_credit_and_new_steps_need_evidence(self):
        participant = self.make_challenge(milestone=100_000)
        day = self.yesterday()
        HealthRecord.objects.create(
            user=self.user, date=day, steps=5000, last_raw_steps=5000,
            anticheat={"v": 1}, synced_at=timezone.now(),
        )
        HealthRecord.objects.filter(user=self.user, date=day).update(
            synced_at=timezone.now() - timedelta(hours=2),
            last_client_timestamp=timezone.now() - timedelta(hours=2),
        )
        untouched = day - timedelta(days=1)
        HealthRecord.objects.create(user=self.user, date=untouched, steps=7000)
        self.assertEqual(self.sync_ev(6000, no_evidence=True, day=day).status_code, 200)
        rec = self.record(day)
        self.assertEqual(rec.tier_grandfathered, 5000)
        self.assertEqual(rec.eligible_steps, 5000)
        participant.refresh_from_db()
        self.assertEqual(participant.steps, 5000 + 7000)  # untouched pre-1b day: full credit
        self.assertIsNone(HealthRecord.objects.get(user=self.user, date=untouched).eligible_steps)

    def test_cutover_date_gives_full_credit_before_it(self):
        day = self.yesterday()
        with self.settings(STEP_EVIDENCE_CUTOVER_DATE=str(timezone.now().date() + timedelta(days=2))):
            self.assertEqual(self.sync_ev(3000, no_evidence=True, day=day).status_code, 200)
        rec = self.record(day)
        self.assertEqual(rec.eligible_steps, 3000)
        self.assertEqual(rec.tier_unverified, 3000)  # tiers are still recorded (shadow)

    @override_settings(STEP_MONEY_REQUIRES_EVIDENCE=False)
    def test_emergency_switch(self):
        day = self.yesterday()
        self.assertEqual(self.sync_ev(3000, no_evidence=True, day=day).status_code, 200)
        self.assertEqual(self.record(day).eligible_steps, 3000)


class IosEvidenceTests(P1bSyncBase):
    platform = "ios"

    def test_ios_coremotion_is_sensor_verified(self):
        day = self.yesterday()
        self.assertEqual(self.sync(5000, day=day, gait=NULL_GAIT, source="apple_health").status_code, 200)
        rec = self.record(day)
        self.assertEqual(rec.tier_sensor_verified, 5000)

    def test_android_evidence_claim_from_ios_is_ignored(self):
        day = self.yesterday()
        body = {"evidence_source": "android_gait_v1", "evidence_hours": evidence_hours_for(5000)}
        self.assertEqual(self.sync(5000, day=day, gait=NULL_GAIT, **body).status_code, 200)
        self.assertEqual(self.record(day).eligible_steps, 0)


class ActiveMinutesTests(P1bSyncBase):
    def test_active_minutes_are_computed_by_the_server(self):
        day = self.yesterday()
        hours = [{"hour": 7, "verified": 3000, "active_minutes": 35}]
        self.assertEqual(self.sync_ev(3000, hours, day=day, active_minutes=1440).status_code, 200)
        self.assertEqual(self.record(day).active_minutes, 35)


class TimezoneTests(P1bSyncBase):
    def test_future_date_for_the_phones_own_zone_is_rejected(self):
        tomorrow = timezone.now().date() + timedelta(days=1)
        response = self.sync_ev(100, day=tomorrow, extra={"tz_offset_minutes": -720})
        self.assertEqual(response.status_code, 400)

    def test_known_offset_sets_the_day_bound(self):
        now = timezone.now()
        minutes_utc = now.hour * 60 + now.minute
        offset = 60 - minutes_utc  # local time ~01:00
        if offset < -720:
            offset += 1440
        local_day = (now + timedelta(minutes=offset)).date()
        # 1 h since local midnight (+0.5 h tolerance): ~4 * 5400 + 2000 = 23,600 plausible.
        response = self.sync_ev(30_000, evidence_hours_for(30_000), day=local_day, extra={"tz_offset_minutes": offset, "tz_name": "Etc/Test"})
        self.assertEqual(response.status_code, 200, response.content)
        rec = self.record(local_day)
        self.assertGreater(rec.unverified_steps, 5_000)
        self.assertEqual(rec.anticheat["tz"]["offset"], offset)

    def test_timezone_hopping_is_flagged_low(self):
        day = self.yesterday()
        for i, off in enumerate((180, 60, 540)):
            self.age_record(30 * 60, day) if i else None
            self.assertEqual(self.sync_ev(1000 + i * 100, evidence_hours_for(1000 + i * 100), day=day, extra={"tz_offset_minutes": off}).status_code, 200)
        flag = FraudFlag.objects.get(user=self.user, flag_type="timezone_hopping")
        self.assertEqual(flag.severity, "low")


class ReinstallTests(P1bSyncBase):
    def test_reinstall_resume_and_second_phone_do_not_create_fraud(self):
        day = self.yesterday()
        self.assertEqual(self.sync_ev(5000, day=day, extra={"install_id": "install-A"}).status_code, 200)
        resume = self.client.get("/api/steps/resume/", {"date": str(day)}).json()
        self.assertEqual(resume["last_raw_steps"], 5000)
        self.age_record(10 * 60, day)
        # A fresh install / second phone that counted only 300 so far.
        r = self.sync_ev(300, evidence_hours_for(300), day=day, extra={"install_id": "install-B"})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertTrue(r.json().get("secondary_stream"))
        self.assertEqual(self.record(day).steps, 5000)
        self.assertFalse(FraudFlag.objects.filter(user=self.user, flag_type="non_monotonic_steps").exists())
        # The reinstalled app resumed from the server total: 5000 + 400 new steps.
        self.age_record(10 * 60, day)
        r = self.sync_ev(5400, evidence_hours_for(5400), day=day, extra={"install_id": "install-B"})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(self.record(day).steps, 5400)
        # The same install going down is still rejected.
        self.age_record(10 * 60, day)
        r = self.sync_ev(5100, evidence_hours_for(5100), day=day, extra={"install_id": "install-B"})
        self.assertEqual(r.status_code, 400)
        self.assertTrue(FraudFlag.objects.filter(user=self.user, flag_type="non_monotonic_steps").exists())


class IntegrityApiTests(P1bSyncBase):
    def test_session_start_returns_nonce_and_shadow_is_unavailable(self):
        session = StepSession.objects.get(id=self.session["session_id"])
        self.assertEqual(self.session["integrity_nonce"], session.server_nonce)
        self.assertFalse(self.session["integrity_requested"])
        self.assertEqual(session.integrity_status, "unavailable")
        r = self.client.post(
            "/api/steps/session/integrity/",
            {"session_id": self.session["session_id"], "session_token": self.session["session_token"], "integrity_token": "t"},
            format="json",
        )
        self.assertEqual(r.json()["integrity_status"], "unavailable")

    def _fail_integrity(self):
        with patch("apps.steps.integrity.verifier_configured", return_value=True), patch(
            "apps.steps.integrity.decode_token",
            return_value={"requestDetails": {"nonce": "wrong"}, "deviceIntegrity": {}},
        ):
            r = self.client.post(
                "/api/steps/session/integrity/",
                {"session_id": self.session["session_id"], "session_token": self.session["session_token"], "integrity_token": "t"},
                format="json",
            )
        self.assertEqual(r.json()["integrity_status"], "failed")

    def test_failed_integrity_in_shadow_changes_nothing(self):
        self._fail_integrity()
        day = self.yesterday()
        self.assertEqual(self.sync_ev(4000, day=day).status_code, 200)
        self.assertEqual(self.record(day).eligible_steps, 4000)

    def test_failed_integrity_enforced_is_goals_only(self):
        set_policy("enforce")
        self._fail_integrity()
        day = self.yesterday()
        self.assertEqual(self.sync_ev(4000, day=day).status_code, 200)
        rec = self.record(day)
        self.assertEqual((rec.steps, rec.eligible_steps), (4000, 0))
        self.assertEqual(rec.anticheat["tiers"]["unverified_reasons"], {"device_not_verified": 4000})
        self.assertFalse(FraudFlag.objects.filter(user=self.user, flag_type__icontains="integrity").exists())


class ServerVehicleTests(P1bSyncBase):
    def test_vehicle_speed_hour_makes_its_steps_unverified(self):
        day = self.yesterday()
        hours = [{"hour": 7, "verified": 3000}, {"hour": 8, "verified": 2000}]
        self.assertEqual(self.sync_ev(5000, hours, day=day).status_code, 200)
        base = datetime.combine(day, datetime.min.time(), tzinfo=dt_timezone.utc) + timedelta(hours=5)  # 08:00 EAT
        waypoints = [
            {"hour": 8, "recorded_at": (base + timedelta(seconds=20 * i)).isoformat(), "latitude": -1.30 + i * 0.002, "longitude": 36.80, "accuracy_m": 8}
            for i in range(40)
        ]
        r = self.client.post("/api/steps/sync/hourly/", {"date": str(day), "hourly": [{"hour": 7, "steps": 3000}, {"hour": 8, "steps": 2000}], "waypoints": waypoints}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        rec = self.record(day)
        self.assertEqual(rec.eligible_steps, 3000)
        self.assertEqual(rec.anticheat["tiers"]["unverified_reasons"], {"vehicle": 2000})


class WalkApiTests(P1bSyncBase):
    def start_walk(self, **extra):
        body = {"client_walk_id": str(uuid.uuid4()), "started_at": (timezone.now() - timedelta(minutes=9)).isoformat(),
                "tz_offset_minutes": 180, "platform": "android", "step_source": "step_counter"}
        body.update(extra)
        r = self.client.post("/api/steps/walks/start/", body, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        return r.json()

    def route(self, walk_start, n=60, step_deg=0.0001, mock=False):
        start = datetime.fromisoformat(walk_start)
        return [{"t": (start + timedelta(seconds=8 * i + 5)).isoformat(), "lat": -1.30 + i * step_deg, "lng": 36.80, "acc": 6, "spd": 1.4, "mock": mock} for i in range(n)]

    def test_verified_walk_counts_in_walk_session_tier(self):
        participant = self.make_challenge(milestone=500)
        walk = self.start_walk()
        self.assertIn("integrity_nonce", walk)
        pts = self.route(walk["started_at"])
        r = self.client.post(f"/api/steps/walks/{walk['id']}/points/", {"points": pts[:30], "steps": 300, "gait_verified_steps": 300}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        distance = walks.route_metrics(walks.clean_points(pts, started_at=timezone.now() - timedelta(hours=1)), tz_offset_minutes=180)["distance_m"]
        steps = int(distance / 0.75)
        r = self.client.post(f"/api/steps/walks/{walk['id']}/finish/", {"points": pts[30:], "steps": steps, "gait_verified_steps": steps, "ended_at": timezone.now().isoformat()}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        summary = r.json()
        self.assertEqual(summary["verdict"], "verified", summary)
        self.assertEqual(summary["verified_steps"], steps)
        self.assertTrue(summary["polyline"])
        self.assertEqual(summary["reasons"][0]["code"], "walk_session_verified")
        # The day's sync attributes those steps to the walk bucket: walk_session tier.
        day = datetime.fromisoformat(summary["local_date"]).date()
        r = self.sync_ev(steps + 1000, [{"hour": 9, "walk": steps, "verified": 1000}], day=day)
        self.assertEqual(r.status_code, 200, r.content)
        rec = self.record(day)
        self.assertEqual(rec.tier_walk_session, steps)
        self.assertEqual(rec.eligible_steps, steps + 1000)
        if participant.challenge.start_date <= day <= participant.challenge.end_date:
            participant.refresh_from_db()
            self.assertEqual(participant.steps, steps + 1000)
        # Idempotent finish.
        again = self.client.post(f"/api/steps/walks/{walk['id']}/finish/", {}, format="json").json()
        self.assertEqual(again["verified_steps"], steps)

    def test_mock_location_walk_is_unverified(self):
        walk = self.start_walk()
        pts = self.route(walk["started_at"], mock=True)
        r = self.client.post(f"/api/steps/walks/{walk['id']}/finish/", {"points": pts, "steps": 600, "gait_verified_steps": 600}, format="json").json()
        self.assertEqual(r["verdict"], "unverified")
        self.assertIn("walk_mock_location", [x["code"] for x in r["reasons"]])
        self.assertTrue(WalkSession.objects.get(id=walk["id"]).mock_location)

    def test_treadmill_walk_falls_back_to_gait(self):
        walk = self.start_walk()
        pts = self.route(walk["started_at"], n=20, step_deg=0.0)  # standing still
        r = self.client.post(f"/api/steps/walks/{walk['id']}/finish/", {"points": pts, "steps": 900, "gait_verified_steps": 850, "gait_shake_steps": 0}, format="json").json()
        self.assertEqual(r["verdict"], "unverified")
        day = datetime.fromisoformat(r["local_date"]).date()
        self.assertEqual(self.sync_ev(900, [{"hour": 9, "walk": 900}], day=day).status_code, 200)
        rec = self.record(day)
        self.assertEqual(rec.tier_sensor_verified, 850)  # gait-verified steps still count

    def test_vehicle_walk_is_unverified(self):
        walk = self.start_walk()
        pts = self.route(walk["started_at"], step_deg=0.001)  # ~14 m/s
        r = self.client.post(f"/api/steps/walks/{walk['id']}/finish/", {"points": pts, "steps": 400, "gait_verified_steps": 400}, format="json").json()
        self.assertEqual(r["verdict"], "unverified")
        self.assertIn("walk_vehicle", [x["code"] for x in r["reasons"]])
        for reason in r["reasons"]:
            for word in INTERNAL_WORDS:
                self.assertNotIn(word, reason["user_message"].lower())

    def test_other_users_cannot_touch_my_walk_and_one_active_walk(self):
        walk = self.start_walk()
        second = self.start_walk()
        self.assertEqual(WalkSession.objects.get(id=walk["id"]).status, "abandoned")
        other = User.objects.create_user(username="walk_nosy", email="walk_nosy@example.com", password="x")
        from rest_framework_simplejwt.tokens import RefreshToken

        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {RefreshToken.for_user(other).access_token}")
        self.assertEqual(self.client.get(f"/api/steps/walks/{second['id']}/").status_code, 404)
        self.assertEqual(self.client.post(f"/api/steps/walks/{second['id']}/finish/", {}, format="json").status_code, 404)

    def test_privacy_zone_and_shared_route(self):
        r = self.client.put("/api/steps/walks/privacy-zone/", {"latitude": -1.30, "longitude": 36.80, "radius_m": 300}, format="json")
        self.assertEqual(r.status_code, 200)
        zone = WalkPrivacyZone.objects.get(user=self.user)
        self.assertNotIn("36.8", str(zone.__dict__))
        self.assertTrue(self.client.get("/api/steps/walks/privacy-zone/").json()["enabled"])
        walk = self.start_walk()
        pts = self.route(walk["started_at"], n=80)
        summary = self.client.post(f"/api/steps/walks/{walk['id']}/finish/", {"points": pts, "steps": 700, "gait_verified_steps": 700}, format="json").json()
        full = walks.decode_polyline(summary["polyline"])
        shared = walks.decode_polyline(summary["shared_polyline"])
        self.assertTrue(full)
        for lat, lng in shared:
            self.assertGreater(walks.haversine_m(-1.30, 36.80, lat, lng), 250)
        self.assertEqual(self.client.delete("/api/steps/walks/privacy-zone/").status_code, 204)
        self.assertFalse(WalkPrivacyZone.objects.filter(user=self.user).exists())
        self.assertEqual(self.client.put("/api/steps/walks/privacy-zone/", {"latitude": 1, "longitude": 1, "radius_m": 5}, format="json").status_code, 400)

    def test_retention_purges_raw_points_and_keeps_route(self):
        walk = self.start_walk()
        pts = self.route(walk["started_at"])
        self.client.post(f"/api/steps/walks/{walk['id']}/finish/", {"points": pts, "steps": 600, "gait_verified_steps": 600}, format="json")
        WalkSession.objects.filter(id=walk["id"]).update(started_at=timezone.now() - timedelta(days=31))
        self.assertEqual(walks.purge_old_walk_points(), 1)
        w = WalkSession.objects.get(id=walk["id"])
        self.assertEqual(w.raw_points, [])
        self.assertIsNotNone(w.raw_points_purged_at)
        self.assertTrue(w.simplified_polyline)
        self.assertEqual(walks.purge_old_walk_points(), 0)
        self.assertTrue(self.client.get(f"/api/steps/walks/{walk['id']}/").json()["polyline"])

    def test_retention_job_is_scheduled(self):
        from django.conf import settings

        from apps.admin_api.scheduler import JOB_OPTIONS

        self.assertEqual(settings.CELERY_BEAT_SCHEDULE["purge-old-walk-points"]["task"], "apps.steps.tasks.purge_old_walk_points_task")
        self.assertIn("purge-old-walk-points", JOB_OPTIONS)
