"""Staff-managed customer content: in-app announcements and the help centre (FAQ).

Nothing here touches money, steps or trust. Everything staff change is audited
(apps/content/admin_views.py). Customers only ever see published, in-schedule items.
"""

from django.conf import settings
from django.db import models
from django.utils import timezone


class Announcement(models.Model):
    """A banner/card shown on the customer app's Home screen."""

    SEVERITY_CHOICES = [("info", "Info"), ("warning", "Warning"), ("success", "Success")]

    AUDIENCE_ALL = "all"
    AUDIENCE_CHOICES = [
        ("all", "Everyone"),
        ("android", "Android app"),
        ("ios", "iPhone app"),
        ("web", "Web app"),
        ("segment", "A group of customers"),
    ]
    SEGMENT_CHOICES = [
        ("active_challenge", "In an active challenge"),
        ("paid_challenge", "In an active paid challenge"),
        ("new_users", "Joined in the last 14 days"),
        ("no_challenge_yet", "Never joined a challenge"),
    ]

    STATUS_DRAFT = "draft"
    STATUS_PUBLISHED = "published"
    STATUS_ARCHIVED = "archived"
    STATUS_CHOICES = [
        (STATUS_DRAFT, "Draft"),
        (STATUS_PUBLISHED, "Published"),
        (STATUS_ARCHIVED, "Archived"),
    ]

    title = models.CharField(max_length=120)
    # Plain text with a tiny markdown subset (**bold**, [label](https://...), "- " lists).
    # Clients render it as text; nothing is ever injected as HTML.
    body = models.TextField(max_length=1000, blank=True, default="")
    severity = models.CharField(max_length=10, choices=SEVERITY_CHOICES, default="info")
    audience = models.CharField(max_length=10, choices=AUDIENCE_CHOICES, default=AUDIENCE_ALL)
    segment = models.CharField(max_length=24, choices=SEGMENT_CHOICES, blank=True, default="")
    link_url = models.CharField(max_length=300, blank=True, default="", help_text="https://... or an in-app path like /wallet")
    link_label = models.CharField(max_length=40, blank=True, default="")
    starts_at = models.DateTimeField(default=timezone.now)
    ends_at = models.DateTimeField(null=True, blank=True)
    dismissible = models.BooleanField(default=True)
    priority = models.IntegerField(default=0, help_text="Higher shows first")
    status = models.CharField(max_length=10, choices=STATUS_CHOICES, default=STATUS_DRAFT, db_index=True)
    published_at = models.DateTimeField(null=True, blank=True)
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="+")
    updated_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="+")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-priority", "-starts_at", "-id"]
        indexes = [models.Index(fields=["status", "starts_at"])]

    def __str__(self):
        return self.title

    def is_live(self, now=None) -> bool:
        now = now or timezone.now()
        return (
            self.status == self.STATUS_PUBLISHED
            and self.starts_at <= now
            and (self.ends_at is None or self.ends_at > now)
        )

    def schedule_state(self, now=None) -> str:
        """draft | scheduled | live | ended | archived (for the console)."""
        now = now or timezone.now()
        if self.status != self.STATUS_PUBLISHED:
            return self.status
        if self.starts_at > now:
            return "scheduled"
        if self.ends_at is not None and self.ends_at <= now:
            return "ended"
        return "live"


class AnnouncementDismissal(models.Model):
    announcement = models.ForeignKey(Announcement, on_delete=models.CASCADE, related_name="dismissals")
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="+")
    dismissed_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["announcement", "user"], name="content_unique_dismissal")]


class HelpCategory(models.Model):
    title = models.CharField(max_length=80)
    description = models.CharField(max_length=200, blank=True, default="")
    order = models.PositiveIntegerField(default=0)
    is_published = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["order", "id"]
        verbose_name_plural = "Help categories"

    def __str__(self):
        return self.title


class HelpArticle(models.Model):
    # PROTECT: a category with articles can't disappear by accident.
    category = models.ForeignKey(HelpCategory, on_delete=models.PROTECT, related_name="articles")
    title = models.CharField(max_length=160)
    # Same safe text subset as announcements.
    body = models.TextField(max_length=10000)
    order = models.PositiveIntegerField(default=0)
    is_published = models.BooleanField(default=False)
    updated_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="+")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["category__order", "order", "id"]

    def __str__(self):
        return self.title
