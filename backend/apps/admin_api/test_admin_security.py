"""The admin API's generic routes can't bypass the guarded actions; deletes are safe and audited."""
from datetime import date, timedelta
from decimal import Decimal

from django.contrib.auth import get_user_model
from django.test import TestCase
from rest_framework.test import APIClient

from apps.admin_api.models import AuditLog
from apps.challenges.models import Challenge, Participant

User = get_user_model()


class AdminSecurityTests(TestCase):
    def setUp(self):
        self.staff = User.objects.create_user(
            username="helper", email="helper@example.com", phone_number="254711000301",
            password="TestPass123!", is_staff=True,
        )
        self.owner = User.objects.create_user(
            username="owner", email="owner@example.com", phone_number="254711000302",
            password="TestPass123!", is_staff=True, is_superuser=True,
        )
        self.customer = User.objects.create_user(
            username="walker", email="walker@example.com", phone_number="254711000303",
            password="TestPass123!",
        )
        self.client = APIClient()

    def _as(self, user):
        self.client.force_authenticate(user)

    def _challenge(self, status="active", with_participant=True):
        c = Challenge.objects.create(
            creator=self.customer, name="Office walkers", entry_fee=Decimal("100.00"), milestone=50000,
            start_date=date.today(), end_date=date.today() + timedelta(days=7), status=status,
            is_public=False, is_private=True, max_participants=10, total_pool=Decimal("100.00"),
        )
        if with_participant:
            Participant.objects.create(challenge=c, user=self.customer)
        return c

    # ── Generic ModelViewSet routes are closed ────────────────────────────────
    def test_staff_cannot_make_themselves_admin_through_the_generic_route(self):
        self._as(self.staff)
        res = self.client.patch(f"/api/admin/users/{self.customer.id}/", {"is_staff": True}, format="json")
        self.assertEqual(res.status_code, 405)
        self.customer.refresh_from_db()
        self.assertFalse(self.customer.is_staff)

    def test_generic_user_delete_and_create_are_closed(self):
        self._as(self.owner)
        self.assertEqual(self.client.delete(f"/api/admin/users/{self.customer.id}/").status_code, 405)
        self.assertTrue(User.objects.filter(pk=self.customer.pk).exists())
        res = self.client.post("/api/admin/users/", {"username": "x", "email": "x@example.com"}, format="json")
        self.assertEqual(res.status_code, 405)

    def test_generic_challenge_writes_are_closed(self):
        c = self._challenge()
        self._as(self.owner)
        self.assertEqual(
            self.client.patch(f"/api/admin/challenges/{c.id}/", {"entry_fee": "1"}, format="json").status_code, 405
        )
        self.assertEqual(self.client.delete(f"/api/admin/challenges/{c.id}/").status_code, 405)
        c.refresh_from_db()
        self.assertEqual(c.entry_fee, Decimal("100.00"))

    def test_reading_still_works(self):
        self._as(self.staff)
        self.assertEqual(self.client.get("/api/admin/users/").status_code, 200)
        self.assertEqual(self.client.get(f"/api/admin/users/{self.customer.id}/").status_code, 200)

    # ── Account deletion is the anonymising flow ──────────────────────────────
    def test_delete_user_anonymises_and_keeps_the_row(self):
        self._as(self.owner)
        res = self.client.delete(f"/api/admin/users/{self.customer.id}/delete_user/", {"reason": "requested"}, format="json")
        self.assertEqual(res.status_code, 200, res.content)
        self.customer.refresh_from_db()
        self.assertIsNotNone(self.customer.deleted_at)
        self.assertNotEqual(self.customer.email, "walker@example.com")
        self.assertTrue(AuditLog.objects.filter(action="delete", resource_type="user", resource_id=self.customer.id).exists())

    def test_delete_user_refused_with_blockers_when_money_is_held(self):
        self.customer.wallet_balance = Decimal("50.00")
        self.customer.save(update_fields=["wallet_balance"])
        self._as(self.owner)
        res = self.client.delete(f"/api/admin/users/{self.customer.id}/delete_user/", format="json")
        self.assertEqual(res.status_code, 409)
        self.assertIn("wallet_balance", [b["code"] for b in res.json()["blockers"]])
        self.customer.refresh_from_db()
        self.assertIsNone(self.customer.deleted_at)

    def test_delete_user_is_superuser_only(self):
        self._as(self.staff)
        res = self.client.delete(f"/api/admin/users/{self.customer.id}/delete_user/", format="json")
        self.assertEqual(res.status_code, 403)

    def test_deleting_a_creator_keeps_other_peoples_challenges(self):
        c = self._challenge(status="completed", with_participant=False)
        self._as(self.owner)
        self.client.delete(f"/api/admin/users/{self.customer.id}/delete_user/", format="json")
        self.assertTrue(Challenge.objects.filter(pk=c.pk).exists())

    # ── Challenge edits and deletes ───────────────────────────────────────────
    def test_goal_of_a_challenge_with_entries_cannot_change(self):
        c = self._challenge()
        self._as(self.owner)
        res = self.client.patch(f"/api/admin/challenges/{c.id}/update_challenge/", {"milestone": 10000}, format="json")
        self.assertEqual(res.status_code, 400)
        c.refresh_from_db()
        self.assertEqual(c.milestone, 50000)

    def test_renaming_is_allowed_and_audited(self):
        c = self._challenge()
        self._as(self.owner)
        res = self.client.patch(f"/api/admin/challenges/{c.id}/update_challenge/", {"name": "Lunch walkers"}, format="json")
        self.assertEqual(res.status_code, 200, res.content)
        log = AuditLog.objects.get(action="update", resource_type="challenge", resource_id=c.id)
        self.assertEqual(log.changes["name"]["new"], "Lunch walkers")

    def test_only_cancelled_challenges_can_be_deleted(self):
        completed = self._challenge(status="completed")
        cancelled = self._challenge(status="cancelled", with_participant=False)
        self._as(self.owner)
        self.assertEqual(self.client.delete(f"/api/admin/challenges/{completed.id}/delete_challenge/").status_code, 400)
        self.assertTrue(Challenge.objects.filter(pk=completed.pk).exists())
        self.assertEqual(self.client.delete(f"/api/admin/challenges/{cancelled.id}/delete_challenge/").status_code, 200)
        self.assertFalse(Challenge.objects.filter(pk=cancelled.pk).exists())
        self.assertTrue(AuditLog.objects.filter(action="delete", resource_type="challenge", resource_id=cancelled.id).exists())

    def test_bulk_delete_skips_completed(self):
        completed = self._challenge(status="completed")
        self._as(self.owner)
        res = self.client.post("/api/admin/challenges/bulk_delete/", {"challenge_ids": [completed.id]}, format="json")
        self.assertEqual(res.status_code, 200)
        self.assertTrue(Challenge.objects.filter(pk=completed.pk).exists())


class WithdrawalAuditTests(TestCase):
    def test_reject_writes_an_audit_row_with_the_withdrawal_id(self):
        from apps.payments.models import WithdrawalRequest

        admin = User.objects.create_user(
            username="fin", email="fin@example.com", phone_number="254711000311",
            password="TestPass123!", is_staff=True, is_superuser=True,
        )
        user = User.objects.create_user(
            username="payee", email="payee@example.com", phone_number="254711000312", password="TestPass123!",
        )
        w = WithdrawalRequest.objects.create(
            user=user, amount_kes=Decimal("100.00"), method="mpesa", phone_number="254711000312", status="pending_review",
        )
        client = APIClient()
        client.force_authenticate(admin)
        res = client.post(f"/api/admin/withdrawals/{w.id}/reject/", {"reason": "duplicate"}, format="json")
        self.assertEqual(res.status_code, 200, res.content)
        log = AuditLog.objects.get(action="reject", resource_type="withdrawal")
        self.assertEqual(log.changes["withdrawal_id"], str(w.id))
