"""
Social layer: friends, teams, weekly rankings, a light activity feed.

Bragging rights only. Nothing in this app holds, moves or promises money: there are
no entry fees, prizes or payouts anywhere in social, and it never reads or writes
wallets. See README.md in this folder.
"""

from __future__ import annotations

import secrets

from django.conf import settings
from django.db import models
from django.db.models import Q

# Unambiguous alphabet for codes people read aloud or type (no 0/O, 1/I/L).
CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"


def new_code(length: int = 8) -> str:
    return "".join(secrets.choice(CODE_ALPHABET) for _ in range(length))


class SocialSettings(models.Model):
    """Singleton with the admin-controlled social switches (Admin > Social)."""

    social_enabled = models.BooleanField(
        default=True, help_text="Master switch: friends, teams, rankings and feed"
    )
    feed_enabled = models.BooleanField(default=True, help_text="Activity feed and reactions")
    teams_enabled = models.BooleanField(default=True, help_text="Creating and joining teams")
    max_team_members = models.PositiveIntegerField(default=30)
    max_teams_per_user = models.PositiveIntegerField(default=3)
    max_friends = models.PositiveIntegerField(default=300)
    friend_requests_per_day = models.PositiveIntegerField(
        default=30, help_text="Friend requests one user can send per 24 hours"
    )
    # Watermark for the incremental weekly-totals job (HealthRecord.synced_at).
    totals_watermark = models.DateTimeField(null=True, blank=True)
    updated_at = models.DateTimeField(auto_now=True)
    updated_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="+"
    )

    class Meta:
        verbose_name = "Social settings"
        verbose_name_plural = "Social settings"

    def save(self, *args, **kwargs):
        self.pk = 1
        super().save(*args, **kwargs)
        from django.core.cache import cache

        cache.delete(SOCIAL_SETTINGS_CACHE_KEY)

    @classmethod
    def load(cls) -> "SocialSettings":
        obj, _ = cls.objects.get_or_create(pk=1)
        return obj


SOCIAL_SETTINGS_CACHE_KEY = "social:settings:v1"


class SocialProfile(models.Model):
    """Per-user social preferences. Created lazily on first social use."""

    DISCOVER_EVERYONE = "everyone"
    DISCOVER_FOF = "friends_of_friends"
    DISCOVER_NOBODY = "nobody"
    DISCOVERABILITY_CHOICES = [
        (DISCOVER_EVERYONE, "Everyone"),
        (DISCOVER_FOF, "Friends of friends"),
        (DISCOVER_NOBODY, "Nobody"),
    ]

    user = models.OneToOneField(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="social_profile"
    )
    # Shared by invite link / QR. Works whatever the search setting (the user chose to
    # share it); it can be reset at any time.
    friend_code = models.CharField(max_length=12, unique=True)
    discoverability = models.CharField(
        max_length=20, choices=DISCOVERABILITY_CHOICES, default=DISCOVER_EVERYONE
    )
    # What friends see in the feed. Milestones only; never locations, routes or money.
    share_goal_hits = models.BooleanField(default=True)
    share_streaks = models.BooleanField(default=True)
    share_badges = models.BooleanField(default=True)
    share_challenges = models.BooleanField(default=True)
    # Appear on friends' and teams' weekly rankings.
    show_in_rankings = models.BooleanField(default=True)
    notify_friend_requests = models.BooleanField(default=True)
    notify_weekly_results = models.BooleanField(default=True)
    notify_reactions = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    def __str__(self):
        return f"SocialProfile({self.user_id})"


class FriendRequest(models.Model):
    PENDING = "pending"
    ACCEPTED = "accepted"
    DECLINED = "declined"
    CANCELLED = "cancelled"
    STATUS_CHOICES = [
        (PENDING, "Pending"),
        (ACCEPTED, "Accepted"),
        (DECLINED, "Declined"),
        (CANCELLED, "Cancelled"),
    ]

    from_user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="friend_requests_sent"
    )
    to_user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="friend_requests_received"
    )
    status = models.CharField(max_length=12, choices=STATUS_CHOICES, default=PENDING)
    via = models.CharField(max_length=12, default="search", help_text="search | code")
    created_at = models.DateTimeField(auto_now_add=True)
    responded_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["from_user", "to_user"],
                condition=Q(status="pending"),
                name="social_one_pending_request_per_pair",
            ),
            models.CheckConstraint(condition=~Q(from_user=models.F("to_user")), name="social_request_not_self"),
        ]
        indexes = [
            models.Index(fields=["to_user", "status", "-created_at"]),
            models.Index(fields=["from_user", "status", "-created_at"]),
        ]
        ordering = ["-created_at"]


class Friendship(models.Model):
    """Stored as two rows (a->b and b->a) so "my friends" is one indexed lookup."""

    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="friendships")
    friend = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="+")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["user", "friend"], name="social_unique_friendship"),
            models.CheckConstraint(condition=~Q(user=models.F("friend")), name="social_friend_not_self"),
        ]


class Block(models.Model):
    blocker = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="social_blocks")
    blocked = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="+")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["blocker", "blocked"], name="social_unique_block"),
            models.CheckConstraint(condition=~Q(blocker=models.F("blocked")), name="social_block_not_self"),
        ]
        indexes = [models.Index(fields=["blocked"])]


class Team(models.Model):
    PUBLIC = "public"
    INVITE_ONLY = "invite_only"
    VISIBILITY_CHOICES = [(PUBLIC, "Public"), (INVITE_ONLY, "Invite only")]

    name = models.CharField(max_length=40)
    # Case/space-insensitive key so two teams can't share a name.
    name_key = models.CharField(max_length=40, unique=True)
    description = models.CharField(max_length=160, blank=True, default="")
    visibility = models.CharField(max_length=12, choices=VISIBILITY_CHOICES, default=PUBLIC)
    invite_code = models.CharField(max_length=12, unique=True)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="+"
    )
    is_disabled = models.BooleanField(default=False, help_text="Hidden and frozen by a moderator")
    disabled_reason = models.CharField(max_length=255, blank=True, default="")
    member_count = models.PositiveIntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        indexes = [
            models.Index(fields=["visibility", "is_disabled", "-member_count"]),
        ]

    def __str__(self):
        return self.name


class TeamMembership(models.Model):
    OWNER = "owner"
    ADMIN = "admin"
    MEMBER = "member"
    ROLE_CHOICES = [(OWNER, "Owner"), (ADMIN, "Admin"), (MEMBER, "Member")]

    team = models.ForeignKey(Team, on_delete=models.CASCADE, related_name="memberships")
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="team_memberships")
    role = models.CharField(max_length=8, choices=ROLE_CHOICES, default=MEMBER)
    joined_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["team", "user"], name="social_unique_team_member"),
            models.UniqueConstraint(
                fields=["team"], condition=Q(role="owner"), name="social_one_owner_per_team"
            ),
        ]
        indexes = [models.Index(fields=["user"])]


class WeeklyStepTotal(models.Model):
    """A user's ranking steps for one Monday-Sunday week (Africa/Nairobi calendar).

    Maintained by the refresh job (incremental) and finalised with friends-rank
    snapshots when the week is archived.
    """

    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="weekly_step_totals")
    week_start = models.DateField()
    steps = models.PositiveIntegerField(default=0)
    days_counted = models.PositiveSmallIntegerField(default=0)
    # Archive snapshot (set when the week is finalised)
    friends_rank = models.PositiveIntegerField(null=True, blank=True)
    friends_size = models.PositiveIntegerField(null=True, blank=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["user", "week_start"], name="social_unique_user_week"),
        ]
        indexes = [models.Index(fields=["week_start", "-steps"])]


class TeamWeeklyTotal(models.Model):
    team = models.ForeignKey(Team, on_delete=models.CASCADE, related_name="weekly_totals")
    week_start = models.DateField()
    steps = models.PositiveBigIntegerField(default=0)
    members_counted = models.PositiveIntegerField(default=0)
    rank = models.PositiveIntegerField(null=True, blank=True, help_text="Set when the week is finalised")
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["team", "week_start"], name="social_unique_team_week"),
        ]
        indexes = [models.Index(fields=["week_start", "-steps"])]


class WeeklyArchive(models.Model):
    """One row per finalised week: makes finalisation idempotent."""

    week_start = models.DateField(unique=True)
    finalized_at = models.DateTimeField(auto_now_add=True)
    users_ranked = models.PositiveIntegerField(default=0)
    teams_ranked = models.PositiveIntegerField(default=0)
    friends_winners = models.PositiveIntegerField(default=0)

    class Meta:
        ordering = ["-week_start"]


class FeedEvent(models.Model):
    GOAL_HIT = "goal_hit"
    STREAK = "streak"
    BADGE = "badge"
    CHALLENGE_QUALIFIED = "challenge_qualified"
    WEEKLY_WINNER = "weekly_winner"
    KIND_CHOICES = [
        (GOAL_HIT, "Daily goal reached"),
        (STREAK, "Streak milestone"),
        (BADGE, "Badge earned"),
        (CHALLENGE_QUALIFIED, "Challenge milestone reached"),
        (WEEKLY_WINNER, "Topped the weekly friends ranking"),
    ]

    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="feed_events")
    kind = models.CharField(max_length=24, choices=KIND_CHOICES)
    # Dedupe key within (user, kind): the day, the badge slug, the challenge id...
    key = models.CharField(max_length=64)
    # Small, non-sensitive facts only (goal, streak days, badge name). Never location,
    # routes, money, or anything from anti-cheat.
    data = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    # Hidden by a moderator (admin console): excluded from every customer view.
    hidden_at = models.DateTimeField(null=True, blank=True, db_index=True)
    hidden_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="+"
    )
    hidden_reason = models.CharField(max_length=255, blank=True, default="")

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["user", "kind", "key"], name="social_unique_feed_event"),
        ]
        indexes = [models.Index(fields=["user", "-created_at"]), models.Index(fields=["-created_at"])]
        ordering = ["-created_at"]


class FeedReaction(models.Model):
    CHEER = "cheer"
    FIRE = "fire"
    STRONG = "strong"
    CLAP = "clap"
    KIND_CHOICES = [(CHEER, "Cheer"), (FIRE, "On fire"), (STRONG, "Strong"), (CLAP, "Well done")]

    event = models.ForeignKey(FeedEvent, on_delete=models.CASCADE, related_name="reactions")
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="+")
    kind = models.CharField(max_length=10, choices=KIND_CHOICES)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["event", "user"], name="social_one_reaction_per_user"),
        ]


class SocialNotification(models.Model):
    FRIEND_REQUEST = "friend_request"
    FRIEND_ACCEPTED = "friend_accepted"
    WEEKLY_RESULTS = "weekly_results"
    REACTION = "reaction"
    TEAM_ROLE = "team_role"
    TEAM_REMOVED = "team_removed"
    KIND_CHOICES = [
        (FRIEND_REQUEST, "Friend request"),
        (FRIEND_ACCEPTED, "Friend request accepted"),
        (WEEKLY_RESULTS, "Weekly results"),
        (REACTION, "Reaction"),
        (TEAM_ROLE, "Team role changed"),
        (TEAM_REMOVED, "Removed from team"),
    ]

    recipient = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="social_notifications")
    actor = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, null=True, blank=True, related_name="+"
    )
    kind = models.CharField(max_length=20, choices=KIND_CHOICES)
    data = models.JSONField(default=dict, blank=True)
    read_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        indexes = [models.Index(fields=["recipient", "read_at", "-created_at"])]
        ordering = ["-created_at"]


class SocialReport(models.Model):
    TARGET_USER = "user"
    TARGET_TEAM = "team"
    TARGET_CHOICES = [(TARGET_USER, "User"), (TARGET_TEAM, "Team")]
    REASON_CHOICES = [
        ("offensive_name", "Offensive name or photo"),
        ("harassment", "Harassment or bullying"),
        ("spam", "Spam or fake account"),
        ("cheating", "Suspected cheating"),
        ("other", "Something else"),
    ]
    OPEN = "open"
    ACTIONED = "actioned"
    DISMISSED = "dismissed"
    STATUS_CHOICES = [(OPEN, "Open"), (ACTIONED, "Action taken"), (DISMISSED, "Dismissed")]

    reporter = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, related_name="social_reports_made"
    )
    target_type = models.CharField(max_length=8, choices=TARGET_CHOICES)
    target_user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, null=True, blank=True, related_name="social_reports_received"
    )
    target_team = models.ForeignKey(Team, on_delete=models.CASCADE, null=True, blank=True, related_name="reports")
    reason = models.CharField(max_length=20, choices=REASON_CHOICES)
    details = models.CharField(max_length=500, blank=True, default="")
    status = models.CharField(max_length=10, choices=STATUS_CHOICES, default=OPEN)
    reviewed_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="+"
    )
    reviewed_at = models.DateTimeField(null=True, blank=True)
    resolution_note = models.CharField(max_length=500, blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        indexes = [models.Index(fields=["status", "-created_at"])]
        ordering = ["-created_at"]
