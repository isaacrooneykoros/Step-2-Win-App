"""
Converted from backend/test_anticheat.py.
Anti-cheat engine unit tests using Django TestCase.
Previously required a running database to invoke as a script; now runs via
``python manage.py test apps.steps.tests_anticheat``.
"""
from django.test import TestCase
from django.utils import timezone
from unittest.mock import MagicMock


class AntiCheatTest(TestCase):
    """Unit tests for the anti-cheat engine (no database access required)."""

    def _make_user(self, id=1):
        from apps.steps.models import TrustScore
        user = MagicMock()
        user.id = id
        user.pk = id
        user.is_active = True
        user.username = f'testuser{id}'
        # Stub the TrustScore relationship
        trust = MagicMock()
        trust.score = 100
        trust.status = 'good'
        user.trust_score = trust
        return user

    def test_impossible_rate_flag_raised(self):
        """Steps / active_minutes > 1000 → impossible_rate flag."""
        from apps.steps.anti_cheat import run_anti_cheat
        user  = self._make_user()
        today = timezone.now().date()

        result = run_anti_cheat(user, steps=10_000, date=today, active_minutes=1)
        flag_types = [f['flag_type'] for f in result.flags]
        self.assertIn('impossible_rate', flag_types)

    def test_daily_cap_enforced(self):
        """Steps > DAILY_STEP_CAP → daily_cap flag and approved_steps capped."""
        from apps.steps.anti_cheat import run_anti_cheat, DAILY_STEP_CAP
        user  = self._make_user()
        today = timezone.now().date()

        result = run_anti_cheat(user, steps=90_000, date=today)
        flag_types = [f['flag_type'] for f in result.flags]
        self.assertIn('daily_cap', flag_types)
        self.assertEqual(result.approved_steps, DAILY_STEP_CAP)

    def test_distance_too_low_flag(self):
        """50k steps with only 50 m distance → distance_too_low flag."""
        from apps.steps.anti_cheat import run_anti_cheat
        user  = self._make_user()
        today = timezone.now().date()

        result = run_anti_cheat(user, steps=50_000, date=today, distance_km=0.05)
        flag_types = [f['flag_type'] for f in result.flags]
        self.assertIn('distance_too_low', flag_types)

    def test_normal_steps_no_flags(self):
        """Realistic step data should not trigger any flags."""
        from apps.steps.anti_cheat import run_anti_cheat
        user  = self._make_user()
        today = timezone.now().date()

        result = run_anti_cheat(user, steps=8_500, date=today, distance_km=5.2, active_minutes=45)
        self.assertEqual(result.flags, [])
        self.assertEqual(result.approved_steps, 8_500)
