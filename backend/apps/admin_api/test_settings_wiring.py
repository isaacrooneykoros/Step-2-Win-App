"""Admin settings that used to be stored only and are now enforced end to end:
entry fee range, max participants, challenge approval, XP rates, withdrawal
review time, notification emails, and the hidden referral switch."""

from datetime import timedelta
from decimal import Decimal
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.test import TestCase
from django.utils import timezone
from rest_framework.test import APIClient

from apps.admin_api.models import SystemSettings
from apps.admin_api.platform import entry_fee_suggestions
from apps.admin_api.system_views import ENFORCED_BY
from apps.challenges.models import Challenge, get_configured_milestones
from apps.gamification.models import XPEvent
from apps.gamification.tasks import award_daily_step_xp
from apps.users.models import UserXP
from apps.wallet.models import WalletTransaction

User = get_user_model()
PHONE = "254712346601"


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
            username="wiring_user", email="wiring@example.com", phone_number=PHONE,
            password="TestPass123!", wallet_balance=Decimal("50000.00"), challenges_joined=3,
        )
        self.other = User.objects.create_user(
            username="wiring_other", email="wiring2@example.com", phone_number="254712346602",
            password="TestPass123!", wallet_balance=Decimal("5000.00"),
        )
        self.admin = User.objects.create_user(
            username="wiring_admin", email="wiringadmin@example.com", phone_number="254712346603",
            password="TestPass123!", is_staff=True,
        )
        self.client.force_authenticate(self.user)

    def tearDown(self):
        cache.clear()

    def create(self, fee=500, is_public=True, **extra):
        body = {
            "name": "Wiring", "milestone": get_configured_milestones()[0], "entry_fee": fee,
            "is_public": is_public, "duration_days": 7, **extra,
        }
        return self.client.post("/api/challenges/create/", body, format="json")

    def admin_update(self, **values):
        self.client.force_authenticate(self.admin)
        res = self.client.post("/api/admin/settings/update/", values, format="json")
        self.client.force_authenticate(self.user)
        return res


class DefaultsTests(_Base):
    def test_defaults_match_previous_live_behaviour(self):
        s = SystemSettings.load()
        self.assertEqual(s.min_challenge_entry_fee, Decimal("50.00"))
        self.assertEqual(s.max_challenge_entry_fee, Decimal("10000.00"))
        self.assertFalse(s.challenge_approval_required)
        res = self.create()
        self.assertEqual(res.status_code, 201, res.content)
        self.assertEqual(res.json()["status"], "active")


class EntryFeeRangeTests(_Base):
    def test_create_and_config_follow_settings(self):
        set_settings(min_challenge_entry_fee=Decimal("200.00"), max_challenge_entry_fee=Decimal("600.00"))
        self.assertEqual(self.create(fee=150).status_code, 400)
        self.assertEqual(self.create(fee=700).status_code, 400)
        self.assertIn("between KES 200 and KES 600", str(self.create(fee=700).content))
        self.assertEqual(self.create(fee=200).status_code, 201)
        cfg = self.client.get("/api/challenges/config/").json()
        self.assertEqual((cfg["entry_fee_min"], cfg["entry_fee_max"]), (200, 600))
        self.assertTrue(cfg["entry_fee_suggestions"])
        self.assertTrue(all(200 <= v <= 600 for v in cfg["entry_fee_suggestions"]))

    def test_suggestions_are_spread_when_ladder_misses(self):
        self.assertEqual(entry_fee_suggestions(50, 10000), [100, 250, 500, 1000, 2000])
        picks = entry_fee_suggestions(3000, 10000)
        self.assertEqual(picks[0], 3000)
        self.assertEqual(picks[-1], 10000)
        self.assertTrue(len(picks) >= 2)

    def test_admin_validation(self):
        self.assertEqual(self.admin_update(min_challenge_entry_fee="0.00").status_code, 400)
        self.assertEqual(self.admin_update(max_challenge_entry_fee="20000.00").status_code, 400)
        self.assertEqual(self.admin_update(min_challenge_entry_fee="10.50").status_code, 400)
        res = self.admin_update(min_challenge_entry_fee="5000.00", max_challenge_entry_fee="5000.00")
        self.assertEqual(res.status_code, 400)
        self.assertIn("max_challenge_entry_fee", res.json())
        self.assertEqual(self.admin_update(min_challenge_entry_fee="100.00", max_challenge_entry_fee="5000.00").status_code, 200)


class MaxParticipantsTests(_Base):
    def test_create_limited_by_setting(self):
        set_settings(max_challenge_participants=10)
        res = self.create(max_participants=11)
        self.assertEqual(res.status_code, 400)
        self.assertIn("Maximum 10 participants", str(res.content))
        self.assertEqual(self.create(max_participants=10).status_code, 201)
        # The implicit default (20) is clamped to the limit instead of failing.
        res = self.create()
        self.assertEqual(res.status_code, 201, res.content)
        self.assertEqual(res.json()["max_participants"], 10)
        self.assertEqual(self.client.get("/api/challenges/config/").json()["max_challenge_participants"], 10)

    def test_admin_bounds(self):
        self.assertEqual(self.admin_update(max_challenge_participants=1).status_code, 400)
        self.assertEqual(self.admin_update(max_challenge_participants=5000).status_code, 400)


class ApprovalTests(_Base):
    def setUp(self):
        super().setUp()
        set_settings(challenge_approval_required=True)

    def test_public_challenge_waits_and_is_hidden(self):
        res = self.create(fee=500)
        self.assertEqual(res.status_code, 201, res.content)
        self.assertEqual(res.json()["status"], "pending")
        self.assertTrue(self.client.get("/api/challenges/config/").json()["public_challenges_need_approval"])
        c = Challenge.objects.get(pk=res.json()["id"])

        # Creator still sees it; others don't, can't open the lobby card, can't join.
        self.assertIn(c.id, [x["id"] for x in self.client.get("/api/challenges/").json()["results"]])
        self.client.force_authenticate(self.other)
        self.assertNotIn(c.id, [x["id"] for x in self.client.get("/api/challenges/lobby/").json()["challenges"]])
        self.assertNotIn(c.id, [x["id"] for x in self.client.get("/api/challenges/").json()["results"]])
        self.assertEqual(self.client.get(f"/api/challenges/lobby/{c.id}/").status_code, 404)
        join = self.client.post("/api/challenges/join/", {"invite_code": c.invite_code}, format="json")
        self.assertEqual(join.status_code, 400)

        # Admin approves: live, listed, joinable.
        self.client.force_authenticate(self.admin)
        self.assertEqual(self.client.post(f"/api/admin/challenges/{c.id}/approve_challenge/").status_code, 200)
        self.client.force_authenticate(self.other)
        self.assertIn(c.id, [x["id"] for x in self.client.get("/api/challenges/lobby/").json()["challenges"]])
        join = self.client.post("/api/challenges/join/", {"invite_code": c.invite_code}, format="json")
        self.assertEqual(join.status_code, 200, join.content)

    def test_private_challenge_skips_approval(self):
        res = self.create(is_public=False)
        self.assertEqual(res.json()["status"], "active")

    def test_approval_restarts_clock(self):
        c = Challenge.objects.get(pk=self.create().json()["id"])
        Challenge.objects.filter(pk=c.pk).update(
            start_date=timezone.localdate() - timedelta(days=3), end_date=timezone.localdate() + timedelta(days=4)
        )
        self.client.force_authenticate(self.admin)
        self.client.post(f"/api/admin/challenges/{c.id}/approve_challenge/")
        c.refresh_from_db()
        self.assertEqual(c.status, "active")
        self.assertEqual(c.start_date, timezone.localdate())
        self.assertEqual(c.end_date, timezone.localdate() + timedelta(days=7))

    def test_reject_refunds_creator_via_cancel_path(self):
        res = self.create(fee=500)
        c = Challenge.objects.get(pk=res.json()["id"])
        self.user.refresh_from_db()
        self.assertEqual(self.user.locked_balance, Decimal("500.00"))
        self.client.force_authenticate(self.admin)
        res = self.client.post(f"/api/admin/challenges/{c.id}/reject_challenge/", {"reason": "Duplicate"}, format="json")
        self.assertEqual(res.status_code, 200, res.content)
        c.refresh_from_db()
        self.user.refresh_from_db()
        self.assertEqual(c.status, "cancelled")
        self.assertEqual(self.user.wallet_balance, Decimal("50000.00"))
        self.assertEqual(self.user.locked_balance, Decimal("0.00"))
        self.assertTrue(WalletTransaction.objects.filter(user=self.user, type="refund", amount=Decimal("500.00")).exists())
        # A second reject does nothing (no double refund).
        self.assertEqual(self.client.post(f"/api/admin/challenges/{c.id}/reject_challenge/").status_code, 400)
        self.assertEqual(WalletTransaction.objects.filter(user=self.user, type="refund").count(), 1)

    def test_unapproved_past_end_date_is_refunded(self):
        from apps.challenges.services import finalize_expired_challenges

        c = Challenge.objects.get(pk=self.create(fee=300).json()["id"])
        finalize_expired_challenges(today=c.end_date + timedelta(days=1))
        c.refresh_from_db()
        self.user.refresh_from_db()
        self.assertEqual(c.status, "cancelled")
        self.assertEqual(self.user.wallet_balance, Decimal("50000.00"))

    def test_rematch_of_public_challenge_waits(self):
        set_settings(challenge_approval_required=False)
        c = Challenge.objects.get(pk=self.create().json()["id"])
        Challenge.objects.filter(pk=c.pk).update(status="completed")
        set_settings(challenge_approval_required=True)
        res = self.client.post(f"/api/challenges/{c.id}/rematch/")
        self.assertIn(res.status_code, (200, 201), res.content)
        self.assertEqual(Challenge.objects.exclude(pk=c.pk).get().status, "pending")


class StepXPTests(_Base):
    def xp(self):
        return UserXP.objects.get(user=self.user).total_xp

    def test_uses_settings_and_is_idempotent(self):
        set_settings(xp_per_step=Decimal("0.10"), daily_goal_bonus_xp=100)
        self.user.daily_goal = 8000
        self.user.save()
        day = timezone.localdate()
        base = UserXP.objects.get_or_create(user=self.user)[0].total_xp

        self.assertEqual(award_daily_step_xp(self.user, day, 5000), 500)
        self.assertEqual(award_daily_step_xp(self.user, day, 5000), 0)  # same re-sync
        self.assertEqual(award_daily_step_xp(self.user, day, 9000), 400 + 100)  # delta + goal bonus
        self.assertEqual(award_daily_step_xp(self.user, day, 9500), 50)  # bonus only once
        self.assertEqual(award_daily_step_xp(self.user, day, 7000), 0)  # never negative
        self.assertEqual(self.xp() - base, 1050)
        self.assertEqual(XPEvent.objects.filter(user=self.user, event_type="daily_goal").count(), 1)

    def test_rates_follow_admin(self):
        set_settings(xp_per_step=Decimal("0.50"), daily_goal_bonus_xp=0)
        self.user.daily_goal = 1000
        self.user.save()
        self.assertEqual(award_daily_step_xp(self.user, timezone.localdate(), 2001), 1000)
        self.assertFalse(XPEvent.objects.filter(user=self.user, event_type="daily_goal").exists())


class WithdrawalMessageTests(_Base):
    def test_message_uses_review_time(self):
        set_settings(withdrawal_processing_time=48, minimum_withdrawal_amount=Decimal("10.00"))
        with patch("apps.payments.intasend.format_phone", return_value=PHONE):
            res = self.client.post(
                "/api/payments/withdrawal/request/",
                {"method": "mpesa", "amount": "500.00", "phone_number": PHONE}, format="json",
            )
        self.assertEqual(res.status_code, 201, res.content)
        self.assertIn("within 2 days", res.json()["message"])
        set_settings(withdrawal_processing_time=6)
        self.assertEqual(self.client.get("/api/app/config/").json()["withdrawals"]["processing_hours"], 6)


class NotificationEmailTests(_Base):
    def test_funding_alert_email_respects_switch(self):
        from apps.users.tasks import _alert_new_non_topup_accounts

        now = timezone.now()
        with patch("apps.users.tasks.send_mail") as send:
            set_settings(email_notifications_enabled=False)
            _alert_new_non_topup_accounts([self.user], now, now)
            send.assert_not_called()
            set_settings(email_notifications_enabled=True)
            _alert_new_non_topup_accounts([self.user], now, now)
            send.assert_called_once()


class ReferralHiddenTests(_Base):
    def test_referral_switch_is_not_exposed(self):
        cfg = self.client.get("/api/app/config/").json()
        self.assertNotIn("referrals", cfg["features"])
        self.assertNotIn("referral_program_enabled", ENFORCED_BY)
        self.client.force_authenticate(self.admin)
        self.assertNotIn("referral_program_enabled", self.client.get("/api/admin/settings/").json())

    def test_enforced_by_covers_every_editable_setting(self):
        from apps.admin_api.serializers import SystemSettingsSerializer

        editable = set(SystemSettingsSerializer().fields) - {"updated_at", "updated_by"}
        self.assertEqual(editable - set(ENFORCED_BY), set())
