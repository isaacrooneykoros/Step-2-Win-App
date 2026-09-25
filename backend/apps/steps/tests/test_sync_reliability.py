"""
Step sync reliability under retries, reordering, long offline periods and load.

Covers the phone <-> server contract the smart background sync relies on:
- session-authenticated syncs pass the signature middleware (the app's protocol)
- resubmitting the same reading never double-counts (idempotent retry)
- an older reading arriving after a newer one never lowers the total
- several days can be caught up one after another
- throttling answers 429 with a Retry-After the phone can honour
"""

import uuid
from datetime import timedelta
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.utils import timezone
from rest_framework.test import APITestCase
from rest_framework_simplejwt.tokens import RefreshToken

from apps.core.throttles import (StepHourlySyncRateThrottle,
                                 StepSyncGlobalThrottle, StepSyncRateThrottle)
from apps.steps.models import (FraudFlag, HealthRecord, HourlyStepRecord,
                               StepSession, StepSyncEvent)

User = get_user_model()


class SyncReliabilityBase(APITestCase):
    def setUp(self):
        cache.clear()
        self.user = User.objects.create_user(
            username="reliable_sync_user",
            email="reliable_sync_user@example.com",
            password="TestPass123!",
            device_id="reliable-device",
            device_platform="android",
        )
        self.client.credentials(
            HTTP_AUTHORIZATION=f"Bearer {RefreshToken.for_user(self.user).access_token}"
        )
        # The 1-request-per-second tick is tested on its own below.
        tick = patch("apps.steps.views._allow_sync_tick", return_value=True)
        tick.start()
        self.addCleanup(tick.stop)
        self.session = self._start_session()
        self.sequence = self.session["sequence_start"]

    def _start_session(self):
        response = self.client.post(
            "/api/steps/session/start/",
            {
                "device_id": "reliable-device",
                "platform": "android",
                "app_version": "1.0.0",
                "ml_model_version": "shakewalk-logreg-v1",
            },
            format="json",
        )
        self.assertIn(response.status_code, (200, 201), response.content)
        return response.json()

    def _payload(self, steps, *, day=None, event_id=None, ts=None, session=None):
        session = session or self.session
        payload = {
            "date": str(day or timezone.now().date()),
            "source": "device_sensor",
            "steps": steps,
            # Derived the way the phone derives them (stride 78 cm, ~120 steps/min).
            "distance_km": round(steps * 0.00078, 2),
            "active_minutes": max(1, round(steps / 120)),
            "calories_active": max(1, round(steps * 0.04)),
            "steps_total": steps,
            "steps_delta": steps,
            "session_id": session["session_id"],
            "session_token": session["session_token"],
            "client_event_id": event_id or str(uuid.uuid4()),
            "sequence_number": self.sequence,
            "timestamp_client": (ts or timezone.now()).isoformat(),
        }
        self.sequence += 1
        return payload

    def _sync(self, payload):
        return self.client.post("/api/steps/sync/", payload, format="json")


class SessionAuthenticatedSyncTests(SyncReliabilityBase):
    def test_session_sync_is_accepted_without_app_signature(self):
        response = self._sync(self._payload(1200))
        self.assertEqual(response.status_code, 200, response.content)
        body = response.json()
        self.assertEqual(body["verification_level"], "session_verified")
        self.assertEqual(body["submitted_steps"], 1200)
        # The day stores the anti-cheat approved figure.
        self.assertEqual(HealthRecord.objects.get(user=self.user).steps, body["approved_steps"])
        self.assertGreater(body["approved_steps"], 0)

    def test_unsigned_sync_without_session_is_still_rejected(self):
        response = self.client.post(
            "/api/steps/sync/",
            {"date": str(timezone.now().date()), "steps": 500},
            format="json",
        )
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()["code"], "MISSING_SIGNATURE")

    def test_forged_session_token_is_rejected(self):
        payload = self._payload(800)
        payload["session_token"] = "not-the-real-token"
        response = self._sync(payload)
        self.assertEqual(response.status_code, 401)
        self.assertFalse(HealthRecord.objects.filter(user=self.user).exists())

    def test_future_date_is_rejected(self):
        day = timezone.now().date() + timedelta(days=3)
        response = self._sync(self._payload(100, day=day))
        self.assertEqual(response.status_code, 400)


class IdempotentResubmissionTests(SyncReliabilityBase):
    def test_same_reading_twice_is_counted_once(self):
        ts = timezone.now()
        first = self._payload(1500, event_id="evt-1", ts=ts)
        response = self._sync(first)
        self.assertEqual(response.status_code, 200)
        approved = response.json()["approved_steps"]

        # Exact retry (response was lost): same body.
        retry = dict(first)
        response = self._sync(retry)
        self.assertEqual(response.status_code, 200, response.content)
        self.assertTrue(response.json().get("duplicate"))

        # Retry after the phone re-attached a newer sequence number: still the same reading.
        retry2 = self._payload(1500, event_id="evt-1", ts=ts)
        response = self._sync(retry2)
        self.assertEqual(response.status_code, 200, response.content)
        self.assertTrue(response.json().get("duplicate"))

        self.assertEqual(HealthRecord.objects.get(user=self.user).steps, approved)
        self.assertEqual(
            StepSyncEvent.objects.filter(user=self.user, accepted=True).count(), 1
        )
        self.assertEqual(
            StepSyncEvent.objects.filter(user=self.user, replay_detected=True).count(), 0
        )
        session = StepSession.objects.get(id=self.session["session_id"])
        self.assertEqual(session.status, "active")
        self.assertEqual(session.total_steps, 1500)

    def test_reused_event_id_with_different_reading_is_still_a_replay(self):
        response = self._sync(self._payload(1000, event_id="evt-x"))
        self.assertEqual(response.status_code, 200)
        approved = response.json()["approved_steps"]
        tampered = self._payload(1100, event_id="evt-x")
        response = self._sync(tampered)
        # Detected as a replay (and no server error from the duplicate id).
        self.assertEqual(response.status_code, 400, response.content)
        self.assertTrue(response.json().get("replay_detected"))
        self.assertEqual(HealthRecord.objects.get(user=self.user).steps, approved)

    def test_retry_after_session_renewal_is_accepted(self):
        StepSession.objects.filter(id=self.session["session_id"]).update(
            expires_at=timezone.now() - timedelta(minutes=1)
        )
        ts = timezone.now()
        response = self._sync(self._payload(900, event_id="evt-renew", ts=ts))
        self.assertEqual(response.status_code, 400)

        self.session = self._start_session()
        self.sequence = self.session["sequence_start"]
        response = self._sync(self._payload(900, event_id="evt-renew", ts=ts))
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()["submitted_steps"], 900)
        self.assertTrue(HealthRecord.objects.filter(user=self.user).exists())


class OutOfOrderUploadTests(SyncReliabilityBase):
    def test_older_reading_arriving_late_does_not_reduce_total(self):
        t_old = timezone.now() - timedelta(minutes=20)
        t_new = timezone.now()
        newer = self._payload(2000, ts=t_new)
        older = self._payload(1800, ts=t_old)

        response = self._sync(newer)
        self.assertEqual(response.status_code, 200)
        approved = response.json()["approved_steps"]
        response = self._sync(older)
        self.assertEqual(response.status_code, 200, response.content)
        self.assertTrue(response.json().get("stale"))
        self.assertEqual(HealthRecord.objects.get(user=self.user).steps, approved)
        self.assertFalse(
            FraudFlag.objects.filter(user=self.user, flag_type="non_monotonic_steps").exists()
        )

    def test_newer_reading_with_lower_total_is_still_flagged(self):
        t1 = timezone.now() - timedelta(minutes=5)
        response = self._sync(self._payload(2000, ts=t1))
        self.assertEqual(response.status_code, 200)
        approved = response.json()["approved_steps"]
        # A *newer* reading with far fewer steps is still treated as tampering.
        response = self._sync(self._payload(500, ts=timezone.now()))
        self.assertEqual(response.status_code, 400)
        self.assertTrue(
            FraudFlag.objects.filter(user=self.user, flag_type="non_monotonic_steps").exists()
        )
        self.assertEqual(HealthRecord.objects.get(user=self.user).steps, approved)

    def test_hourly_bucket_never_goes_down(self):
        day = str(timezone.now().date())
        newer = {"date": day, "hourly": [{"hour": 9, "steps": 600}], "waypoints": []}
        older = {"date": day, "hourly": [{"hour": 9, "steps": 250}], "waypoints": []}
        self.assertEqual(
            self.client.post("/api/steps/sync/hourly/", newer, format="json").status_code, 200
        )
        self.assertEqual(
            self.client.post("/api/steps/sync/hourly/", older, format="json").status_code, 200
        )
        self.assertEqual(
            HourlyStepRecord.objects.get(user=self.user, date=day, hour=9).steps, 600
        )


class MultiDayCatchUpTests(SyncReliabilityBase):
    def test_week_offline_is_caught_up_day_by_day(self):
        today = timezone.now().date()
        approved = {}
        for offset in range(6, -1, -1):
            day = today - timedelta(days=offset)
            response = self._sync(self._payload(3000 + offset * 100, day=day))
            self.assertEqual(response.status_code, 200, (day, response.content))
            approved[day] = response.json()["approved_steps"]
            hourly = {
                "date": str(day),
                "hourly": [{"hour": h, "steps": 100} for h in range(8, 20)],
                "waypoints": [],
            }
            response = self.client.post("/api/steps/sync/hourly/", hourly, format="json")
            self.assertEqual(response.status_code, 200, response.content)

        self.assertEqual(HealthRecord.objects.filter(user=self.user).count(), 7)
        self.assertEqual(HourlyStepRecord.objects.filter(user=self.user).count(), 7 * 12)
        for day, steps in approved.items():
            self.assertEqual(HealthRecord.objects.get(user=self.user, date=day).steps, steps)

    def test_hourly_payload_caps(self):
        day = str(timezone.now().date())
        too_many_hours = {
            "date": day,
            "hourly": [{"hour": h % 24, "steps": 1} for h in range(30)],
            "waypoints": [],
        }
        response = self.client.post("/api/steps/sync/hourly/", too_many_hours, format="json")
        self.assertEqual(response.status_code, 413)

        future = {
            "date": str(timezone.now().date() + timedelta(days=5)),
            "hourly": [{"hour": 1, "steps": 1}],
            "waypoints": [],
        }
        response = self.client.post("/api/steps/sync/hourly/", future, format="json")
        self.assertEqual(response.status_code, 400)


class SyncThrottleTests(SyncReliabilityBase):
    def _assert_retry_after(self, response):
        self.assertEqual(response.status_code, 429, response.content)
        retry_after = response.headers.get("Retry-After")
        self.assertIsNotNone(retry_after)
        self.assertGreaterEqual(int(retry_after), 1)

    def test_per_user_burst_limit_returns_retry_after(self):
        with patch.object(StepSyncRateThrottle, "THROTTLE_RATES", {"step_sync": "2/minute"}):
            self.assertEqual(self._sync(self._payload(100)).status_code, 200)
            self.assertEqual(self._sync(self._payload(150)).status_code, 200)
            self._assert_retry_after(self._sync(self._payload(180)))
        # The throttled reading was not applied (the phone keeps it and retries later).
        self.assertFalse(
            StepSyncEvent.objects.filter(user=self.user, raw_steps_total=180).exists()
        )

    def test_hourly_limit_returns_retry_after(self):
        day = str(timezone.now().date())
        body = {"date": day, "hourly": [{"hour": 1, "steps": 1}], "waypoints": []}
        with patch.object(
            StepHourlySyncRateThrottle, "THROTTLE_RATES", {"step_sync_hourly": "1/minute"}
        ):
            self.assertEqual(
                self.client.post("/api/steps/sync/hourly/", body, format="json").status_code,
                200,
            )
            self._assert_retry_after(
                self.client.post("/api/steps/sync/hourly/", body, format="json")
            )

    def test_global_load_shedding_returns_spread_retry_after(self):
        with patch.object(StepSyncGlobalThrottle, "default_rate", "2/minute"):
            self.assertEqual(self._sync(self._payload(100)).status_code, 200)
            self.assertEqual(self._sync(self._payload(150)).status_code, 200)
            response = self._sync(self._payload(180))
            self._assert_retry_after(response)
            # Shed requests are spread beyond the window so the herd doesn't return at once.
            self.assertLessEqual(int(response.headers["Retry-After"]), 60 + 61)

    def test_one_per_second_tick_includes_retry_after(self):
        with patch("apps.steps.views._allow_sync_tick", return_value=False):
            response = self._sync(self._payload(100))
        self.assertEqual(response.status_code, 429)
        self.assertEqual(response.headers.get("Retry-After"), "2")
