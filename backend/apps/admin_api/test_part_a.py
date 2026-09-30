"""Admin console part A: staff roles, wallet corrections, deposits, withdrawals,
step corrections, user tools and challenge controls."""

from datetime import date, timedelta
from decimal import Decimal
from itertools import count
from unittest import mock

from django.contrib.auth import get_user_model
from django.test import TestCase
from django.utils import timezone
from rest_framework.test import APIClient

from apps.admin_api.models import AuditLog, StaffInvite, StaffProfile, WalletCorrection
from apps.challenges.models import Challenge, Participant
from apps.payments.models import PaymentTransaction, PlatformRevenue, WithdrawalRequest
from apps.wallet.models import WalletTransaction

User = get_user_model()
_phone = count(700000)


def make_user(username, *, roles=None, superuser=False, staff=False, balance="0.00"):
    user = User.objects.create_user(
        username=username,
        email=f"{username}@example.com",
        phone_number=f"254711{next(_phone)}",
        password="Pass!word-2026",
        is_staff=bool(staff or roles is not None or superuser),
        is_superuser=superuser,
        wallet_balance=Decimal(balance),
    )
    if roles is not None:
        StaffProfile.objects.create(user=user, roles=roles)
    return user


class PartABase(TestCase):
    def setUp(self):
        self.owner = make_user("owner", superuser=True)
        self.finance = make_user("fin", roles=["finance"])
        self.finance2 = make_user("fin2", roles=["finance"])
        self.support = make_user("sup", roles=["support"])
        self.trust = make_user("tru", roles=["trust"])
        self.content = make_user("con", roles=["content"])
        self.settings_staff = make_user("set", roles=["settings"])
        self.alice = make_user("alice", balance="1000.00")
        self.client = APIClient()

    def as_(self, user):
        self.client.force_authenticate(user)
        return self.client


class RoleTests(PartABase):
    # (method, path, body, allowed role attribute names)
    def endpoints(self):
        return [
            ("get", "/api/admin/finance/ledger/", None, {"finance", "support"}),
            ("post", "/api/admin/finance/adjustments/", {}, {"finance"}),
            ("get", "/api/admin/support/queue/", None, {"support", "trust"}),
            ("get", "/api/admin/trust/summary/", None, {"trust"}),
            ("post", "/api/admin/badges/", {}, {"content"}),
            ("post", "/api/admin/settings/update/", {}, {"settings"}),
            ("get", "/api/admin/staff/", None, set()),
            ("patch", "/api/admin/finance/controls/", {}, set()),
        ]

    def test_each_group_is_enforced_and_owner_passes(self):
        people = {
            "finance": self.finance, "support": self.support, "trust": self.trust,
            "content": self.content, "settings": self.settings_staff,
        }
        for method, path, body, allowed in self.endpoints():
            for role, user in people.items():
                res = getattr(self.as_(user), method)(path, body, format="json")
                if role in allowed:
                    self.assertNotEqual(res.status_code, 403, f"{role} {method} {path}")
                else:
                    self.assertEqual(res.status_code, 403, f"{role} {method} {path}")
            res = getattr(self.as_(self.owner), method)(path, body, format="json")
            self.assertNotEqual(res.status_code, 403, f"owner {method} {path}")
        self.assertEqual(self.as_(self.alice).get("/api/admin/finance/ledger/").status_code, 403)

    def test_legacy_staff_without_profile_has_all_but_owner(self):
        legacy = make_user("legacy", staff=True)
        c = self.as_(legacy)
        self.assertEqual(c.get("/api/admin/finance/ledger/").status_code, 200)
        self.assertEqual(c.get("/api/admin/trust/summary/").status_code, 200)
        self.assertEqual(c.get("/api/admin/staff/").status_code, 403)
        body = c.get("/api/admin/me/permissions/").data
        self.assertTrue(body["legacy_roles"])
        self.assertNotIn("owner", body["roles"])

    def test_me_permissions(self):
        body = self.as_(self.support).get("/api/admin/me/permissions/").data
        self.assertEqual(body["roles"], ["support"])
        self.assertIn("support.reply", body["permissions"])
        self.assertNotIn("finance.adjust", body["permissions"])
        self.assertFalse(body["is_owner"])
        body = self.as_(self.owner).get("/api/admin/me/permissions/").data
        self.assertTrue(body["is_owner"])
        self.assertIn("owner.staff", body["permissions"])
        self.assertEqual(self.as_(self.alice).get("/api/admin/me/permissions/").status_code, 403)

    def test_support_cannot_reset_owner_password(self):
        res = self.as_(self.support).post(
            f"/api/admin/users/{self.owner.id}/reset_password/", {"new_password": "An0ther!Pass-99"}, format="json"
        )
        self.assertEqual(res.status_code, 403)

    def test_invite_register_and_roles(self):
        c = self.as_(self.owner)
        res = c.post("/api/admin/staff/invite/", {"identifier": "new@example.com", "roles": ["trust", "support"]}, format="json")
        self.assertEqual(res.status_code, 201)
        code = res.data["code"]
        self.assertFalse(StaffInvite.objects.filter(code_hash=code).exists())  # only the hash is stored
        anon = APIClient()
        bad = anon.post("/api/admin/auth/register/", {
            "username": "newbie", "email": "other@example.com", "password": "Str0ng!Pass-2026",
            "confirm_password": "Str0ng!Pass-2026", "invite_code": code}, format="json")
        self.assertEqual(bad.status_code, 403)
        ok = anon.post("/api/admin/auth/register/", {
            "username": "newbie", "email": "new@example.com", "password": "Str0ng!Pass-2026",
            "confirm_password": "Str0ng!Pass-2026", "invite_code": code}, format="json")
        self.assertEqual(ok.status_code, 201, ok.content)
        newbie = User.objects.get(username="newbie")
        self.assertTrue(newbie.is_staff and not newbie.is_superuser)
        self.assertEqual(newbie.staff_profile.roles, ["support", "trust"])
        again = anon.post("/api/admin/auth/register/", {
            "username": "newbie2", "email": "new@example.com", "password": "Str0ng!Pass-2026",
            "confirm_password": "Str0ng!Pass-2026", "invite_code": code}, format="json")
        self.assertEqual(again.status_code, 403)
        # change roles, then remove
        res = c.post(f"/api/admin/staff/{newbie.id}/roles/", {"roles": ["content"]}, format="json")
        self.assertEqual(res.data["staff"]["roles"], ["content"])
        res = c.post(f"/api/admin/staff/{newbie.id}/remove/", {"reason": "left the team"}, format="json")
        newbie.refresh_from_db()
        self.assertFalse(newbie.is_staff)
        self.assertTrue(AuditLog.objects.filter(resource_type="staff", action="demote", resource_id=newbie.id).exists())
        # the last owner can't lose the owner role
        self.assertEqual(c.post(f"/api/admin/staff/{self.owner.id}/roles/", {"roles": ["finance"]}, format="json").status_code, 400)


class AdjustmentTests(PartABase):
    def adjust(self, user, amount, key, reason="Goodwill credit"):
        return self.as_(user).post(
            "/api/admin/finance/adjustments/",
            {"user_id": self.alice.id, "amount": amount, "reason": reason, "idempotency_key": key},
            format="json",
        )

    def test_credit_and_debit_math_with_ledger_and_audit(self):
        res = self.adjust(self.finance, "250.50", "key-credit-1")
        self.assertEqual(res.status_code, 201, res.content)
        self.assertEqual(res.data["correction"]["status"], "applied")
        self.alice.refresh_from_db()
        self.assertEqual(self.alice.wallet_balance, Decimal("1250.50"))
        t = WalletTransaction.objects.get(type="adjustment", user=self.alice)
        self.assertEqual((t.balance_before, t.balance_after, t.amount), (Decimal("1000.00"), Decimal("1250.50"), Decimal("250.50")))
        res = self.adjust(self.finance, "-50.50", "key-debit-01")
        self.alice.refresh_from_db()
        self.assertEqual(self.alice.wallet_balance, Decimal("1200.00"))
        self.assertTrue(AuditLog.objects.filter(resource_type="wallet", action="adjust", resource_id=self.alice.id).count() >= 4)

    def test_idempotency(self):
        a = self.adjust(self.finance, "10", "same-key-123")
        b = self.adjust(self.finance, "10", "same-key-123")
        self.assertEqual(a.status_code, 201)
        self.assertEqual(b.status_code, 200)
        self.assertEqual(a.data["correction"]["id"], b.data["correction"]["id"])
        self.assertEqual(WalletTransaction.objects.filter(type="adjustment").count(), 1)
        self.assertEqual(self.adjust(self.finance, "11", "same-key-123").status_code, 409)

    def test_never_negative(self):
        res = self.adjust(self.finance, "-1000.01", "neg-key-001")
        self.assertEqual(res.status_code, 400)
        self.alice.refresh_from_db()
        self.assertEqual(self.alice.wallet_balance, Decimal("1000.00"))
        self.assertFalse(WalletTransaction.objects.filter(type="adjustment").exists())

    def test_two_person_rule(self):
        res = self.adjust(self.finance, "6000", "big-key-0001")
        self.assertEqual(res.data["correction"]["status"], "pending")
        cid = res.data["correction"]["id"]
        self.alice.refresh_from_db()
        self.assertEqual(self.alice.wallet_balance, Decimal("1000.00"))
        # the requester can't approve their own request
        same = self.as_(self.finance).post(f"/api/admin/finance/corrections/{cid}/approve/", {}, format="json")
        self.assertEqual(same.status_code, 403)
        # support can't approve at all
        self.assertEqual(self.as_(self.support).post(f"/api/admin/finance/corrections/{cid}/approve/", {}, format="json").status_code, 403)
        ok = self.as_(self.finance2).post(f"/api/admin/finance/corrections/{cid}/approve/", {}, format="json")
        self.assertEqual(ok.status_code, 200, ok.content)
        self.alice.refresh_from_db()
        self.assertEqual(self.alice.wallet_balance, Decimal("7000.00"))
        self.assertEqual(WalletCorrection.objects.get(id=cid).decided_by, self.finance2)
        self.assertEqual(self.as_(self.owner).post(f"/api/admin/finance/corrections/{cid}/approve/", {}, format="json").status_code, 409)

    def test_reversal_once_only(self):
        deposit = WalletTransaction.objects.create(
            user=self.alice, type="deposit", amount=Decimal("300"), balance_before=Decimal("700"),
            balance_after=Decimal("1000"), description="dep", reference_id="DEP-X1",
        )
        c = self.as_(self.finance)
        res = c.post(f"/api/admin/finance/transactions/{deposit.id}/reverse/", {"reason": "Duplicate credit", "idempotency_key": "rev-key-001"}, format="json")
        self.assertEqual(res.status_code, 201, res.content)
        rev = WalletTransaction.objects.get(type="reversal")
        self.assertEqual(rev.reversal_of_id, deposit.id)
        self.assertEqual(rev.amount, Decimal("-300"))
        self.alice.refresh_from_db()
        self.assertEqual(self.alice.wallet_balance, Decimal("700.00"))
        again = c.post(f"/api/admin/finance/transactions/{deposit.id}/reverse/", {"reason": "Duplicate credit", "idempotency_key": "rev-key-002"}, format="json")
        self.assertEqual(again.status_code, 409)
        self.assertEqual(again.data["code"], "already_reversed")
        rr = c.post(f"/api/admin/finance/transactions/{rev.id}/reverse/", {"reason": "Undo the undo", "idempotency_key": "rev-key-003"}, format="json")
        self.assertEqual(rr.data["code"], "is_reversal")
        wd = WalletTransaction.objects.create(
            user=self.alice, type="withdrawal", amount=Decimal("-10"), balance_before=Decimal("710"),
            balance_after=Decimal("700"), description="wd",
        )
        self.assertEqual(
            c.post(f"/api/admin/finance/transactions/{wd.id}/reverse/", {"reason": "not allowed", "idempotency_key": "rev-key-004"}, format="json").data["code"],
            "not_reversible",
        )


class DepositWithdrawalTests(PartABase):
    def test_deposit_verify_credits_exactly_once(self):
        txn = PaymentTransaction.objects.create(
            user=self.alice, type="deposit", status="pending", amount_kes=Decimal("500"), order_id="DEP-ABC",
            tracking_reference="TR-ABC", collection_id="INV-1", phone_number="254700000001", narration="d",
        )
        invoice = {"invoice_id": "INV-1", "state": "COMPLETE", "mpesa_reference": "QWE123"}
        c = self.as_(self.finance)
        with mock.patch("apps.payments.intasend.query_collection", return_value=invoice):
            r1 = c.post(f"/api/admin/finance/deposits/{txn.id}/verify/", {}, format="json")
            r2 = c.post(f"/api/admin/finance/deposits/{txn.id}/verify/", {}, format="json")
        self.assertEqual(r1.data["outcome"], "credited", r1.content)
        self.assertEqual(r2.data["outcome"], "already_completed")
        self.alice.refresh_from_db()
        self.assertEqual(self.alice.wallet_balance, Decimal("1500.00"))
        self.assertEqual(WalletTransaction.objects.filter(reference_id="DEP-ABC").count(), 1)
        detail = c.get(f"/api/admin/finance/deposits/{txn.id}/")
        self.assertTrue(detail.data["callbacks"])
        self.assertEqual(c.get("/api/admin/finance/deposits/?q=QWE123").data["count"], 1)

    def _processing(self, amount="200"):
        w = WithdrawalRequest.objects.create(user=self.alice, status="processing", amount_kes=Decimal(amount),
                                             method="mpesa", phone_number="254700000001", tracking_reference=f"T-{amount}")
        PaymentTransaction.objects.create(user=self.alice, type="payout", status="pending", amount_kes=Decimal(amount),
                                          order_id=str(w.id), tracking_reference=f"T-{amount}", phone_number="2547", narration="w")
        return w

    def test_withdrawal_resolve_failed_refunds_once(self):
        w = self._processing()
        c = self.as_(self.finance)
        res = c.post(f"/api/admin/finance/withdrawals/{w.id}/resolve/", {"outcome": "failed", "reason": "IntaSend says failed"}, format="json")
        self.assertEqual(res.status_code, 200, res.content)
        self.alice.refresh_from_db()
        self.assertEqual(self.alice.wallet_balance, Decimal("1200.00"))
        w.refresh_from_db()
        self.assertEqual(w.status, "failed")
        self.assertEqual(c.post(f"/api/admin/finance/withdrawals/{w.id}/resolve/", {"outcome": "failed", "reason": "again please"}, format="json").status_code, 409)
        self.alice.refresh_from_db()
        self.assertEqual(self.alice.wallet_balance, Decimal("1200.00"))
        # the user got an in-app notice
        self.assertTrue(self.alice.support_tickets.filter(subject="Withdrawal could not be paid").exists())

    def test_withdrawal_resolve_paid(self):
        w = self._processing("300")
        res = self.as_(self.finance).post(f"/api/admin/finance/withdrawals/{w.id}/resolve/",
                                          {"outcome": "paid", "reason": "Confirmed on statement", "mpesa_reference": "MP1"}, format="json")
        self.assertEqual(res.data["status"], "completed")
        self.assertEqual(PaymentTransaction.objects.get(order_id=str(w.id)).status, "completed")
        self.alice.refresh_from_db()
        self.assertEqual(self.alice.wallet_balance, Decimal("1000.00"))
        self.assertEqual(self.as_(self.support).post(f"/api/admin/finance/withdrawals/{w.id}/resolve/", {}, format="json").status_code, 403)


class StepCorrectionTests(PartABase):
    def setUp(self):
        super().setUp()
        from apps.steps.models import HealthRecord

        self.day = timezone.localdate() - timedelta(days=1)
        self.rec = HealthRecord.objects.create(user=self.alice, date=self.day, steps=8000, eligible_steps=8000)
        self.ch = Challenge.objects.create(
            creator=self.owner, name="Live", entry_fee=Decimal("0"), milestone=10000,
            start_date=self.day - timedelta(days=1), end_date=self.day + timedelta(days=5), status="active",
        )
        self.p = Participant.objects.create(challenge=self.ch, user=self.alice, steps=8000)

    def correct(self, **body):
        return self.as_(self.trust).post(f"/api/admin/users/{self.alice.id}/correct_steps/",
                                         {"date": self.day.isoformat(), "reason": "Phone double counted", **body}, format="json")

    def test_set_recomputes_and_clear_restores(self):
        res = self.correct(kind="set", steps=12000)
        self.assertEqual(res.status_code, 200, res.content)
        self.rec.refresh_from_db()
        self.p.refresh_from_db()
        self.alice.refresh_from_db()
        self.assertEqual((self.rec.steps, self.rec.eligible_steps), (12000, 12000))
        self.assertEqual(self.p.steps, 12000)
        self.assertTrue(self.p.qualified)
        self.assertEqual(self.alice.total_steps, 12000)
        res = self.correct(kind="void")
        self.p.refresh_from_db()
        self.assertEqual(self.p.steps, 0)
        res = self.correct(kind="clear")
        self.rec.refresh_from_db()
        self.p.refresh_from_db()
        self.assertEqual(self.rec.steps, 8000)
        self.assertEqual(self.p.steps, 8000)
        from apps.steps.models import StepCorrection

        self.assertEqual(StepCorrection.objects.filter(user=self.alice).count(), 3)  # append-only
        self.assertTrue(AuditLog.objects.filter(action="steps_correction", resource_id=self.alice.id).exists())

    def test_settled_challenge_refused(self):
        done = Challenge.objects.create(
            creator=self.owner, name="Done", entry_fee=Decimal("0"), milestone=10000,
            start_date=self.day - timedelta(days=3), end_date=self.day, status="completed",
        )
        Participant.objects.create(challenge=done, user=self.alice, steps=8000)
        res = self.correct(kind="set", steps=20000)
        self.assertEqual(res.status_code, 409)
        self.rec.refresh_from_db()
        self.assertEqual(self.rec.steps, 8000)

    def test_permission(self):
        res = self.as_(self.support).post(f"/api/admin/users/{self.alice.id}/correct_steps/", {}, format="json")
        self.assertEqual(res.status_code, 403)


class UserToolTests(PartABase):
    def test_sign_out_everywhere(self):
        from rest_framework_simplejwt.token_blacklist.models import BlacklistedToken
        from rest_framework_simplejwt.tokens import RefreshToken

        RefreshToken.for_user(self.alice)
        res = self.as_(self.support).post(f"/api/admin/users/{self.alice.id}/sign_out_everywhere/", {}, format="json")
        self.assertEqual(res.status_code, 200)
        self.assertTrue(BlacklistedToken.objects.filter(token__user=self.alice).exists())
        self.assertTrue(AuditLog.objects.filter(action="sign_out", resource_id=self.alice.id).exists())

    def test_device_reset(self):
        from apps.steps.models import DeviceRegistration

        self.alice.device_id = "d" * 40
        self.alice.save()
        DeviceRegistration.objects.create(user=self.alice, device_id="d" * 40, platform="android")
        self.assertEqual(self.as_(self.support).post(f"/api/admin/users/{self.alice.id}/reset_device/", {"reason": "lost phone"}, format="json").status_code, 403)
        res = self.as_(self.trust).post(f"/api/admin/users/{self.alice.id}/reset_device/", {"mode": "reset", "reason": "Lost phone"}, format="json")
        self.assertEqual(res.status_code, 200, res.content)
        self.alice.refresh_from_db()
        self.assertIsNone(self.alice.device_id)
        self.assertFalse(DeviceRegistration.objects.filter(user=self.alice, is_active=True).exists())

    def test_csv_export_permission_and_no_secrets(self):
        self.assertEqual(self.as_(self.content).get("/api/admin/users/export/").status_code, 403)
        res = self.as_(self.support).get("/api/admin/users/export/?search=alice")
        self.assertEqual(res.status_code, 200)
        body = res.content.decode()
        self.assertIn("alice@example.com", body)
        self.assertNotIn("pbkdf2", body)
        self.assertNotIn("password", body.lower())
        self.assertTrue(AuditLog.objects.filter(action="export").exists())

    def test_badge_revoke_and_award_audited(self):
        from apps.gamification.models import Badge, UserBadge

        badge = Badge.objects.create(slug="b1", name="B1", description="d", icon="x", badge_type="milestone",
                                     criteria_type="total_steps", criteria_value=1)
        c = self.as_(self.content)
        self.assertEqual(c.post(f"/api/admin/badges/{badge.id}/award_to_user/", {"user_id": self.alice.id}, format="json").status_code, 200)
        self.assertTrue(AuditLog.objects.filter(action="award", resource_id=self.alice.id).exists())
        res = c.post(f"/api/admin/users/{self.alice.id}/revoke_badge/", {"badge_id": badge.id, "reason": "Awarded by mistake"}, format="json")
        self.assertEqual(res.status_code, 200, res.content)
        self.assertFalse(UserBadge.objects.filter(user=self.alice, badge=badge).exists())
        self.assertTrue(AuditLog.objects.filter(action="revoke", resource_id=self.alice.id).exists())

    def test_xp_adjust_applies_once_and_not_below_zero(self):
        from apps.users.models import UserXP

        c = self.as_(self.content)
        res = c.post(f"/api/admin/users/{self.alice.id}/adjust_xp/", {"amount": 150, "reason": "Event bonus"}, format="json")
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(UserXP.objects.get(user=self.alice).total_xp, 150)
        self.assertEqual(c.post(f"/api/admin/users/{self.alice.id}/adjust_xp/", {"amount": -500, "reason": "Too much"}, format="json").status_code, 400)
        self.assertTrue(AuditLog.objects.filter(action="xp_adjust", resource_id=self.alice.id).exists())

    def test_edit_names_goal_message_and_records(self):
        c = self.as_(self.support)
        res = c.patch(f"/api/admin/users/{self.alice.id}/update_user/", {"first_name": "Alice", "daily_goal": 12000}, format="json")
        self.assertEqual(res.status_code, 200, res.content)
        self.alice.refresh_from_db()
        self.assertEqual((self.alice.first_name, self.alice.daily_goal), ("Alice", 12000))
        res = c.post(f"/api/admin/users/{self.alice.id}/message/", {"subject": "About your deposit", "message": "Hi Alice"}, format="json")
        self.assertEqual(res.status_code, 201)
        self.assertTrue(self.alice.support_tickets.filter(subject="About your deposit", status="in_progress").exists())
        rec = c.get(f"/api/admin/users/{self.alice.id}/records/")
        self.assertEqual(rec.status_code, 200)
        self.assertIn("consents", rec.data)
        self.assertTrue(rec.data["change_history"])


class ChallengeControlTests(PartABase):
    def _challenge(self, fee="100", **kw):
        return Challenge.objects.create(
            creator=self.owner, name="C", entry_fee=Decimal(fee), milestone=10000,
            start_date=date.today(), end_date=date.today() + timedelta(days=3), status="active", **kw,
        )

    def _join(self, ch, user):
        user.refresh_from_db()
        user.wallet_balance -= ch.entry_fee
        user.locked_balance += ch.entry_fee
        user.save()
        ch.total_pool += ch.entry_fee
        ch.save()
        return Participant.objects.create(challenge=ch, user=user)

    def test_remove_participant_refund_and_forfeit(self):
        ch = self._challenge()
        bob = make_user("bob", balance="500.00")
        self._join(ch, self.alice)
        self._join(ch, bob)
        c = self.as_(self.trust)
        res = c.post(f"/api/admin/challenges/{ch.id}/remove_participant/", {"user_id": self.alice.id, "mode": "refund", "reason": "Wrong challenge"}, format="json")
        self.assertEqual(res.status_code, 200, res.content)
        self.alice.refresh_from_db()
        self.assertEqual((self.alice.wallet_balance, self.alice.locked_balance), (Decimal("1000.00"), Decimal("0.00")))
        res = c.post(f"/api/admin/challenges/{ch.id}/remove_participant/", {"user_id": bob.id, "mode": "forfeit", "reason": "Confirmed cheating"}, format="json")
        bob.refresh_from_db()
        self.assertEqual((bob.wallet_balance, bob.locked_balance), (Decimal("400.00"), Decimal("0.00")))
        self.assertTrue(PlatformRevenue.objects.filter(challenge=ch, amount_kes=Decimal("100"), metadata__kind="forfeited_entry").exists())
        ch.refresh_from_db()
        self.assertEqual(ch.total_pool, Decimal("0.00"))
        self.assertEqual(AuditLog.objects.filter(action="disqualify").count(), 2)
        self.assertEqual(self.as_(self.content).post(f"/api/admin/challenges/{ch.id}/remove_participant/", {}, format="json").status_code, 403)

    def test_platform_challenge_bonus_is_funded_once_at_settlement(self):
        # content alone can't spend platform money
        body = {"name": "Sponsored walk", "milestone": 10000, "entry_fee": "100", "platform_bonus_kes": "500",
                "end_date": (date.today() + timedelta(days=7)).isoformat(), "max_participants": 50}
        self.assertEqual(self.as_(self.content).post("/api/admin/challenges/create_platform/", body, format="json").status_code, 403)
        res = self.as_(self.owner).post("/api/admin/challenges/create_platform/", body, format="json")
        self.assertEqual(res.status_code, 201, res.content)
        ch = Challenge.objects.get(id=res.data["id"])
        self.assertTrue(ch.is_platform_challenge)
        bob = make_user("bob2", balance="500.00")
        p1 = self._join(ch, self.alice)
        self._join(ch, bob)
        Participant.objects.filter(id=p1.id).update(steps=15000, qualified=True)
        Challenge.objects.filter(id=ch.id).update(end_date=date.today() - timedelta(days=1), start_date=date.today() - timedelta(days=8))
        from apps.challenges.services import finalize_challenge

        self.assertTrue(finalize_challenge(ch))
        ch.refresh_from_db()
        payout = WalletTransaction.objects.get(user=self.alice, type="payout").amount
        self.assertEqual(payout, Decimal("200") - ch.platform_fee + Decimal("500"))
        self.assertEqual(PlatformRevenue.objects.filter(challenge=ch, metadata__kind="platform_bonus").get().amount_kes, Decimal("-500"))

    def test_archive_hides_from_customer_list(self):
        ch = self._challenge()
        Challenge.objects.filter(id=ch.id).update(status="completed")
        c = self.as_(self.content)
        self.assertEqual(c.post(f"/api/admin/challenges/{ch.id}/set_archived/", {"archived": True}, format="json").status_code, 200)
        ch.refresh_from_db()
        self.assertTrue(ch.is_archived)
        other = make_user("carol")
        res = self.as_(other).get("/api/challenges/?status=completed")
        ids = [r["id"] for r in (res.data.get("results", res.data) if isinstance(res.data, dict) else res.data)]
        self.assertNotIn(ch.id, ids)
        live = self._challenge()
        c = self.as_(self.content)
        self.assertEqual(c.post(f"/api/admin/challenges/{live.id}/set_archived/", {"archived": True}, format="json").status_code, 400)

    def test_bulk_cancel_is_audited(self):
        a, b = self._challenge(), self._challenge()
        res = self.as_(self.content).post("/api/admin/challenges/bulk_cancel/", {"challenge_ids": [a.id, b.id], "reason": "Duplicate"}, format="json")
        self.assertEqual(res.data["cancelled"], 2)
        self.assertEqual(AuditLog.objects.filter(action="cancel", resource_type="challenge").count(), 2)
