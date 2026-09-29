"""
Account deletion, the privacy part that apps.users.account_deletion does not cover.

apps.users.account_deletion.delete_account anonymises the user row and deletes the
activity data; apps.risk_ml, apps.linkage and apps.social remove their own data from
their own post_save signals. This module (called from signals.py when a user's
``deleted_at`` is first set, inside the same transaction) removes what was left over:

- DeviceSession rows (device name, OS, IP address, network hash): deleted. Tokens are
  already blacklisted by delete_account before the user row is saved.
- PasswordResetCode rows (they carry the requesting IP): deleted.
- Body measurements on the user row (weight, stride, calibration) reset to defaults,
  last_login cleared. Aggregate counters (total steps, streaks) stay: they identify
  nobody once the account is anonymised and keep leaderboard history consistent.
- django-auditlog entries the person caused: their IP (remote_addr) cleared.
- Staff audit log (admin_api.AuditLog) rows about the account: the old username / email /
  phone replaced with the anonymous name in resource_name and description.
- django-axes login records for the old username / email / phone: deleted.
- This app's own data-export archives: deleted. Consent records are KEPT (evidence that
  processing was lawful; they hold no contact details).

``scrub_deleted_user`` is idempotent and can be re-run for accounts deleted before this
module existed (manage.py privacy_scrub_deleted_accounts).
"""

from __future__ import annotations

import logging

from django.apps import apps as django_apps
from django.db.models import Q

logger = logging.getLogger(__name__)

USER_DEFAULTS = {
    "stride_length_cm": 78.0,
    "weight_kg": 70.0,
    "calibration_quality": None,
    "calibration_variance_pct": None,
    "last_calibrated_at": None,
    "last_login": None,
}


def _model(label: str, name: str):
    try:
        return django_apps.get_model(label, name)
    except LookupError:
        return None


def _replace_all(text: str, needles: list[str], replacement: str) -> str:
    for needle in needles:
        if needle and needle in text:
            text = text.replace(needle, replacement)
    return text


def scrub_deleted_user(user, old_identifiers: tuple[str, ...] = ()) -> dict:
    """Remove the leftovers listed in the module docstring. ``old_identifiers`` are the
    username / email / phone the account had before anonymisation (when known)."""
    from apps.users.models import DeviceSession, PasswordResetCode, User

    uid = user.pk
    anon = f"deleted_{uid}"
    needles = sorted({str(v) for v in old_identifiers if v and str(v) != anon}, key=len, reverse=True)
    counts: dict[str, int] = {}

    counts["device_sessions"] = DeviceSession.objects.filter(user_id=uid).delete()[0]
    counts["password_reset_codes"] = PasswordResetCode.objects.filter(user_id=uid).delete()[0]
    user_fields = {k: v for k, v in USER_DEFAULTS.items() if hasattr(User, k)}
    User.objects.filter(pk=uid).update(**user_fields)

    LogEntry = _model("auditlog", "LogEntry")
    if LogEntry is not None:
        counts["auditlog_ips"] = (
            LogEntry.objects.filter(actor_id=uid).exclude(remote_addr__isnull=True).update(remote_addr=None)
        )

    AuditLog = _model("admin_api", "AuditLog")
    if AuditLog is not None and needles:
        changed = 0
        for row in AuditLog.objects.filter(resource_type="user", resource_id=uid).exclude(action="account_deleted"):
            name = _replace_all(row.resource_name or "", needles, anon)
            desc = _replace_all(row.description or "", needles, anon)
            if name != row.resource_name or desc != row.description:
                row.resource_name, row.description = name, desc
                row.save(update_fields=["resource_name", "description"])
                changed += 1
        counts["staff_audit_rows"] = changed

    if needles:
        removed = 0
        for model_name in ("AccessAttempt", "AccessLog", "AccessFailureLog"):
            Model = _model("axes", model_name)
            if Model is not None:
                removed += Model.objects.filter(username__in=needles).delete()[0]
        counts["login_records"] = removed

    from .models import DataExportRequest

    counts["data_exports"] = DataExportRequest.objects.filter(user_id=uid).delete()[0]
    logger.info("Privacy scrub after account deletion: user=%s %s", uid, counts)
    return counts


def deleted_accounts_missing_scrub():
    """Deleted accounts that still have leftovers (for the backfill command)."""
    from apps.users.models import DeviceSession, PasswordResetCode, User

    return User.objects.filter(deleted_at__isnull=False).filter(
        Q(pk__in=DeviceSession.objects.values("user_id"))
        | Q(pk__in=PasswordResetCode.objects.values("user_id"))
        | ~Q(weight_kg=USER_DEFAULTS["weight_kg"])
        | ~Q(stride_length_cm=USER_DEFAULTS["stride_length_cm"])
    )
