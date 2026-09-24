"""Enforcement of admin settings: minimum withdrawal, feature switches,
maintenance mode (callbacks keep flowing), support SLA / auto-assignment /
escalation, tags and saved replies."""

import hashlib
import hmac
import json
from datetime import timedelta
from decimal import Decimal
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.test import TestCase, override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from apps.admin_api.models import (AuditLog, SupportReplyTemplate, SupportTag,
                                   SupportTicket, SupportTicketMessage,
                                   SystemSettings)
from apps.admin_api.support_rules import auto_assign, escalate_overdue
from apps.payments.models import PaymentTransaction, WithdrawalRequest

User = get_user_model()
PHONE = "254712345601"


def set_settings(**values):
    s = SystemSettings.load()
    for k, v in values.items():
        setattr(s, k, v)
    s.save()
    return s


class _Base(TestCase):
    def setUp(self):
        cache.clear()
        self.client = APIClient()
        self.user = User.objects.create_user(
            username="rules_user", email="rules@example.com", phone_number=PHONE,
            password="TestPass123!", wallet_balance=Decimal("5000.00"),
        )
        self.admin = User.objects.create_user(
            username="rules_admin", email="rulesadmin@example.com", phone_number="254712345602",
            password="TestPass123!", is_staff=True,
        )

    def tearDown(self):
        cache.clear()


class MinimumWithdrawalTests(_Base):
    def _withdraw(self, url, amount):
        self.client.force_authenticate(self.user)
        with patch("apps.payments.intasend.format_phone", return_value=PHONE):
            return self.client.post(url, {"method": "mpesa", "amount": amount, "phone_number": PHONE}, format="json")

    def test_below_configured_minimum_is_refused_on_both_endpoints(self):
        set_settings(minimum_withdrawal_amount=Decimal("500.00"))
        for url in ("/api/payments/withdrawal/request/", "/api/wallet/withdraw/"):
            res = self._withdraw(url, "300.00")
            self.assertEqual(res.status_code, 400, res.content)
            self.assertIn("minimum withdrawal is KES 500.00", res.json()["error"])
        self.assertFalse(WithdrawalRequest.objects.exists())
        self.user.refresh_from_db()
        self.assertEqual(self.user.wallet_balance, Decimal("5000.00"))

    def test_at_or_above_minimum_goes_through(self):
        set_settings(minimum_withdrawal_amount=Decimal("500.00"))
        res = self._withdraw("/api/payments/withdrawal/request/", "500.00")
        self.assertEqual(res.status_code, 201, res.content)

    def test_app_config_exposes_effective_minimum(self):
        set_settings(minimum_withdrawal_amount=Decimal("250.00"), withdrawal_processing_time=12)
        data = self.client.get("/api/app/config/").json()
        self.assertEqual(Decimal(data["withdrawals"]["minimum_kes"]), Decimal("250.00"))
        self.assertEqual(data["withdrawals"]["processing_hours"], 12)
        # Never below the server floor (MIN_WITHDRAWAL_KES = 10).
        set_settings(minimum_withdrawal_amount=Decimal("1.00"))
        data = self.client.get("/api/app/config/").json()
        self.assertEqual(Decimal(data["withdrawals"]["minimum_kes"]), Decimal("10"))

    def test_settings_reject_minimum_above_largest_withdrawal(self):
        self.client.force_authenticate(self.admin)
        res = self.client.post("/api/admin/settings/update/", {"minimum_withdrawal_amount": "999999.00"}, format="json")
        self.assertEqual(res.status_code, 400)
        self.assertIn("minimum_withdrawal_amount", res.json())


class FeatureSwitchTests(_Base):
    def assertDisabled(self, res, feature):
        self.assertEqual(res.status_code, 403, res.content)
        body = res.json()
        self.assertEqual(body["code"], "feature_disabled")
        self.assertEqual(body["feature"], feature)
        self.assertTrue(body["error"])

    def test_withdrawals_switch(self):
        set_settings(withdrawals_enabled=False)
        self.client.force_authenticate(self.user)
        for url in ("/api/payments/withdrawal/request/", "/api/wallet/withdraw/"):
            res = self.client.post(url, {"method": "mpesa", "amount": "300.00", "phone_number": PHONE}, format="json")
            self.assertDisabled(res, "withdrawals")
        self.assertFalse(WithdrawalRequest.objects.exists())

    def test_registrations_switch(self):
        set_settings(registrations_enabled=False)
        res = self.client.post("/api/auth/register/", {
            "username": "newbie", "email": "newbie@example.com", "password": "TestPass123!",
            "password_confirm": "TestPass123!", "phone_number": "254712345603",
        }, format="json")
        self.assertDisabled(res, "registrations")
        self.assertFalse(User.objects.filter(username="newbie").exists())

    def test_registrations_switch_blocks_new_google_accounts_only(self):
        set_settings(registrations_enabled=False)

        from apps.users.social_auth import VerifiedIdentity

        def _identity(email, sub):
            return VerifiedIdentity(
                provider="google", subject=sub, email=email, email_verified=True, full_name="G User"
            )

        # Token verification itself is covered in apps/users/test_social_auth.py.
        with patch(
            "apps.users.social_auth.verify_google_id_token",
            return_value=_identity("brandnew@example.com", "sub-new"),
        ):
            res = self.client.post("/api/auth/google/", {"id_token": "x"}, format="json")
        self.assertDisabled(res, "registrations")
        with patch(
            "apps.users.social_auth.verify_google_id_token",
            return_value=_identity(self.user.email, "sub-existing"),
        ):
            res = self.client.post("/api/auth/google/", {"id_token": "x"}, format="json")
        self.assertEqual(res.status_code, 200, res.content)

    def test_challenges_switch(self):
        set_settings(challenges_enabled=False)
        self.client.force_authenticate(self.user)
        res = self.client.post("/api/challenges/create/", {"name": "x"}, format="json")
        self.assertDisabled(res, "challenges")
        res = self.client.post("/api/challenges/999/rematch/", {}, format="json")
        self.assertDisabled(res, "challenges")

    def test_switches_on_do_not_interfere(self):
        self.client.force_authenticate(self.user)
        res = self.client.post("/api/challenges/create/", {}, format="json")
        self.assertEqual(res.status_code, 400)  # validation, not the switch

    def test_app_config_reports_switches(self):
        set_settings(challenges_enabled=False)
        data = self.client.get("/api/app/config/").json()
        self.assertFalse(data["features"]["challenges"])
        self.assertTrue(data["features"]["withdrawals"])


@override_settings(INTASEND_WEBHOOK_SECRET="test-secret")
class MaintenanceModeTests(_Base):
    def setUp(self):
        super().setUp()
        set_settings(maintenance_mode=True, maintenance_message="Back at 14:00 EAT.")

    def test_customer_routes_get_503_with_message(self):
        self.client.force_authenticate(self.user)
        for url in ("/api/wallet/summary/", "/api/challenges/", "/api/auth/profile/"):
            res = self.client.get(url)
            self.assertEqual(res.status_code, 503, url)
            self.assertEqual(res.json()["code"], "maintenance")
            self.assertEqual(res.json()["error"], "Back at 14:00 EAT.")
        res = self.client.post("/api/auth/login/", {"username": "rules_user", "password": "TestPass123!"}, format="json")
        self.assertEqual(res.status_code, 503)

    def test_admin_health_and_config_pass(self):
        self.client.force_authenticate(self.admin)
        self.assertEqual(self.client.get("/api/admin/settings/").status_code, 200)
        self.assertEqual(self.client.get("/api/health/").status_code, 200)
        cfg = self.client.get("/api/app/config/").json()
        self.assertTrue(cfg["maintenance"]["enabled"])
        self.assertEqual(cfg["maintenance"]["message"], "Back at 14:00 EAT.")

    def test_staff_bearer_token_passes_customer_routes(self):
        from rest_framework_simplejwt.tokens import RefreshToken

        token = str(RefreshToken.for_user(self.admin).access_token)
        res = self.client.get("/api/wallet/summary/", HTTP_AUTHORIZATION=f"Bearer {token}")
        self.assertNotEqual(res.status_code, 503)
        user_token = str(RefreshToken.for_user(self.user).access_token)
        res = self.client.get("/api/wallet/summary/", HTTP_AUTHORIZATION=f"Bearer {user_token}")
        self.assertEqual(res.status_code, 503)

    def test_payment_callback_still_credits_wallet(self):
        PaymentTransaction.objects.create(
            user=self.user, type="deposit", status="pending", amount_kes=Decimal("50.00"),
            order_id="DEP-MAINT-1", tracking_reference="DEP-TRACK-M1", collection_id="COLL-M1",
            request_id="REQ-M1", phone_number=PHONE, narration="Deposit during maintenance",
        )
        body = json.dumps({"invoice": {"api_ref": "DEP-MAINT-1", "state": "COMPLETE", "mpesa_reference": "MPESA-M1"}})
        sig = hmac.new(b"test-secret", body.encode(), hashlib.sha256).hexdigest()
        res = self.client.generic("POST", "/api/payments/mpesa/deposit-callback/", data=body,
                                  content_type="application/json", HTTP_X_INTASEND_SIGNATURE=sig)
        self.assertEqual(res.status_code, 200, res.content)
        self.user.refresh_from_db()
        self.assertEqual(self.user.wallet_balance, Decimal("5050.00"))

    def test_turning_it_off_restores_access(self):
        set_settings(maintenance_mode=False)
        self.client.force_authenticate(self.user)
        self.assertEqual(self.client.get("/api/wallet/summary/").status_code, 200)


class SupportRulesTests(_Base):
    def setUp(self):
        super().setUp()
        self.agent2 = User.objects.create_user(
            username="rules_agent2", email="agent2@example.com", phone_number="254712345604",
            password="TestPass123!", is_staff=True,
        )

    def _ticket(self, category="general", priority="medium", hours_ago=0):
        t = SupportTicket.objects.create(user=self.user, subject="Help", category=category, message="hi", priority=priority)
        m = SupportTicketMessage.objects.create(ticket=t, sender=self.user, sender_username=self.user.username,
                                                is_admin=False, message="hi")
        if hours_ago:
            at = timezone.now() - timedelta(hours=hours_ago)
            SupportTicket.objects.filter(pk=t.pk).update(created_at=at)
            SupportTicketMessage.objects.filter(pk=m.pk).update(created_at=at)
            t.refresh_from_db()
        return t

    def test_auto_assign_off_by_default(self):
        t = self._ticket()
        self.assertIsNone(auto_assign(t))
        t.refresh_from_db()
        self.assertIsNone(t.assigned_to_id)

    def test_round_robin_rotates_agents(self):
        set_settings(support_auto_assign_mode="round_robin", support_agent_ids=[self.admin.id, self.agent2.id])
        got = []
        for _ in range(3):
            t = self._ticket()
            auto_assign(t)
            t.refresh_from_db()
            got.append(t.assigned_to_id)
        self.assertEqual(got, [self.admin.id, self.agent2.id, self.admin.id])
        self.assertTrue(AuditLog.objects.filter(resource_type="support", admin__isnull=True).exists())

    def test_category_rule_with_fallback(self):
        set_settings(support_auto_assign_mode="category", support_agent_ids=[self.admin.id],
                     support_category_assignees={"payment": self.agent2.id})
        t = self._ticket(category="payment")
        auto_assign(t)
        t.refresh_from_db()
        self.assertEqual(t.assigned_to_id, self.agent2.id)
        t2 = self._ticket(category="technical")
        auto_assign(t2)
        t2.refresh_from_db()
        self.assertEqual(t2.assigned_to_id, self.admin.id)

    def test_ticket_created_in_app_is_auto_assigned(self):
        set_settings(support_auto_assign_mode="round_robin", support_agent_ids=[self.agent2.id])
        self.client.force_authenticate(self.user)
        res = self.client.post("/api/auth/support/tickets/create/", {
            "subject": "Deposit", "category": "payment", "priority": "high", "message": "Paid, not credited",
        }, format="json")
        self.assertIn(res.status_code, (200, 201), res.content)
        self.assertEqual(SupportTicket.objects.get(subject="Deposit").assigned_to_id, self.agent2.id)

    def test_queue_uses_configured_targets_and_overdue_view(self):
        set_settings(support_sla_medium_hours=3)
        late = self._ticket(priority="medium", hours_ago=4)
        fresh = self._ticket(priority="medium", hours_ago=1)
        self.client.force_authenticate(self.admin)
        data = self.client.get("/api/admin/support/queue/", {"view": "overdue"}).json()
        self.assertEqual([r["id"] for r in data["results"]], [late.id])
        self.assertEqual(data["sla_hours"]["medium"], 3)
        self.assertEqual(data["counts"]["overdue"], 1)
        row = data["results"][0]
        self.assertTrue(row["overdue"])
        self.assertEqual(row["sla_target_hours"], 3)
        rows = {r["id"]: r for r in self.client.get("/api/admin/support/queue/", {"view": "awaiting"}).json()["results"]}
        self.assertFalse(rows[fresh.id]["overdue"])

    def test_escalation_is_idempotent_per_waiting_episode(self):
        t = self._ticket(priority="low", hours_ago=50)
        self.assertEqual(escalate_overdue(), 1)
        t.refresh_from_db()
        self.assertEqual(t.priority, "medium")
        self.assertIsNotNone(t.escalated_at)
        # Tighter target now, but the same episode never escalates twice.
        self.assertEqual(escalate_overdue(), 0)
        t.refresh_from_db()
        self.assertEqual(t.priority, "medium")

    def test_escalation_off_switch(self):
        set_settings(support_escalation_enabled=False)
        self._ticket(priority="low", hours_ago=50)
        self.assertEqual(escalate_overdue(), 0)

    def test_escalation_without_priority_raise(self):
        set_settings(support_escalation_raise_priority=False)
        t = self._ticket(priority="urgent", hours_ago=3)
        self.assertEqual(escalate_overdue(), 1)
        t.refresh_from_db()
        self.assertEqual(t.priority, "urgent")
        self.client.force_authenticate(self.admin)
        row = self.client.get(f"/api/admin/support/tickets/{t.id}/conversation/").json()["ticket"]
        self.assertTrue(row["escalated"])

    def test_settings_validate_support_fields(self):
        self.client.force_authenticate(self.admin)
        res = self.client.post("/api/admin/settings/update/", {"support_agent_ids": [self.user.id]}, format="json")
        self.assertEqual(res.status_code, 400)
        res = self.client.post("/api/admin/settings/update/", {
            "support_auto_assign_mode": "round_robin", "support_agent_ids": [self.admin.id],
            "support_sla_urgent_hours": 1, "support_category_assignees": {"payment": self.agent2.id},
        }, format="json")
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(res.json()["support_agent_ids"], [self.admin.id])


class TagsAndTemplatesTests(_Base):
    def setUp(self):
        super().setUp()
        self.client.force_authenticate(self.admin)
        self.ticket = SupportTicket.objects.create(user=self.user, subject="Refund", category="payment", message="x")

    def test_set_tags_and_filter_queue(self):
        res = self.client.post(f"/api/admin/support/tickets/{self.ticket.id}/tags/", {"tags": ["Refund", " mpesa  delay ", "refund"]}, format="json")
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(res.json()["tags"], ["mpesa delay", "refund"])
        self.assertEqual(SupportTag.objects.count(), 2)
        data = self.client.get("/api/admin/support/queue/", {"view": "all", "tag": "refund"}).json()
        self.assertEqual([r["id"] for r in data["results"]], [self.ticket.id])
        self.assertEqual(sorted(data["results"][0]["tags"]), ["mpesa delay", "refund"])
        self.assertEqual(self.client.get("/api/admin/support/queue/", {"view": "all", "tag": "other"}).json()["total"], 0)
        tags = self.client.get("/api/admin/support/tags/").json()["results"]
        self.assertEqual({t["name"]: t["open_count"] for t in tags}, {"mpesa delay": 1, "refund": 1})
        self.assertTrue(AuditLog.objects.filter(resource_id=self.ticket.id, description__icontains="tags").exists())

    def test_template_crud_and_usage(self):
        res = self.client.post("/api/admin/support/templates/", {"title": "Deposit delay", "body": "Hi {username}, ticket #{ticket_id}", "category": "payment"}, format="json")
        self.assertEqual(res.status_code, 201, res.content)
        tid = res.json()["id"]
        self.assertEqual(self.client.post("/api/admin/support/templates/", {"title": "", "body": ""}, format="json").status_code, 400)
        self.assertEqual(self.client.post("/api/admin/support/templates/", {"title": "x", "body": "y", "category": "nope"}, format="json").status_code, 400)
        res = self.client.patch(f"/api/admin/support/templates/{tid}/", {"title": "Deposit delayed"}, format="json")
        self.assertEqual(res.json()["title"], "Deposit delayed")
        self.client.post(f"/api/admin/support/templates/{tid}/used/")
        self.assertEqual(SupportReplyTemplate.objects.get(pk=tid).usage_count, 1)
        self.assertEqual(len(self.client.get("/api/admin/support/templates/").json()["results"]), 1)
        self.assertEqual(self.client.delete(f"/api/admin/support/templates/{tid}/").status_code, 204)
        self.assertFalse(SupportReplyTemplate.objects.exists())

    def test_customers_cannot_use_desk_endpoints(self):
        self.client.force_authenticate(self.user)
        self.assertEqual(self.client.get("/api/admin/support/templates/").status_code, 403)
        self.assertEqual(self.client.post(f"/api/admin/support/tickets/{self.ticket.id}/tags/", {"tags": ["x"]}, format="json").status_code, 403)
