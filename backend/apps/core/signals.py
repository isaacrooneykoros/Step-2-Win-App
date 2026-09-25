"""
Model signals -> admin realtime events.

Every handler is O(1): it reads fields already on the instance (``*_id``, never
related objects, so no extra query) and calls ``publish_admin_event``, which
defers to ``transaction.on_commit``. Queryset ``.update()`` / ``bulk_create``
bypass signals by design; the rows those paths touch are covered by a sibling
model that is saved normally (e.g. a step sync always saves its HealthRecord or
StepSyncEvent), and the admin client refetches on any event of the domain.

Models are resolved lazily by label so a model renamed or removed by another
app degrades to "no event for it" instead of breaking start-up.
"""

from __future__ import annotations

import logging
from decimal import Decimal

from django.apps import apps as django_apps
from django.db.models.signals import post_delete, post_save

from apps.core.realtime import publish_admin_event

logger = logging.getLogger("apps.core.realtime")

# User fields whose new value may be included in "user.updated" (all already
# visible in the admin users list / drawer). Everything else is sent by name only.
_USER_VALUE_FIELDS = {
    "wallet_balance",
    "locked_balance",
    "total_steps",
    "total_earned",
    "challenges_joined",
    "challenges_won",
    "current_streak",
    "best_streak",
    "best_day_steps",
    "is_active",
    "is_staff",
}
# Field names that may be announced as "changed" (no values for these).
_USER_NAMED_FIELDS = _USER_VALUE_FIELDS | {
    "last_login",
    "username",
    "profile_picture",
    "daily_goal",
    "updated_at",
    "deleted_at",
    "is_superuser",
}


def _plain(value):
    if isinstance(value, Decimal):
        return str(value)
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return value


def _fields(update_fields) -> list[str] | None:
    return sorted(update_fields) if update_fields else None


# ── Users, sessions, devices ─────────────────────────────────────────────────


def _user_saved(sender, instance, created, raw=False, update_fields=None, **kwargs):
    if raw:
        return
    if created:
        publish_admin_event("user.registered", {"id": instance.pk, "at": _plain(instance.date_joined)})
        return
    fields = _fields(update_fields)
    if getattr(instance, "deleted_at", None) and not instance.is_active and (fields is None or "deleted_at" in fields):
        publish_admin_event("user.deleted", {"id": instance.pk})
        return
    payload: dict = {"id": instance.pk}
    if fields is not None:
        payload["fields"] = [f for f in fields if f in _USER_NAMED_FIELDS]
        for f in fields:
            if f in _USER_VALUE_FIELDS:
                payload[f] = _plain(getattr(instance, f, None))
    publish_admin_event("user.updated", payload)


def _user_deleted(sender, instance, **kwargs):
    publish_admin_event("user.deleted", {"id": instance.pk})


def _device_session_saved(sender, instance, created, raw=False, **kwargs):
    if raw:
        return
    payload = {
        "user_id": instance.user_id,
        "id": str(instance.pk),
        "device_type": getattr(instance, "device_type", None),
        "is_active": getattr(instance, "is_active", None),
    }
    publish_admin_event("session.login" if created else "session.updated", payload)


def _device_registration_saved(sender, instance, created, raw=False, **kwargs):
    if raw:
        return
    publish_admin_event(
        "device.updated",
        {"user_id": instance.user_id, "platform": getattr(instance, "platform", None), "created": bool(created)},
    )


# ── Steps ────────────────────────────────────────────────────────────────────


def _health_record_saved(sender, instance, created, raw=False, **kwargs):
    if raw:
        return
    publish_admin_event(
        "steps.updated",
        {
            "user_id": instance.user_id,
            "date": _plain(getattr(instance, "date", None)),
            "steps": getattr(instance, "steps", None),
            "is_suspicious": getattr(instance, "is_suspicious", None),
            "at": _plain(getattr(instance, "synced_at", None)),
        },
    )


def _step_detail_saved(sender, instance, created, raw=False, **kwargs):
    """StepSyncEvent / HourlyStepRecord: a sync happened even if the daily total didn't change."""
    if raw:
        return
    payload = {"user_id": instance.user_id}
    date = getattr(instance, "date", None)
    if date is not None:
        payload["date"] = _plain(date)
    publish_admin_event("steps.updated", payload)


# ── Challenges ───────────────────────────────────────────────────────────────


def _challenge_saved(sender, instance, created, raw=False, update_fields=None, **kwargs):
    if raw:
        return
    payload = {"id": instance.pk, "status": getattr(instance, "status", None)}
    if created:
        payload["creator_id"] = getattr(instance, "creator_id", None)
        publish_admin_event("challenge.created", payload)
    else:
        fields = _fields(update_fields)
        if fields is not None:
            payload["fields"] = fields
        publish_admin_event("challenge.updated", payload)


def _challenge_deleted(sender, instance, **kwargs):
    publish_admin_event("challenge.deleted", {"id": instance.pk})


def _participant_saved(sender, instance, created, raw=False, **kwargs):
    if raw:
        return
    if created:
        publish_admin_event(
            "challenge.joined",
            {"id": instance.pk, "challenge_id": instance.challenge_id, "user_id": instance.user_id},
        )
    else:
        publish_admin_event("challenge.progress", {"challenge_id": instance.challenge_id})


def _participant_deleted(sender, instance, **kwargs):
    publish_admin_event(
        "challenge.left",
        {"id": instance.pk, "challenge_id": instance.challenge_id, "user_id": instance.user_id},
    )


# ── Money ────────────────────────────────────────────────────────────────────


def _wallet_txn_saved(sender, instance, created, raw=False, **kwargs):
    if raw or not created:
        return
    publish_admin_event(
        "wallet.transaction",
        {
            "id": instance.pk,
            "user_id": instance.user_id,
            "type": getattr(instance, "type", None),
            "amount": _plain(getattr(instance, "amount", None)),
            "balance_after": _plain(getattr(instance, "balance_after", None)),
        },
    )


def _payment_saved(sender, instance, created, raw=False, **kwargs):
    if raw:
        return
    publish_admin_event(
        "payment.updated",
        {
            "id": instance.pk,
            "user_id": instance.user_id,
            "type": getattr(instance, "type", None),
            "status": getattr(instance, "status", None),
            "amount_kes": _plain(getattr(instance, "amount_kes", None)),
            "created": bool(created),
        },
    )


def _withdrawal_request_saved(sender, instance, created, raw=False, **kwargs):
    if raw:
        return
    publish_admin_event(
        "withdrawal.updated",
        {
            "id": instance.pk,
            "user_id": instance.user_id,
            "status": getattr(instance, "status", None),
            "amount_kes": _plain(getattr(instance, "amount_kes", None)),
            "created": bool(created),
        },
    )


def _legacy_withdrawal_saved(sender, instance, created, raw=False, **kwargs):
    if raw:
        return
    publish_admin_event(
        "withdrawal.legacy",
        {
            "id": instance.pk,
            "user_id": instance.user_id,
            "status": getattr(instance, "status", None),
            "created": bool(created),
        },
    )


# ── Support ──────────────────────────────────────────────────────────────────


def _ticket_saved(sender, instance, created, raw=False, **kwargs):
    if raw:
        return
    publish_admin_event(
        "support.ticket",
        {
            "id": instance.pk,
            "user_id": instance.user_id,
            "status": getattr(instance, "status", None),
            "priority": getattr(instance, "priority", None),
            "assigned_to_id": getattr(instance, "assigned_to_id", None),
            "created": bool(created),
        },
    )


def _ticket_message_saved(sender, instance, created, raw=False, **kwargs):
    if raw or not created:
        return
    publish_admin_event(
        "support.message",
        {"id": instance.pk, "ticket_id": instance.ticket_id, "is_admin": bool(getattr(instance, "is_admin", False))},
    )


# ── Trust and safety ─────────────────────────────────────────────────────────


def _fraud_flag_saved(sender, instance, created, raw=False, **kwargs):
    if raw:
        return
    publish_admin_event(
        "trust.flag",
        {
            "id": instance.pk,
            "user_id": instance.user_id,
            "severity": getattr(instance, "severity", None),
            "flag_type": getattr(instance, "flag_type", None),
            "reviewed": getattr(instance, "reviewed", None),
            "created": bool(created),
        },
    )


def _suspicious_activity_saved(sender, instance, created, raw=False, **kwargs):
    if raw:
        return
    publish_admin_event("trust.activity", {"id": instance.pk, "user_id": instance.user_id, "created": bool(created)})


def _session_review_saved(sender, instance, created, raw=False, **kwargs):
    if raw:
        return
    publish_admin_event(
        "trust.review",
        {
            "id": str(instance.pk),
            "user_id": instance.user_id,
            "status": getattr(instance, "status", None),
            "created": bool(created),
        },
    )


def _trust_score_saved(sender, instance, created, raw=False, **kwargs):
    if raw:
        return
    score = getattr(instance, "score", None)
    if score is None:
        score = getattr(instance, "trust_score", None)
    publish_admin_event("trust.score", {"user_id": instance.user_id, "score": _plain(score)})


# ── Staff actions ────────────────────────────────────────────────────────────


def _audit_saved(sender, instance, created, raw=False, **kwargs):
    if raw or not created:
        return
    publish_admin_event(
        "audit.logged",
        {
            "id": instance.pk,
            "action": getattr(instance, "action", None),
            "resource_type": getattr(instance, "resource_type", None),
            "resource_id": getattr(instance, "resource_id", None),
        },
    )


# label -> [(signal, handler)]
_WIRING = {
    "users.User": [(post_save, _user_saved), (post_delete, _user_deleted)],
    "users.DeviceSession": [(post_save, _device_session_saved)],
    "steps.DeviceRegistration": [(post_save, _device_registration_saved)],
    "steps.HealthRecord": [(post_save, _health_record_saved)],
    "steps.StepSyncEvent": [(post_save, _step_detail_saved)],
    "steps.HourlyStepRecord": [(post_save, _step_detail_saved)],
    "challenges.Challenge": [(post_save, _challenge_saved), (post_delete, _challenge_deleted)],
    "challenges.Participant": [(post_save, _participant_saved), (post_delete, _participant_deleted)],
    "wallet.WalletTransaction": [(post_save, _wallet_txn_saved)],
    "wallet.Withdrawal": [(post_save, _legacy_withdrawal_saved)],
    "payments.PaymentTransaction": [(post_save, _payment_saved)],
    "payments.WithdrawalRequest": [(post_save, _withdrawal_request_saved)],
    "admin_api.SupportTicket": [(post_save, _ticket_saved)],
    "admin_api.SupportTicketMessage": [(post_save, _ticket_message_saved)],
    "admin_api.AuditLog": [(post_save, _audit_saved)],
    "steps.FraudFlag": [(post_save, _fraud_flag_saved)],
    "steps.SuspiciousActivity": [(post_save, _suspicious_activity_saved)],
    "steps.SuspiciousSessionReview": [(post_save, _session_review_saved)],
    "steps.TrustScore": [(post_save, _trust_score_saved)],
    "steps.UserTrustProfile": [(post_save, _trust_score_saved)],
}


def connect_signals() -> list[str]:
    """Wire every model that exists. Returns the labels that were connected."""
    connected = []
    for label, pairs in _WIRING.items():
        try:
            model = django_apps.get_model(label)
        except (LookupError, ValueError):
            logger.info("Realtime: model %s not found; no admin events for it.", label)
            continue
        for signal, handler in pairs:
            signal.connect(
                handler,
                sender=model,
                weak=False,
                dispatch_uid=f"admin-realtime:{label}:{handler.__name__}:{signal is post_save}",
            )
        connected.append(label)
    return connected
