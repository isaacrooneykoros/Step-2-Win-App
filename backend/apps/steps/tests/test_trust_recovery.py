"""TrustScore semantics: slow time-based recovery and admin locks.

- automatic recovery (a clean sync) adds at most +1 per calendar day, however
  many clean syncs arrive;
- an admin restrict / suspend / ban is locked: neither automatic recovery nor a
  dismissed flag can lift the score out of that status; only an admin lift
  (unrestrict / unsuspend / unban) or the lock's expiry ends it;
- deduct() keeps its API (Phase 0 calls it with capped amounts).
"""

from datetime import date, timedelta

from django.contrib.auth import get_user_model
from django.test import TestCase
from django.utils import timezone
from rest_framework.test import APITestCase

from apps.steps.models import FraudFlag, TrustScore

User = get_user_model()


class TrustRecoveryTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            username="recovery_user", email="recovery@example.com", password="x-Pass-123!"
        )
        self.trust = TrustScore.objects.create(user=self.user, score=50)

    def test_many_clean_syncs_same_day_recover_one_point(self):
        today = date(2026, 9, 1)
        for _ in range(30):
            self.trust.recover(1, today=today)
        self.trust.refresh_from_db()
        self.assertEqual(self.trust.score, 51)
        self.assertEqual(self.trust.last_recovered_on, today)

    def test_one_point_per_calendar_day(self):
        start = date(2026, 9, 1)
        for i in range(10):
            for _ in range(5):
                self.trust.recover(1, today=start + timedelta(days=i))
        self.trust.refresh_from_db()
        self.assertEqual(self.trust.score, 60)

    def test_large_automatic_request_is_capped(self):
        added = self.trust.recover(10, today=date(2026, 9, 1))
        self.assertEqual(added, 1)
        self.assertEqual(self.trust.score, 51)

    def test_recovery_never_exceeds_100(self):
        self.trust.score = 100
        self.trust.save()
        self.assertEqual(self.trust.recover(1, today=date(2026, 9, 1)), 0)
        self.assertEqual(self.trust.score, 100)

    def test_deduct_api_unchanged(self):
        self.trust.deduct(8)
        self.trust.refresh_from_db()
        self.assertEqual(self.trust.score, 42)
        self.assertEqual(self.trust.flags_total, 1)
        self.trust.deduct(500)
        self.assertEqual(self.trust.score, 0)


class AdminLockTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            username="locked_user", email="locked@example.com", password="x-Pass-123!"
        )
        self.trust = TrustScore.objects.create(user=self.user, score=90)

    def _recover_days(self, n):
        start = date(2026, 1, 1)
        for i in range(n):
            self.trust.recover(1, today=start + timedelta(days=i))

    def test_restrict_is_not_undone_by_recovery(self):
        self.trust.apply_admin_action("restrict")
        self.assertEqual(self.trust.status, "RESTRICT")
        self._recover_days(200)
        self.trust.refresh_from_db()
        self.assertLessEqual(self.trust.score, 40)
        self.assertEqual(self.trust.status, "RESTRICT")

    def test_suspend_and_ban_hold(self):
        self.trust.apply_admin_action("suspend")
        self._recover_days(100)
        self.assertEqual(self.trust.status, "SUSPEND")
        self.trust.apply_admin_action("ban")
        self._recover_days(100)
        self.trust.recover(10, by_admin=True)  # a dismissed flag
        self.assertEqual(self.trust.score, 0)
        self.assertEqual(self.trust.status, "BAN")

    def test_dismissed_flag_cannot_lift_a_restriction(self):
        self.trust.apply_admin_action("restrict")
        for _ in range(5):
            self.trust.apply_admin_action("dismiss")
        self.assertEqual(self.trust.status, "RESTRICT")

    def test_admin_lift_ends_the_lock(self):
        self.trust.apply_admin_action("suspend")
        self.trust.apply_admin_action("unsuspend")
        self.assertEqual(self.trust.score, 45)
        self.assertIsNone(self.trust.admin_ceiling)
        self._recover_days(20)
        self.assertEqual(self.trust.score, 65)

    def test_lock_expiry_lets_slow_recovery_resume(self):
        self.trust.apply_admin_action("restrict", until=timezone.now() - timedelta(minutes=1))
        self.assertFalse(self.trust.admin_lock_active())
        self._recover_days(10)
        self.trust.refresh_from_db()
        self.assertEqual(self.trust.score, 45)
        self.assertIsNone(self.trust.admin_ceiling)
        self.assertEqual(self.trust.admin_status, "")

    def test_future_expiry_still_holds(self):
        self.trust.apply_admin_action("restrict", until=timezone.now() + timedelta(days=7))
        self._recover_days(30)
        self.assertEqual(self.trust.status, "RESTRICT")

    def test_unknown_action_raises(self):
        with self.assertRaises(ValueError):
            self.trust.apply_admin_action("promote")


class AdminEndpointsUseTheLockTests(APITestCase):
    """Both admin trust endpoints (console moderation and legacy flag action) lock."""

    def setUp(self):
        self.admin = User.objects.create_user(
            username="lock_admin", email="lock_admin@example.com", password="x-Pass-123!",
            is_staff=True, is_superuser=True,
        )
        self.user = User.objects.create_user(
            username="lock_target", email="lock_target@example.com", password="x-Pass-123!"
        )
        self.client.force_authenticate(self.admin)

    def test_console_moderation_restrict_is_locked(self):
        r = self.client.post(
            f"/api/admin/trust/users/{self.user.id}/moderate/",
            {"action": "restrict", "reason": "Repeated shaking pattern on several days", "lock_days": 14},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        trust = TrustScore.objects.get(user=self.user)
        self.assertEqual(trust.admin_status, "restrict")
        self.assertEqual(trust.admin_ceiling, 40)
        self.assertIsNotNone(trust.admin_locked_until)
        for i in range(60):
            trust.recover(1, today=date(2026, 1, 1) + timedelta(days=i))
        self.assertEqual(trust.status, "RESTRICT")

    def test_legacy_flag_action_suspend_is_locked(self):
        flag = FraudFlag.objects.create(
            user=self.user, flag_type="step_velocity_spike", severity="high", date=date(2026, 9, 1)
        )
        r = self.client.post(f"/api/admin/fraud/{flag.id}/action/", {"action": "suspend"}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        trust = TrustScore.objects.get(user=self.user)
        self.assertEqual(trust.admin_status, "suspend")
        trust.recover(10, by_admin=True)
        self.assertEqual(trust.status, "SUSPEND")
