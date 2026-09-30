"""
Privacy: consent records, data-export requests and the retention settings.

- PrivacySettings (singleton, pk=1): retention periods, export limits and the minimum
  policy versions a user must have accepted (raised automatically when a Terms or
  Privacy Policy version is published with "notify users", see signals.py).
- Consent: an append-only ledger. Every grant or withdrawal is a new row; the latest
  row per (user, purpose) is the current state. Rows are never edited or deleted (they
  are the evidence that processing was lawful) and contain no contact details.
- DataExportRequest: a user's "download my data" request. The ZIP is built by the
  scheduled job runner (apps/privacy/export.py), stored in the database (the web host's
  disk is ephemeral) and deleted when the download expires.
"""

from __future__ import annotations

import uuid

from django.conf import settings
from django.db import models


class PrivacySettings(models.Model):
    # ── Retention (days). 0 switches a rule off. Bounds in BOUNDS. ─────────────
    retention_enabled = models.BooleanField(
        default=True, help_text="Master switch for the privacy retention job."
    )
    sync_payload_days = models.PositiveIntegerField(
        default=90,
        help_text="Step sync raw payloads are trimmed to aggregate fields after this many days.",
    )
    legacy_waypoint_days = models.PositiveIntegerField(
        default=30, help_text="Legacy GPS waypoints (LocationWaypoint) are deleted after this many days."
    )
    risk_ml_days = models.PositiveIntegerField(
        default=365, help_text="Shadow risk-model features and scores are deleted after this many days."
    )
    interval_verification_days = models.PositiveIntegerField(
        default=365,
        help_text="Per-interval anti-cheat results (IntervalVerificationResult) are deleted after this many days.",
    )
    password_reset_days = models.PositiveIntegerField(
        default=30, help_text="Password-reset code rows (with the requesting IP) are deleted after this many days."
    )
    login_log_days = models.PositiveIntegerField(
        default=30,
        help_text="Login attempt / access logs (django-axes: username, IP, user agent) are deleted after this many days.",
    )
    retention_batch_size = models.PositiveIntegerField(default=1000)
    # Raw GPS points of walks (the simplified route is kept). Blank = the server value
    # WALK_RAW_POINTS_RETENTION_DAYS; never longer than WALK_RAW_POINTS_MAX_DAYS.
    walk_raw_points_days = models.PositiveIntegerField(
        null=True,
        blank=True,
        help_text="Raw GPS points of walks are deleted after this many days (blank = server value).",
    )

    # ── Data export ────────────────────────────────────────────────────────────
    export_link_hours = models.PositiveIntegerField(
        default=72, help_text="How long a finished export can be downloaded."
    )
    export_cooldown_hours = models.PositiveIntegerField(
        default=24, help_text="A user can request one export per this many hours."
    )

    # ── Consent ────────────────────────────────────────────────────────────────
    require_consent_at_registration = models.BooleanField(
        # Off at launch: the app already on phones has no consent checkboxes. Current clients
        # are checked regardless; turn this on once the updated app is distributed.
        default=False,
        help_text="Also refuse registrations that send no consent answers at all (old app builds). "
        "Current apps are always checked. Turn on once the updated app is distributed.",
    )
    # Users whose accepted version is below these are asked to accept again. Raised
    # automatically when a document is published with "notify users" on.
    min_terms_version = models.PositiveIntegerField(default=0)
    min_privacy_version = models.PositiveIntegerField(default=0)

    updated_at = models.DateTimeField(auto_now=True)
    updated_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="+"
    )

    EDITABLE = (
        "retention_enabled",
        "sync_payload_days",
        "legacy_waypoint_days",
        "risk_ml_days",
        "interval_verification_days",
        "password_reset_days",
        "login_log_days",
        "retention_batch_size",
        "walk_raw_points_days",
        "export_link_hours",
        "export_cooldown_hours",
        "require_consent_at_registration",
        "min_terms_version",
        "min_privacy_version",
    )
    # (min, max). A day value of 0 disables that rule; otherwise it must be >= min so a
    # typo can't wipe recent data the anti-cheat review still needs.
    BOUNDS = {
        "sync_payload_days": (30, 3650),
        "legacy_waypoint_days": (7, 3650),
        "risk_ml_days": (90, 3650),
        "interval_verification_days": (90, 3650),
        "password_reset_days": (1, 3650),
        "login_log_days": (7, 3650),
        "retention_batch_size": (100, 10000),
        "walk_raw_points_days": (1, 3650),  # upper limit also WALK_RAW_POINTS_MAX_DAYS
        "export_link_hours": (1, 24 * 30),
        "export_cooldown_hours": (0, 24 * 30),
        "min_terms_version": (0, 100000),
        "min_privacy_version": (0, 100000),
    }
    ZERO_DISABLES = (
        "sync_payload_days",
        "legacy_waypoint_days",
        "risk_ml_days",
        "interval_verification_days",
        "password_reset_days",
        "login_log_days",
    )

    class Meta:
        verbose_name = "Privacy settings"
        verbose_name_plural = "Privacy settings"

    def save(self, *args, **kwargs):
        self.pk = 1
        super().save(*args, **kwargs)

    @classmethod
    def load(cls) -> "PrivacySettings":
        obj, _ = cls.objects.get_or_create(pk=1)
        return obj

    NULLABLE = ("walk_raw_points_days",)

    def as_dict(self) -> dict:
        return {f: getattr(self, f) for f in self.EDITABLE}

    @staticmethod
    def walk_points_max_days() -> int:
        from django.conf import settings as dj

        return max(1, int(getattr(dj, "WALK_RAW_POINTS_MAX_DAYS", 90)))

    def effective_walk_raw_points_days(self) -> int:
        """Console value, else the server value, never above the server maximum."""
        from django.conf import settings as dj

        days = self.walk_raw_points_days or int(getattr(dj, "WALK_RAW_POINTS_RETENTION_DAYS", 30))
        return max(1, min(days, self.walk_points_max_days()))

    def __str__(self):
        return "Privacy settings"


class Consent(models.Model):
    PURPOSE_TERMS = "terms"
    PURPOSE_HEALTH = "health_data"
    PURPOSE_LOCATION = "location_walks"
    PURPOSE_CHOICES = [
        (PURPOSE_TERMS, "Terms, Privacy Policy and age 18+"),
        (PURPOSE_HEALTH, "Activity and health data processing"),
        (PURPOSE_LOCATION, "Location during walks I start"),
    ]

    SOURCE_CHOICES = [
        ("registration", "Registration form"),
        ("social_signup", "Google / Apple sign-up"),
        ("reconsent", "Asked again after a policy change"),
        ("settings", "Settings > Privacy"),
        ("walk_start", "Before the first walk"),
        ("admin", "Recorded by staff"),
        ("api", "Other"),
    ]

    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="consents"
    )
    purpose = models.CharField(max_length=32, choices=PURPOSE_CHOICES)
    granted = models.BooleanField()
    # Human-readable version string, e.g. "terms=3;privacy=5" (see consent.py).
    version = models.CharField(max_length=64)
    # {"terms": 3, "privacy": 5}: the published document versions at that moment.
    document_versions = models.JSONField(default=dict, blank=True)
    # Version of the in-app wording shown next to the checkbox (consent.py TEXT_VERSION).
    text_version = models.CharField(max_length=16, blank=True, default="")
    source = models.CharField(max_length=20, choices=SOURCE_CHOICES, default="api")
    app_version = models.CharField(max_length=32, blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        ordering = ["-created_at", "-id"]
        indexes = [models.Index(fields=["user", "purpose", "-created_at"], name="privacy_consent_latest_idx")]

    def __str__(self):
        return f"{self.user_id} {self.purpose} {'granted' if self.granted else 'withdrawn'} ({self.version})"


class DataExportRequest(models.Model):
    STATUS_PENDING = "pending"
    STATUS_RUNNING = "running"
    STATUS_READY = "ready"
    STATUS_FAILED = "failed"
    STATUS_EXPIRED = "expired"
    STATUS_CHOICES = [
        (STATUS_PENDING, "Waiting"),
        (STATUS_RUNNING, "Being prepared"),
        (STATUS_READY, "Ready to download"),
        (STATUS_FAILED, "Failed"),
        (STATUS_EXPIRED, "Expired"),
    ]
    OPEN_STATUSES = (STATUS_PENDING, STATUS_RUNNING)

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="data_exports"
    )
    status = models.CharField(max_length=10, choices=STATUS_CHOICES, default=STATUS_PENDING, db_index=True)
    requested_at = models.DateTimeField(auto_now_add=True)
    started_at = models.DateTimeField(null=True, blank=True)
    finished_at = models.DateTimeField(null=True, blank=True)
    expires_at = models.DateTimeField(null=True, blank=True)
    attempts = models.PositiveSmallIntegerField(default=0)
    # The ZIP itself (deleted on expiry). Personal data: never logged or shown to staff.
    archive = models.BinaryField(null=True, blank=True, editable=False)
    size_bytes = models.PositiveIntegerField(default=0)
    sha256 = models.CharField(max_length=64, blank=True, default="")
    download_count = models.PositiveIntegerField(default=0)
    last_downloaded_at = models.DateTimeField(null=True, blank=True)
    error = models.CharField(max_length=255, blank=True, default="")

    class Meta:
        ordering = ["-requested_at"]
        indexes = [models.Index(fields=["user", "-requested_at"], name="privacy_export_user_idx")]

    def __str__(self):
        return f"export {self.id} user={self.user_id} {self.status}"
