"""The privacy jobs are registered with the scheduled-job runner."""

from rest_framework.test import APITestCase as TestCase

from apps.admin_api import scheduler
from apps.privacy.models import PrivacySettings

from .helpers import make_user


class PrivacySchedulerTests(TestCase):
    def test_jobs_registered_with_priority_and_lease(self):
        jobs = {j.name: j for j in scheduler.get_jobs()}
        exports = jobs["privacy-process-exports"]
        retention = jobs["privacy-retention"]
        self.assertEqual(exports.task, "apps.privacy.tasks.process_data_exports_task")
        self.assertEqual(retention.task, "apps.privacy.tasks.run_privacy_retention_task")
        self.assertEqual((exports.priority, exports.lease_seconds), (115, 900))
        self.assertEqual((retention.priority, retention.lease_seconds), (138, 900))
        # Money jobs always run first.
        self.assertLess(jobs["finalize-completed-challenges"].priority, exports.priority)
        self.assertEqual(scheduler.describe_schedule(exports.schedule), "*/5 * * * * (UTC)")
        self.assertEqual(scheduler.describe_schedule(retention.schedule), "50 * * * * (UTC)")
        self.assertIn("privacy-retention", scheduler.celery_beat_schedule())

    def test_jobs_resolve_and_run_through_the_runner(self):
        make_user()
        for name in ("privacy-process-exports", "privacy-retention"):
            job = scheduler.get_job(name)
            self.assertTrue(callable(job.resolve()))
            outcome = scheduler.run_job(job, force=True, trigger="test")
            self.assertEqual(outcome["status"], "ok", name)

    def test_admin_settings_endpoint_validates_bounds(self):
        admin = make_user("admin1", "254711000900", is_staff=True)
        self.client.force_authenticate(admin)
        url = "/api/privacy/admin/settings/"
        self.assertEqual(self.client.get(url).status_code, 200)
        bad = self.client.patch(url, {"sync_payload_days": 3}, format="json")
        self.assertEqual(bad.status_code, 400)
        ok = self.client.patch(url, {"sync_payload_days": 120, "legacy_waypoint_days": 0},
                               format="json")
        self.assertEqual(ok.status_code, 200, ok.content)
        s = PrivacySettings.load()
        self.assertEqual((s.sync_payload_days, s.legacy_waypoint_days), (120, 0))
        user = make_user("plain", "254711000901")
        self.client.force_authenticate(user)
        self.assertEqual(self.client.get(url).status_code, 403)
