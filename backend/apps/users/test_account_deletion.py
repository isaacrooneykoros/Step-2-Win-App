"""Self-service account deletion: API, service and the public /account/delete/ page."""

from datetime import date, timedelta
from decimal import Decimal

from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import Client, TestCase
from django.utils import timezone
from rest_framework.test import APITestCase
from rest_framework_simplejwt.tokens import RefreshToken

from apps.admin_api.models import AuditLog, SupportTicket, SupportTicketMessage
from apps.challenges.models import Challenge, ChallengeResult, Participant
from apps.payments.models import PaymentTransaction, WithdrawalRequest
from apps.steps.models import (DeviceRegistration, FraudFlag, HealthRecord,
                               HourlyStepRecord, LocationWaypoint)
from apps.users.account_deletion import AccountDeletionError, delete_account
from apps.users.models import DeviceSession, SocialAccount
from apps.wallet.models import WalletTransaction

User = get_user_model()
PASSWORD = "Walk-More-2026!"
ELIGIBILITY = "/api/auth/account/delete/eligibility/"
DELETE = "/api/auth/account/delete/"
PAGE = "/account/delete/"


def make_user(username="wanjiru", phone="254711000001", **extra):
    return User.objects.create_user(
        username=username,
        email=f"{username}@example.com",
        phone_number=phone,
        password=PASSWORD,
        first_name="Wanjiru",
        last_name="Kamau",
        **extra,
    )


def make_challenge(creator, status_value, days_ago_end=1):
    return Challenge.objects.create(
        creator=creator,
        name=f"Challenge {status_value}",
        entry_fee=Decimal("100.00"),
        milestone=10000,
        start_date=date.today() - timedelta(days=7),
        end_date=date.today() - timedelta(days=days_ago_end),
        status=status_value,
        total_pool=Decimal("100.00"),
    )


class AccountDeletionBase(APITestCase):
    def setUp(self):
        cache.clear()  # throttles
        self.user = make_user()

    def login(self, user=None, password=PASSWORD):
        response = self.client.post(
            "/api/auth/login/",
            {"username": (user or self.user).username, "password": password},
            format="json",
        )
        return response

    def auth(self, user=None):
        response = self.login(user)
        self.assertEqual(response.status_code, 200, response.data)
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {response.data['access']}")
        return response.data


class EligibleDeletionTests(AccountDeletionBase):
    def _seed_history(self):
        u = self.user
        # Money + challenge history that must survive.
        WalletTransaction.objects.create(
            user=u, type="deposit", amount=Decimal("500.00"), balance_before=Decimal("0"),
            balance_after=Decimal("500.00"), description="M-Pesa deposit",
        )
        self.payment = PaymentTransaction.objects.create(
            user=u, type="deposit", status="completed", amount_kes=Decimal("500.00"), order_id="ORD-DEL-1",
        )
        self.withdrawal = WithdrawalRequest.objects.create(
            user=u, amount_kes=Decimal("500.00"), method="mpesa", phone_number="254711000001", status="completed",
        )
        challenge = make_challenge(u, "completed")
        participant = Participant.objects.create(challenge=challenge, user=u, steps=12000, qualified=True)
        self.result = ChallengeResult.objects.create(
            challenge=challenge, participant=participant, user=u, final_steps=12000, gps_verified_pct=50.0,
            zero_step_days=0, best_day_steps=4000, longest_streak=3, joined_at=timezone.now(),
            tied_with_count=0, qualified=True, final_rank=1, payout_kes=Decimal("100.00"),
            payout_method="proportional",
        )
        # Personal activity data that must go.
        today = date.today()
        HealthRecord.objects.create(user=u, date=today, steps=5000)
        HourlyStepRecord.objects.create(user=u, date=today, hour=9, steps=800)
        LocationWaypoint.objects.create(
            user=u, date=today, hour=9, recorded_at=timezone.now(), latitude=-1.29, longitude=36.82,
        )
        DeviceRegistration.objects.create(user=u, device_id="dev-123", platform="android")
        FraudFlag.objects.create(user=u, severity="low", **_fraud_flag_extra())
        SocialAccount.objects.create(user=u, provider="google", subject="g-sub-1", email="wanjiru@example.com")
        ticket = SupportTicket.objects.create(user=u, subject="Help", message="My steps", category="general")
        SupportTicketMessage.objects.create(ticket=ticket, sender=u, sender_username=u.username, message="hi")
        u.profile_picture = SimpleUploadedFile("me.png", b"\x89PNG\r\n\x1a\nfake", content_type="image/png")
        u.device_id = "dev-123"
        u.save()
        return ticket

    def test_eligibility_reports_eligible(self):
        self.auth()
        response = self.client.get(ELIGIBILITY)
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.data["eligible"])
        self.assertEqual(response.data["blockers"], [])
        self.assertTrue(response.data["requires_password"])

    def test_deletion_anonymises_revokes_and_keeps_money_records(self):
        ticket = self._seed_history()
        photo_name = User.objects.get(pk=self.user.pk).profile_picture.name
        storage = User.objects.get(pk=self.user.pk).profile_picture.storage
        self.assertTrue(storage.exists(photo_name))
        tokens = self.auth()
        refresh = tokens["refresh"]
        other_device = RefreshToken.for_user(self.user)  # second, untracked login

        with self.captureOnCommitCallbacks(execute=True):
            response = self.client.post(DELETE, {"password": PASSWORD}, format="json")
        self.assertEqual(response.status_code, 200, response.data)
        self.assertTrue(response.data["deleted"])

        u = User.objects.get(pk=self.user.pk)
        self.assertEqual(u.username, f"deleted_{u.pk}")
        self.assertTrue(u.email.startswith(f"deleted_{u.pk}@") and u.email.endswith(".invalid"))
        self.assertNotIn("254711000001", u.phone_number)
        self.assertEqual((u.first_name, u.last_name), ("", ""))
        self.assertFalse(u.is_active)
        self.assertFalse(u.has_usable_password())
        self.assertIsNotNone(u.deleted_at)
        self.assertIsNone(u.device_id)
        self.assertFalse(u.profile_picture)
        self.assertFalse(storage.exists(photo_name))

        # Tokens and sessions are dead.
        self.assertFalse(DeviceSession.objects.filter(user=u, is_active=True).exists())
        self.client.credentials()
        self.assertEqual(self.client.post("/api/auth/refresh/", {"refresh": refresh}, format="json").status_code, 401)
        self.assertEqual(
            self.client.post("/api/auth/refresh/", {"refresh": str(other_device)}, format="json").status_code, 401
        )
        self.assertNotEqual(self.login(password=PASSWORD).status_code, 200)
        self.assertNotEqual(
            self.client.post("/api/auth/login/", {"username": "wanjiru", "password": PASSWORD}, format="json").status_code,
            200,
        )

        # Personal data gone.
        self.assertFalse(HealthRecord.objects.filter(user=u).exists())
        self.assertFalse(HourlyStepRecord.objects.filter(user=u).exists())
        self.assertFalse(LocationWaypoint.objects.filter(user=u).exists())
        self.assertFalse(DeviceRegistration.objects.filter(user=u).exists())
        self.assertFalse(SocialAccount.objects.filter(user=u).exists())

        # Money / integrity records kept, pointing at the anonymised user.
        self.assertEqual(WalletTransaction.objects.filter(user=u).count(), 1)
        self.assertTrue(PaymentTransaction.objects.filter(pk=self.payment.pk, user=u).exists())
        self.assertTrue(WithdrawalRequest.objects.filter(pk=self.withdrawal.pk, user=u).exists())
        self.assertTrue(ChallengeResult.objects.filter(pk=self.result.pk, user=u).exists())
        self.assertTrue(Participant.objects.filter(user=u).exists())
        self.assertTrue(FraudFlag.objects.filter(user=u).exists())
        self.assertTrue(SupportTicket.objects.filter(pk=ticket.pk, user=u).exists())
        self.assertEqual(
            SupportTicketMessage.objects.get(ticket=ticket).sender_username, f"deleted_{u.pk}"
        )

        log = AuditLog.objects.get(action="account_deleted", resource_id=u.pk)
        self.assertEqual(log.changes["reason"], "self-service")
        self.assertNotIn("wanjiru", str(log.description) + str(log.changes) + log.resource_name)

    def test_old_access_token_is_rejected_after_deletion(self):
        self.auth()
        self.assertEqual(self.client.post(DELETE, {"password": PASSWORD}, format="json").status_code, 200)
        self.assertEqual(self.client.get("/api/auth/profile/").status_code, 401)

    def test_wrong_password_rejected(self):
        self.auth()
        response = self.client.post(DELETE, {"password": "nope-nope"}, format="json")
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.data["code"], "invalid_password")
        self.assertIsNone(User.objects.get(pk=self.user.pk).deleted_at)

    def test_missing_password_rejected(self):
        self.auth()
        response = self.client.post(DELETE, {"confirm": "DELETE"}, format="json")
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.data["code"], "password_required")

    def test_idempotent_second_delete_is_clean_error(self):
        delete_account(self.user)
        with self.assertRaises(AccountDeletionError) as ctx:
            delete_account(User.objects.get(pk=self.user.pk))
        self.assertEqual(ctx.exception.code, "already_deleted")
        self.assertEqual(ctx.exception.status_code, 410)
        self.assertEqual(AuditLog.objects.filter(action="account_deleted").count(), 1)

    def test_deletion_frees_email_and_phone_for_a_new_signup(self):
        delete_account(self.user)
        again = make_user(username="wanjiru")  # same username, email, phone
        self.assertTrue(again.is_active)


def _fraud_flag_extra():
    """FraudFlag's other required fields vary; fill any non-null field without a default."""
    from django.db.models import NOT_PROVIDED

    extra = {}
    for field in FraudFlag._meta.concrete_fields:
        if field.name in ("id", "user", "severity") or field.null or field.default is not NOT_PROVIDED:
            continue
        if getattr(field, "auto_now", False) or getattr(field, "auto_now_add", False):
            continue
        internal = field.get_internal_type()
        if field.choices:
            extra[field.name] = field.choices[0][0]
        elif internal in ("CharField", "TextField"):
            extra[field.name] = "test"
        elif internal in ("IntegerField", "FloatField", "PositiveIntegerField", "BigIntegerField"):
            extra[field.name] = 0
        elif internal == "DateField":
            extra[field.name] = date.today()
        elif internal == "DateTimeField":
            extra[field.name] = timezone.now()
        elif internal == "JSONField":
            extra[field.name] = {}
        elif internal == "BooleanField":
            extra[field.name] = False
    return extra


class BlockerTests(AccountDeletionBase):
    def assertBlocked(self, code):
        response = self.client.get(ELIGIBILITY)
        self.assertFalse(response.data["eligible"])
        self.assertIn(code, [b["code"] for b in response.data["blockers"]])
        response = self.client.post(DELETE, {"password": PASSWORD}, format="json")
        self.assertEqual(response.status_code, 409, response.data)
        self.assertEqual(response.data["code"], code)
        self.assertTrue(response.data["error"])
        u = User.objects.get(pk=self.user.pk)
        self.assertIsNone(u.deleted_at)
        self.assertTrue(u.is_active)

    def test_wallet_balance_blocks(self):
        User.objects.filter(pk=self.user.pk).update(wallet_balance=Decimal("250.00"))
        self.auth()
        self.assertBlocked("wallet_balance")

    def test_locked_balance_blocks(self):
        User.objects.filter(pk=self.user.pk).update(locked_balance=Decimal("100.00"))
        self.auth()
        self.assertBlocked("active_challenge")

    def test_active_challenge_blocks(self):
        challenge = make_challenge(self.user, "active", days_ago_end=-3)
        Participant.objects.create(challenge=challenge, user=self.user)
        self.auth()
        self.assertBlocked("active_challenge")

    def test_pending_challenge_blocks(self):
        challenge = make_challenge(self.user, "pending", days_ago_end=-3)
        Participant.objects.create(challenge=challenge, user=self.user)
        self.auth()
        self.assertBlocked("active_challenge")

    def test_pending_withdrawal_blocks(self):
        for status_value in ("pending_review", "approved", "processing"):
            WithdrawalRequest.objects.all().delete()
            WithdrawalRequest.objects.create(
                user=self.user, amount_kes=Decimal("100.00"), method="mpesa",
                phone_number="254711000001", status=status_value,
            )
            cache.clear()
            self.auth()
            self.assertBlocked("withdrawal_pending")

    def test_pending_mpesa_deposit_blocks(self):
        PaymentTransaction.objects.create(
            user=self.user, type="deposit", status="pending", amount_kes=Decimal("100.00"), order_id="ORD-PEND",
        )
        self.auth()
        self.assertBlocked("payment_pending")

    def test_finished_challenge_and_completed_withdrawal_do_not_block(self):
        challenge = make_challenge(self.user, "completed")
        Participant.objects.create(challenge=challenge, user=self.user)
        WithdrawalRequest.objects.create(
            user=self.user, amount_kes=Decimal("100.00"), method="mpesa", phone_number="254711000001",
            status="rejected",
        )
        self.auth()
        self.assertTrue(self.client.get(ELIGIBILITY).data["eligible"])

    def test_staff_cannot_self_delete(self):
        User.objects.filter(pk=self.user.pk).update(is_staff=True)
        self.auth()
        self.assertBlocked("staff_account")

    def test_requires_authentication(self):
        self.assertEqual(self.client.get(ELIGIBILITY).status_code, 401)
        self.assertEqual(self.client.post(DELETE, {}, format="json").status_code, 401)


class SocialOnlyAccountTests(AccountDeletionBase):
    def setUp(self):
        super().setUp()
        self.social = User.objects.create_user(
            username="apple_walker", email="walker@privaterelay.appleid.com", phone_number="254711000009",
        )
        self.social.set_unusable_password()
        self.social.save()
        SocialAccount.objects.create(user=self.social, provider="apple", subject="apple-sub-1")
        refresh = RefreshToken.for_user(self.social)
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {refresh.access_token}")

    def test_eligibility_says_confirm_word(self):
        data = self.client.get(ELIGIBILITY).data
        self.assertTrue(data["eligible"])
        self.assertFalse(data["requires_password"])
        self.assertEqual(data["confirm_word"], "DELETE")
        self.assertEqual(data["social_providers"], ["apple"])

    def test_confirm_word_required(self):
        response = self.client.post(DELETE, {"confirm": "delete me"}, format="json")
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.data["code"], "confirmation_required")
        self.assertIsNone(User.objects.get(pk=self.social.pk).deleted_at)

    def test_confirm_word_deletes(self):
        response = self.client.post(DELETE, {"confirm": "DELETE"}, format="json")
        self.assertEqual(response.status_code, 200, response.data)
        u = User.objects.get(pk=self.social.pk)
        self.assertIsNotNone(u.deleted_at)
        self.assertFalse(SocialAccount.objects.filter(subject="apple-sub-1").exists())


class WebPageTests(TestCase):
    def setUp(self):
        cache.clear()
        self.user = make_user(username="kiprono", phone="254711000077")
        self.client = Client(enforce_csrf_checks=True)

    def _csrf(self):
        response = self.client.get(PAGE)
        return response.cookies["csrftoken"].value

    def test_get_renders_accessible_page(self):
        response = self.client.get(PAGE)
        self.assertEqual(response.status_code, 200)
        body = response.content.decode()
        self.assertIn("Delete your Step2Win account", body)
        self.assertIn("What we keep", body)
        self.assertIn('name="csrfmiddlewaretoken"', body)
        self.assertIn("style-src 'nonce-", response["Content-Security-Policy"])
        self.assertNotIn("<script", body)

    def test_page_is_not_blocked_by_maintenance(self):
        from apps.admin_api.platform import current_settings

        s = current_settings()
        s.maintenance_mode = True
        s.save()
        self.assertEqual(self.client.get(PAGE).status_code, 200)

    def test_post_without_csrf_is_rejected(self):
        response = self.client.post(
            PAGE, {"identifier": "kiprono", "password": PASSWORD, "understand": "yes"}
        )
        self.assertEqual(response.status_code, 403)
        self.assertIsNone(User.objects.get(pk=self.user.pk).deleted_at)

    def test_wrong_password_rejected(self):
        token = self._csrf()
        response = self.client.post(
            PAGE,
            {"csrfmiddlewaretoken": token, "identifier": "kiprono", "password": "wrong-one", "understand": "yes"},
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("couldn", response.content.decode())
        self.assertIsNone(User.objects.get(pk=self.user.pk).deleted_at)

    def test_requires_understand_checkbox(self):
        token = self._csrf()
        response = self.client.post(
            PAGE, {"csrfmiddlewaretoken": token, "identifier": "kiprono", "password": PASSWORD}
        )
        self.assertEqual(response.status_code, 400)
        self.assertIsNone(User.objects.get(pk=self.user.pk).deleted_at)

    def test_valid_credentials_by_email_delete(self):
        token = self._csrf()
        response = self.client.post(
            PAGE,
            {
                "csrfmiddlewaretoken": token,
                "identifier": "KIPRONO@example.com",
                "password": PASSWORD,
                "understand": "yes",
            },
        )
        self.assertEqual(response.status_code, 200)
        self.assertIn("Your account has been deleted", response.content.decode())
        u = User.objects.get(pk=self.user.pk)
        self.assertIsNotNone(u.deleted_at)
        self.assertEqual(u.username, f"deleted_{u.pk}")
        self.assertEqual(AuditLog.objects.get(action="account_deleted").changes["channel"], "web")

    def test_blockers_shown_on_web(self):
        User.objects.filter(pk=self.user.pk).update(wallet_balance=Decimal("40.00"))
        token = self._csrf()
        response = self.client.post(
            PAGE,
            {"csrfmiddlewaretoken": token, "identifier": "kiprono", "password": PASSWORD, "understand": "yes"},
        )
        self.assertEqual(response.status_code, 409)
        self.assertIn("Withdraw it to M-Pesa", response.content.decode())
        self.assertIsNone(User.objects.get(pk=self.user.pk).deleted_at)


class AdminViewOfDeletedAccountTests(AccountDeletionBase):
    def test_admin_sees_deleted_and_cannot_unban(self):
        delete_account(self.user)
        admin = User.objects.create_user(
            username="ops", email="ops@example.com", phone_number="254711000099", password=PASSWORD,
            is_staff=True, is_superuser=True,
        )
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {RefreshToken.for_user(admin).access_token}")
        data = self.client.get(f"/api/admin/users/{self.user.pk}/").data
        self.assertTrue(data["is_deleted"])
        self.assertFalse(data["is_banned"])
        response = self.client.post(f"/api/admin/users/{self.user.pk}/unban_user/")
        self.assertEqual(response.status_code, 409)
        self.assertFalse(User.objects.get(pk=self.user.pk).is_active)
