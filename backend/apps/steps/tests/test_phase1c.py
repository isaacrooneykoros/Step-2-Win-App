"""
Anti-cheat Phase 1c: Health Connect (Android) and Apple Health (iOS) as extra step
sources with provenance.

Covers the allowlist (trust by origin / device / recording method), manual and unknown
apps never counting, the wearable tier, corroboration, max-not-sum merging, disagreement
(review reason + MEDIUM flag, no trust change), route-verified workouts, strict payload
validation and platform matching, the evidence rule off vs on, "Remove imported data"
and account deletion. See backend/ANTICHEAT.md ("Phase 1c").
"""

from datetime import datetime, timedelta
from datetime import timezone as dt_timezone

from django.test import SimpleTestCase, override_settings
from django.utils import timezone

from apps.steps import health_sources as hs
from apps.steps.models import FraudFlag, HealthRecord, HealthSourceDay, TrustScore
from apps.steps.tests.test_anticheat_phase0 import Phase0SyncBase, evidence_hours_for

URL = "/api/steps/health-sources/"
SAMSUNG = "com.sec.android.app.shealth"
FIT = "com.google.android.apps.fitness"
GARMIN = "com.garmin.android.apps.connectmobile"
STRAVA = "com.strava"
SHADY = "com.example.stepfaker"

INTERNAL_WORDS = ("gait", "shake", "risk", "rule", "threshold", "fraud", "cheat", "integrity", "mock", "spm")


def H(hour, origin, steps, device="phone", method="automatic"):
    return {"hour": hour, "origin": origin, "steps": steps, "device": device, "method": method}


def spread(origin, steps, *, start_hour=6, device="phone", method="automatic", per_hour=6000):
    out, hour, left = [], start_hour, steps
    while left > 0:
        chunk = min(per_hour, left)
        out.append(H(hour, origin, chunk, device, method))
        left -= chunk
        hour += 1
    return out


RULES = hs.parse_rules(hs.DEFAULT_TRUSTED_ORIGINS_TEXT)


# ── Pure units ────────────────────────────────────────────────────────────────


class AllowlistTests(SimpleTestCase):
    def test_trusted_phone_app_is_corroboration_only(self):
        self.assertEqual(hs.classify(SAMSUNG, "phone", "automatic", RULES), ("trusted", "phone_app", "Samsung Health"))
        self.assertEqual(hs.classify(FIT, "unknown", "active", RULES)[:2], ("trusted", "phone_app"))

    def test_watch_from_trusted_origin_is_wearable(self):
        self.assertEqual(hs.classify(SAMSUNG, "watch", "automatic", RULES)[:2], ("trusted", "wearable"))
        self.assertEqual(hs.classify("com.fitbit.FitbitMobile", "band", "automatic", RULES)[:2], ("trusted", "wearable"))

    def test_wearable_only_app_without_device_type_is_wearable(self):
        self.assertEqual(hs.classify(GARMIN, "unknown", "automatic", RULES)[:2], ("trusted", "wearable"))
        # ... but a phone it says is a phone.
        self.assertEqual(hs.classify(GARMIN, "phone", "automatic", RULES)[:2], ("trusted", "phone_app"))

    def test_platform_recording_and_apple_health_prefixes(self):
        self.assertEqual(hs.classify("android", "phone", "automatic", RULES)[0], "trusted")
        self.assertEqual(
            hs.classify("com.android.healthconnect.phone.jd5bdd37e1a8d3667a05d0abebfc4a89e", "phone", "automatic", RULES)[0],
            "trusted",
        )
        self.assertEqual(hs.classify("com.apple.health.1B2C3D4E-0000", "watch", "automatic", RULES)[:2], ("trusted", "wearable"))
        self.assertEqual(hs.classify("com.apple.healthy.fake", "watch", "automatic", RULES)[0], "untrusted")

    def test_manual_and_unknown_origins_never_trusted(self):
        self.assertEqual(hs.classify(SAMSUNG, "watch", "manual", RULES)[0], "manual")
        self.assertEqual(hs.classify(SHADY, "watch", "automatic", RULES)[0], "untrusted")
        self.assertEqual(hs.classify("com.step2win.app", "phone", "automatic", RULES)[0], "ignored")

    def test_admin_list_replaces_defaults_and_blank_means_defaults(self):
        custom = hs.parse_rules("com.example.stepfaker wearable  # Tester\n# comment only\n")
        self.assertEqual(hs.classify(SHADY, "unknown", "automatic", custom)[:2], ("trusted", "wearable"))
        self.assertEqual(hs.classify(SAMSUNG, "phone", "automatic", custom)[0], "untrusted")
        self.assertEqual(hs.parse_rules(""), [])


class PlanDayTests(SimpleTestCase):
    def plan(self, hours, *, sensor_raw, evidence=None, source="android_gait_v1", workouts=None):
        summary = hs.summarize({"hours": hours}, RULES)
        return hs.plan_day(
            summary, workouts=workouts or [], rules=RULES, sensor_raw=sensor_raw,
            evidence=evidence or {}, evidence_source=source, offset_minutes=180,
        )

    def test_max_not_sum_across_origins_and_sensor(self):
        hours = [H(9, SAMSUNG, 5000), H(9, FIT, 4800), H(9, SAMSUNG, 4000, device="watch")]
        summary = hs.summarize({"hours": hours}, RULES)
        self.assertEqual(summary["trusted_total"], 5000)  # max per hour, never 13,800
        p = self.plan(hours, sensor_raw=5000)
        self.assertEqual(p["extra_wearable"] + p["extra_phone_app"], 0)

    def test_extra_is_what_trusted_sources_saw_beyond_the_sensor(self):
        p = self.plan(spread(SAMSUNG, 9000, device="watch"), sensor_raw=2000)
        self.assertEqual(p["extra_wearable"], 7000)
        self.assertEqual(p["extra_phone_app"], 0)

    def test_manual_and_untrusted_are_not_counted(self):
        hours = [H(8, SAMSUNG, 3000, method="manual"), H(9, SHADY, 8000, device="watch")]
        summary = hs.summarize({"hours": hours}, RULES)
        self.assertEqual(summary["trusted_total"], 0)
        self.assertEqual(summary["not_counted"], {"manual": 3000, "untrusted": 8000})

    def test_wearable_covers_verified_before_shaken_steps(self):
        ev = {9: {"verified": 4000, "shake": 3000, "unknown": 0, "vehicle": 0, "walk": 0}}
        p = self.plan([H(9, SAMSUNG, 4000, device="watch")], sensor_raw=7000, evidence=ev)
        self.assertEqual(p["adjusted_evidence"][9]["verified"], 0)
        self.assertEqual(p["adjusted_evidence"][9]["shake"], 3000)

    def test_corroboration_within_tolerance_only(self):
        ev = {9: {"verified": 0, "shake": 0, "unknown": 3000, "vehicle": 0, "walk": 0},
              10: {"verified": 0, "shake": 0, "unknown": 3000, "vehicle": 0, "walk": 0},
              11: {"verified": 0, "shake": 2000, "unknown": 0, "vehicle": 0, "walk": 0}}
        hours = [H(9, SAMSUNG, 3300), H(10, SAMSUNG, 5000), H(11, SAMSUNG, 2000)]
        p = self.plan(hours, sensor_raw=8000, evidence=ev)
        self.assertEqual(p["corroborated"], 3000)
        self.assertEqual(p["corroborated_hours"], [9])
        self.assertEqual(p["adjusted_evidence"][11]["shake"], 2000)  # shaken steps never "confirmed"

    def test_disagreement_withholds_phone_app_excess(self):
        p = self.plan(spread(SAMSUNG, 40000), sensor_raw=4000)
        self.assertTrue(p["disagreement"])
        self.assertEqual(p["extra_phone_app"], 0)
        self.assertEqual(p["withheld"], 36000)

    def test_wearable_excess_is_not_a_disagreement(self):
        p = self.plan(spread(SAMSUNG, 30000, device="watch"), sensor_raw=4000)
        self.assertFalse(p["disagreement"])
        self.assertEqual(p["extra_wearable"], 26000)

    def _run(self, *, distance, route_points=200, type_="running", minutes=30, origin=STRAVA, method="active"):
        start = datetime(2026, 9, 28, 6, 0, tzinfo=dt_timezone.utc)  # 09:00 EAT
        return {
            "start": start.isoformat(), "end": (start + timedelta(minutes=minutes)).isoformat(),
            "type": type_, "origin": origin, "device": "phone", "method": method,
            "distance_m": distance, "steps": None,
            "route": {"points": route_points, "distance_m": distance} if route_points else None,
        }

    def test_route_verified_workout_verifies_unknown_steps(self):
        ev = {9: {"verified": 0, "shake": 0, "unknown": 5000, "vehicle": 0, "walk": 0}}
        p = self.plan([], sensor_raw=5000, evidence=ev, workouts=[self._run(distance=5000)])
        self.assertEqual(p["workouts"][0]["verdict"], "verified")
        self.assertEqual(p["workout_steps"], 2500)  # half of the hour's steps (30 of 60 min)

    def test_workout_without_route_or_bad_pace_does_not_verify(self):
        ev = {9: {"verified": 0, "shake": 0, "unknown": 5000, "vehicle": 0, "walk": 0}}
        for workout, reason in (
            (self._run(distance=5000, route_points=0), "no_route"),
            (self._run(distance=20000), "pace_not_plausible"),  # 11 m/s: a vehicle
            (self._run(distance=5000, method="manual"), "manual_entry"),
            (self._run(distance=5000, origin=SHADY), "untrusted_app"),
        ):
            p = self.plan([], sensor_raw=5000, evidence=ev, workouts=[workout])
            self.assertEqual(p["workouts"][0]["reason"], reason)
            self.assertEqual(p["workout_steps"], 0)


class CleanPayloadTests(SimpleTestCase):
    def setUp(self):
        self.now = datetime(2026, 9, 29, 9, 30, tzinfo=dt_timezone.utc)  # 12:30 EAT
        self.day = self.now.date()

    def clean(self, raw, platform="android"):
        return hs.clean_payload(raw, platform=platform, day=self.day, tz_offset_minutes=180, now=self.now)

    def test_platform_must_match_session_and_provider(self):
        with self.assertRaises(hs.HealthSourcesError):
            self.clean({"provider": "healthkit", "hours": []}, platform="android")
        with self.assertRaises(hs.HealthSourcesError):
            self.clean({"provider": "health_connect", "platform": "ios", "hours": []}, platform="android")
        with self.assertRaises(hs.HealthSourcesError):
            self.clean({"provider": "fitbit_cloud", "hours": []})
        with self.assertRaises(hs.HealthSourcesError):
            self.clean({"provider": "health_connect", "hours": []}, platform="web")

    def test_caps_future_hours_and_bad_entries(self):
        out = self.clean({
            "provider": "health_connect",
            "hours": [
                H(9, SAMSUNG, 99999),               # clipped to 14,400
                H(15, SAMSUNG, 1000),               # 15:00 local is in the future
                H(25, SAMSUNG, 100),                # not an hour
                {"hour": 8, "origin": "has space", "steps": 5},
                H(9, SAMSUNG, 100, device="toaster"),  # unknown device -> "unknown"
            ],
        })
        self.assertEqual(out["dropped"], 3)
        by_device = {h["device"]: h["steps"] for h in out["hours"]}
        self.assertEqual(by_device, {"phone": 14_400, "unknown": 100})

    def test_too_many_entries_is_rejected(self):
        with self.assertRaises(hs.HealthSourcesError):
            self.clean({"provider": "health_connect", "hours": [H(1, SAMSUNG, 1)] * (hs.MAX_HOUR_ENTRIES + 1)})
        with self.assertRaises(hs.HealthSourcesError):
            self.clean({"provider": "health_connect", "hours": [H(1, f"com.app{i}", 1) for i in range(hs.MAX_ORIGINS + 1)]})

    def test_workout_windows_must_fall_within_the_day(self):
        inside = {"start": "2026-09-29T04:00:00+00:00", "end": "2026-09-29T04:30:00+00:00", "origin": STRAVA, "type": "running", "distance_m": 5000}
        yesterday = {"start": "2026-09-27T04:00:00+00:00", "end": "2026-09-27T04:30:00+00:00", "origin": STRAVA, "type": "running"}
        across_midnight = {"start": "2026-09-28T20:30:00+00:00", "end": "2026-09-28T21:30:00+00:00", "origin": STRAVA, "type": "running", "distance_m": 10000}
        naive = {"start": "2026-09-29T04:00:00", "end": "2026-09-29T04:30:00", "origin": STRAVA}
        out = self.clean({"provider": "health_connect", "workouts": [inside, yesterday, across_midnight, naive]})
        self.assertEqual(out["dropped"], 2)
        self.assertEqual(len(out["workouts"]), 2)
        clipped = out["workouts"][1]
        self.assertEqual(clipped["start"], "2026-09-28T21:00:00+00:00")  # local midnight (EAT)
        self.assertEqual(clipped["distance_m"], 5000.0)  # half the run is on this day


# ── Integration (sync + endpoint) ─────────────────────────────────────────────


class HealthSourcesApiBase(Phase0SyncBase):
    """Uses yesterday's date so the hours used are never in the (local) future."""

    provider = "health_connect"

    def day(self):
        return self.yesterday()

    def upload(self, hours=(), workouts=(), *, day=None, provider=None, tz=180):
        return self.client.post(
            URL,
            {
                "session_id": self.session["session_id"],
                "session_token": self.session["session_token"],
                "date": str(day or self.day()),
                "tz_offset_minutes": tz,
                "health_sources": {
                    "provider": provider or self.provider,
                    "read_at": timezone.now().isoformat(),
                    "hours": list(hours),
                    "workouts": list(workouts),
                },
            },
            format="json",
        )

    def sensor(self, steps, *, bucket="verified"):
        self.age_record(3600 * 6, day=self.day())
        r = self.sync(steps, day=self.day(), evidence_hours=evidence_hours_for(steps, bucket=bucket))
        self.assertEqual(r.status_code, 200, r.content)
        return self.record(self.day())

    def codes(self, record):
        return [r["code"] for r in record.verification["reasons"]]


@override_settings(STEP_MONEY_REQUIRES_EVIDENCE=True)
class AndroidHealthConnectTests(HealthSourcesApiBase):
    def test_manual_and_untrusted_never_count(self):
        self.sensor(3000)
        r = self.upload([H(8, SAMSUNG, 5000, method="manual"), *spread(SHADY, 12000, device="watch")])
        self.assertEqual(r.status_code, 200, r.content)
        rec = self.record(self.day())
        self.assertEqual(rec.steps, 3000)
        self.assertEqual(rec.eligible_steps, 3000)
        self.assertEqual(rec.tier_wearable, 0)
        codes = self.codes(rec)
        self.assertIn("manual_entry_not_counted", codes)
        self.assertIn("untrusted_app_not_counted", codes)
        sources = {s["reason"]: s for s in rec.verification["sources"]}
        self.assertEqual(sources["manual"]["status"], "not_counted")
        self.assertEqual(sources["untrusted"]["label"], "Other app")  # never a raw package id

    def test_watch_steps_fill_the_wearable_tier_without_double_counting(self):
        self.sensor(3000)  # 3,000 verified phone steps at 06:00
        r = self.upload(spread(SAMSUNG, 8000, device="watch", per_hour=4000))  # 06:00-07:00
        self.assertEqual(r.status_code, 200, r.content)
        rec = self.record(self.day())
        self.assertEqual(rec.steps, 8000)  # max(3,000, 8,000), not 11,000
        self.assertEqual(rec.tier_wearable, 8000)
        self.assertEqual(rec.tier_sensor_verified, 0)  # the phone's steps are the same steps
        self.assertEqual(rec.eligible_steps, 8000)
        self.assertIn("wearable_verified", self.codes(rec))
        self.assertEqual(rec.anticheat["health"]["applied_wearable_extra"], 5000)

    def test_later_sensor_syncs_never_compound_the_extra(self):
        self.sensor(3000)
        self.upload(spread(SAMSUNG, 8000, device="watch", per_hour=4000))
        rec = self.sensor(5000)
        self.assertEqual(rec.steps, 8000)
        rec = self.sensor(9000)
        self.assertEqual(rec.steps, 9000)  # the sensor passed the watch: max, not sum
        self.assertEqual(rec.anticheat["health"]["applied_extra"], 0)
        self.assertEqual(rec.last_raw_steps, 9000)

    def test_phone_app_corroborates_unmeasured_sensor_steps(self):
        self.sensor(3000, bucket="unknown")  # app couldn't judge these steps (hour 06)
        rec = self.record(self.day())
        self.assertEqual(rec.eligible_steps, 0)
        self.upload([H(6, SAMSUNG, 3200)])
        rec = self.record(self.day())
        self.assertEqual(rec.steps, 3200)  # Samsung saw 200 more: goals only
        self.assertEqual(rec.tier_sensor_verified, 3000)
        self.assertEqual(rec.eligible_steps, 3000)
        codes = self.codes(rec)
        self.assertIn("health_app_confirmed", codes)
        self.assertIn("health_app_not_verified", codes)

    def test_disagreement_is_a_review_signal_not_a_punishment(self):
        self.sensor(4000)
        trust_before = TrustScore.objects.get(user=self.user).score
        self.upload(spread(SAMSUNG, 40000))
        rec = self.record(self.day())
        self.assertEqual(rec.steps, 4000)  # the excess is withheld
        self.assertEqual(rec.eligible_steps, 4000)  # our own verified steps still count
        self.assertFalse(rec.is_suspicious)
        self.assertIn("sources_disagree_under_review", self.codes(rec))
        flag = FraudFlag.objects.get(user=self.user, flag_type="health_sources_disagree")
        self.assertEqual(flag.severity, "medium")
        self.assertEqual(TrustScore.objects.get(user=self.user).score, trust_before)
        for reason in rec.verification["reasons"]:
            for word in INTERNAL_WORDS:
                self.assertNotIn(word, reason["user_message"].lower())

    def test_route_verified_run_counts_like_a_walk(self):
        self.sensor(5000, bucket="unknown")  # hour 06 local
        start = datetime.combine(self.day(), datetime.min.time(), tzinfo=dt_timezone.utc) + timedelta(hours=3)  # 06:00 EAT
        run = {"start": start.isoformat(), "end": (start + timedelta(minutes=40)).isoformat(), "type": "running",
               "origin": STRAVA, "device": "phone", "method": "active", "distance_m": 6000, "steps": 5000,
               "route": {"points": 400, "distance_m": 5950}}
        self.assertEqual(self.upload([], [run]).status_code, 200)
        rec = self.record(self.day())
        self.assertEqual(rec.tier_walk_session, 5000)
        self.assertIn("workout_verified", self.codes(rec))

    def test_ios_provider_rejected_for_android_session(self):
        r = self.upload([H(6, "com.apple.health.X", 3000, device="watch")], provider="healthkit")
        self.assertEqual(r.status_code, 400)
        self.assertFalse(HealthSourceDay.objects.filter(user=self.user).exists())

    def test_session_is_required(self):
        r = self.client.post(URL, {"session_id": "00000000-0000-0000-0000-000000000000", "session_token": "x",
                                   "date": str(self.day()), "health_sources": {"provider": "health_connect"}}, format="json")
        self.assertEqual(r.status_code, 403)

    def test_watch_only_day_then_first_sensor_sync_is_not_penalised(self):
        self.upload(spread(SAMSUNG, 7000, device="watch"))
        rec = self.record(self.day())
        self.assertEqual(rec.steps, 7000)
        self.assertEqual(rec.eligible_steps, 7000)
        rec = self.sensor(2000)
        self.assertEqual(rec.unverified_steps, 0)
        self.assertEqual(rec.last_raw_steps, 2000)
        self.assertEqual(rec.steps, 7000)

    def test_remove_imported_data_reverts_to_the_sensor(self):
        self.sensor(3000)
        self.upload(spread(SAMSUNG, 8000, device="watch"))
        self.assertEqual(self.client.get(URL).json()["days"][0]["wearable_steps"], 8000)
        r = self.client.delete(URL)
        self.assertEqual(r.status_code, 200)
        rec = self.record(self.day())
        self.assertEqual(rec.steps, 3000)
        self.assertEqual(rec.tier_wearable, 0)
        self.assertNotIn("health", rec.anticheat)
        self.assertEqual(self.client.get(URL).json()["days"], [])

    def test_summary_can_ride_along_with_the_sync(self):
        self.age_record(3600 * 6, day=self.day())
        r = self.sync(3000, day=self.day(), evidence_hours=evidence_hours_for(3000),
                      health_sources={"provider": "health_connect", "hours": spread(SAMSUNG, 6000, device="watch")})
        self.assertEqual(r.status_code, 200, r.content)
        rec = self.record(self.day())
        self.assertEqual(rec.steps, 6000)
        self.assertEqual(rec.tier_wearable, 6000)
        # A bad summary never fails the step sync.
        r = self.sync(3500, day=self.day(), evidence_hours=evidence_hours_for(3500),
                      health_sources={"provider": "healthkit", "hours": []})
        self.assertEqual(r.status_code, 200, r.content)


class EvidenceRuleOffTests(HealthSourcesApiBase):
    """STEP_MONEY_REQUIRES_EVIDENCE off (the default): every credited step counts toward
    challenges, except steps only another phone app counted."""

    def test_phone_app_extra_stays_goals_only_when_rule_is_off(self):
        self.sensor(3000, bucket="unknown")
        self.upload([H(6, SAMSUNG, 3000), H(7, SAMSUNG, 2000)])
        rec = self.record(self.day())
        self.assertEqual(rec.steps, 5000)
        self.assertEqual(rec.eligible_steps, 3000)
        self.assertIn("health_app_not_verified", self.codes(rec))

    def test_wearable_extra_counts_when_rule_is_off(self):
        self.sensor(3000, bucket="unknown")
        self.upload(spread(SAMSUNG, 9000, device="watch"))
        rec = self.record(self.day())
        self.assertEqual(rec.steps, 9000)
        self.assertEqual(rec.eligible_steps, 9000)


@override_settings(STEP_MONEY_REQUIRES_EVIDENCE=True)
class IosHealthKitTests(HealthSourcesApiBase):
    platform = "ios"
    provider = "healthkit"

    def test_apple_watch_is_wearable_and_iphone_is_not_double_counted(self):
        self.sensor(4000)
        self.upload([
            H(6, "com.apple.health.AAAA-IPHONE", 4000, device="phone"),
            H(6, "com.apple.health.BBBB-WATCH", 4200, device="watch"),
            H(7, "com.apple.health.BBBB-WATCH", 3000, device="watch"),
        ])
        rec = self.record(self.day())
        self.assertEqual(rec.steps, 7200)  # max per hour: 4,200 + 3,000
        self.assertEqual(rec.tier_wearable, 7200)
        self.assertEqual(rec.eligible_steps, 7200)

    def test_user_entered_steps_are_not_counted(self):
        self.sensor(4000)
        self.upload([H(8, "com.apple.health.AAAA-IPHONE", 9000, method="manual")])
        rec = self.record(self.day())
        self.assertEqual(rec.steps, 4000)
        self.assertIn("manual_entry_not_counted", self.codes(rec))

    def test_health_connect_rejected_for_ios_session(self):
        self.assertEqual(self.upload([H(6, SAMSUNG, 100)], provider="health_connect").status_code, 400)


class AccountDeletionTests(HealthSourcesApiBase):
    def test_account_deletion_removes_imported_health_data(self):
        from apps.users.account_deletion import _delete_activity_data

        self.sensor(3000)
        self.upload(spread(SAMSUNG, 5000, device="watch"))
        self.assertTrue(HealthSourceDay.objects.filter(user=self.user).exists())
        counts = _delete_activity_data(self.user)
        self.assertEqual(counts["health_sources"], 1)
        self.assertFalse(HealthSourceDay.objects.filter(user=self.user).exists())
        self.assertFalse(HealthRecord.objects.filter(user=self.user).exists())


class AdminAllowlistTests(HealthSourcesApiBase):
    def test_admin_allowlist_is_used_and_validated(self):
        from apps.admin_api.models import SystemSettings
        from apps.admin_api.serializers import SystemSettingsSerializer

        s = SystemSettings.load()
        s.health_trusted_origins = "com.sec.android.app.shealth  # Samsung Health\n"
        s.save()
        self.sensor(3000)
        self.upload([*spread(SAMSUNG, 6000, device="watch"), H(9, "com.fitbit.FitbitMobile", 3000, device="band")])
        rec = self.record(self.day())
        self.assertEqual(rec.tier_wearable, 6000)  # Fitbit isn't on this admin's list
        bad = SystemSettingsSerializer(data={"health_trusted_origins": "com.x yes please"}, partial=True)
        self.assertFalse(bad.is_valid())
        good = SystemSettingsSerializer(data={"health_trusted_origins": "com.x wearable # X\ncom.y.*"}, partial=True)
        self.assertTrue(good.is_valid(), good.errors)
