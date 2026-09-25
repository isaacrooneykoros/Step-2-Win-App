import uuid

from django.conf import settings
from django.db import models


class HealthRecord(models.Model):
    SOURCE_CHOICES = [
        ("device_sensor", "Device Sensor"),
        ("google_fit", "Google Fit"),
        ("apple_health", "Apple Health"),
        ("manual", "Manual Entry"),
    ]

    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="health_records",
    )
    date = models.DateField()
    source = models.CharField(
        max_length=20, choices=SOURCE_CHOICES, default="google_fit"
    )

    steps = models.IntegerField(default=0)
    distance_km = models.FloatField(null=True, blank=True)
    calories_active = models.IntegerField(null=True, blank=True)
    active_minutes = models.IntegerField(null=True, blank=True)

    is_suspicious = models.BooleanField(default=False)
    synced_at = models.DateTimeField(auto_now=True)
    # Phone clock time of the newest reading applied to this day. Lets the sync endpoint
    # recognise an older upload arriving late (out-of-order retry) and ignore it instead
    # of treating the lower total as tampering.
    last_client_timestamp = models.DateTimeField(null=True, blank=True)

    class Meta:
        unique_together = ["user", "date"]
        indexes = [
            models.Index(fields=["user", "-date"]),
            models.Index(fields=["user", "date"]),
        ]
        ordering = ["-date"]

    def __str__(self):
        return f"{self.user.username} — {self.date} ({self.steps:,} steps)"


class SuspiciousActivity(models.Model):
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    reason = models.CharField(max_length=255)
    steps_submitted = models.IntegerField()
    date = models.DateField()
    reviewed = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return f"Suspicious: {self.user.username} on {self.date}"


class TrustScore(models.Model):
    user = models.OneToOneField(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="trust_score",
    )
    score = models.IntegerField(default=100)
    flags_total = models.IntegerField(default=0)
    updated_at = models.DateTimeField(auto_now=True)
    # Automatic recovery is time based: at most one point per calendar day
    # (the day of the last clean sync that earned a point).
    last_recovered_on = models.DateField(null=True, blank=True)
    # Admin-imposed status (restrict / suspend / ban). While the lock is in force
    # automatic recovery (and a dismissed flag) can never lift the score above
    # admin_ceiling; only an admin "lift" action, or admin_locked_until passing,
    # ends it. admin_locked_until NULL with a ceiling = until an admin lifts it.
    admin_status = models.CharField(max_length=12, blank=True, default="")
    admin_ceiling = models.IntegerField(null=True, blank=True)
    admin_locked_until = models.DateTimeField(null=True, blank=True)

    # Admin actions -> (score set, ceiling held while locked). Scores sit inside
    # the band of the matching status (RESTRICT 21-40, SUSPEND 1-20, BAN 0).
    ADMIN_LOCKS = {
        "restrict": (35, 40),
        "suspend": (10, 20),
        "ban": (0, 0),
    }
    # Admin lift actions -> minimum score after the lift.
    ADMIN_LIFTS = {
        "unrestrict": 65,
        "unsuspend": 45,
        "unban": 35,
    }
    MAX_AUTO_RECOVERY_PER_DAY = 1

    @property
    def status(self):
        if self.score > 80:
            return "GOOD"
        if self.score > 60:
            return "WARN"
        if self.score > 40:
            return "REVIEW"
        if self.score > 20:
            return "RESTRICT"
        if self.score > 0:
            return "SUSPEND"
        return "BAN"

    def deduct(self, points: int):
        self.score = max(0, self.score - points)
        self.flags_total += 1
        self.save(update_fields=["score", "flags_total", "updated_at"])

    # ── admin lock ───────────────────────────────────────────────────────

    def admin_lock_active(self, now=None) -> bool:
        if self.admin_ceiling is None:
            return False
        if self.admin_locked_until is None:
            return True
        from django.utils import timezone

        return self.admin_locked_until > (now or timezone.now())

    def recovery_ceiling(self, now=None) -> int:
        """Highest score recovery may reach right now (100 unless an admin lock holds)."""
        return self.admin_ceiling if self.admin_lock_active(now) else 100

    def _clear_expired_lock(self, now=None) -> bool:
        if self.admin_ceiling is not None and not self.admin_lock_active(now):
            self.admin_status = ""
            self.admin_ceiling = None
            self.admin_locked_until = None
            return True
        return False

    def recover(self, points: int = 1, *, by_admin: bool = False, today=None) -> int:
        """Raise the score. Returns the points actually added.

        Automatic recovery (the default, called after a clean sync) is slow and
        time based: at most MAX_AUTO_RECOVERY_PER_DAY point per calendar day, no
        matter how many clean syncs arrive. `by_admin=True` (a dismissed flag) may
        add more at once. Neither path can lift the score above an admin lock's
        ceiling: only an admin lift action (apply_admin_action) or the lock's
        expiry does that.
        """
        from django.utils import timezone

        now = timezone.now()
        fields = ["score", "updated_at"]
        if self._clear_expired_lock(now):
            fields += ["admin_status", "admin_ceiling", "admin_locked_until"]
        if not by_admin:
            day = today or timezone.localdate()
            if self.last_recovered_on is not None and self.last_recovered_on >= day:
                if len(fields) > 2:
                    self.save(update_fields=fields)
                return 0
            points = min(points, self.MAX_AUTO_RECOVERY_PER_DAY)
        ceiling = self.recovery_ceiling(now)
        target = min(100, ceiling, self.score + max(0, points))
        added = max(0, target - self.score)
        if added:
            self.score = target
            if not by_admin:
                self.last_recovered_on = today or timezone.localdate()
                fields.append("last_recovered_on")
        if added or len(fields) > 2:
            self.save(update_fields=fields)
        return added

    def apply_admin_action(self, action: str, *, until=None) -> None:
        """Admin trust action (the single implementation for every admin endpoint).

        restrict / suspend / ban set the score and hold it there (see ADMIN_LOCKS)
        until an admin lifts it or `until` (optional datetime) passes.
        unrestrict / unsuspend / unban clear the lock and raise the score to the
        lift minimum. warn deducts 5; dismiss restores 10 (never above a lock).
        """
        if action in self.ADMIN_LOCKS:
            score, ceiling = self.ADMIN_LOCKS[action]
            self.score = score
            self.admin_status = action
            self.admin_ceiling = ceiling
            self.admin_locked_until = until
            self.save(
                update_fields=[
                    "score", "admin_status", "admin_ceiling", "admin_locked_until", "updated_at",
                ]
            )
        elif action in self.ADMIN_LIFTS:
            self.score = max(self.score, self.ADMIN_LIFTS[action])
            self.admin_status = ""
            self.admin_ceiling = None
            self.admin_locked_until = None
            self.save(
                update_fields=[
                    "score", "admin_status", "admin_ceiling", "admin_locked_until", "updated_at",
                ]
            )
        elif action == "warn":
            self.deduct(5)
        elif action == "dismiss":
            self.recover(10, by_admin=True)
        else:
            raise ValueError(f"Unknown trust action: {action}")

    def __str__(self):
        return f"{self.user.username}: {self.score}/100 ({self.status})"


class FraudFlag(models.Model):
    SEVERITY_CHOICES = [
        ("low", "Low — Log Only"),
        ("medium", "Medium — Admin Review"),
        ("high", "High — Auto Cap Steps"),
        ("critical", "Critical — Reject Submission"),
    ]

    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="fraud_flags",
    )
    flag_type = models.CharField(max_length=40)
    severity = models.CharField(max_length=10, choices=SEVERITY_CHOICES)
    date = models.DateField()
    details = models.JSONField(default=dict)
    reviewed = models.BooleanField(default=False)
    actioned = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        indexes = [
            models.Index(fields=["user", "-created_at"]),
            models.Index(fields=["reviewed", "severity", "-created_at"]),
        ]
        ordering = ["-created_at"]


class HourlyStepRecord(models.Model):
    """
    Stores step data broken down by hour for a given day.
    Synced from Google Fit / Apple Health alongside the daily record.
    One row per hour per user per day (max 24 rows per day).

    Example: user walked 320 steps between 8:00–8:59 AM on Mar 4.
    """

    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="hourly_steps"
    )
    date = models.DateField(db_index=True)
    hour = models.IntegerField()  # 0–23 (0 = midnight, 14 = 2PM)
    steps = models.IntegerField(default=0)
    distance_km = models.FloatField(default=0.0)
    calories = models.FloatField(default=0.0)

    class Meta:
        unique_together = [("user", "date", "hour")]
        ordering = ["date", "hour"]
        indexes = [models.Index(fields=["user", "date"])]

    def __str__(self):
        return f"{self.user.username} | {self.date} {self.hour:02d}:00 | {self.steps} steps"


class LocationWaypoint(models.Model):
    """
    GPS waypoints recorded during a walking session.
    Multiple waypoints per day — connected to draw the movement route on map.
    Captured by Capacitor Geolocation during active step sessions.

    Privacy note: Location data stays on-device until explicitly synced.
    Users must grant location permission for this feature.
    """

    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="location_waypoints",
    )
    date = models.DateField(db_index=True)
    hour = models.IntegerField()  # which hour this waypoint belongs to
    recorded_at = models.DateTimeField()  # exact timestamp of GPS fix
    latitude = models.FloatField()
    longitude = models.FloatField()
    accuracy_m = models.FloatField(default=0.0)  # GPS accuracy in metres

    class Meta:
        ordering = ["date", "recorded_at"]
        indexes = [models.Index(fields=["user", "date"])]

    def __str__(self):
        return f"{self.user.username} | {self.recorded_at} | ({self.latitude:.4f}, {self.longitude:.4f})"


class IntervalVerificationResult(models.Model):
    """Stores anti-cheat v2 decision output for one normalized interval."""

    MODE_CHOICES = [
        ("active", "Active"),
        ("shadow", "Shadow"),
    ]

    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="interval_verification_results",
    )
    date = models.DateField(db_index=True)
    interval_start = models.DateTimeField()
    interval_end = models.DateTimeField()
    source_platform = models.CharField(max_length=40, blank=True)
    source_device = models.CharField(max_length=80, blank=True)
    source_app = models.CharField(max_length=80, blank=True)
    raw_steps = models.IntegerField(default=0)
    normalized_steps = models.IntegerField(default=0)
    verified_steps = models.IntegerField(default=0)
    risk_score = models.FloatField(default=0.0)
    confidence_score = models.FloatField(default=0.0)
    verification_status = models.CharField(max_length=20, default="accept")
    review_state = models.CharField(max_length=20, default="none")
    payout_state = models.CharField(max_length=20, default="eligible")
    rule_hits_json = models.JSONField(default=list)
    explainability_json = models.JSONField(default=dict)
    trust_score_before = models.IntegerField(default=100)
    trust_score_after = models.IntegerField(default=100)
    mode = models.CharField(max_length=12, choices=MODE_CHOICES, default="active")
    verification_version = models.CharField(max_length=32, default="v2")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        indexes = [
            models.Index(
                fields=["user", "date", "mode"], name="steps_int_usr_mode_idx"
            ),
            models.Index(
                fields=["review_state", "payout_state", "-created_at"],
                name="steps_int_rev_pay_idx",
            ),
            models.Index(
                fields=["verification_status", "-created_at"],
                name="steps_int_status_idx",
            ),
        ]
        ordering = ["-created_at"]


class DailyVerificationSummary(models.Model):
    """Stores anti-cheat v2 daily aggregate decision per user/date/mode."""

    MODE_CHOICES = [
        ("active", "Active"),
        ("shadow", "Shadow"),
    ]

    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="daily_verification_summaries",
    )
    date = models.DateField(db_index=True)
    raw_steps_total = models.IntegerField(default=0)
    verified_steps_total = models.IntegerField(default=0)
    suspicious_steps_total = models.IntegerField(default=0)
    interval_count = models.IntegerField(default=0)
    accepted_count = models.IntegerField(default=0)
    review_count = models.IntegerField(default=0)
    rejected_count = models.IntegerField(default=0)
    risk_score = models.FloatField(default=0.0)
    review_state = models.CharField(max_length=20, default="none")
    payout_state = models.CharField(max_length=20, default="eligible")
    trust_score_before = models.IntegerField(default=100)
    trust_score_after = models.IntegerField(default=100)
    mode = models.CharField(max_length=12, choices=MODE_CHOICES, default="active")
    verification_version = models.CharField(max_length=32, default="v2")
    audit_snapshot = models.JSONField(default=dict)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        unique_together = [("user", "date", "mode")]
        indexes = [
            models.Index(
                fields=["user", "date", "mode"], name="steps_day_usr_mode_idx"
            ),
            models.Index(
                fields=["review_state", "payout_state", "-updated_at"],
                name="steps_day_rev_pay_idx",
            ),
        ]
        ordering = ["-date", "-updated_at"]


class DeviceRegistration(models.Model):
    """Register and track device-level trust and signatures."""

    PLATFORM_CHOICES = [
        ("android", "Android"),
        ("ios", "iOS"),
        ("web", "Web"),
    ]
    TRUST_LEVEL_CHOICES = [
        ("unknown", "Unknown"),
        ("new", "New"),
        ("low", "Low"),
        ("standard", "Standard"),
        ("trusted", "Trusted"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="device_registrations",
    )
    device_id = models.CharField(max_length=255, db_index=True)
    device_public_key = models.TextField(null=True, blank=True)
    platform = models.CharField(max_length=20, choices=PLATFORM_CHOICES)
    app_version = models.CharField(max_length=64, null=True, blank=True)
    is_active = models.BooleanField(default=True)
    trust_level = models.CharField(
        max_length=20, choices=TRUST_LEVEL_CHOICES, default="unknown"
    )
    first_seen_at = models.DateTimeField(auto_now_add=True)
    last_seen_at = models.DateTimeField(auto_now=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        unique_together = [("user", "device_id")]
        indexes = [
            models.Index(fields=["user", "is_active"]),
            models.Index(fields=["device_id"]),
        ]
        ordering = ["-last_seen_at"]

    def __str__(self):
        return f"{self.user.username} — {self.platform} {self.app_version} — {self.trust_level}"


class StepSession(models.Model):
    """Represents a step-syncing session with challenge/response and aggregates."""

    STATUS_CHOICES = [
        ("active", "Active"),
        ("completed", "Completed"),
        ("expired", "Expired"),
        ("rejected", "Rejected"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="step_sessions"
    )
    device = models.ForeignKey(
        DeviceRegistration,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="sessions",
    )
    session_token_hash = models.CharField(max_length=255, db_index=True)
    server_nonce = models.CharField(max_length=255)
    status = models.CharField(
        max_length=20, choices=STATUS_CHOICES, default="active", db_index=True
    )
    started_at = models.DateTimeField(auto_now_add=True)
    ended_at = models.DateTimeField(null=True, blank=True)
    expires_at = models.DateTimeField(db_index=True)
    last_sequence_number = models.IntegerField(default=0)
    total_steps = models.IntegerField(default=0)
    accepted_steps = models.IntegerField(default=0)
    rejected_steps = models.IntegerField(default=0)
    avg_walk_probability = models.FloatField(null=True, blank=True)
    avg_shake_probability = models.FloatField(null=True, blank=True)
    avg_risk_score = models.FloatField(null=True, blank=True)
    session_risk_score = models.FloatField(default=0.0)
    trust_adjustment = models.FloatField(default=0.0)
    policy_version = models.CharField(max_length=64, null=True, blank=True)
    ml_model_version = models.CharField(max_length=64, null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        indexes = [
            models.Index(fields=["user", "status"]),
            models.Index(fields=["user", "-created_at"]),
            models.Index(fields=["expires_at", "status"]),
        ]
        ordering = ["-created_at"]

    def __str__(self):
        return f"{self.user.username} session {self.id} — {self.status}"


class StepSyncEvent(models.Model):
    """Individual sync event within a session, prevents replay attacks."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="sync_events"
    )
    session = models.ForeignKey(
        StepSession,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="events",
    )
    device = models.ForeignKey(
        DeviceRegistration,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="sync_events",
    )
    client_event_id = models.CharField(max_length=255, db_index=True)
    sequence_number = models.IntegerField(default=0)
    timestamp_client = models.DateTimeField(null=True, blank=True)
    timestamp_server = models.DateTimeField(auto_now_add=True)
    payload_hash = models.CharField(max_length=255, db_index=True)
    signature_valid = models.BooleanField(default=False)
    replay_detected = models.BooleanField(default=False)
    steps_delta = models.IntegerField(default=0)
    raw_steps_total = models.IntegerField(null=True, blank=True)
    ml_motion_label = models.CharField(max_length=20, null=True, blank=True)
    ml_walk_probability = models.FloatField(null=True, blank=True)
    ml_shake_probability = models.FloatField(null=True, blank=True)
    ml_model_version = models.CharField(max_length=64, null=True, blank=True)
    interval_risk_score = models.FloatField(default=0.0)
    accepted = models.BooleanField(default=True, db_index=True)
    rejection_reason = models.CharField(max_length=255, null=True, blank=True)
    raw_payload = models.JSONField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        unique_together = [("user", "client_event_id")]
        indexes = [
            models.Index(fields=["session", "sequence_number"]),
            models.Index(fields=["user", "created_at"]),
            models.Index(fields=["payload_hash"]),
            models.Index(fields=["replay_detected"]),
        ]
        ordering = ["-created_at"]

    def __str__(self):
        status = (
            "replay"
            if self.replay_detected
            else ("rejected" if not self.accepted else "accepted")
        )
        return f"{self.user.username} sync {self.client_event_id[:8]} — {status}"


class AntiCheatPolicy(models.Model):
    """Configurable anti-cheat scoring policy, allows A/B testing and tuning."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    version = models.CharField(max_length=64, unique=True, db_index=True)
    is_active = models.BooleanField(default=False, db_index=True)
    description = models.TextField(null=True, blank=True)
    config = models.JSONField(default=dict)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-created_at"]
        verbose_name_plural = "Anti-cheat policies"

    def __str__(self):
        active_str = "(ACTIVE)" if self.is_active else "(inactive)"
        return f"{self.version} {active_str}"


class UserTrustProfile(models.Model):
    """User reputation and trust scoring for reward system."""

    TRUST_TIER_CHOICES = [
        ("new", "New User"),
        ("low", "Low Trust"),
        ("standard", "Standard"),
        ("trusted", "Trusted"),
        ("restricted", "Restricted"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.OneToOneField(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="trust_profile"
    )
    trust_score = models.FloatField(default=50.0)
    trust_tier = models.CharField(
        max_length=20, choices=TRUST_TIER_CHOICES, default="new"
    )
    verified_sessions_count = models.IntegerField(default=0)
    suspicious_sessions_count = models.IntegerField(default=0)
    replay_attempts_count = models.IntegerField(default=0)
    total_accepted_steps = models.IntegerField(default=0)
    total_rejected_steps = models.IntegerField(default=0)
    last_suspicious_at = models.DateTimeField(null=True, blank=True)
    last_verified_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-created_at"]

    def save(self, *args, **kwargs):
        if self.trust_score <= 20:
            self.trust_tier = "restricted"
        elif self.trust_score <= 40:
            self.trust_tier = "low"
        elif self.trust_score <= 70:
            self.trust_tier = "standard"
        else:
            self.trust_tier = "trusted"
        super().save(*args, **kwargs)

    def __str__(self):
        return f"{self.user.username} — {self.trust_tier} ({self.trust_score:.1f}/100)"


class SuspiciousSessionReview(models.Model):
    """Flagged sessions for manual review."""

    STATUS_CHOICES = [
        ("pending", "Pending Review"),
        ("reviewed", "Reviewed"),
        ("approved", "Approved"),
        ("rejected", "Rejected"),
        ("escalated", "Escalated"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="suspicious_session_reviews",
    )
    session = models.ForeignKey(
        StepSession, on_delete=models.CASCADE, related_name="reviews"
    )
    risk_score = models.FloatField()
    reason_summary = models.TextField()
    risk_hits = models.JSONField(default=list)
    status = models.CharField(
        max_length=20, choices=STATUS_CHOICES, default="pending", db_index=True
    )
    reviewer = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="reviewed_sessions",
    )
    reviewed_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        indexes = [
            models.Index(fields=["status", "-created_at"]),
            models.Index(fields=["user", "-created_at"]),
        ]
        ordering = ["-created_at"]

    def __str__(self):
        return f"Review {self.id} — {self.user.username} — {self.status}"
