from django.db import models
from django.contrib.auth import get_user_model
from django.core.validators import MinValueValidator
from apps.challenges.models import Challenge

User = get_user_model()


class Badge(models.Model):
    """
    Badge definition with criteria and metadata.
    Pre-populated badges for various achievements.
    """
    BADGE_TYPES = [
        ('milestone', 'Milestone'),
        ('achievement', 'Achievement'),
        ('challenge', 'Challenge'),
        ('streak', 'Streak'),
        ('rank', 'Rank'),
    ]

    slug = models.SlugField(unique=True, max_length=50)
    name = models.CharField(max_length=100)
    description = models.TextField()
    icon = models.CharField(max_length=10, help_text='Emoji or icon name')
    badge_type = models.CharField(max_length=20, choices=BADGE_TYPES, default='achievement')
    color = models.CharField(max_length=7, default='#00F5E9', help_text='Hex color code')
    
    # Criteria for auto-awarding
    criteria_type = models.CharField(
        max_length=50,
        choices=[
            ('first_challenge', 'First Challenge Joined'),
            ('first_win', 'First Challenge Won'),
            ('step_milestone', 'Step Milestone'),
            ('challenge_wins', 'Number of Challenge Wins'),
            ('streak_days', 'Streak Days'),
            ('total_xp', 'Total XP Earned'),
            ('manual', 'Manual Award'),
        ],
        default='manual'
    )
    criteria_value = models.IntegerField(null=True, blank=True, help_text='Threshold value for criteria')
    
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        indexes = [
            models.Index(fields=['slug']),
            models.Index(fields=['criteria_type']),
        ]
        ordering = ['-created_at']
        verbose_name = 'Badge'
        verbose_name_plural = 'Badges'

    def __str__(self):
        return f"{self.icon} {self.name}"


class UserBadge(models.Model):
    """
    User's earned badge with timestamp
    """
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name='badges')
    badge = models.ForeignKey(Badge, on_delete=models.CASCADE, related_name='users')
    earned_at = models.DateTimeField(auto_now_add=True)
    is_new = models.BooleanField(default=True, help_text='Shows notification until user views')

    class Meta:
        unique_together = ('user', 'badge')
        indexes = [
            models.Index(fields=['user', 'earned_at']),
            models.Index(fields=['badge']),
        ]
        ordering = ['-earned_at']
        verbose_name = 'User Badge'
        verbose_name_plural = 'User Badges'

    def __str__(self):
        return f"{self.user.username} - {self.badge.name}"


class XPEvent(models.Model):
    """
    Log of all XP events with audit trail
    """
    EVENT_TYPES = [
        ('daily_login', 'Daily Login'),
        ('challenge_join', 'Challenge Join'),
        ('challenge_complete', 'Challenge Complete'),
        ('challenge_win', 'Challenge Win'),
        ('step_milestone', 'Step Milestone'),
        ('streak_milestone', 'Streak Milestone'),
        ('level_up', 'Level Up'),
        ('manual_award', 'Manual Award'),
        ('admin_adjustment', 'Admin Adjustment'),
    ]

    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name='xp_events')
    event_type = models.CharField(max_length=30, choices=EVENT_TYPES)
    amount = models.IntegerField(validators=[MinValueValidator(-10000)])
    
    # Reference to challenge (optional)
    challenge = models.ForeignKey(
        Challenge,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='xp_events'
    )
    
    # Optional data JSON
    description = models.CharField(max_length=255, blank=True)
    metadata = models.JSONField(default=dict, blank=True)
    
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)
    processed = models.BooleanField(default=False)

    class Meta:
        indexes = [
            models.Index(fields=['user', 'created_at']),
            models.Index(fields=['event_type', 'created_at']),
            models.Index(fields=['processed', 'created_at']),
        ]
        ordering = ['-created_at']
        verbose_name = 'XP Event'
        verbose_name_plural = 'XP Events'

    def __str__(self):
        return f"{self.user.username} (+{self.amount} XP) - {self.get_event_type_display()}"


class LevelMilestone(models.Model):
    """
    Track level up milestones for each user
    """
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name='level_milestones')
    level = models.IntegerField()
    reached_at = models.DateTimeField(auto_now_add=True)
    total_xp = models.IntegerField()
    reward_badge = models.ForeignKey(
        Badge,
        on_delete=models.SET_NULL,
        null=True,
        blank=True
    )

    class Meta:
        unique_together = ('user', 'level')
        indexes = [
            models.Index(fields=['user', 'level']),
            models.Index(fields=['level']),
        ]
        ordering = ['-level']
        verbose_name = 'Level Milestone'
        verbose_name_plural = 'Level Milestones'

    def __str__(self):
        return f"{self.user.username} - Level {self.level}"


class DailyLoginStreak(models.Model):
    """
    Track user daily login streaks for streak-based gamification
    """
    user = models.OneToOneField(User, on_delete=models.CASCADE, related_name='login_streak')
    current_streak = models.IntegerField(default=0)
    longest_streak = models.IntegerField(default=0)
    last_login_date = models.DateField(null=True, blank=True)
    total_logins = models.IntegerField(default=0)
    
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = 'Daily Login Streak'
        verbose_name_plural = 'Daily Login Streaks'

    def __str__(self):
        return f"{self.user.username} - {self.current_streak} day streak"

    def update_streak(self, today):
        """Update streak based on login date"""
        from datetime import timedelta
        
        if self.last_login_date is None:
            self.current_streak = 1
        elif self.last_login_date == today:
            # Already logged in today
            pass
        elif self.last_login_date == today - timedelta(days=1):
            # Consecutive day
            self.current_streak += 1
            if self.current_streak > self.longest_streak:
                self.longest_streak = self.current_streak
        else:
            # Streak broken
            self.current_streak = 1
        
        self.last_login_date = today
        self.total_logins += 1
        self.save()
