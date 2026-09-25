"""Device binding without a shared client secret (JWT + server-side rules)."""

from decimal import Decimal

from django.contrib.auth import get_user_model
from django.core.cache import cache
from rest_framework.test import APITestCase

from apps.steps.models import DeviceRegistration, TrustScore

User = get_user_model()

DEV_A = "a" * 40
DEV_B = "b" * 40
DEV_C = "c" * 40


class DeviceBindingTests(APITestCase):
    def setUp(self):
        cache.clear()
        self.user = User.objects.create_user(
            username="binder", email="binder@example.com", password="x-Pass-123!"
        )
        self.client.force_authenticate(self.user)

    def _bind(self, device_id, platform="android", **extra):
        return self.client.post(
            "/api/auth/bind-device/", {"device_id": device_id, "platform": platform, **extra}, format="json"
        )

    def test_binds_with_jwt_only_no_signature(self):
        r = self._bind(DEV_A)
        self.assertEqual(r.status_code, 200, r.content)
        self.user.refresh_from_db()
        self.assertEqual(self.user.device_id, DEV_A)
        self.assertTrue(DeviceRegistration.objects.get(user=self.user, device_id=DEV_A).is_active)

    def test_legacy_signature_field_is_ignored(self):
        r = self._bind(DEV_A, device_signature="anything")
        self.assertEqual(r.status_code, 200, r.content)

    def test_requires_authentication(self):
        self.client.force_authenticate(None)
        self.assertEqual(self._bind(DEV_A).status_code, 401)

    def test_short_device_id_rejected(self):
        self.assertEqual(self._bind("short").status_code, 400)

    def test_device_bound_to_another_account_rejected(self):
        other = User.objects.create_user(username="other", email="o@example.com", password="x-Pass-123!")
        other.device_id = DEV_A
        other.save()
        self.assertEqual(self._bind(DEV_A).status_code, 400)

    def test_one_active_device_and_rebind_cooldown(self):
        self.assertEqual(self._bind(DEV_A).status_code, 200)
        self.assertEqual(self._bind(DEV_A).status_code, 200)  # same device again: fine
        self.assertEqual(self._bind(DEV_B).status_code, 200)  # first switch allowed
        active = list(DeviceRegistration.objects.filter(user=self.user, is_active=True).values_list("device_id", flat=True))
        self.assertEqual(active, [DEV_B])
        r = self._bind(DEV_C)  # second switch within the cooldown
        self.assertEqual(r.status_code, 429)
        self.user.refresh_from_db()
        self.assertEqual(self.user.device_id, DEV_B)

    def test_suspended_account_cannot_switch_device(self):
        self._bind(DEV_A)
        TrustScore.objects.create(user=self.user, score=10)
        self.assertEqual(self._bind(DEV_B).status_code, 403)

    def test_no_switch_while_payout_under_review(self):
        from datetime import date

        from apps.challenges.models import Challenge, HeldPayout, Participant

        self._bind(DEV_A)
        c = Challenge.objects.create(
            creator=self.user, name="C", entry_fee=Decimal("100"), milestone=10000,
            start_date=date(2026, 9, 1), end_date=date(2026, 9, 7), status="completed",
        )
        p = Participant.objects.create(challenge=c, user=self.user, steps=20000)
        HeldPayout.objects.create(challenge=c, participant=p, user=self.user, amount=Decimal("190"))
        self.assertEqual(self._bind(DEV_B).status_code, 403)
