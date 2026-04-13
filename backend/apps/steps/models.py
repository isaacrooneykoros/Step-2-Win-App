from django.conf import settings
from django.db import models


class HealthRecord(models.Model):
    SOURCE_CHOICES = [
        ('device_sensor', 'Device Sensor'),
        ('google_fit', 'Google Fit'),
        ('apple_health', 'Apple Health'),
        ('manual', 'Manual Entry'),
    ]

    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name='health_records'
    )
    date = models.DateField()
    source = models.CharField(max_length=20, choices=SOURCE_CHOICES, default='google_fit')

    steps = models.IntegerField(default=0)
    distance_km = models.FloatField(null=True, blank=True)
    calories_active = models.IntegerField(null=True, blank=True)
    active_minutes = models.IntegerField(null=True, blank=True)

    is_suspicious = models.BooleanField(default=False)
    synced_at = models.DateTimeField(auto_now=True)

    class Meta:
        unique_together = ['user', 'date']
        indexes = [
            models.Index(fields=['user', '-date']),
            models.Index(fields=['user', 'date']),
        ]
        ordering = ['-date']

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
        related_name='trust_score',
    )
    score = models.IntegerField(default=100)
    flags_total = models.IntegerField(default=0)
    updated_at = models.DateTimeField(auto_now=True)

    @property
    def status(self):
        if self.score > 80:
            return 'GOOD'
        if self.score > 60:
            return 'WARN'
        if self.score > 40:
            return 'REVIEW'
        if self.score > 20:
            return 'RESTRICT'
        if self.score > 0:
            return 'SUSPEND'
        return 'BAN'

    def deduct(self, points: int):
        self.score = max(0, self.score - points)
        self.flags_total += 1
        self.save(update_fields=['score', 'flags_total', 'updated_at'])

    def recover(self, points: int = 1):
        if self.score < 100:
            self.score = min(100, self.score + points)
            self.save(update_fields=['score', 'updated_at'])

    def __str__(self):
        return f"{self.user.username}: {self.score}/100 ({self.status})"


class FraudFlag(models.Model):
    SEVERITY_CHOICES = [
        ('low', 'Low — Log Only'),
        ('medium', 'Medium — Admin Review'),
        ('high', 'High — Auto Cap Steps'),
        ('critical', 'Critical — Reject Submission'),
    ]

    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name='fraud_flags',
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
            models.Index(fields=['user', '-created_at']),
            models.Index(fields=['reviewed', 'severity', '-created_at']),
        ]
        ordering = ['-created_at']


class HourlyStepRecord(models.Model):
    """
    Stores step data broken down by hour for a given day.
    Synced from Google Fit / Apple Health alongside the daily record.
    One row per hour per user per day (max 24 rows per day).

    Example: user walked 320 steps between 8:00–8:59 AM on Mar 4.
    """
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name='hourly_steps'
    )
    date = models.DateField(db_index=True)
    hour = models.IntegerField()           # 0–23 (0 = midnight, 14 = 2PM)
    steps = models.IntegerField(default=0)
    distance_km = models.FloatField(default=0.0)
    calories = models.FloatField(default=0.0)

    class Meta:
        unique_together = [('user', 'date', 'hour')]
        ordering = ['date', 'hour']
        indexes = [models.Index(fields=['user', 'date'])]

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
        related_name='location_waypoints'
    )
    date = models.DateField(db_index=True)
    hour = models.IntegerField()           # which hour this waypoint belongs to
    recorded_at = models.DateTimeField()   # exact timestamp of GPS fix
    latitude = models.FloatField()
    longitude = models.FloatField()
    accuracy_m = models.FloatField(default=0.0)  # GPS accuracy in metres

    class Meta:
        ordering = ['date', 'recorded_at']
        indexes = [models.Index(fields=['user', 'date'])]

    def __str__(self):
        return f"{self.user.username} | {self.recorded_at} | ({self.latitude:.4f}, {self.longitude:.4f})"
