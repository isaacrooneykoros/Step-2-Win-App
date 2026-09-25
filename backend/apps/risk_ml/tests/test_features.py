"""Pure feature computation: known inputs -> known features (no database)."""

from datetime import date, datetime, timedelta, timezone as dt_timezone

from django.test import SimpleTestCase

from apps.risk_ml.features import (AccountCtx, ChallengeCtx, DayInputs, SyncObs,
                                   Waypoint, compute_day_features, share_l1,
                                   twin_counts)

DAY = date(2026, 9, 10)  # a Thursday


def utc(day, hour, minute=0):
    return datetime(day.year, day.month, day.day, tzinfo=dt_timezone.utc) + timedelta(hours=hour - 3, minutes=minute)


def hourly(**kw):
    out = [0] * 24
    for k, v in kw.items():
        out[int(k[1:])] = v
    return out


class VolumeAndTimingTests(SimpleTestCase):
    def test_robust_baseline_ratio_and_z(self):
        history = [(DAY - timedelta(days=i), 5000 + (i % 3) * 100) for i in range(1, 11)]  # 5000/5100/5200
        f = compute_day_features(DayInputs(day=DAY, steps=17000, history=history))
        self.assertEqual(f["history_days"], 10)
        self.assertEqual(f["user_median_steps"], 5100.0)
        self.assertEqual(f["user_mad_steps"], 100.0)
        self.assertAlmostEqual(f["steps_ratio_to_median"], 17000 / 5100, places=3)
        # scale = max(1.4826 * 100, 0.1 * 5100, 500) = 510
        self.assertAlmostEqual(f["steps_robust_z"], (17000 - 5100) / 510, places=3)
        self.assertEqual(f["dow"], 3)
        self.assertEqual(f["is_weekend"], 0)

    def test_no_baseline_for_new_user(self):
        f = compute_day_features(DayInputs(day=DAY, steps=9000, history=[(DAY - timedelta(days=1), 8000)]))
        self.assertIsNone(f["steps_ratio_to_median"])
        self.assertIsNone(f["steps_robust_z"])

    def test_hourly_distribution(self):
        h = hourly(h1=3000, h2=3000, h3=3200, h10=800)
        f = compute_day_features(DayInputs(day=DAY, steps=10000, hourly=h))
        self.assertEqual(f["hourly_total"], 10000)
        self.assertAlmostEqual(f["night_share"], 0.92)
        self.assertEqual(f["max_hour_steps"], 3200)
        self.assertEqual(f["active_hours"], 4)
        self.assertEqual(f["longest_active_span_h"], 3)
        self.assertGreater(f["hour_entropy"], 0.0)
        self.assertLess(f["hour_entropy"], 0.5)

    def test_even_spread_has_max_entropy(self):
        f = compute_day_features(DayInputs(day=DAY, steps=24000, hourly=[1000] * 24))
        self.assertAlmostEqual(f["hour_entropy"], 1.0, places=4)
        self.assertEqual(f["longest_active_span_h"], 24)

    def test_identical_previous_curve_and_repeated_total(self):
        h = hourly(h7=2000, h12=3000, h17=5000)
        prev = {DAY - timedelta(days=1): list(h), DAY - timedelta(days=2): hourly(h8=4000, h18=6000)}
        hist = [(DAY - timedelta(days=1), 10000), (DAY - timedelta(days=2), 10000), (DAY - timedelta(days=3), 9000)]
        f = compute_day_features(DayInputs(day=DAY, steps=10000, hourly=h, prev_hourly=prev, history=hist))
        self.assertEqual(f["curve_l1_min_prev"], 0.0)
        self.assertEqual(f["total_repeat_7d"], 2)
        self.assertEqual(f["round_total"], 1)

    def test_share_l1(self):
        self.assertEqual(share_l1([1, 1], [2, 2]), 0.0)
        self.assertAlmostEqual(share_l1([1, 0], [0, 1]), 2.0)
        self.assertIsNone(share_l1([0, 0], [1, 1]))


class SyncAndGaitTests(SimpleTestCase):
    def test_sync_counts_gaps_and_late_share(self):
        syncs = [
            SyncObs(created_at=utc(DAY, 8), steps=1000),
            SyncObs(created_at=utc(DAY, 12), steps=4000),
            SyncObs(created_at=utc(DAY, 13), accepted=False),
            SyncObs(created_at=utc(DAY, 14), replay=True, accepted=False),
            SyncObs(created_at=utc(DAY + timedelta(days=2), 9), steps=6000),  # 2 days late
        ]
        f = compute_day_features(DayInputs(day=DAY, steps=6000, syncs=syncs))
        self.assertEqual(f["sync_count"], 5)
        self.assertEqual(f["accepted_sync_count"], 3)
        self.assertEqual(f["rejected_count"], 1)
        self.assertEqual(f["replay_count"], 1)
        self.assertAlmostEqual(f["late_sync_share"], 0.2)
        self.assertEqual(f["days_late_max"], 2)
        self.assertEqual(f["steps_raw_max"], 6000)
        self.assertAlmostEqual(f["max_sync_gap_h"], 43.0)

    def test_gait_stats(self):
        syncs = [
            SyncObs(created_at=utc(DAY, 9), gait_confidence=0.8, shake_prob=0.1, cadence=110, burst_5s=10,
                    carry_mode="pocket", ml_label="walk"),
            SyncObs(created_at=utc(DAY, 10), gait_confidence=0.4, shake_prob=0.7, cadence=190, burst_5s=40,
                    carry_mode="in_hand", ml_label="shake"),
            SyncObs(created_at=utc(DAY, 11)),  # iOS / no motion sample
        ]
        f = compute_day_features(DayInputs(day=DAY, steps=5000, syncs=syncs))
        self.assertEqual(f["gait_sync_count"], 2)
        self.assertAlmostEqual(f["gait_sync_share"], 0.667)
        self.assertAlmostEqual(f["gait_conf_mean"], 0.6)
        self.assertAlmostEqual(f["gait_conf_min"], 0.4)
        self.assertAlmostEqual(f["shake_prob_mean"], 0.4)
        self.assertAlmostEqual(f["shake_prob_max"], 0.7)
        self.assertAlmostEqual(f["cadence_mean"], 150.0)
        self.assertAlmostEqual(f["cadence_std"], 40.0)
        self.assertAlmostEqual(f["burst_max"], 40.0)
        self.assertAlmostEqual(f["carry_pocket_share"], 0.5)
        self.assertAlmostEqual(f["carry_in_hand_share"], 0.5)
        self.assertAlmostEqual(f["ml_shake_label_share"], 0.5)

    def test_ios_day_has_no_gait(self):
        f = compute_day_features(DayInputs(day=DAY, steps=5000, syncs=[SyncObs(created_at=utc(DAY, 20))]))
        self.assertEqual(f["gait_sync_share"], 0.0)
        self.assertIsNone(f["gait_conf_mean"])


class RouteTests(SimpleTestCase):
    def _line(self, hour, n, km_per_step, seconds=30):
        pts, lat = [], -1.28
        for i in range(n):
            pts.append(Waypoint(recorded_at=utc(DAY, hour) + timedelta(seconds=seconds * i), lat=lat, lon=36.8,
                                accuracy_m=10, hour=hour))
            lat += km_per_step / 111.0
        return pts

    def test_walking_route_distance_and_ratio(self):
        # 21 fixes, 20 segments of 35 m every 30 s = 0.7 km at 4.2 km/h, during an hour with 1000 steps.
        pts = self._line(9, 21, 0.035)
        f = compute_day_features(DayInputs(day=DAY, steps=1000, hourly=hourly(h9=1000), waypoints=pts))
        self.assertEqual(f["waypoint_count"], 21)
        self.assertAlmostEqual(f["route_km"], 0.7, places=2)
        self.assertAlmostEqual(f["route_km_per_1k_steps"], 0.7, places=2)
        self.assertAlmostEqual(f["speed_p95_kmh"], 4.2, places=1)
        self.assertEqual(f["vehicle_step_share"], 0.0)
        for key, value in f.items():  # privacy: no coordinates in the feature store
            self.assertNotIn(key, {"lat", "lon", "latitude", "longitude"})
            self.assertNotEqual(value, -1.28)
            self.assertNotEqual(value, 36.8)

    def test_vehicle_speed_steps(self):
        pts = self._line(8, 40, 0.4)  # 0.4 km per 30 s = 48 km/h
        f = compute_day_features(DayInputs(day=DAY, steps=4000, hourly=hourly(h8=3000, h12=1000), waypoints=pts))
        self.assertGreater(f["speed_p95_kmh"], 40)
        self.assertAlmostEqual(f["vehicle_step_share"], 0.75)

    def test_gps_jump_and_bad_accuracy_ignored(self):
        pts = self._line(9, 5, 0.035)
        pts.append(Waypoint(recorded_at=pts[-1].recorded_at + timedelta(seconds=30), lat=0.0, lon=0.0,
                            accuracy_m=10, hour=9))  # 150 km jump: glitch
        pts.append(Waypoint(recorded_at=pts[-1].recorded_at + timedelta(seconds=30), lat=-1.0, lon=36.0,
                            accuracy_m=500, hour=9))  # poor accuracy: dropped
        f = compute_day_features(DayInputs(day=DAY, steps=1000, hourly=hourly(h9=1000), waypoints=pts))
        self.assertAlmostEqual(f["route_km"], 0.14, places=2)


class AccountMoneyAndTwinTests(SimpleTestCase):
    def test_account_context_passthrough(self):
        acc = AccountCtx(account_age_days=3.5, devices_per_account=2, max_accounts_per_device=3,
                         mpesa_shared_accounts=1, phone_prefix_cluster=4)
        f = compute_day_features(DayInputs(day=DAY, account=acc, twin_count=2))
        self.assertEqual((f["account_age_days"], f["devices_per_account"], f["max_accounts_per_device"],
                          f["mpesa_shared_accounts"], f["phone_prefix_cluster"], f["twin_count"]),
                         (3.5, 2, 3, 1, 4, 2))

    def test_money_context_and_deadline_surge(self):
        history = [(DAY - timedelta(days=i), 4000) for i in range(1, 11)]
        ch = ChallengeCtx(entry_fee=200.0, milestone=30000, start=DAY - timedelta(days=6), end=DAY + timedelta(days=1),
                          steps_before_day=24000)
        f = compute_day_features(DayInputs(day=DAY, steps=12000, history=history, challenges=[ch]))
        self.assertEqual(f["in_paid_challenge"], 1)
        self.assertEqual(f["entry_fee_exposure_kes"], 200.0)
        self.assertEqual(f["days_to_deadline"], 1)
        self.assertEqual(f["milestone_gap_before"], 6000)
        self.assertEqual(f["milestone_share_today"], 2.0)
        self.assertEqual(f["crossed_milestone_today"], 1)
        self.assertAlmostEqual(f["deadline_surge_ratio"], 3.0)

    def test_no_challenge(self):
        f = compute_day_features(DayInputs(day=DAY, steps=100))
        self.assertEqual(f["in_challenge"], 0)
        self.assertIsNone(f["days_to_deadline"])
        self.assertEqual(f["deadline_surge_ratio"], 0.0)

    def test_twin_counts(self):
        base = [0] * 7 + [1000, 2000, 500, 0, 0, 800, 0, 0, 0, 1500, 900] + [0] * 6
        jitter = [v + (5 if v else 0) for v in base]
        other = [0] * 6 + [3000, 0, 0, 1000, 2000, 0, 0, 0, 1000, 1000, 0, 0] + [0] * 6
        small = [10] * 24  # below the minimum steps: never a twin
        counts = twin_counts({1: base, 2: jitter, 3: [v * 2 for v in base], 4: other, 5: small, 6: list(small)})
        self.assertEqual(counts[1], 2)
        self.assertEqual(counts[2], 2)
        self.assertEqual(counts[3], 2)
        self.assertEqual(counts[4], 0)
        self.assertEqual(counts[5], 0)
