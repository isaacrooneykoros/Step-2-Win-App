"""Tests for the admin console read/filter endpoints and audited user/challenge actions."""

from datetime import timedelta
from decimal import Decimal

from django.contrib.auth import get_user_model
from django.test import TestCase
from django.utils import timezone
from rest_framework.test import APIClient

from apps.admin_api.models import AuditLog
from apps.challenges.models import Challenge, Participant
from apps.steps.models import FraudFlag, HealthRecord, TrustScore
from apps.users.models import DeviceSession

User = get_user_model()


class ConsoleTestBase(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.superuser = User.objects.create_user(
            username="root", email="root@example.com", phone_number="254700000001",
            password="pass12345!", is_staff=True, is_superuser=True,
        )
        self.staff = User.objects.create_user(
            username="agent", email="agent@example.com", phone_number="254700000002",
            password="pass12345!", is_staff=True,
        )
        self.alice = User.objects.create_user(
            username="alice", email="alice@example.com", phone_number="254700000003",
            password="pass12345!", wallet_balance=Decimal("250.00"), locked_balance=Decimal("100.00"),
        )
        self.bob = User.objects.create_user(
            username="bob", email="bob@example.com", phone_number="254700000004",
            password="pass12345!", is_active=False,
        )
        TrustScore.objects.create(user=self.alice, score=35, flags_total=2)
        FraudFlag.objects.create(user=self.alice, flag_type="rate_spike", severity="high", date=timezone.localdate())
        DeviceSession.objects.create(user=self.alice, refresh_jti="secret-jti", device_type="android")
        self.client.force_authenticate(self.superuser)


class UserListTests(ConsoleTestBase):
    def test_list_is_paginated_with_page_size(self):
        res = self.client.get("/api/admin/users/?page_size=2")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.data["count"], 4)
        self.assertEqual(len(res.data["results"]), 2)

    def test_search_status_and_trust_filters(self):
        res = self.client.get("/api/admin/users/?search=alice")
        self.assertEqual([u["username"] for u in res.data["results"]], ["alice"])
        row = res.data["results"][0]
        self.assertEqual(row["trust_score"], 35)
        self.assertEqual(row["trust_status"], "RESTRICT")
        self.assertEqual(row["open_flags"], 1)
        self.assertIsNotNone(row["last_seen_at"])

        res = self.client.get("/api/admin/users/?status=banned")
        self.assertEqual([u["username"] for u in res.data["results"]], ["bob"])

        res = self.client.get("/api/admin/users/?trust=flagged")
        self.assertEqual([u["username"] for u in res.data["results"]], ["alice"])

        res = self.client.get("/api/admin/users/?trust=restrict")
        self.assertEqual([u["username"] for u in res.data["results"]], ["alice"])

    def test_ordering_whitelist(self):
        res = self.client.get("/api/admin/users/?ordering=-wallet_balance")
        self.assertEqual(res.data["results"][0]["username"], "alice")
        res = self.client.get("/api/admin/users/?ordering=password")
        self.assertEqual(res.status_code, 200)

    def test_user_stats(self):
        res = self.client.get("/api/admin/users/user_stats/")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.data["flagged_users"], 1)
        self.assertEqual(res.data["banned_users"], 1)
        self.assertEqual(res.data["low_trust_users"], 1)

    def test_regular_user_denied(self):
        self.client.force_authenticate(self.alice)
        self.assertEqual(self.client.get("/api/admin/users/").status_code, 403)
        self.assertEqual(self.client.get(f"/api/admin/users/{self.alice.id}/overview/").status_code, 403)


class UserOverviewTests(ConsoleTestBase):
    def test_overview_sections(self):
        HealthRecord.objects.create(user=self.alice, date=timezone.localdate(), steps=8123, source="device_sensor")
        res = self.client.get(f"/api/admin/users/{self.alice.id}/overview/")
        self.assertEqual(res.status_code, 200)
        for key in ["user", "wallet", "trust", "activity", "devices", "sessions", "challenges",
                    "transactions", "withdrawals", "flags", "tickets", "audit"]:
            self.assertIn(key, res.data)
        self.assertEqual(res.data["wallet"]["locked_balance"], "100.00")
        self.assertEqual(res.data["wallet"]["available_balance"], "250.00")
        self.assertEqual(res.data["trust"]["status"], "RESTRICT")
        self.assertEqual(len(res.data["activity"]["days"]), 30)
        self.assertEqual(res.data["activity"]["days"][-1]["steps"], 8123)
        # Session tokens are never exposed.
        self.assertNotIn("refresh_jti", res.data["sessions"][0])
        self.assertNotIn("secret-jti", str(res.data))


class UserActionAuditTests(ConsoleTestBase):
    def test_ban_logs_reason_and_blocks_self(self):
        res = self.client.post(f"/api/admin/users/{self.alice.id}/ban_user/", {"reason": "Shared account"}, format="json")
        self.assertEqual(res.status_code, 200)
        log = AuditLog.objects.get(action="ban", resource_id=self.alice.id)
        self.assertEqual(log.changes["reason"], "Shared account")
        self.assertEqual(self.client.post(f"/api/admin/users/{self.superuser.id}/ban_user/").status_code, 400)

        res = self.client.get(f"/api/admin/users/{self.alice.id}/overview/")
        self.assertEqual(res.data["audit"][0]["action"], "ban")

    def test_staff_changes_require_superuser(self):
        self.client.force_authenticate(self.staff)
        self.assertEqual(self.client.post(f"/api/admin/users/{self.bob.id}/make_staff/").status_code, 403)
        self.client.force_authenticate(self.superuser)
        self.assertEqual(self.client.post(f"/api/admin/users/{self.bob.id}/make_staff/").status_code, 200)
        self.assertTrue(AuditLog.objects.filter(action="promote", resource_id=self.bob.id).exists())

    def test_delete_refuses_accounts_holding_money(self):
        res = self.client.delete(f"/api/admin/users/{self.alice.id}/delete_user/")
        self.assertEqual(res.status_code, 400)
        self.assertTrue(User.objects.filter(id=self.alice.id).exists())
        res = self.client.delete(f"/api/admin/users/{self.bob.id}/delete_user/")
        self.assertEqual(res.status_code, 200)
        self.assertTrue(AuditLog.objects.filter(action="delete", resource_name="bob").exists())

    def test_update_user_logs_changes(self):
        res = self.client.patch(f"/api/admin/users/{self.bob.id}/update_user/", {"email": "bob2@example.com"}, format="json")
        self.assertEqual(res.status_code, 200)
        log = AuditLog.objects.get(action="update", resource_id=self.bob.id)
        self.assertEqual(log.changes["email"], {"old": "bob@example.com", "new": "bob2@example.com"})


class ChallengeConsoleTests(ConsoleTestBase):
    def make(self, name, status_value, **extra):
        return Challenge.objects.create(
            creator=self.alice, name=name, entry_fee=Decimal("100.00"), milestone=10000,
            start_date=timezone.localdate(), end_date=timezone.localdate() + timedelta(days=7), status=status_value, **extra,
        )

    def test_status_filter_and_pagination(self):
        self.make("Pending one", "pending")
        self.make("Live one", "active")
        res = self.client.get("/api/admin/challenges/?status=pending&page_size=10")
        self.assertEqual(res.data["count"], 1)
        self.assertEqual(res.data["results"][0]["name"], "Pending one")
        self.assertIn("is_featured", res.data["results"][0])
        self.assertIn("net_pool", res.data["results"][0])

    def test_reject_only_pending_and_audited(self):
        done = self.make("Done", "completed")
        self.assertEqual(self.client.post(f"/api/admin/challenges/{done.id}/reject_challenge/").status_code, 400)
        done.refresh_from_db()
        self.assertEqual(done.status, "completed")

        pending = self.make("Queue", "pending")
        res = self.client.post(f"/api/admin/challenges/{pending.id}/reject_challenge/", {"reason": "Offensive name"}, format="json")
        self.assertEqual(res.status_code, 200)
        log = AuditLog.objects.get(action="reject", resource_id=pending.id)
        self.assertEqual(log.changes["reason"], "Offensive name")

    def test_set_featured_and_results_timeline(self):
        live = self.make("Live", "active", is_public=True, is_private=False)
        Participant.objects.create(challenge=live, user=self.alice, steps=5000)
        res = self.client.post(f"/api/admin/challenges/{live.id}/set_featured/", {"featured": True}, format="json")
        self.assertEqual(res.status_code, 200)
        self.assertTrue(res.data["is_featured"])
        res = self.client.get(f"/api/admin/challenges/{live.id}/results/")
        self.assertEqual(res.data["results"][0]["user_id"], self.alice.id)
        self.assertEqual(res.data["audit"][0]["action"], "update")

        private = self.make("Private", "active", is_private=True, is_public=False)
        self.assertEqual(
            self.client.post(f"/api/admin/challenges/{private.id}/set_featured/", {"featured": True}, format="json").status_code,
            400,
        )

    def test_challenge_stats_include_pending(self):
        self.make("P", "pending")
        res = self.client.get("/api/admin/challenges/challenge_stats/")
        self.assertEqual(res.data["pending_challenges"], 1)


class StepLogConsoleTests(ConsoleTestBase):
    def test_filters_distribution_and_reasons(self):
        today = timezone.localdate()
        HealthRecord.objects.create(user=self.alice, date=today, steps=42000, source="manual", is_suspicious=True)
        HealthRecord.objects.create(user=self.bob, date=today, steps=3000, source="device_sensor")
        FraudFlag.objects.create(user=self.alice, flag_type="impossible_rate", severity="critical", date=today)

        res = self.client.get(f"/api/admin/steps/logs/?user_id={self.alice.id}")
        self.assertEqual(res.data["total"], 1)
        row = res.data["results"][0]
        self.assertTrue(row["is_suspicious"])
        self.assertIn("impossible_rate", [r["type"] for r in row["reasons"]])

        res = self.client.get("/api/admin/steps/logs/?source=device_sensor")
        self.assertEqual([r["username"] for r in res.data["results"]], ["bob"])

        res = self.client.get("/api/admin/steps/logs/?sort=steps&order=desc")
        summary = res.data["summary"]
        self.assertEqual(res.data["results"][0]["steps"], 42000)
        self.assertEqual(summary["suspicious_count"], 1)
        buckets = {b["label"]: b["count"] for b in summary["distribution"]}
        self.assertEqual(buckets["30K+"], 1)
        self.assertEqual(buckets["2K–5K"], 1)
        self.assertEqual(summary["daily"][0]["steps"], 45000)


class AuditLogFilterTests(ConsoleTestBase):
    def test_resource_id_and_search(self):
        AuditLog.log_action(admin=self.superuser, action="ban", resource_type="user", resource_id=self.alice.id,
                            resource_name="alice", description="Banned alice")
        AuditLog.log_action(admin=self.superuser, action="ban", resource_type="user", resource_id=self.bob.id,
                            resource_name="bob", description="Banned bob")
        res = self.client.get(f"/api/admin/audit-logs/?resource_type=user&resource_id={self.alice.id}")
        self.assertEqual(res.data["total"], 1)
        AuditLog.log_action(admin=self.superuser, action="login", resource_type="auth", description="Admin root logged in")
        res = self.client.get("/api/admin/audit-logs/?exclude_auth=true")
        self.assertEqual(res.data["total"], 2)
        res = self.client.get("/api/admin/audit-logs/?search=bob")
        self.assertEqual(res.data["total"], 1)
        self.assertIn("root", res.data["admins"])
        self.assertEqual(self.client.get("/api/admin/audit-logs/?limit=abc").status_code, 400)
