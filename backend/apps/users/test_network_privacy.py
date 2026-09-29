"""Login IP minimisation: keyed network hash, full IP only while the session is
active, 90-day retention, masked display, data migration."""

from datetime import timedelta
from importlib import import_module

from django.apps import apps as django_apps
from django.contrib.auth import get_user_model
from django.test import TestCase, override_settings
from django.utils import timezone
from rest_framework.test import APITestCase

from apps.users.models import DeviceSession
from apps.users.network_privacy import masked_ip, network_hash, network_prefix, purge_ip_data

User = get_user_model()


def mk(name, **extra):
    n = abs(hash(name)) % 10**8
    return User.objects.create_user(username=name, email=f"{name}@ex.com", password="Pass-123-xyz!",
                                    phone_number=f"2547{n:08d}", **extra)


class HashTests(TestCase):
    def test_same_network_same_hash_private_none(self):
        self.assertEqual(network_hash("41.90.64.10"), network_hash("41.90.64.250"))
        self.assertNotEqual(network_hash("41.90.64.10"), network_hash("41.90.65.10"))
        self.assertEqual(len(network_hash("41.90.64.10")), 32)
        self.assertNotIn("41.90", network_hash("41.90.64.10"))
        self.assertEqual(network_hash("2c0f:fe38:2001:1::5"), network_hash("2c0f:fe38:2001:ffff::9"))
        for private in ("10.0.0.5", "192.168.1.2", "127.0.0.1", "", None, "garbage"):
            self.assertEqual(network_hash(private), "")
        self.assertIsNone(network_prefix("172.16.0.1"))

    def test_key_changes_hash(self):
        a = network_hash("41.90.64.10")
        with override_settings(NETWORK_HASH_SECRET="another-secret"):
            self.assertNotEqual(network_hash("41.90.64.10"), a)

    def test_masked(self):
        self.assertEqual(masked_ip("41.90.64.10"), "41.90.x.x")
        self.assertEqual(masked_ip("2c0f:fe38:2001:1::5"), "2c0f:fe38:…")
        self.assertIsNone(masked_ip(None))


class SessionLifecycleTests(APITestCase):
    def setUp(self):
        self.user = mk("ipuser")

    def login(self, ip="41.90.64.10"):
        r = self.client.post("/api/auth/login/", {"username": "ipuser", "password": "Pass-123-xyz!"},
                             format="json", REMOTE_ADDR=ip)
        self.assertEqual(r.status_code, 200)
        return r.data

    def test_login_stores_hash_and_logout_clears_ip(self):
        data = self.login()
        s = DeviceSession.objects.get(user=self.user)
        self.assertEqual(s.ip_address, "41.90.64.10")  # kept while active
        self.assertEqual(s.network_hash, network_hash("41.90.64.10"))
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {data['access']}")
        r = self.client.get("/api/auth/sessions/")
        self.assertEqual(r.status_code, 200)
        self.assertNotIn("41.90.64.10", str(r.data))
        self.assertIn("41.90.x.x", str(r.data))
        self.client.post("/api/auth/logout/", {"refresh": data["refresh"]}, format="json")
        s.refresh_from_db()
        self.assertFalse(s.is_active)
        self.assertIsNone(s.ip_address)
        self.assertEqual(s.network_hash, network_hash("41.90.64.10"))

    def test_revoke_clears_ip(self):
        self.login()
        data = self.login(ip="41.90.70.1")
        other = DeviceSession.objects.filter(user=self.user).order_by("created_at").first()
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {data['access']}")
        r = self.client.post(f"/api/auth/sessions/{other.id}/revoke/", {}, format="json")
        self.assertEqual(r.status_code, 200)
        if r.status_code == 200:
            other.refresh_from_db()
            self.assertFalse(other.is_active)
            self.assertIsNone(other.ip_address)
            self.assertTrue(other.network_hash)

    def test_save_with_update_fields_clears_ip(self):
        s = DeviceSession.objects.create(user=self.user, refresh_jti="j-1", ip_address="41.90.64.10")
        s.is_active = False
        s.save(update_fields=["is_active"])
        s.refresh_from_db()
        self.assertIsNone(s.ip_address)
        self.assertTrue(s.network_hash)

    def test_admin_console_shows_masked_ip(self):
        staff = mk("staffer", is_staff=True)
        DeviceSession.objects.create(user=self.user, refresh_jti="j-2", ip_address="41.90.64.10")
        self.client.force_authenticate(staff)
        r = self.client.get(f"/api/admin/users/{self.user.pk}/overview/")
        self.assertEqual(r.status_code, 200)
        self.assertNotIn("41.90.64.10", str(r.data))
        self.assertIn("41.90.x.x", str(r.data))


class RetentionTests(TestCase):
    def setUp(self):
        self.user = mk("retain")

    def make(self, jti, ip, *, active=True, days_ago=0, hashed=True):
        s = DeviceSession.objects.create(user=self.user, refresh_jti=jti, ip_address=ip)
        DeviceSession.objects.filter(pk=s.pk).update(
            is_active=active, ip_address=ip, network_hash=network_hash(ip) if hashed else "",
            last_active_at=timezone.now() - timedelta(days=days_ago))
        return s

    def test_purge(self):
        live = self.make("a", "41.90.64.10")
        ended = self.make("b", "41.90.64.11", active=False, hashed=False)  # e.g. bulk update path
        expired = self.make("c", "41.90.64.12", days_ago=10)              # refresh lifetime is 7 days
        old = self.make("d", "41.90.64.13", active=False, days_ago=95)
        result = purge_ip_data()
        for s in (live, ended, expired, old):
            s.refresh_from_db()
        self.assertEqual(live.ip_address, "41.90.64.10")
        self.assertIsNone(ended.ip_address)
        self.assertEqual(ended.network_hash, network_hash("41.90.64.11"))
        self.assertIsNone(expired.ip_address)
        self.assertTrue(expired.network_hash)
        self.assertIsNone(old.ip_address)
        self.assertEqual(old.network_hash, "")
        self.assertEqual(purge_ip_data()["ips_cleared"], 0)  # idempotent
        self.assertGreaterEqual(result["ips_cleared"], 2)

    def test_data_migration_hashes_then_clears(self):
        live = self.make("a", "41.90.64.10", hashed=False)
        ended = self.make("b", "41.90.64.11", active=False, hashed=False)
        old = self.make("c", "41.90.64.12", days_ago=120, hashed=False)
        import_module("apps.users.migrations.0015_minimise_session_ips").forwards(django_apps, None)
        for s in (live, ended, old):
            s.refresh_from_db()
        self.assertEqual((live.ip_address, live.network_hash), ("41.90.64.10", network_hash("41.90.64.10")))
        self.assertEqual((ended.ip_address, ended.network_hash), (None, network_hash("41.90.64.11")))
        self.assertEqual((old.ip_address, old.network_hash), (None, ""))

    def test_job_registered(self):
        from apps.admin_api import scheduler

        job = scheduler.get_job("privacy-ip-retention")
        self.assertEqual((job.task, job.priority), ("apps.users.tasks.purge_login_ip_data", 125))
