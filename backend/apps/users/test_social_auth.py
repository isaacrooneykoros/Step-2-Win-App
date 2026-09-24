"""
Sign in with Google / Apple: real RS256 tokens signed by a throwaway test key,
served through a mocked JWKS endpoint (no network).
"""

import base64
import hashlib
import time
from unittest.mock import patch

import jwt
from cryptography.hazmat.primitives.asymmetric import rsa
from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.test import override_settings
from rest_framework.test import APITestCase

from apps.admin_api.models import SystemSettings
from apps.users import social_auth
from apps.users.models import DeviceSession, SocialAccount

User = get_user_model()

GOOGLE_WEB = "123-web.apps.googleusercontent.com"
GOOGLE_IOS = "123-ios.apps.googleusercontent.com"
APPLE_BUNDLE = "com.step2win.app"
APPLE_SERVICES = "com.step2win.web"

_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
_OTHER_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
_KID = "test-kid-1"


def _b64(n: int) -> str:
    raw = n.to_bytes((n.bit_length() + 7) // 8, "big")
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def _jwks(key=_KEY, kid=_KID):
    pub = key.public_key().public_numbers()
    return {"keys": [{"kty": "RSA", "kid": kid, "use": "sig", "alg": "RS256", "n": _b64(pub.n), "e": _b64(pub.e)}]}


def _token(claims: dict, key=_KEY, kid=_KID) -> str:
    return jwt.encode(claims, key, algorithm="RS256", headers={"kid": kid})


def _sha(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


def google_claims(**over):
    now = int(time.time())
    c = {
        "iss": "https://accounts.google.com",
        "aud": GOOGLE_WEB,
        "sub": "google-sub-1",
        "email": "walker@example.com",
        "email_verified": True,
        "name": "Wanjiru Walker",
        "given_name": "Wanjiru",
        "family_name": "Walker",
        "iat": now,
        "exp": now + 3600,
    }
    c.update(over)
    return c


def apple_claims(raw_nonce="raw-nonce-123", **over):
    now = int(time.time())
    c = {
        "iss": "https://appleid.apple.com",
        "aud": APPLE_BUNDLE,
        "sub": "001234.apple-sub.0001",
        "email": "abc123@privaterelay.appleid.com",
        "email_verified": "true",
        "is_private_email": "true",
        "nonce": _sha(raw_nonce),
        "nonce_supported": True,
        "iat": now,
        "exp": now + 600,
    }
    c.update(over)
    return c


@override_settings(
    GOOGLE_OAUTH_CLIENT_IDS=[GOOGLE_WEB, GOOGLE_IOS],
    APPLE_CLIENT_IDS=[APPLE_BUNDLE, APPLE_SERVICES],
)
class SocialAuthTests(APITestCase):
    def setUp(self):
        cache.clear()  # throttles + settings cache
        social_auth.reset_jwks_cache()
        self.jwks = _jwks()
        patcher = patch.object(jwt.PyJWKClient, "fetch_data", side_effect=lambda: self.jwks)
        self.fetch = patcher.start()
        self.addCleanup(patcher.stop)

    # helpers
    def google(self, claims=None, nonce=None, key=_KEY, **extra):
        body = {"id_token": _token(claims or google_claims(), key=key), "device_type": "android",
                "device_name": "Pixel 8", "app_version": "1.0.0", **extra}
        if nonce is not None:
            body["nonce"] = nonce
        return self.client.post("/api/auth/google/", body, format="json")

    def apple(self, claims=None, nonce="raw-nonce-123", **extra):
        body = {"id_token": _token(claims or apple_claims()), "nonce": nonce, "device_type": "ios", **extra}
        return self.client.post("/api/auth/apple/", body, format="json")

    # ── Google ───────────────────────────────────────────────────────────────
    def test_google_valid_token_creates_account_and_session(self):
        res = self.google()
        self.assertEqual(res.status_code, 201, res.content)
        body = res.json()
        self.assertTrue(body["created"])
        self.assertIn("access", body)
        self.assertIn("refresh", body)
        self.assertIn("session_id", body)
        user = User.objects.get(email="walker@example.com")
        self.assertFalse(user.has_usable_password())
        self.assertEqual(user.first_name, "Wanjiru")
        self.assertTrue(SocialAccount.objects.filter(user=user, provider="google", subject="google-sub-1").exists())
        session = DeviceSession.objects.get(id=body["session_id"])
        self.assertEqual((session.user_id, session.device_type), (user.id, "android"))

        # second sign-in: same user via subject, no duplicate
        res2 = self.google()
        self.assertEqual(res2.status_code, 200, res2.content)
        self.assertFalse(res2.json()["created"])
        self.assertEqual(User.objects.filter(email="walker@example.com").count(), 1)

    def test_google_ios_client_id_is_an_accepted_audience(self):
        res = self.google(google_claims(aud=GOOGLE_IOS))
        self.assertEqual(res.status_code, 201, res.content)

    def test_google_wrong_audience_rejected(self):
        res = self.google(google_claims(aud="someone-elses-app.apps.googleusercontent.com"))
        self.assertEqual(res.status_code, 400)
        self.assertEqual(res.json()["code"], "invalid_token")
        self.assertFalse(User.objects.filter(email="walker@example.com").exists())

    def test_google_wrong_issuer_rejected(self):
        res = self.google(google_claims(iss="https://evil.example.com"))
        self.assertEqual(res.json()["code"], "invalid_token")

    def test_google_expired_rejected(self):
        past = int(time.time()) - 7200
        res = self.google(google_claims(iat=past, exp=past + 3600))
        self.assertEqual(res.status_code, 400)
        self.assertEqual(res.json()["code"], "token_expired")

    def test_google_bad_signature_rejected(self):
        res = self.google(key=_OTHER_KEY)
        self.assertEqual(res.status_code, 400)
        self.assertEqual(res.json()["code"], "invalid_token")

    def test_google_access_token_style_garbage_rejected(self):
        res = self.client.post("/api/auth/google/", {"id_token": "ya29.not-a-jwt"}, format="json")
        self.assertEqual(res.status_code, 400)
        self.assertEqual(res.json()["code"], "invalid_token")

    def test_google_nonce_checked_when_sent(self):
        good = self.google(google_claims(nonce=_sha("n-1")), nonce="n-1")
        self.assertEqual(good.status_code, 201, good.content)
        bad = self.google(google_claims(nonce=_sha("n-1")), nonce="n-2")
        self.assertEqual(bad.json()["code"], "invalid_nonce")

    def test_google_unverified_email_rejected(self):
        res = self.google(google_claims(email_verified=False))
        self.assertEqual(res.status_code, 400)
        self.assertEqual(res.json()["code"], "email_not_verified")
        self.assertFalse(User.objects.filter(email="walker@example.com").exists())

    def test_unverified_email_never_links_existing_account(self):
        User.objects.create_user("victim", "walker@example.com", "Secret123!", phone_number="254700000101")
        res = self.google(google_claims(email_verified=False))
        self.assertEqual(res.json()["code"], "email_not_verified")
        self.assertFalse(SocialAccount.objects.exists())

    def test_google_links_existing_password_account_by_verified_email(self):
        existing = User.objects.create_user("wanjiru", "Walker@Example.com", "Secret123!", phone_number="254700000102")
        res = self.google()
        self.assertEqual(res.status_code, 200, res.content)
        self.assertFalse(res.json()["created"])
        self.assertEqual(res.json()["user"]["id"], existing.id)
        self.assertEqual(User.objects.filter(email__iexact="walker@example.com").count(), 1)
        link = SocialAccount.objects.get(provider="google")
        self.assertEqual(link.user_id, existing.id)
        existing.refresh_from_db()
        self.assertTrue(existing.check_password("Secret123!"))  # password still works

    def test_link_by_subject_survives_email_change(self):
        user = User.objects.create_user("linked", "old@example.com", "x", phone_number="254700000103")
        SocialAccount.objects.create(user=user, provider="google", subject="google-sub-1", email="old@example.com")
        res = self.google(google_claims(email="new@example.com"))
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(res.json()["user"]["id"], user.id)
        self.assertFalse(User.objects.filter(email="new@example.com").exists())

    def test_disabled_account_rejected(self):
        user = User.objects.create_user("gone", "walker@example.com", "x", phone_number="254700000104", is_active=False)
        res = self.google()
        self.assertEqual(res.status_code, 403)
        self.assertEqual(res.json()["code"], "account_disabled")
        self.assertFalse(DeviceSession.objects.filter(user=user).exists())

    def test_staff_accounts_cannot_use_social_sign_in(self):
        User.objects.create_user("ops", "walker@example.com", "x", phone_number="254700000105", is_staff=True)
        res = self.google()
        self.assertEqual(res.status_code, 403)
        self.assertEqual(res.json()["code"], "staff_account")
        self.assertFalse(SocialAccount.objects.exists())

    def test_jwks_unreachable_is_503(self):
        self.fetch.side_effect = jwt.PyJWKClientConnectionError("down")
        res = self.google()
        self.assertEqual(res.status_code, 503)
        self.assertEqual(res.json()["code"], "provider_unavailable")

    # ── sign-ups switch ──────────────────────────────────────────────────────
    def _pause_signups(self):
        s = SystemSettings.load()
        s.registrations_enabled = False
        s.save()

    def test_signups_paused_blocks_new_social_accounts_only(self):
        self._pause_signups()
        res = self.google()
        self.assertEqual(res.status_code, 403)
        self.assertEqual(res.json()["code"], "feature_disabled")
        self.assertEqual(res.json()["feature"], "registrations")
        self.assertFalse(User.objects.filter(email="walker@example.com").exists())

        res = self.apple()
        self.assertEqual(res.json()["code"], "feature_disabled")

        # existing users (by verified email, or already linked) still get in
        User.objects.create_user("wanjiru", "walker@example.com", "x", phone_number="254700000106")
        self.assertEqual(self.google().status_code, 200)
        apple_user = User.objects.create_user("appler", "a@example.com", "x", phone_number="254700000107")
        SocialAccount.objects.create(user=apple_user, provider="apple", subject="001234.apple-sub.0001")
        self.assertEqual(self.apple().status_code, 200)

    # ── not configured ───────────────────────────────────────────────────────
    @override_settings(GOOGLE_OAUTH_CLIENT_IDS=[])
    def test_google_not_configured(self):
        res = self.google()
        self.assertEqual(res.status_code, 503)
        self.assertEqual(res.json()["code"], "provider_not_configured")
        self.fetch.assert_not_called()

    @override_settings(APPLE_CLIENT_IDS=[])
    def test_apple_not_configured(self):
        res = self.apple()
        self.assertEqual(res.status_code, 503)
        self.assertEqual(res.json()["code"], "provider_not_configured")

    # ── Apple ────────────────────────────────────────────────────────────────
    def test_apple_valid_token_creates_account_with_first_time_name(self):
        res = self.apple(given_name="Amani", family_name="Otieno")
        self.assertEqual(res.status_code, 201, res.content)
        user = User.objects.get(email="abc123@privaterelay.appleid.com")
        self.assertEqual((user.first_name, user.last_name), ("Amani", "Otieno"))
        self.assertTrue(SocialAccount.objects.filter(user=user, provider="apple").exists())

    def test_apple_later_sign_in_without_email_matches_by_subject(self):
        self.assertEqual(self.apple().status_code, 201)
        claims = apple_claims()
        claims.pop("email")
        claims.pop("email_verified")
        res = self.apple(claims)
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(User.objects.count(), 1)

    def test_apple_services_id_audience_accepted(self):
        self.assertEqual(self.apple(apple_claims(aud=APPLE_SERVICES)).status_code, 201)

    def test_apple_wrong_audience_rejected(self):
        res = self.apple(apple_claims(aud="com.other.app"))
        self.assertEqual(res.json()["code"], "invalid_token")

    def test_apple_expired_rejected(self):
        past = int(time.time()) - 3600
        res = self.apple(apple_claims(iat=past - 600, exp=past))
        self.assertEqual(res.json()["code"], "token_expired")

    def test_apple_bad_nonce_rejected(self):
        res = self.apple(nonce="some-other-raw-nonce")
        self.assertEqual(res.status_code, 400)
        self.assertEqual(res.json()["code"], "invalid_nonce")
        self.assertFalse(User.objects.exists())

    def test_apple_token_without_nonce_rejected(self):
        claims = apple_claims()
        claims.pop("nonce")
        self.assertEqual(self.apple(claims).json()["code"], "invalid_nonce")

    def test_apple_nonce_is_required_in_request(self):
        res = self.client.post("/api/auth/apple/", {"id_token": _token(apple_claims())}, format="json")
        self.assertEqual(res.status_code, 400)
        self.assertIn("nonce", res.json().get("details", res.json()))

    def test_apple_unverified_email_rejected(self):
        res = self.apple(apple_claims(email_verified="false"))
        self.assertEqual(res.json()["code"], "email_not_verified")

    def test_apple_first_sign_in_without_email_cannot_create(self):
        claims = apple_claims()
        claims.pop("email")
        res = self.apple(claims)
        self.assertEqual(res.json()["code"], "email_required")

    def test_apple_links_existing_user_by_verified_email_then_by_subject(self):
        existing = User.objects.create_user("amani", "amani@example.com", "Secret123!", phone_number="254700000108")
        res = self.apple(apple_claims(email="amani@example.com", is_private_email="false"))
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(res.json()["user"]["id"], existing.id)
        # later sign-in with a relay email still resolves via subject
        res = self.apple(apple_claims(email="relay@privaterelay.appleid.com"))
        self.assertEqual(res.json()["user"]["id"], existing.id)
        self.assertEqual(User.objects.count(), 1)

    def test_same_person_google_and_apple_share_one_account(self):
        self.assertEqual(self.google().status_code, 201)
        res = self.apple(apple_claims(email="walker@example.com", is_private_email="false"))
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(User.objects.count(), 1)
        self.assertEqual(SocialAccount.objects.count(), 2)

    # ── public app config tells the app which buttons to show ────────────────
    def test_app_config_reports_configured_providers(self):
        data = self.client.get("/api/app/config/").json()
        self.assertEqual(data["auth_providers"], {"google": True, "apple": True})
        with override_settings(GOOGLE_OAUTH_CLIENT_IDS=[], APPLE_CLIENT_IDS=[]):
            data = self.client.get("/api/app/config/").json()
        self.assertEqual(data["auth_providers"], {"google": False, "apple": False})
