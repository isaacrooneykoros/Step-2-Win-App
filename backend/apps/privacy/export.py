"""
"Download my data" (Kenya Data Protection Act s.26 right of access, data portability).

A user asks for an export (POST /api/privacy/exports/); the scheduled job
"privacy-process-exports" (every 5 minutes) builds a ZIP with one JSON file per section
plus a README, stores it on the request row and makes it downloadable by that user only
(GET /api/privacy/exports/<id>/download/, JWT) until ``expires_at``.

What is included: the person's own data only, listed field by field in SECTIONS.
What is not, on purpose:
  - other people's data (friends' names, other chat members, linked accounts, who
    reacted), staff notes and staff identities;
  - anti-cheat internals: rule thresholds, detector evidence, HealthRecord.anticheat,
    FraudFlag details, risk-model features/explanations, account-linkage evidence. The
    export states that these assessments exist and how many (see ``_assessment_summary``)
    and the user-facing verification breakdown per day is included. Whether the full
    assessments must be disclosed on request is a question for the lawyer
    (DPIA_DRAFT.md, "Open questions").
Sections for apps that aren't installed yet (walks, social) are skipped automatically.
"""

from __future__ import annotations

import hashlib
import io
import json
import logging
import zipfile
from dataclasses import dataclass, field
from datetime import timedelta

from django.apps import apps as django_apps
from django.db import transaction
from django.db.models import Q
from django.utils import timezone

from .models import DataExportRequest, PrivacySettings

logger = logging.getLogger(__name__)

FORMAT_VERSION = 1
MAX_ATTEMPTS = 3
EXPORTS_PER_RUN = 3
STALE_RUNNING = timedelta(minutes=30)
SYNC_EVENT_DAYS = 90


@dataclass(frozen=True)
class Section:
    name: str
    app: str
    model: str
    user_field: str
    fields: tuple[str, ...]
    order: tuple[str, ...] = ()
    filters: dict = field(default_factory=dict)
    note: str = ""


SECTIONS: tuple[Section, ...] = (
    Section("account/social_logins", "users", "SocialAccount", "user",
            ("provider", "email", "created_at", "last_login_at"), ("created_at",)),
    Section("account/sessions", "users", "DeviceSession", "user",
            ("device_type", "device_name", "os_version", "app_version", "ip_address", "country",
             "is_active", "last_active_at", "created_at"), ("-last_active_at",),
            note="IP addresses are kept only while a session is active."),
    Section("account/devices", "steps", "DeviceRegistration", "user",
            ("device_id", "platform", "app_version", "is_active", "first_seen_at", "last_seen_at"),
            ("-last_seen_at",)),
    Section("account/legal_acknowledgements", "legal", "UserDocumentAck", "user",
            ("document__title", "version_seen", "acknowledged_at"), ("acknowledged_at",)),
    Section("account/consents", "privacy", "Consent", "user",
            ("purpose", "granted", "version", "source", "created_at"), ("created_at",)),
    Section("activity/daily_steps", "steps", "HealthRecord", "user",
            ("date", "source", "steps", "distance_km", "calories_active", "active_minutes",
             "last_raw_steps", "unverified_steps", "eligible_steps", "tier_wearable",
             "tier_walk_session", "tier_sensor_verified", "tier_unverified", "verification",
             "synced_at"), ("date",),
            note="'verification' is the same per-day breakdown the app shows under 'How were my steps counted?'."),
    Section("activity/hourly_steps", "steps", "HourlyStepRecord", "user",
            ("date", "hour", "steps", "distance_km", "calories"), ("date", "hour")),
    Section("activity/step_syncs_last_90_days", "steps", "StepSyncEvent", "user",
            ("timestamp_client", "timestamp_server", "steps_delta", "raw_steps_total", "accepted"),
            ("timestamp_server",), note="Technical upload log, last 90 days."),
    Section("location/walks", "steps", "WalkSession", "user",
            ("started_at", "ended_at", "local_date", "status", "verdict", "verdict_reasons", "steps",
             "verified_steps", "distance_m", "duration_s", "avg_speed_mps", "simplified_polyline",
             "raw_points", "points_count"), ("started_at",),
            note="simplified_polyline is a Google encoded polyline. raw_points are deleted 30 days after a walk."),
    Section("location/privacy_zone", "steps", "WalkPrivacyZone", "user",
            ("radius_m", "created_at", "updated_at"), (),
            note="The zone itself is stored only as one-way hashes, so its location can't be exported."),
    Section("location/legacy_route_points", "steps", "LocationWaypoint", "user",
            ("date", "hour", "recorded_at", "latitude", "longitude", "accuracy_m"), ("recorded_at",)),
    Section("challenges/participations", "challenges", "Participant", "user",
            ("challenge__name", "challenge__start_date", "challenge__end_date", "challenge__entry_fee",
             "steps", "qualified", "payout", "rank", "joined_at"), ("joined_at",)),
    Section("challenges/results", "challenges", "ChallengeResult", "user",
            ("challenge__name", "final_steps", "qualified", "final_rank", "payout_kes", "payout_method",
             "finalized_at"), ("finalized_at",)),
    Section("challenges/my_chat_messages", "challenges", "ChallengeMessage", "user",
            ("challenge__name", "message", "created_at"), ("created_at",), filters={"is_system": False},
            note="Only messages you wrote."),
    Section("money/payouts_under_review", "challenges", "HeldPayout", "user",
            ("challenge__name", "amount", "status", "created_at", "decided_at"), ("created_at",)),
    Section("money/wallet_transactions", "wallet", "WalletTransaction", "user",
            ("type", "amount", "balance_before", "balance_after", "description", "reference_id", "created_at"),
            ("created_at",)),
    Section("money/mpesa_payments", "payments", "PaymentTransaction", "user",
            ("type", "status", "amount_kes", "mpesa_reference", "phone_number", "narration", "created_at"),
            ("created_at",)),
    Section("money/withdrawal_requests", "payments", "WithdrawalRequest", "user",
            ("status", "amount_kes", "method", "phone_number", "bank_name", "account_number", "short_code",
             "mpesa_reference", "rejection_reason", "created_at", "reviewed_at"), ("created_at",)),
    Section("money/legacy_withdrawals", "wallet", "Withdrawal", "user",
            ("amount", "account_details", "status", "rejection_reason", "reference_number", "created_at",
             "processed_at"), ("created_at",)),
    Section("rewards/xp_events", "gamification", "XPEvent", "user",
            ("event_type", "amount", "description", "created_at"), ("created_at",)),
    Section("rewards/badges", "gamification", "UserBadge", "user", ("badge__name", "earned_at"), ("earned_at",)),
    Section("rewards/levels", "gamification", "LevelMilestone", "user", ("level", "total_xp", "reached_at"),
            ("reached_at",)),
    Section("support/tickets", "admin_api", "SupportTicket", "user",
            ("id", "subject", "category", "message", "status", "created_at", "resolved_at"), ("created_at",)),
    Section("social/profile", "social", "SocialProfile", "user",
            ("friend_code", "discoverability", "share_goal_hits", "share_streaks", "share_badges",
             "share_challenges", "show_in_rankings", "created_at"), ()),
    Section("social/weekly_totals", "social", "WeeklyStepTotal", "user",
            ("week_start", "steps", "days_counted", "friends_rank", "friends_size"), ("week_start",)),
    Section("social/my_feed_items", "social", "FeedEvent", "user", ("kind", "data", "created_at"), ("created_at",)),
    Section("social/team_memberships", "social", "TeamMembership", "user",
            ("team__name", "role", "joined_at"), ("joined_at",)),
)

ACCOUNT_FIELDS = (
    "id", "username", "email", "phone_number", "first_name", "last_name", "date_joined", "last_login",
    "device_platform", "daily_goal", "stride_length_cm", "weight_kg", "calibration_quality",
    "last_calibrated_at", "total_steps", "best_day_steps", "current_streak", "best_streak",
    "challenges_joined", "challenges_won", "total_earned", "wallet_balance", "locked_balance",
    "privacy_policy_accepted", "created_at",
)

README = """Step2Win: your personal data
================================

This archive was prepared at your request on {generated} (UTC).
Format version {fmt}. Every file is JSON (UTF-8). Dates and times are UTC.

account.json            your account and profile
account/*.json          sign-in methods, sessions, devices, consents, policy acknowledgements
activity/*.json         daily and hourly steps, how each day was verified, upload log (90 days)
location/*.json         walks you started and their routes (if any)
challenges/*.json       challenges you joined, results, messages you wrote
money/*.json            wallet, M-Pesa payments, withdrawals, payouts under review
rewards/*.json          XP, badges, levels
support/*.json          your support tickets and our replies
social/*.json           your social settings and weekly totals (if you use friends/teams)
assessments.json        which fair-play checks exist on your account (counts only)

Not included:
- other people's data (for example who is in your challenges or your friends' names);
- internal staff notes and the detailed settings of our fair-play checks, which we keep
  confidential so they can't be worked around. assessments.json lists which checks
  exist. You can ask us about any decision that affected you: see the Privacy Policy.

Want something corrected? Edit your details in Settings > Personal details, or contact
support. Questions about this export: see "Contact us" in the Privacy Policy.
"""


def _model(label: str, name: str):
    try:
        return django_apps.get_model(label, name)
    except LookupError:
        return None


def _field_exists(Model, path: str) -> bool:
    parts = path.split("__")
    current = Model
    for i, part in enumerate(parts):
        try:
            f = current._meta.get_field(part)
        except Exception:  # noqa: BLE001 - FieldDoesNotExist
            return False
        if i < len(parts) - 1:
            if not getattr(f, "related_model", None):
                return False
            current = f.related_model
    return True


def _rows(user, section: Section, now) -> list[dict] | None:
    Model = _model(section.app, section.model)
    if Model is None:
        return None
    fields = [f for f in section.fields if _field_exists(Model, f)]
    qs = Model.objects.filter(**{section.user_field: user}, **section.filters)
    if section.model == "StepSyncEvent":
        qs = qs.filter(timestamp_server__gte=now - timedelta(days=SYNC_EVENT_DAYS))
    if section.order:
        qs = qs.order_by(*[o for o in section.order if _field_exists(Model, o.lstrip("-"))])
    return list(qs.values(*fields))


def _support_messages(user) -> list[dict]:
    Msg = _model("admin_api", "SupportTicketMessage")
    if Msg is None:
        return []
    out = []
    for m in Msg.objects.filter(ticket__user=user).order_by("created_at").values(
        "ticket_id", "is_admin", "message", "created_at"
    ):
        out.append(
            {
                "ticket_id": m["ticket_id"],
                "from": "Step2Win support" if m["is_admin"] else "you",
                "message": m["message"],
                "created_at": m["created_at"],
            }
        )
    return out


def _assessment_summary(user) -> dict:
    """Which fair-play assessments exist (counts and date ranges, no rule details)."""
    out: dict = {}
    trust = _model("steps", "TrustScore")
    if trust is not None:
        t = trust.objects.filter(user=user).first()
        if t is not None:
            out["trust_score"] = {"score": t.score, "status": t.status, "updated_at": t.updated_at}
    for key, label, name in (
        ("fair_play_flags", "steps", "FraudFlag"),
        ("shadow_risk_scores", "risk_ml", "RiskScore"),
        ("interval_checks", "steps", "IntervalVerificationResult"),
    ):
        Model = _model(label, name)
        if Model is None:
            continue
        date_field = "date" if _field_exists(Model, "date") else "created_at"
        qs = Model.objects.filter(user=user)
        agg = list(qs.order_by(date_field).values_list(date_field, flat=True))
        out[key] = {"count": len(agg), "first": agg[0] if agg else None, "last": agg[-1] if agg else None}
    Edge = _model("linkage", "LinkEdge")
    if Edge is not None:
        out["account_links"] = {
            "count": Edge.objects.filter(Q(user_a=user) | Q(user_b=user), active=True).count(),
            "note": "Signals that this account may be operated together with another one. "
            "Details are not shown because they concern other people.",
        }
    out["explanation"] = (
        "Step2Win checks that steps come from real walking before money is paid. Automated checks "
        "can lower how many steps count toward challenge money or hold a payout for a human review "
        "(normally within 48 hours); they never close an account on their own. The shadow risk "
        "model is not used for any decision. You can ask for a human to review any decision."
    )
    return out


def build_archive(user, now=None) -> bytes:
    """ZIP bytes with the user's personal data (pure function of the database)."""
    now = now or timezone.now()
    from apps.users.models import User

    account = User.objects.filter(pk=user.pk).values(*[f for f in ACCOUNT_FIELDS if _field_exists(User, f)]).first()
    files: dict[str, object] = {"account.json": account or {}}
    notes = {}
    for section in SECTIONS:
        rows = _rows(user, section, now)
        if rows is None:
            continue
        files[f"{section.name}.json"] = rows
        if section.note:
            notes[section.name] = section.note
    files["support/messages.json"] = _support_messages(user)
    files["assessments.json"] = _assessment_summary(user)
    files["notes.json"] = notes

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("README.txt", README.format(generated=now.strftime("%Y-%m-%d %H:%M"), fmt=FORMAT_VERSION))
        for name, payload in files.items():
            zf.writestr(name, json.dumps(payload, indent=2, default=str, ensure_ascii=False))
    return buf.getvalue()


# ── Requests ──────────────────────────────────────────────────────────────────


class ExportRateLimited(Exception):
    def __init__(self, retry_after):
        super().__init__("export rate limited")
        self.retry_after = retry_after


def request_export(user, now=None) -> tuple[DataExportRequest, bool]:
    """Create a request, or return the open one. Raises ExportRateLimited when the last
    request is younger than the cooldown. Returns (request, created)."""
    now = now or timezone.now()
    s = PrivacySettings.load()
    with transaction.atomic():
        # Serialise requests per user (a double tap creates one request).
        from apps.users.models import User

        User.objects.select_for_update().filter(pk=user.pk).first()
        open_req = DataExportRequest.objects.filter(user=user, status__in=DataExportRequest.OPEN_STATUSES).first()
        if open_req:
            return open_req, False
        last = (
            DataExportRequest.objects.filter(user=user)
            .exclude(status=DataExportRequest.STATUS_FAILED)
            .order_by("-requested_at")
            .first()
        )
        cooldown = timedelta(hours=int(s.export_cooldown_hours))
        if last and cooldown and last.requested_at > now - cooldown:
            raise ExportRateLimited(last.requested_at + cooldown)
        return DataExportRequest.objects.create(user=user), True


def _claim_next(now) -> DataExportRequest | None:
    stale = now - STALE_RUNNING
    candidates = DataExportRequest.objects.filter(
        Q(status=DataExportRequest.STATUS_PENDING)
        | Q(status=DataExportRequest.STATUS_RUNNING, started_at__lt=stale)
    ).order_by("requested_at")
    for req in candidates[:10]:
        if req.attempts >= MAX_ATTEMPTS:  # crashed mid-build too often
            DataExportRequest.objects.filter(pk=req.pk, status=req.status).update(
                status=DataExportRequest.STATUS_FAILED, error="gave up after repeated attempts"
            )
            continue
        claimed = DataExportRequest.objects.filter(pk=req.pk, status=req.status, started_at=req.started_at).update(
            status=DataExportRequest.STATUS_RUNNING, started_at=now, attempts=req.attempts + 1
        )
        if claimed:
            req.refresh_from_db()
            return req
    return None


def process_pending_exports(limit: int = EXPORTS_PER_RUN, now=None) -> dict:
    """Build up to ``limit`` waiting exports. Idempotent and safe with several runners."""
    now = now or timezone.now()
    s = PrivacySettings.load()
    done = failed = 0
    for _ in range(limit):
        req = _claim_next(now)
        if req is None:
            break
        if getattr(req.user, "deleted_at", None) is not None or not req.user.is_active:
            req.delete()
            continue
        try:
            data = build_archive(req.user, now=timezone.now())
        except Exception as exc:  # noqa: BLE001
            logger.exception("data export %s failed", req.pk)
            req.status = (
                DataExportRequest.STATUS_FAILED if req.attempts >= MAX_ATTEMPTS else DataExportRequest.STATUS_PENDING
            )
            req.error = f"{type(exc).__name__}"[:255]
            req.save(update_fields=["status", "error"])
            failed += 1
            continue
        finished = timezone.now()
        req.archive = data
        req.size_bytes = len(data)
        req.sha256 = hashlib.sha256(data).hexdigest()
        req.status = DataExportRequest.STATUS_READY
        req.finished_at = finished
        req.expires_at = finished + timedelta(hours=int(s.export_link_hours))
        req.error = ""
        req.save(update_fields=["archive", "size_bytes", "sha256", "status", "finished_at", "expires_at", "error"])
        done += 1
        _notify_ready(req)
    return {"built": done, "failed": failed}


def _notify_ready(req: DataExportRequest) -> None:
    """Email a short "your export is ready" notice (no data, no link). Best effort."""
    try:
        from apps.core.emails import send_branded_email

        send_branded_email(
            kind="data_export_ready",
            to=req.user.email,
            subject="Your Step2Win data is ready",
            heading="Your data is ready",
            paragraphs=[
                "The copy of your data you asked for is ready. Open Step2Win and go to "
                "Settings > Privacy & your data to download it.",
                f"The download is available until {req.expires_at:%d %b %Y %H:%M} UTC.",
                "If you didn't ask for this, change your password and contact support.",
            ],
        )
    except Exception:  # noqa: BLE001 - the app shows the status anyway
        logger.warning("data export %s: ready email not sent", req.pk)
