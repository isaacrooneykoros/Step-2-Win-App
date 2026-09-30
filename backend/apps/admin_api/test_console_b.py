"""Admin console Part B: jobs pause/history, export queue, anti-cheat policy versions,
support outbound / merge / bulk / tag rename, risk model activation, linkage runs."""

from datetime import timedelta

from celery.schedules import crontab
from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.test import TestCase, override_settings
from rest_framework.test import APIClient

from apps.admin_api import scheduler
from apps.admin_api.models import (AuditLog, ScheduledJobRun, SupportTag,
                                   SupportTicket, SupportTicketMessage)

User = get_user_model()
CALLS: list[str] = []


def fake_job():
    CALLS.append("ran")
    return {"ok": 1}


SCHEDULE = {"test-job": {"task": "apps.admin_api.test_console_b.fake_job", "schedule": crontab(minute="*")}}


def mk(username, **extra):
    return User.objects.create_user(username=username, email=f"{username}@example.com",
                                    phone_number=f"2547{abs(hash(username)) % 10**8:08d}",
                                    password="TestPass123!", **extra)


class _Base(TestCase):
    def setUp(self):
        cache.clear()
        CALLS.clear()
        self.admin = mk("b_admin", is_staff=True)
        self.root = mk("b_root", is_staff=True, is_superuser=True)
        self.user = mk("b_user")
        self.client = APIClient()
        self.client.force_authenticate(self.admin)
        self.root_client = APIClient()
        self.root_client.force_authenticate(self.root)


@override_settings(CELERY_BEAT_SCHEDULE=SCHEDULE, JOB_RUNNER="builtin")
class JobPauseTests(_Base):
    def test_pause_is_respected_by_runner_and_history_is_kept(self):
        r = self.client.post("/api/admin/monitoring/jobs/test-job/pause/", {"reason": "Investigating an incident"}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertTrue(r.json()["paused"])
        summary = scheduler.run_due_jobs(trigger="ticker")
        self.assertEqual(CALLS, [])
        self.assertIn("test-job", summary.get("paused", []))
        self.assertEqual(scheduler.run_scheduled_job("test-job")["status"], "paused")
        self.assertEqual(scheduler.run_job(scheduler.get_job("test-job"))["status"], "paused")
        self.client.post("/api/admin/monitoring/jobs/test-job/resume/")
        scheduler.run_due_jobs(trigger="ticker")
        self.assertEqual(CALLS, ["ran"])
        runs = self.client.get("/api/admin/monitoring/jobs/test-job/runs/").json()["results"]
        self.assertEqual(len(runs), 1)
        self.assertEqual(runs[0]["status"], "ok")
        self.assertEqual(set(AuditLog.objects.filter(resource_type="scheduled_job").values_list("action", flat=True)),
                         {"pause", "resume"})

    def test_pause_needs_reason_and_history_is_capped(self):
        r = self.client.post("/api/admin/monitoring/jobs/test-job/pause/", {"reason": ""}, format="json")
        self.assertEqual(r.status_code, 400)
        job = scheduler.get_job("test-job")
        keep = ScheduledJobRun.RUN_HISTORY_PER_JOB
        for _ in range(keep + 3):
            scheduler.run_job(job, force=True, trigger="test")
        self.assertEqual(ScheduledJobRun.objects.filter(name="test-job").count(), keep)


class ExportQueueTests(_Base):
    def test_retry_failed_export_never_exposes_archive(self):
        from apps.privacy.models import DataExportRequest

        e = DataExportRequest.objects.create(user=self.user, status="failed", attempts=3, error="ValueError",
                                             archive=b"secret-zip")
        data = self.client.get("/api/admin/privacy/exports/?status=failed").json()
        row = data["results"][0]
        self.assertNotIn("archive", row)
        self.assertNotIn("sha256", row)
        self.assertEqual(row["error"], "ValueError")
        r = self.client.post(f"/api/admin/privacy/exports/{e.id}/retry/")
        self.assertEqual(r.status_code, 200)
        e.refresh_from_db()
        self.assertEqual((e.status, e.attempts, e.error), ("pending", 0, ""))
        log = AuditLog.objects.get(resource_type="data_export")
        self.assertEqual(log.changes["export_id"], str(e.id))
        self.assertEqual(self.client.post(f"/api/admin/privacy/exports/{e.id}/retry/").status_code, 409)


class AntiCheatPolicyTests(_Base):
    def test_create_from_default_validate_and_activate_superuser_only(self):
        from apps.steps.models import AntiCheatPolicy
        from apps.steps.security import get_active_policy, get_active_policy_version

        listing = self.client.get("/api/admin/anticheat/policies/").json()
        cfg = listing["default_config"]
        cfg["session"]["max_steps_per_minute"] = 200
        body = {"version": "v2-tuned", "description": "Allow running cadence", "config": cfg}
        self.assertEqual(self.client.post("/api/admin/anticheat/policies/", body, format="json").status_code, 403)
        bad = {**body, "config": {**cfg, "session": {**cfg["session"], "max_steps_per_minute": "fast"}}}
        self.assertEqual(self.root_client.post("/api/admin/anticheat/policies/", bad, format="json").status_code, 400)
        typo = {**body, "config": {**cfg, "ml": {**cfg["ml"], "hgh_shake_threshold": 0.5}}}
        self.assertEqual(self.root_client.post("/api/admin/anticheat/policies/", typo, format="json").status_code, 400)
        r = self.root_client.post("/api/admin/anticheat/policies/", body, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        pid = r.json()["id"]
        self.assertFalse(r.json()["is_active"])
        self.assertEqual(get_active_policy_version(), "default-v1")
        self.assertEqual(self.client.post(f"/api/admin/anticheat/policies/{pid}/activate/", {"reason": "Tuned"}, format="json").status_code, 403)
        a = self.root_client.post(f"/api/admin/anticheat/policies/{pid}/activate/", {"reason": "Tuned for runners"}, format="json")
        self.assertEqual(a.status_code, 200)
        self.assertEqual(get_active_policy()["session"]["max_steps_per_minute"], 200)
        # Roll back: a second version then re-activate the first.
        cfg2 = get_active_policy()
        cfg2["session"]["max_steps_per_minute"] = 190
        p2 = self.root_client.post("/api/admin/anticheat/policies/", {**body, "version": "v3", "config": cfg2}, format="json").json()
        self.root_client.post(f"/api/admin/anticheat/policies/{p2['id']}/activate/", {"reason": "Try 190"}, format="json")
        self.root_client.post(f"/api/admin/anticheat/policies/{pid}/activate/", {"reason": "Roll back"}, format="json")
        self.assertEqual(AntiCheatPolicy.objects.filter(is_active=True).get().version, "v2-tuned")
        self.assertEqual(AuditLog.objects.filter(resource_type="anticheat_policy", action="activate").count(), 3)
        created = AuditLog.objects.filter(resource_type="anticheat_policy", action="create").first()
        self.assertIsNone(created.resource_id)
        self.assertIn("session.max_steps_per_minute", created.changes["changed"])


class SupportDeskTests(_Base):
    def test_outbound_ticket(self):
        r = self.client.post("/api/admin/support/tickets/outbound/",
                             {"user_id": self.user.id, "subject": "About your withdrawal", "message": "Hi, we need a detail."},
                             format="json")
        self.assertEqual(r.status_code, 201, r.content)
        t = SupportTicket.objects.get(pk=r.json()["id"])
        self.assertEqual((t.user, t.status, t.assigned_to), (self.user, "in_progress", self.admin))
        self.assertTrue(SupportTicketMessage.objects.get(ticket=t).is_admin)
        self.assertTrue(AuditLog.objects.filter(resource_type="support", resource_id=t.id, action="create").exists())
        # The user sees it in their inbox.
        c = APIClient()
        c.force_authenticate(self.user)
        mine = c.get("/api/auth/support/tickets/").json()
        rows = mine["results"] if isinstance(mine, dict) and "results" in mine else mine
        self.assertIn(t.id, [x["id"] for x in rows])
        self.assertEqual(self.client.post("/api/admin/support/tickets/outbound/", {"user_id": 999999, "subject": "x", "message": "y"}, format="json").status_code, 404)

    def _ticket(self, subject, user=None):
        t = SupportTicket.objects.create(user=user or self.user, subject=subject, message="help")
        SupportTicketMessage.objects.create(ticket=t, sender=t.user, sender_username=t.user.username, message=f"{subject} msg")
        return t

    def test_merge(self):
        a, b = self._ticket("Deposit missing"), self._ticket("Deposit missing again")
        b.tags.add(SupportTag.objects.create(name="mpesa"))
        other = self._ticket("Other person", user=mk("b_other"))
        self.assertEqual(self.client.post(f"/api/admin/support/tickets/{a.id}/merge/", {"duplicate_ids": [other.id]}, format="json").status_code, 400)
        r = self.client.post(f"/api/admin/support/tickets/{a.id}/merge/", {"duplicate_ids": [b.id]}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        b.refresh_from_db()
        self.assertEqual(b.status, "closed")
        self.assertEqual(SupportTicketMessage.objects.filter(ticket=a).count(), 2)
        self.assertEqual(list(a.tags.values_list("name", flat=True)), ["mpesa"])
        self.assertEqual(AuditLog.objects.filter(action="merge").count(), 2)

    def test_bulk_assign_and_close(self):
        t1, t2 = self._ticket("One"), self._ticket("Two")
        r = self.client.post("/api/admin/support/tickets/bulk/", {"ticket_ids": [t1.id, t2.id], "action": "assign", "assigned_to": self.root.id}, format="json")
        self.assertEqual(r.json()["updated"], [t1.id, t2.id])
        r = self.client.post("/api/admin/support/tickets/bulk/", {"ticket_ids": [t1.id, t2.id], "action": "close"}, format="json")
        self.assertEqual(SupportTicket.objects.filter(status="closed").count(), 2)
        self.assertEqual(AuditLog.objects.filter(action="bulk_update").count(), 4)
        self.assertEqual(self.client.post("/api/admin/support/tickets/bulk/", {"ticket_ids": [t1.id], "action": "assign", "assigned_to": self.user.id}, format="json").status_code, 400)

    def test_tag_rename_and_template_audit(self):
        tag = self.client.post("/api/admin/support/tags/", {"name": "Refund"}, format="json").json()
        SupportTag.objects.create(name="taken")
        self.assertEqual(self.client.patch(f"/api/admin/support/tags/{tag['id']}/", {"name": "taken"}, format="json").status_code, 409)
        r = self.client.patch(f"/api/admin/support/tags/{tag['id']}/", {"name": "refunds"}, format="json")
        self.assertEqual(r.json()["name"], "refunds")
        self.assertEqual(self.client.delete(f"/api/admin/support/tags/{tag['id']}/").status_code, 204)
        self.assertEqual(list(AuditLog.objects.filter(resource_type="support_tag").order_by("id").values_list("action", flat=True)),
                         ["create", "update", "delete"])
        t = self.client.post("/api/admin/support/templates/", {"title": "Hi", "body": "Hello {username}"}, format="json").json()
        self.client.patch(f"/api/admin/support/templates/{t['id']}/", {"body": "Hello again"}, format="json")
        self.client.delete(f"/api/admin/support/templates/{t['id']}/")
        self.assertEqual(list(AuditLog.objects.filter(resource_type="support_template").order_by("id").values_list("action", flat=True)),
                         ["create", "update", "delete"])


class TrustToolTests(_Base):
    def test_model_activation_superuser_only(self):
        from apps.risk_ml.models import ModelArtifact

        ModelArtifact.objects.create(kind="anomaly", version="m1", feature_version="f1", payload={}, is_active=True)
        ModelArtifact.objects.create(kind="anomaly", version="m2", feature_version="f1", payload={})
        ModelArtifact.objects.create(kind="anomaly", version="syn", feature_version="f1", payload={}, trained_on="synthetic")
        url = "/api/admin/risk-ml/models/m2/activate/"
        self.assertEqual(self.client.post(url, {"reason": "Better recall"}, format="json").status_code, 403)
        self.assertEqual(self.root_client.post(url, {"reason": ""}, format="json").status_code, 400)
        r = self.root_client.post(url, {"reason": "Better recall"}, format="json")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(list(ModelArtifact.objects.filter(is_active=True).values_list("version", flat=True)), ["m2"])
        self.assertEqual(self.root_client.post("/api/admin/risk-ml/models/syn/activate/", {"reason": "try it"}, format="json").status_code, 409)
        self.assertTrue(AuditLog.objects.filter(resource_type="risk_model", action="activate").exists())

    def test_linkage_runs(self):
        from django.utils import timezone

        from apps.linkage.models import LinkageRun

        LinkageRun.objects.create(finished_at=timezone.now() + timedelta(seconds=3), ok=True, stats={"seconds": 3})
        rows = self.client.get("/api/admin/linkage/runs/").json()["results"]
        self.assertEqual(rows[0]["ok"], True)


class PartBRoleTests(_Base):
    """Part B endpoints follow the staff roles (apps/admin_api/roles.py)."""

    def _as(self, roles):
        from apps.admin_api.staff_models import StaffProfile

        u = mk(f"b_role_{'_'.join(roles) or 'none'}", is_staff=True)
        StaffProfile.objects.create(user=u, roles=roles)
        c = APIClient()
        c.force_authenticate(u)
        return c

    def test_role_gates(self):
        content = self._as(["content"])
        support = self._as(["support"])
        trust = self._as(["trust"])
        settings_staff = self._as(["settings"])
        # Announcements: content writes, everyone else reads only.
        body = {"title": "Hi"}
        self.assertEqual(content.post("/api/admin/content/announcements/", body, format="json").status_code, 201)
        self.assertEqual(support.post("/api/admin/content/announcements/", body, format="json").status_code, 403)
        self.assertEqual(support.get("/api/admin/content/announcements/").status_code, 200)
        # Support desk actions: support only.
        out = {"user_id": self.user.id, "subject": "Hello", "message": "A question for you"}
        self.assertEqual(content.post("/api/admin/support/tickets/outbound/", out, format="json").status_code, 403)
        self.assertEqual(support.post("/api/admin/support/tickets/outbound/", out, format="json").status_code, 201)
        # Exports queue and job pause: settings.
        self.assertEqual(trust.get("/api/admin/privacy/exports/").status_code, 403)
        self.assertEqual(settings_staff.get("/api/admin/privacy/exports/").status_code, 200)
        # Anti-cheat policy: trust reads, only owners create.
        self.assertEqual(trust.get("/api/admin/anticheat/policies/").status_code, 200)
        self.assertEqual(support.get("/api/admin/anticheat/policies/").status_code, 403)
        cfg = trust.get("/api/admin/anticheat/policies/").json()["default_config"]
        self.assertEqual(trust.post("/api/admin/anticheat/policies/", {"version": "x", "description": "Trying it", "config": cfg},
                                    format="json").status_code, 403)
        owner = self._as(["owner"])
        self.assertEqual(owner.post("/api/admin/anticheat/policies/", {"version": "x", "description": "Trying it", "config": cfg},
                                    format="json").status_code, 201)
