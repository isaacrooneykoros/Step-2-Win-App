"""
Privacy retention (scheduled job "privacy-retention", hourly at :50 UTC).

Each rule works in small batches (PrivacySettings.retention_batch_size rows, one short
transaction per batch), is idempotent (a second run finds nothing to do) and stops when
the time budget is spent; the next run carries on. Periods are admin settings
(PrivacySettings); 0 switches a rule off.

Rules owned here (defaults):
  sync_payloads           StepSyncEvent.raw_payload older than 90 days is trimmed to the
                          aggregate fields in KEEP_PAYLOAD_KEYS (no device ids, install id,
                          time zone, arrays or free text). Events of step sessions under an
                          open anti-cheat review are skipped until the review is closed.
  legacy_waypoints        LocationWaypoint (legacy background GPS points) older than 30 days:
                          deleted.
  risk_ml                 risk_ml UserDayFeatures / RiskScore older than 12 months: deleted.
                          Labels (human decisions) are kept with the decision they record.
  interval_verifications  IntervalVerificationResult older than 12 months: deleted (the
                          daily summaries and HealthRecord.verification stay).
  password_resets         PasswordResetCode rows older than 30 days (codes expire in
                          minutes; the row holds the requesting IP): deleted.
  login_logs              django-axes AccessAttempt / AccessLog / AccessFailureLog older
                          than 30 days: deleted.
  exports                 finished data exports past their download window: archive
                          deleted, status "expired"; request rows older than 1 year deleted.

Owned elsewhere (referenced, not duplicated):
  walk raw GPS points     Phase 1b, apps/steps/walks.py::purge_old_walk_points (job
                          "purge-old-walk-points", WALK_RAW_POINTS_RETENTION_DAYS=30).
  login IPs / net hashes  Phase 2a, apps/users/network_privacy.py::purge_ip_data (job
                          "privacy-ip-retention": full IP cleared at session end, network
                          hash deleted after 90 days).
  inactive sessions       apps.users.tasks.cleanup_inactive_sessions (30 days).

NEVER touched here: wallet transactions, payments, withdrawals, payout holds, challenge
results, platform revenue, callback logs (financial records, kept 7 years; see
backend/legal/DATA_INVENTORY.md).
"""

from __future__ import annotations

import logging
import time
from datetime import timedelta

from django.apps import apps as django_apps
from django.db import transaction
from django.utils import timezone

from .models import DataExportRequest, PrivacySettings

logger = logging.getLogger(__name__)

DEFAULT_BUDGET_SECONDS = 40.0
EXPORT_ROW_RETENTION_DAYS = 365

# Aggregate / scalar fields a trimmed sync payload keeps (the step pipeline and the risk
# model only read these; the risk model's look-back is 35 + 9 days, far below 90).
KEEP_PAYLOAD_KEYS = (
    "date",
    "steps",
    "steps_total",
    "steps_delta",
    "source",
    "client_source",
    "burst_source",
    "distance_km",
    "calories_active",
    "active_minutes",
    "cadence_spm",
    "burst_steps_5s",
    "gait_state",
    "gait_confidence",
    "gait_autocorr",
    "gait_interval_std_ms",
    "carry_mode",
    "ml_motion_label",
    "ml_walk_probability",
    "ml_shake_probability",
    "ml_model_version",
    "timestamp_client",
    "sequence_number",
    "app_version",
    "platform",
)
TRIM_MARKER = "_trimmed"
OPEN_REVIEW_STATUSES = ("pending", "escalated")


def trim_payload(payload) -> dict | None:
    if not isinstance(payload, dict):
        return None
    kept = {
        k: payload[k]
        for k in KEEP_PAYLOAD_KEYS
        if k in payload and (payload[k] is None or isinstance(payload[k], (str, int, float, bool)))
        and not (isinstance(payload[k], str) and len(payload[k]) > 64)
    }
    kept[TRIM_MARKER] = True
    return kept


def _model(label: str, name: str):
    try:
        return django_apps.get_model(label, name)
    except LookupError:
        return None


class _Budget:
    def __init__(self, seconds: float):
        self.deadline = time.monotonic() + seconds

    def spent(self) -> bool:
        return time.monotonic() >= self.deadline


def _delete_in_batches(qs, batch: int, budget: _Budget) -> tuple[int, bool]:
    """Delete ``qs`` by primary key in batches. Returns (rows deleted, finished)."""
    total = 0
    model = qs.model
    while True:
        if budget.spent():
            return total, False
        ids = list(qs.order_by("pk").values_list("pk", flat=True)[:batch])
        if not ids:
            return total, True
        with transaction.atomic():
            model.objects.filter(pk__in=ids).delete()
        total += len(ids)
        if len(ids) < batch:
            return total, True


# ── Rules ─────────────────────────────────────────────────────────────────────


def trim_sync_payloads(days: int, batch: int, budget: _Budget, now) -> dict:
    from apps.steps.models import StepSyncEvent, SuspiciousSessionReview

    cutoff = now - timedelta(days=days)
    under_review = SuspiciousSessionReview.objects.filter(status__in=OPEN_REVIEW_STATUSES).values("session_id")
    qs = (
        StepSyncEvent.objects.filter(created_at__lt=cutoff, raw_payload__isnull=False)
        .exclude(raw_payload__has_key=TRIM_MARKER)
        .exclude(session_id__in=under_review)
    )
    trimmed = 0
    last_pk = None
    while not budget.spent():
        page = qs.order_by("pk")
        if last_pk is not None:
            page = page.filter(pk__gt=last_pk)
        rows = list(page.values_list("pk", "raw_payload")[:batch])
        if not rows:
            return {"trimmed": trimmed, "finished": True}
        last_pk = rows[-1][0]
        with transaction.atomic():
            objs = []
            for pk, payload in rows:
                obj = StepSyncEvent(pk=pk)
                obj.raw_payload = trim_payload(payload)
                objs.append(obj)
            StepSyncEvent.objects.bulk_update(objs, ["raw_payload"])
        trimmed += len(rows)
        if len(rows) < batch:
            return {"trimmed": trimmed, "finished": True}
    return {"trimmed": trimmed, "finished": False}


def purge_legacy_waypoints(days: int, batch: int, budget: _Budget, now) -> dict:
    from apps.steps.models import LocationWaypoint

    qs = LocationWaypoint.objects.filter(recorded_at__lt=now - timedelta(days=days))
    deleted, finished = _delete_in_batches(qs, batch, budget)
    return {"deleted": deleted, "finished": finished}


def purge_risk_ml(days: int, batch: int, budget: _Budget, now) -> dict:
    cutoff_day = (now - timedelta(days=days)).date()
    out = {"finished": True}
    for name in ("UserDayFeatures", "RiskScore"):
        Model = _model("risk_ml", name)
        if Model is None:
            continue
        deleted, finished = _delete_in_batches(Model.objects.filter(date__lt=cutoff_day), batch, budget)
        out[name] = deleted
        out["finished"] = out["finished"] and finished
    return out


def purge_interval_verifications(days: int, batch: int, budget: _Budget, now) -> dict:
    from apps.steps.models import IntervalVerificationResult

    qs = IntervalVerificationResult.objects.filter(created_at__lt=now - timedelta(days=days))
    deleted, finished = _delete_in_batches(qs, batch, budget)
    return {"deleted": deleted, "finished": finished}


def purge_password_resets(days: int, batch: int, budget: _Budget, now) -> dict:
    from apps.users.models import PasswordResetCode

    qs = PasswordResetCode.objects.filter(created_at__lt=now - timedelta(days=days))
    deleted, finished = _delete_in_batches(qs, batch, budget)
    return {"deleted": deleted, "finished": finished}


def purge_login_logs(days: int, batch: int, budget: _Budget, now) -> dict:
    cutoff = now - timedelta(days=days)
    out = {"finished": True}
    for name, field in (("AccessAttempt", "attempt_time"), ("AccessLog", "attempt_time"),
                        ("AccessFailureLog", "attempt_time")):
        Model = _model("axes", name)
        if Model is None or not any(f.name == field for f in Model._meta.get_fields()):
            continue
        deleted, finished = _delete_in_batches(Model.objects.filter(**{f"{field}__lt": cutoff}), batch, budget)
        out[name] = deleted
        out["finished"] = out["finished"] and finished
    return out


def expire_exports(now) -> dict:
    expired = DataExportRequest.objects.filter(
        status=DataExportRequest.STATUS_READY, expires_at__lt=now
    ).update(status=DataExportRequest.STATUS_EXPIRED, archive=None)
    # A failed build keeps no archive, but make sure no bytes survive in any other state.
    DataExportRequest.objects.filter(
        status__in=(DataExportRequest.STATUS_FAILED, DataExportRequest.STATUS_EXPIRED), archive__isnull=False
    ).update(archive=None)
    old = DataExportRequest.objects.filter(requested_at__lt=now - timedelta(days=EXPORT_ROW_RETENTION_DAYS)).exclude(
        status__in=DataExportRequest.OPEN_STATUSES
    ).delete()[0]
    return {"expired": expired, "old_rows_deleted": old}


RULES = (
    ("sync_payloads", "sync_payload_days", trim_sync_payloads),
    ("legacy_waypoints", "legacy_waypoint_days", purge_legacy_waypoints),
    ("risk_ml", "risk_ml_days", purge_risk_ml),
    ("interval_verifications", "interval_verification_days", purge_interval_verifications),
    ("password_resets", "password_reset_days", purge_password_resets),
    ("login_logs", "login_log_days", purge_login_logs),
)


def run_retention(now=None, budget_seconds: float = DEFAULT_BUDGET_SECONDS) -> dict:
    """Apply every enabled rule. Safe to run any number of times."""
    now = now or timezone.now()
    s = PrivacySettings.load()
    summary: dict = {"exports": expire_exports(now)}
    if not s.retention_enabled:
        summary["skipped"] = "retention disabled"
        return summary
    budget = _Budget(budget_seconds)
    batch = max(100, int(s.retention_batch_size or 1000))
    for name, field, rule in RULES:
        days = int(getattr(s, field) or 0)
        if days <= 0:
            summary[name] = "off"
            continue
        if budget.spent():
            summary[name] = "deferred"
            continue
        try:
            summary[name] = rule(days, batch, budget, now)
        except Exception as exc:  # noqa: BLE001 - one failing rule never stops the others
            logger.exception("privacy retention rule %s failed", name)
            summary[name] = f"error: {type(exc).__name__}"
    logger.info("privacy retention: %s", summary)
    return summary
