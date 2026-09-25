"""Scheduled jobs: due logic, lease, runner, triggers, admin views and ticker gating."""

import threading
import time
from datetime import datetime, timedelta
from datetime import timezone as dt_timezone
from unittest.mock import patch
from zoneinfo import ZoneInfo

from celery.schedules import crontab
from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.test import TestCase, TransactionTestCase, override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from apps.admin_api import jobs_views, scheduler
from apps.admin_api.job_ticker import (JobTicker, is_daphne_process,
                                       should_start, start_ticker_if_enabled)
from apps.admin_api.models import AuditLog, ScheduledJobState

User = get_user_model()
UTC = dt_timezone.utc

CALLS: list[str] = []


def fake_ok():
    CALLS.append("ok")
    return {"done": 1}


def fake_other():
    CALLS.append("other")
    return "other done"


def fake_boom():
    CALLS.append("boom")
    raise RuntimeError("kaboom")


def fake_slow():
    CALLS.append("slow")
    time.sleep(0.3)
    return "slow done"


def _schedule(**entries):
    return {name: {"task": f"apps.admin_api.test_scheduled_jobs.{task}", "schedule": sched} for name, (task, sched) in entries.items()}


def at(y, m, d, hh=0, mm=0, ss=0, tz=UTC):
    return datetime(y, m, d, hh, mm, ss, tzinfo=tz)


class DueLogicTests(TestCase):
    def test_first_run_is_due(self):
        self.assertTrue(scheduler.is_due(crontab(hour=2, minute=0), None, at(2026, 9, 25, 10)))

    def test_interval_crontab(self):
        every5 = crontab(minute="*/5")
        last = at(2026, 9, 25, 10, 0, 30)
        self.assertFalse(scheduler.is_due(every5, last, at(2026, 9, 25, 10, 4, 59)))
        self.assertTrue(scheduler.is_due(every5, last, at(2026, 9, 25, 10, 5, 0)))
        self.assertTrue(scheduler.is_due(every5, last, at(2026, 9, 25, 10, 7, 0)))
        self.assertEqual(scheduler.next_run_at(every5, last, at(2026, 9, 25, 10, 2)), at(2026, 9, 25, 10, 5))

    def test_daily_crontab(self):
        daily = crontab(hour=0, minute=5)
        last = at(2026, 9, 24, 0, 5, 10)
        self.assertFalse(scheduler.is_due(daily, last, at(2026, 9, 24, 23, 59)))
        self.assertFalse(scheduler.is_due(daily, last, at(2026, 9, 25, 0, 4, 59)))
        self.assertTrue(scheduler.is_due(daily, last, at(2026, 9, 25, 0, 5)))
        self.assertEqual(scheduler.nominal_interval(daily, at(2026, 9, 25, 12)), timedelta(days=1))
        self.assertEqual(scheduler.nominal_interval(crontab(minute="*/30"), at(2026, 9, 25, 12, 1)), timedelta(minutes=30))

    def test_catch_up_after_gap_runs_once(self):
        daily = crontab(hour=0, minute=5)
        # Server asleep for three days: due now, once.
        last = at(2026, 9, 21, 0, 5)
        now = at(2026, 9, 24, 9, 0)
        self.assertTrue(scheduler.is_due(daily, last, now))
        # After the catch-up run it waits for the next slot, not for the missed ones.
        self.assertFalse(scheduler.is_due(daily, now, now + timedelta(minutes=1)))
        self.assertFalse(scheduler.is_due(daily, now, at(2026, 9, 25, 0, 4)))
        self.assertTrue(scheduler.is_due(daily, now, at(2026, 9, 25, 0, 5)))

    def test_timezone_of_inputs_does_not_matter(self):
        """Schedules are UTC (CELERY_TIMEZONE); aware datetimes in any zone give the same answer."""
        daily = crontab(hour=0, minute=5)
        nairobi = ZoneInfo("Africa/Nairobi")  # UTC+3
        last = at(2026, 9, 24, 3, 5, 10, tz=nairobi)  # = 00:05:10 UTC
        self.assertFalse(scheduler.is_due(daily, last, at(2026, 9, 25, 3, 4, tz=nairobi)))  # 00:04 UTC
        self.assertTrue(scheduler.is_due(daily, last, at(2026, 9, 25, 3, 5, tz=nairobi)))  # 00:05 UTC

    def test_weekly_crontab(self):
        monday = crontab(hour=0, minute=0, day_of_week=1)
        last = at(2026, 9, 21, 0, 0, 20)  # Monday
        self.assertFalse(scheduler.is_due(monday, last, at(2026, 9, 27, 23, 59)))
        self.assertTrue(scheduler.is_due(monday, last, at(2026, 9, 28, 0, 0)))

    def test_registry_reads_beat_schedule_in_priority_order(self):
        names = [j.name for j in scheduler.get_jobs()]
        from django.conf import settings

        self.assertEqual(set(names), set(settings.CELERY_BEAT_SCHEDULE))
        self.assertEqual(names[0], "process-unprocessed-callbacks")
        self.assertLess(names.index("reconcile-pending-payments"), names.index("nightly-fraud-scan"))
        self.assertLess(names.index("update-participant-consistency"), names.index("finalize-completed-challenges"))
        for job in scheduler.get_jobs():
            self.assertTrue(callable(job.resolve()), job.task)

    def test_celery_beat_schedule_wraps_every_entry(self):
        from django.conf import settings

        beat = scheduler.celery_beat_schedule()
        self.assertEqual(set(beat), set(settings.CELERY_BEAT_SCHEDULE))
        for name, entry in beat.items():
            self.assertEqual(entry["task"], "scheduler.run_scheduled_job")
            self.assertEqual(entry["args"], (name,))


class LeaseTests(TestCase):
    def test_second_acquire_fails_while_leased(self):
        self.assertIsNotNone(scheduler.acquire_lease("job-a", 600))
        self.assertIsNone(scheduler.acquire_lease("job-a", 600))

    def test_expired_lease_can_be_taken_over(self):
        now = timezone.now()
        self.assertIsNotNone(scheduler.acquire_lease("job-a", 60, now=now - timedelta(minutes=5)))
        self.assertIsNotNone(scheduler.acquire_lease("job-a", 60, now=now))

    def test_interleaved_runners_one_winner(self):
        """Two runners both saw the job as due; only the first gets to run it, even after release."""
        seen = scheduler.get_state("job-a").last_started_at  # both read None
        first = scheduler.acquire_lease("job-a", 600, expected_last_started=seen)
        self.assertIsNotNone(first)
        ScheduledJobState.objects.filter(name="job-a").update(lease_until=None)  # first finished
        self.assertIsNone(scheduler.acquire_lease("job-a", 600, expected_last_started=seen))

    def test_finish_releases_lease(self):
        started = scheduler.acquire_lease("job-a", 600)
        scheduler._finish("job-a", started, "ok", 5, result="x")
        s = ScheduledJobState.objects.get(name="job-a")
        self.assertIsNone(s.lease_until)
        self.assertEqual((s.last_status, s.run_count), ("ok", 1))


class ConcurrentLeaseTests(TransactionTestCase):
    def test_threads_race_for_one_lease(self):
        from django.db import OperationalError, connections

        scheduler.get_state("job-race")
        barrier = threading.Barrier(6)
        wins, errors = [], []

        def worker():
            try:
                barrier.wait()
                for _ in range(20):  # SQLite shared-cache may report "locked"; retry
                    try:
                        if scheduler.acquire_lease("job-race", 600):
                            wins.append(1)
                        return
                    except OperationalError:
                        time.sleep(0.01)
                errors.append("gave up")
            finally:
                connections.close_all()

        threads = [threading.Thread(target=worker) for _ in range(6)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(10)
        self.assertEqual(len(wins), 1, errors)


@override_settings(CELERY_BEAT_SCHEDULE=_schedule(a_first=("fake_ok", crontab(minute=0)), b_boom=("fake_boom", crontab(minute=0)), c_after=("fake_other", crontab(minute=0))))
class RunnerTests(TestCase):
    def setUp(self):
        CALLS.clear()

    def test_failure_isolation_and_state(self):
        summary = scheduler.run_due_jobs(30, trigger="command")
        self.assertEqual(CALLS, ["ok", "boom", "other"])
        self.assertEqual([r["status"] for r in summary["ran"]], ["ok", "error", "ok"])
        boom = ScheduledJobState.objects.get(name="b_boom")
        self.assertEqual(boom.last_status, "error")
        self.assertIn("RuntimeError: kaboom", boom.last_error)
        self.assertIsNone(boom.lease_until)
        self.assertEqual(ScheduledJobState.objects.get(name="a_first").last_result, '{"done":1}')
        # Nothing is due again within the same minute.
        CALLS.clear()
        again = scheduler.run_due_jobs(30, trigger="command")
        self.assertEqual((CALLS, again["ran"]), ([], []))

    def test_busy_job_is_skipped(self):
        # Due (never started) but another runner holds the lease.
        ScheduledJobState.objects.create(name="a_first", lease_until=timezone.now() + timedelta(minutes=10))
        summary = scheduler.run_due_jobs(30, trigger="command")
        self.assertIn("a_first", summary["busy"])
        self.assertNotIn("ok", CALLS)

    @override_settings(JOB_RUNNER="celery")
    def test_ticker_and_endpoint_triggers_respect_runner(self):
        self.assertEqual(scheduler.run_due_jobs(30, trigger="ticker")["skipped"], "runner is celery")
        self.assertEqual(CALLS, [])

    @override_settings(CELERY_BEAT_SCHEDULE=_schedule(a=("fake_slow", crontab(minute=0)), b=("fake_ok", crontab(minute=0)), c=("fake_other", crontab(minute=0))))
    def test_budget_stops_new_jobs(self):
        summary = scheduler.run_due_jobs(0.1, trigger="command")
        self.assertEqual(CALLS, ["slow"])
        self.assertEqual(summary["deferred"], ["b", "c"])
        # The next tick picks up the rest.
        scheduler.run_due_jobs(30, trigger="command")
        self.assertEqual(CALLS, ["slow", "ok", "other"])

    def test_celery_wrapper_shares_due_check_and_lease(self):
        ScheduledJobState.objects.create(name="a_first", lease_until=timezone.now() + timedelta(minutes=10))
        self.assertEqual(scheduler.run_scheduled_job("a_first")["status"], "busy")
        ScheduledJobState.objects.filter(name="a_first").update(lease_until=None)
        self.assertEqual(scheduler.run_scheduled_job("a_first")["status"], "ok")
        # The slot was handled: a second beat fire (or the built-in runner) does not rerun it.
        self.assertEqual(scheduler.run_scheduled_job("a_first")["status"], "not_due")
        self.assertEqual(CALLS, ["ok"])


@override_settings(CELERY_BEAT_SCHEDULE=_schedule(job_ok=("fake_ok", crontab(minute=0))), CRON_SECRET="s3cret-token", JOB_RUNNER="builtin")
class EndpointTests(TestCase):
    url = "/api/internal/jobs/run-due/"

    def setUp(self):
        cache.clear()
        CALLS.clear()
        self.client = APIClient()

    @override_settings(CRON_SECRET="")
    def test_404_without_secret_configured(self):
        self.assertEqual(self.client.post(self.url, HTTP_X_CRON_TOKEN="anything").status_code, 404)
        self.assertEqual(CALLS, [])

    def test_403_with_wrong_or_missing_token(self):
        self.assertEqual(self.client.post(self.url, HTTP_X_CRON_TOKEN="wrong").status_code, 403)
        self.assertEqual(self.client.post(self.url).status_code, 403)
        self.assertEqual(CALLS, [])

    def test_200_with_right_token(self):
        res = self.client.post(self.url, HTTP_X_CRON_TOKEN="s3cret-token")
        self.assertEqual(res.status_code, 200)
        body = res.json()
        self.assertEqual(body["ran"], [{"name": "job_ok", "status": "ok"}])
        self.assertEqual(body["counts"]["ok"], 1)
        self.assertNotIn("last_error", str(body))
        self.assertEqual(CALLS, ["ok"])
        # Second call: nothing due, nothing runs twice.
        again = self.client.post(self.url, HTTP_X_CRON_TOKEN="s3cret-token").json()
        self.assertEqual((again["ran"], CALLS), ([], ["ok"]))

    @override_settings(JOB_RUNNER="celery")
    def test_409_when_runner_is_celery(self):
        res = self.client.post(self.url, HTTP_X_CRON_TOKEN="s3cret-token")
        self.assertEqual(res.status_code, 409)
        self.assertEqual(res.json()["detail"], "runner is celery")
        self.assertEqual(CALLS, [])

    def test_get_not_allowed_and_no_jwt_needed(self):
        self.assertEqual(self.client.get(self.url, HTTP_X_CRON_TOKEN="s3cret-token").status_code, 405)

    def test_works_during_maintenance(self):
        from apps.admin_api.models import SystemSettings

        s = SystemSettings.load()
        s.maintenance_mode = True
        s.save()
        self.assertEqual(self.client.post(self.url, HTTP_X_CRON_TOKEN="s3cret-token").status_code, 200)


@override_settings(CELERY_BEAT_SCHEDULE=_schedule(job_ok=("fake_ok", crontab(hour=2, minute=0))))
class AdminJobsViewTests(TestCase):
    def setUp(self):
        CALLS.clear()
        self.staff = User.objects.create_user(username="ops", email="ops@example.com", phone_number="254712349100", password="pw12345678x", is_staff=True)
        self.walker = User.objects.create_user(username="walker", email="w@example.com", phone_number="254712349101", password="pw12345678x")
        self.client = APIClient()

    def test_staff_only(self):
        self.assertEqual(self.client.get("/api/admin/monitoring/jobs/").status_code, 401)
        self.client.force_authenticate(self.walker)
        self.assertEqual(self.client.get("/api/admin/monitoring/jobs/").status_code, 403)
        self.assertEqual(self.client.post("/api/admin/monitoring/jobs/job_ok/run/").status_code, 403)
        self.assertEqual(CALLS, [])

    def test_list(self):
        self.client.force_authenticate(self.staff)
        body = self.client.get("/api/admin/monitoring/jobs/").json()
        row = body["jobs"][0]
        self.assertEqual(row["name"], "job_ok")
        self.assertEqual(row["schedule"], "0 2 * * * (UTC)")
        self.assertTrue(row["overdue"])  # never ran
        self.assertIsNone(row["last_status"])

    def test_run_now_is_audited_and_respects_lease(self):
        self.client.force_authenticate(self.staff)
        with patch.object(jobs_views, "RUN_NOW_EXECUTOR", lambda job, started, trigger: scheduler.execute(job, started, trigger)):
            res = self.client.post("/api/admin/monitoring/jobs/job_ok/run/")
        self.assertEqual(res.status_code, 202)
        self.assertEqual(CALLS, ["ok"])
        log = AuditLog.objects.get(action="run_job")
        self.assertEqual((log.admin, log.resource_type, log.resource_name), (self.staff, "system", "job_ok"))
        state = ScheduledJobState.objects.get(name="job_ok")
        self.assertEqual((state.last_status, state.run_count), ("ok", 1))

        scheduler.acquire_lease("job_ok", 600)
        busy = self.client.post("/api/admin/monitoring/jobs/job_ok/run/")
        self.assertEqual(busy.status_code, 409)
        self.assertEqual(AuditLog.objects.filter(action="run_job").count(), 1)
        self.assertEqual(self.client.post("/api/admin/monitoring/jobs/nope/run/").status_code, 404)


class TickerGatingTests(TestCase):
    def test_not_started_under_tests_or_management_commands(self):
        self.assertIsNone(start_ticker_if_enabled())  # this process is `manage.py test`
        for argv in (["manage.py", "test"], ["manage.py", "migrate"], ["manage.py", "shell"], ["manage.py", "runserver"], ["celery", "-A", "step2win", "worker"], []):
            self.assertFalse(should_start(argv, runner="builtin"), argv)

    def test_started_only_for_daphne_with_builtin_runner(self):
        daphne = ["/opt/render/project/src/.venv/bin/daphne", "-b", "0.0.0.0", "step2win.asgi:application"]  # nosec B104
        self.assertTrue(should_start(daphne, runner="builtin"))
        self.assertFalse(should_start(daphne, runner="celery"))
        self.assertFalse(should_start(daphne, runner="off"))
        self.assertTrue(is_daphne_process([r"C:\app\venv\Scripts\daphne.exe", "x"]))
        self.assertTrue(is_daphne_process(["/usr/lib/python3/site-packages/daphne/__main__.py"]))
        self.assertFalse(is_daphne_process(["manage.py", "runserver"]))
        with patch.dict("os.environ", {"JOB_TICKER_DISABLED": "1"}):
            self.assertFalse(should_start(daphne, runner="builtin"))

    def test_ticker_ticks_and_stops_cleanly(self):
        calls = []
        with patch("apps.admin_api.scheduler.run_due_jobs", side_effect=lambda *a, **k: calls.append(1) or (_ for _ in ()).throw(RuntimeError("db down"))):
            ticker = JobTicker(interval=0.05, jitter=0, budget=1, startup_delay=0)
            ticker.start()
            deadline = time.time() + 3
            while len(calls) < 2 and time.time() < deadline:
                time.sleep(0.02)
            ticker.stop()
        self.assertGreaterEqual(len(calls), 2)  # errors did not kill the thread
        self.assertFalse(ticker.is_alive())
