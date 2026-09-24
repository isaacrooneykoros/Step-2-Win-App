"""
Self-service account deletion ("Anonymise, keep money records").

Required by the App Store (5.1.1(v): deletion must be possible in-app) and Google Play
(in-app AND via a web link). Used by:
  - POST /api/auth/account/delete/            (customer app)
  - GET  /api/auth/account/delete/eligibility/ (customer app, shows blockers first)
  - GET/POST /account/delete/                  (public web page for Google Play)

What happens (one DB transaction):
  - Sign-in is disabled (is_active=False, unusable password) and every refresh token /
    DeviceSession is revoked.
  - PII on the user row is replaced: username -> "deleted_<id>", email -> a unique
    non-routable placeholder (email is unique + NOT NULL), phone_number -> "del_<id>"
    (unique + NOT NULL), names cleared, device binding cleared, profile photo removed
    from storage (after commit).
  - Google / Apple links (SocialAccount) are deleted.
  - Raw activity data is deleted: health records, hourly steps, GPS waypoints, sync
    events (raw payloads), interval / daily verification rows, device registrations and
    step sessions that are not under an anti-cheat review.
  - Kept (financial / integrity records, now pointing at the anonymised user): wallet
    ledger, M-Pesa payment transactions, withdrawal requests, challenge participation /
    results, fraud flags, trust scores, session reviews, legal acknowledgements, support
    tickets (sender name on the user's messages is anonymised).
  - An AuditLog "account_deleted" entry (reason "self-service", no PII) is written.

Deletion is BLOCKED while money is on the account or in flight - see ``get_blockers``.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import timedelta
from decimal import Decimal

from django.db import transaction
from django.utils import timezone

logger = logging.getLogger(__name__)

CONFIRM_WORD = "DELETE"
DELETED_EMAIL_DOMAIN = "deleted.step2win.invalid"  # RFC 2606 .invalid: never routable
PENDING_WITHDRAWAL_STATUSES = ("pending_review", "approved", "processing")
ACTIVE_CHALLENGE_STATUSES = ("pending", "active")
# A deposit STK push that is still waiting for M-Pesa could credit the account after
# deletion. Older initiated/pending rows are abandoned prompts and don't block.
PENDING_PAYMENT_WINDOW = timedelta(hours=24)


@dataclass(frozen=True)
class Blocker:
    code: str
    message: str

    def as_dict(self) -> dict:
        return {"code": self.code, "message": self.message}


class AccountDeletionError(Exception):
    """Deletion refused. ``blockers`` lists every reason (code + user-facing message)."""

    def __init__(self, blockers: list[Blocker], status_code: int = 409):
        self.blockers = blockers
        self.status_code = status_code
        super().__init__("; ".join(b.message for b in blockers))

    @property
    def code(self) -> str:
        return self.blockers[0].code if self.blockers else "not_eligible"


def _kes(amount: Decimal) -> str:
    return f"KSh {amount:,.2f}"


def get_blockers(user) -> list[Blocker]:
    """Every reason this account can't be deleted right now (empty list = eligible)."""
    from apps.challenges.models import Participant
    from apps.payments.models import PaymentTransaction, WithdrawalRequest
    from apps.wallet.models import Withdrawal

    if getattr(user, "deleted_at", None) is not None:
        return [Blocker("already_deleted", "This account has already been deleted.")]

    blockers: list[Blocker] = []
    if user.is_staff or user.is_superuser:
        blockers.append(
            Blocker(
                "staff_account",
                "Staff and admin accounts can't be deleted here. Ask a superuser to "
                "remove your staff access first.",
            )
        )

    balance = user.wallet_balance or Decimal("0")
    if balance > 0:
        blockers.append(
            Blocker(
                "wallet_balance",
                f"You have {_kes(balance)} in your wallet. Withdraw it to M-Pesa before "
                "deleting your account.",
            )
        )

    locked = user.locked_balance or Decimal("0")
    in_challenge = Participant.objects.filter(
        user=user, challenge__status__in=ACTIVE_CHALLENGE_STATUSES
    ).exists()
    if locked > 0 or in_challenge:
        message = "You're in a challenge that hasn't finished yet"
        if locked > 0:
            message += f" ({_kes(locked)} is committed to it)"
        message += ". Wait for it to end and for any payout to reach your wallet."
        blockers.append(Blocker("active_challenge", message))

    if (
        WithdrawalRequest.objects.filter(
            user=user, status__in=PENDING_WITHDRAWAL_STATUSES
        ).exists()
        or Withdrawal.objects.filter(user=user, status="processing").exists()
    ):
        blockers.append(
            Blocker(
                "withdrawal_pending",
                "A withdrawal is still being processed. Wait until it has been paid out "
                "(or rejected) before deleting your account.",
            )
        )

    if PaymentTransaction.objects.filter(
        user=user,
        status__in=("initiated", "pending"),
        created_at__gte=timezone.now() - PENDING_PAYMENT_WINDOW,
    ).exists():
        blockers.append(
            Blocker(
                "payment_pending",
                "An M-Pesa payment is still being confirmed. Wait for it to complete "
                "(it can take a few minutes) and withdraw any balance first.",
            )
        )
    return blockers


def eligibility(user) -> dict:
    blockers = get_blockers(user)
    return {
        "eligible": not blockers,
        "blockers": [b.as_dict() for b in blockers],
        # Tells the app how to re-authenticate: password, or type DELETE (Google/Apple sign-ups).
        "requires_password": user.has_usable_password(),
        "confirm_word": CONFIRM_WORD,
        "social_providers": sorted(
            set(user.social_accounts.values_list("provider", flat=True))
        ),
    }


def check_reauthentication(user, *, password: str | None, confirm: str | None) -> Blocker | None:
    """Password for password accounts; the word DELETE for Google/Apple-only accounts."""
    if user.has_usable_password():
        if not password:
            return Blocker("password_required", "Enter your current password to confirm.")
        if not user.check_password(password):
            return Blocker("invalid_password", "That password isn't correct.")
        return None
    if (confirm or "").strip() != CONFIRM_WORD:
        return Blocker(
            "confirmation_required", f"Type {CONFIRM_WORD} to confirm you want to delete your account."
        )
    return None


# ── Apple sign-in token revocation ───────────────────────────────────────────


def revoke_apple_tokens(user, apple_subjects: list[str]) -> None:
    """
    Apple requires apps offering Sign in with Apple to revoke the user's Apple tokens
    when they delete their account (https://appleid.apple.com/auth/revoke).

    TODO(apple-signin): Sign in with Apple isn't configured yet (no APPLE_TEAM_ID /
    APPLE_KEY_ID / APPLE_PRIVATE_KEY, and we don't store Apple refresh tokens). When it
    is, exchange/stash the authorization code's refresh token at sign-in and POST it to
    https://appleid.apple.com/auth/revoke with a client_secret JWT signed by the key.
    See step2win-web/AUTH_SETUP.md ("Account deletion and Apple token revocation").
    This is deliberately a no-op until then and must never block deletion.
    """
    if apple_subjects:
        logger.info(
            "Account deletion: Apple token revocation skipped (not configured) user=%s links=%d",
            user.pk,
            len(apple_subjects),
        )


# ── Deletion ─────────────────────────────────────────────────────────────────


def _revoke_all_tokens(user) -> int:
    from rest_framework_simplejwt.token_blacklist.models import (
        BlacklistedToken, OutstandingToken)

    from apps.users.models import DeviceSession

    jtis = list(DeviceSession.objects.filter(user=user).values_list("refresh_jti", flat=True))
    outstanding = OutstandingToken.objects.filter(user=user) | OutstandingToken.objects.filter(
        jti__in=jtis
    )
    revoked = 0
    for token in outstanding.distinct():
        _, created = BlacklistedToken.objects.get_or_create(token=token)
        revoked += int(created)
    DeviceSession.objects.filter(user=user, is_active=True).update(is_active=False)
    return revoked


def _delete_activity_data(user) -> dict:
    from apps.steps.models import (DailyVerificationSummary, DeviceRegistration,
                                   HealthRecord, HourlyStepRecord,
                                   IntervalVerificationResult, LocationWaypoint,
                                   StepSession, StepSyncEvent)

    counts = {}
    for label, qs in (
        ("location_waypoints", LocationWaypoint.objects.filter(user=user)),
        ("hourly_steps", HourlyStepRecord.objects.filter(user=user)),
        ("health_records", HealthRecord.objects.filter(user=user)),
        ("sync_events", StepSyncEvent.objects.filter(user=user)),
        ("interval_verifications", IntervalVerificationResult.objects.filter(user=user)),
        ("daily_verifications", DailyVerificationSummary.objects.filter(user=user)),
        # Sessions under an anti-cheat review are integrity records: keep those.
        ("step_sessions", StepSession.objects.filter(user=user, reviews__isnull=True)),
        ("device_registrations", DeviceRegistration.objects.filter(user=user)),
    ):
        counts[label] = qs.delete()[0]
    return counts


def _scrub_auditlog_history(user, social_ids: list[int]) -> None:
    """django-auditlog snapshots of the user / social links still hold the old email etc."""
    from auditlog.models import LogEntry
    from django.contrib.contenttypes.models import ContentType

    from apps.users.models import SocialAccount

    redacted = "[deleted]"
    user_ct = ContentType.objects.get_for_model(type(user))
    social_ct = ContentType.objects.get_for_model(SocialAccount)
    entries = LogEntry.objects.filter(content_type=user_ct, object_pk=str(user.pk))
    if social_ids:
        entries = entries | LogEntry.objects.filter(
            content_type=social_ct, object_pk__in=[str(i) for i in social_ids]
        )
    for entry in entries:
        changes = entry.changes if isinstance(entry.changes, dict) else {}
        for field in ("username", "email", "subject"):
            if field in changes:
                changes[field] = [redacted, redacted]
        entry.changes = changes
        entry.changes_text = ""
        entry.serialized_data = None
        entry.remote_addr = None
        entry.object_repr = user.username if entry.content_type_id == user_ct.id else redacted
        entry.save(update_fields=["changes", "changes_text", "serialized_data", "remote_addr", "object_repr"])


def delete_account(user, *, channel: str = "app") -> None:
    """
    Anonymise ``user`` and remove their personal data. Raises ``AccountDeletionError``
    if the account isn't eligible (re-checked under a row lock, so a deposit or challenge
    join racing the request can't slip through).
    """
    from auditlog.context import disable_auditlog

    from apps.admin_api.models import AuditLog, SupportTicketMessage
    from apps.users.models import SocialAccount, User

    photo_name = None
    photo_storage = None

    with transaction.atomic():
        locked_user = User.objects.select_for_update().get(pk=user.pk)
        blockers = get_blockers(locked_user)
        if blockers:
            raise AccountDeletionError(
                blockers, status_code=410 if blockers[0].code == "already_deleted" else 409
            )

        social = list(SocialAccount.objects.filter(user=locked_user).values_list("id", "provider", "subject"))
        revoked = _revoke_all_tokens(locked_user)
        data_counts = _delete_activity_data(locked_user)

        if locked_user.profile_picture:
            photo_name = locked_user.profile_picture.name
            photo_storage = locked_user.profile_picture.storage

        anon = f"deleted_{locked_user.pk}"
        with disable_auditlog():
            SocialAccount.objects.filter(user=locked_user).delete()
            locked_user.username = anon
            locked_user.email = f"{anon}@{DELETED_EMAIL_DOMAIN}"
            locked_user.phone_number = f"del_{locked_user.pk}"[:20]
            locked_user.first_name = ""
            locked_user.last_name = ""
            locked_user.device_id = None
            locked_user.device_platform = None
            locked_user.profile_picture = None
            locked_user.last_profile_picture_update = None
            locked_user.is_active = False
            locked_user.set_unusable_password()
            locked_user.deleted_at = timezone.now()
            locked_user.save()

        SupportTicketMessage.objects.filter(sender=locked_user).update(sender_username=anon)
        _scrub_auditlog_history(locked_user, [s[0] for s in social])

        AuditLog.objects.create(
            admin=None,
            admin_username="self-service",
            action="account_deleted",
            resource_type="user",
            resource_id=locked_user.pk,
            resource_name=anon,
            description=f"Account deleted by its owner (self-service, {channel}). "
            "Personal data anonymised; money records kept.",
            changes={
                "reason": "self-service",
                "channel": channel,
                "revoked_tokens": revoked,
                "deleted": data_counts,
                "social_links_removed": len(social),
            },
        )

        apple_subjects = [s[2] for s in social if s[1] == SocialAccount.PROVIDER_APPLE]

        if photo_name and photo_storage is not None:
            def _remove_photo(name=photo_name, storage=photo_storage):
                try:
                    storage.delete(name)
                except Exception:  # storage hiccup must not undo a committed deletion
                    logger.warning("Account deletion: could not remove profile photo for user=%s", user.pk)

            transaction.on_commit(_remove_photo)

    revoke_apple_tokens(locked_user, apple_subjects)
    logger.info("Account deleted (self-service): user=%s channel=%s", locked_user.pk, channel)
    # Keep the caller's instance in sync.
    user.refresh_from_db()
