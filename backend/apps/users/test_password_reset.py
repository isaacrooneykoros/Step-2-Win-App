"""Forgot password with a 6-digit email code: request / verify / confirm."""

import re
from datetime import timedelta
from unittest import mock

from django.contrib.auth import get_user_model
from django.core import mail
from django.core.cache import cache
from django.test import override_settings
from django.utils import timezone
from rest_framework.test import APITestCase

from apps.admin_api.models import AuditLog
from apps.users import password_reset as svc
from apps.users.account_deletion import delete_account
from apps.users.models import DeviceSession, PasswordResetCode, SocialAccount

User = get_user_model()
PASSWORD = "Walk-More-2026!"
NEW_PASSWORD = "Brand-New-Stride-77"
REQUEST = "/api/auth/password-reset/request/"
VERIFY = "/api/auth/password-reset/verify/"
CONFIRM = "/api/auth/password-reset/confirm/"


def make_user(username="wanjiru", phone="254711000001", **extra):
    return User.objects.create_user(
        username=username,
        email=f"{username}@example.com",
        phone_number=phone,
        password=PASSWORD,
        **extra,
    )


@override_settings(
    EMAIL_BACKEND="django.core.mail.backends.locmem.EmailBackend",
    EMAIL_SEND_ASYNC=False,
    PASSWORD_HASHERS=["django.contrib.auth.hashers.MD5PasswordHasher"],
)
class PasswordResetBase(APITestCase):
    def setUp(self):
        cache.clear()  # throttles + miss counters
        self.user = make_user()
        self._ip = 0

    def post(self, url, data, ip=None):
        self._ip += 1
        return self.client.post(
            url, data, format="json", REMOTE_ADDR=ip or f"10.0.{self._ip // 250}.{self._ip % 250 + 1}"
        )

    def request_code(self, identifier="wanjiru@example.com"):
        mail.outbox.clear()
        res = self.post(REQUEST, {"identifier": identifier})
        self.assertEqual(res.status_code, 200, res.content)
        return res

    def code_from_mail(self):
        self.assertEqual(len(mail.outbox), 1)
        match = re.search(r"\b(\d{6})\b", mail.outbox[-1].subject)
        self.assertIsNotNone(match)
        return match.group(1)

    def verify(self, code, identifier="wanjiru@example.com"):
        return self.post(VERIFY, {"identifier": identifier, "code": code})

    def full_token(self, identifier="wanjiru@example.com"):
        self.request_code(identifier)
        res = self.verify(self.code_from_mail(), identifier)
        self.assertEqual(res.status_code, 200, res.content)
        return res.json()["reset_token"]

    def login(self, password, username="wanjiru"):
        return self.post("/api/auth/login/", {"username": username, "password": password})


class RequestTests(PasswordResetBase):
    def test_identical_response_for_every_kind_of_account(self):
        google = User.objects.create_user(
            username="gina", email="gina@example.com", phone_number="254711000002"
        )
        google.set_unusable_password()
        google.save()
        SocialAccount.objects.create(user=google, provider="google", subject="g-123")
        deleted = make_user("gone", "254711000003")
        delete_account(deleted)
        inactive = make_user("banned", "254711000004", is_active=False)
        staff = make_user("ops", "254711000005", is_staff=True)

        bodies = {}
        for label, identifier in {
            "existing": "wanjiru@example.com",
            "unknown": "nobody@example.com",
            "deleted": "deleted_%d" % deleted.pk,
            "google": "gina@example.com",
            "inactive": inactive.email,
            "staff": staff.email,
        }.items():
            res = self.post(REQUEST, {"identifier": identifier})
            self.assertEqual(res.status_code, 200, label)
            bodies[label] = res.json()
        self.assertEqual(len({str(sorted(b.items())) for b in bodies.values()}), 1, bodies)

        # Mail only to the real password account (code) and the Google account (hint).
        recipients = sorted(m.to[0] for m in mail.outbox)
        self.assertEqual(recipients, ["gina@example.com", "wanjiru@example.com"])
        google_mail = next(m for m in mail.outbox if m.to == ["gina@example.com"])
        self.assertIn("Continue with Google", google_mail.body)
        self.assertIsNone(re.search(r"\b\d{6}\b", google_mail.body))
        self.assertEqual(PasswordResetCode.objects.count(), 1)
        self.assertFalse(PasswordResetCode.objects.filter(user=google).exists())

    def test_username_and_phone_identifiers_work(self):
        self.request_code("wanjiru")
        self.assertEqual(len(mail.outbox), 1)
        PasswordResetCode.objects.all().delete()
        self.request_code("0711000001")  # local format of 254711000001
        self.assertEqual(len(mail.outbox), 1)

    def test_code_is_hashed_and_email_is_branded(self):
        self.request_code()
        code = self.code_from_mail()
        row = PasswordResetCode.objects.get(user=self.user)
        self.assertNotIn(code, row.code_hash)
        self.assertNotEqual(row.code_hash, code)
        self.assertTrue(row.expires_at > timezone.now() + timedelta(minutes=14))
        msg = mail.outbox[0]
        self.assertIn(code, msg.body)
        html = msg.alternatives[0][0]
        self.assertIn("#14855D", html)
        self.assertIn(code, html)

    def test_new_request_invalidates_previous_code(self):
        self.request_code()
        first = self.code_from_mail()
        PasswordResetCode.objects.update(created_at=timezone.now() - timedelta(minutes=2))
        self.request_code()
        second = self.code_from_mail()
        self.assertEqual(PasswordResetCode.objects.filter(used_at__isnull=True).count(), 1)
        if first != second:
            self.assertEqual(self.verify(first).status_code, 400)
        self.assertEqual(self.verify(second).status_code, 200)

    def test_quick_resend_keeps_the_existing_code(self):
        self.request_code()
        code = self.code_from_mail()
        self.request_code()
        self.assertEqual(len(mail.outbox), 0)
        self.assertEqual(self.verify(code).status_code, 200)

    def test_missing_identifier_is_400(self):
        self.assertEqual(self.post(REQUEST, {}).status_code, 400)

    @override_settings(EMAIL_BACKEND="django.core.mail.backends.dummy.EmailBackend")
    def test_unconfigured_email_does_not_crash(self):
        with self.assertLogs("apps.core.emails", level="ERROR") as logs:
            res = self.post(REQUEST, {"identifier": "wanjiru@example.com"})
        self.assertEqual(res.status_code, 200)
        self.assertIn("not configured", logs.output[0])
        self.assertNotIn("wanjiru", " ".join(logs.output))

    def test_smtp_failure_is_logged_without_address(self):
        with mock.patch("apps.core.emails.send_mail", side_effect=OSError("boom")):
            with self.assertLogs("apps.core.emails", level="ERROR") as logs:
                res = self.post(REQUEST, {"identifier": "wanjiru@example.com"})
        self.assertEqual(res.status_code, 200)
        self.assertNotIn("example.com", " ".join(logs.output))

    def test_rate_limit_per_identifier(self):
        for i in range(5):
            self.assertEqual(self.post(REQUEST, {"identifier": "Someone@Example.com"}).status_code, 200)
        self.assertEqual(self.post(REQUEST, {"identifier": "someone@example.com"}).status_code, 429)

    def test_rate_limit_per_ip(self):
        for i in range(20):
            res = self.post(REQUEST, {"identifier": f"user{i}@example.com"}, ip="10.9.9.9")
            self.assertEqual(res.status_code, 200)
        res = self.post(REQUEST, {"identifier": "another@example.com"}, ip="10.9.9.9")
        self.assertEqual(res.status_code, 429)


class VerifyTests(PasswordResetBase):
    def test_wrong_code_counts_attempts_and_locks_at_five(self):
        self.request_code()
        code = self.code_from_mail()
        wrong = "000000" if code != "000000" else "111111"
        for left in (4, 3, 2, 1):
            res = self.verify(wrong)
            self.assertEqual(res.status_code, 400)
            self.assertEqual(res.json()["code"], "invalid_code")
            self.assertEqual(res.json()["attempts_left"], left)
        res = self.verify(wrong)
        self.assertEqual(res.json()["code"], "too_many_attempts")
        self.assertEqual(PasswordResetCode.objects.get().attempts, 5)
        # Even the right code is refused now.
        self.assertEqual(self.verify(code).status_code, 400)

    def test_unknown_identifier_fails_the_same_way(self):
        self.request_code("nobody@example.com")
        res = self.verify("123456", "nobody@example.com")
        self.assertEqual(res.status_code, 400)
        self.assertEqual(res.json(), {
            "error": "That code is incorrect or has expired.", "code": "invalid_code", "attempts_left": 4,
        })
        for _ in range(4):
            res = self.verify("123456", "nobody@example.com")
        self.assertEqual(res.json()["code"], "too_many_attempts")

    def test_expired_code_rejected(self):
        self.request_code()
        code = self.code_from_mail()
        PasswordResetCode.objects.update(expires_at=timezone.now() - timedelta(seconds=1))
        res = self.verify(code)
        self.assertEqual(res.status_code, 400)
        self.assertEqual(res.json()["code"], "invalid_code")

    def test_code_is_single_use(self):
        self.request_code()
        code = self.code_from_mail()
        self.assertEqual(self.verify(code).status_code, 200)
        self.assertEqual(self.verify(code).status_code, 400)
        row = PasswordResetCode.objects.get()
        self.assertTrue(row.reset_token_hash)
        self.assertEqual(len(row.reset_token_hash), 64)


class ConfirmTests(PasswordResetBase):
    def test_confirm_sets_password_and_revokes_sessions(self):
        login = self.login(PASSWORD)
        self.assertEqual(login.status_code, 200, login.content)
        old_refresh = login.json()["refresh"]
        self.assertTrue(DeviceSession.objects.filter(user=self.user, is_active=True).exists())

        token = self.full_token()
        mail.outbox.clear()
        res = self.post(CONFIRM, {
            "reset_token": token, "new_password": NEW_PASSWORD, "confirm_password": NEW_PASSWORD,
        })
        self.assertEqual(res.status_code, 200, res.content)

        self.user.refresh_from_db()
        self.assertTrue(self.user.check_password(NEW_PASSWORD))
        self.assertEqual(self.post("/api/auth/refresh/", {"refresh": old_refresh}).status_code, 401)
        self.assertFalse(DeviceSession.objects.filter(user=self.user, is_active=True).exists())
        self.assertFalse(PasswordResetCode.objects.filter(used_at__isnull=True).exists())
        self.assertEqual(self.login(PASSWORD).status_code, 401)
        self.assertEqual(self.login(NEW_PASSWORD).status_code, 200)

        # Notice email, audit entry without PII.
        self.assertEqual(len(mail.outbox), 1)
        self.assertIn("password was changed", mail.outbox[0].subject)
        entry = AuditLog.objects.get(action="reset_password", resource_id=self.user.pk)
        self.assertNotIn("wanjiru", f"{entry.resource_name} {entry.description} {entry.changes}")

        # Single-use token.
        again = self.post(CONFIRM, {
            "reset_token": token, "new_password": "Another-Pass-2027", "confirm_password": "Another-Pass-2027",
        })
        self.assertEqual(again.status_code, 400)
        self.assertEqual(again.json()["code"], "invalid_token")

    def test_weak_password_rejected_and_token_kept(self):
        token = self.full_token()
        res = self.post(CONFIRM, {"reset_token": token, "new_password": "123", "confirm_password": "123"})
        self.assertEqual(res.status_code, 400)
        self.assertEqual(res.json()["code"], "invalid_password")
        self.assertIn("new_password", res.json()["errors"])
        mismatch = self.post(CONFIRM, {
            "reset_token": token, "new_password": NEW_PASSWORD, "confirm_password": NEW_PASSWORD + "x",
        })
        self.assertEqual(mismatch.json()["code"], "password_mismatch")
        self.user.refresh_from_db()
        self.assertTrue(self.user.check_password(PASSWORD))
        ok = self.post(CONFIRM, {
            "reset_token": token, "new_password": NEW_PASSWORD, "confirm_password": NEW_PASSWORD,
        })
        self.assertEqual(ok.status_code, 200)

    def test_expired_or_bogus_token_rejected(self):
        token = self.full_token()
        PasswordResetCode.objects.update(token_expires_at=timezone.now() - timedelta(seconds=1))
        for t in (token, "not-a-token", ""):
            res = self.post(CONFIRM, {
                "reset_token": t, "new_password": NEW_PASSWORD, "confirm_password": NEW_PASSWORD,
            })
            self.assertEqual(res.status_code, 400)
            self.assertEqual(res.json()["code"], "invalid_token")

    def test_reset_lifts_login_lockout(self):
        cache.set("login_attempts:wanjiru", 99, 900)
        token = self.full_token()
        self.post(CONFIRM, {"reset_token": token, "new_password": NEW_PASSWORD, "confirm_password": NEW_PASSWORD})
        self.assertIsNone(cache.get("login_attempts:wanjiru"))
        self.assertEqual(self.login(NEW_PASSWORD).status_code, 200)

    def test_generated_codes_are_six_digits(self):
        codes = {svc._generate_code() for _ in range(200)}
        self.assertTrue(all(len(c) == 6 and c.isdigit() for c in codes))
        self.assertGreater(len(codes), 150)


@override_settings(PASSWORD_HASHERS=["django.contrib.auth.hashers.MD5PasswordHasher"])
class ChangePasswordRevokesAllTests(APITestCase):
    def test_change_password_blacklists_all_refresh_tokens(self):
        cache.clear()
        user = make_user()
        a = self.client.post("/api/auth/login/", {"username": "wanjiru", "password": PASSWORD}, format="json").json()
        b = self.client.post("/api/auth/login/", {"username": "wanjiru", "password": PASSWORD}, format="json").json()
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {a['access']}")
        weak = self.client.post("/api/auth/change-password/", {"old_password": PASSWORD, "new_password": "password"}, format="json")
        self.assertEqual(weak.status_code, 400)
        res = self.client.post("/api/auth/change-password/", {"old_password": PASSWORD, "new_password": NEW_PASSWORD}, format="json")
        self.assertEqual(res.status_code, 200)
        self.client.credentials()
        for tok in (a["refresh"], b["refresh"]):
            self.assertEqual(self.client.post("/api/auth/refresh/", {"refresh": tok}, format="json").status_code, 401)
        user.refresh_from_db()
        self.assertTrue(user.check_password(NEW_PASSWORD))
